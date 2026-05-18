const { neon } = require('@neondatabase/serverless');
function getDb() { return neon(process.env.DATABASE_URL || process.env.POSTGRES_URL); }

// Resolve effective scan limit for a user.
// Priority: feature_overrides > plan_snapshot > hard-coded plan default
function resolveLimit(user, key, planDefaults) {
  const overrides = user.feature_overrides || {};
  if (key in overrides) return overrides[key];
  const snapshot = user.plan_snapshot || {};
  if (key in snapshot) return snapshot[key];
  return planDefaults[user.plan || 'free'] || planDefaults['free'];
}

const SCAN_PLAN_DEFAULTS = { free: '5', pro: 'Unlimited', business: 'Unlimited' };

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  // ── Plan limit enforcement ───────────────────────────────────────────────
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  // ── Payload size guard ────────────────────────────────────────────────────
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > 10485760) return res.status(413).json({ error: 'Payload too large — maximum 10MB' });
  let enforcedUser = null;
  if (token) {
    try {
      const sql = getDb();
      const rows = await sql`
        SELECT id, plan, feature_overrides, plan_snapshot
        FROM users WHERE session_token=${token} AND token_expires > NOW() LIMIT 1
      `;
      if (rows.length) {
        enforcedUser = rows[0];
        const limitRaw = resolveLimit(enforcedUser, 'ai_scans', SCAN_PLAN_DEFAULTS);
        const isUnlimited = String(limitRaw).toLowerCase() === 'unlimited' || limitRaw === '-1';
        if (!isUnlimited) {
          const limit = parseInt(limitRaw) || 5;
          const thisMonth = new Date().toISOString().slice(0, 7);
          const usageRows = await sql`
            SELECT scan_count FROM scan_usage WHERE user_id=${enforcedUser.id} AND month=${thisMonth} LIMIT 1
          `;
          const used = usageRows.length ? parseInt(usageRows[0].scan_count) : 0;
          if (used >= limit) {
            return res.status(402).json({
              error: 'scan_limit_reached',
              used, limit,
              message: `You have used all ${limit} AI scans for this month. Upgrade your plan or contact support for more.`
            });
          }
          // Store limit info for post-success increment — do NOT increment here
          enforcedUser._scanMonth = thisMonth;
        }
      }
    } catch(e) { console.error('scan limit check error:', e.message); /* never block on check failure */ }
  }

  const { image, images, mediaType, mode } = req.body || {};
  const isStatement = mode === 'statement';
  const today = new Date().toISOString().split('T')[0];

  // Build image blocks
  let imageBlocks = [];
  if (images && Array.isArray(images) && images.length > 0) {
    imageBlocks = images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: img.data }
    }));
  } else if (image) {
    imageBlocks = [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }];
  } else {
    return res.status(400).json({ error: 'No image provided' });
  }

  // Validate
  for (let i = 0; i < imageBlocks.length; i++) {
    if (!imageBlocks[i].source.data || imageBlocks[i].source.data.length < 50) {
      return res.status(400).json({ error: `Image ${i+1} missing data` });
    }
  }

  console.log(`scan: mode=${mode} images=${imageBlocks.length} kb=${Math.round(imageBlocks.reduce((s,b)=>s+b.source.data.length,0)/1024)}`);

  const statementPrompt = `Extract all transactions from these ${imageBlocks.length} bank statement image(s). De-duplicate overlapping sections.
Return ONLY raw JSON: {"transactions":[{"date":"YYYY-MM-DD","description":"","amount":0.00,"type":"debit|credit"}],"bank":"","period_start":"YYYY-MM-DD","period_end":"YYYY-MM-DD"}
Negative=debit, positive=credit. Today=${today}`;

  // Two-stage receipt prompt: first just extract text, then parse
  const receiptPrompt = `You are reading ${imageBlocks.length > 1 ? imageBlocks.length + ' photos of the SAME receipt' : 'a receipt photo'}. The receipt may be at an angle, crumpled, or partially lit — do your best to read all text.

Extract every line item and the total. Return ONLY this exact JSON structure with no other text:
{"merchant":"store name","date":"YYYY-MM-DD","receipt_total":0.00,"currency":"AUD","line_items":[{"desc":"item name","amount":-0.00}],"notes":""}

Rules:
- receipt_total: the final total printed (positive number like 430.35)  
- line_items amounts: negative for purchases (e.g. -12.99), positive for discounts/returns
- If you cannot read a value clearly, use your best estimate
- Do NOT include payment/card details, just the purchased items
- Today is ${today}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: isStatement ? statementPrompt : receiptPrompt }] }]
      })
    });

    const rawText = await r.text();
    console.log(`Claude response status: ${r.status}`);

    if (!r.ok) {
      let detail = rawText.slice(0, 300);
      try { detail = JSON.parse(rawText).error?.message || detail; } catch(e) {}
      console.error('Claude API error:', r.status, detail);
      return res.status(500).json({ error: `Claude API ${r.status}: ${detail}` });
    }

    // ── Increment scan usage only on successful Claude response ──────────────
    if (enforcedUser && enforcedUser._scanMonth) {
      const sql = getDb();
      await sql`
        INSERT INTO scan_usage (user_id, month, scan_count, updated_at)
        VALUES (${enforcedUser.id}, ${enforcedUser._scanMonth}, 1, NOW())
        ON CONFLICT (user_id, month) DO UPDATE SET scan_count = scan_usage.scan_count + 1, updated_at = NOW()
      `.catch(e => console.error('scan_usage increment failed:', e.message));
    }

    let d;
    try { d = JSON.parse(rawText); } catch(e) {
      return res.status(500).json({ error: 'Bad response from Claude API' });
    }

    const text = (d.content?.[0]?.text || '').trim();
    console.log('Claude raw text (first 200):', text.slice(0, 200));

    // Strip markdown fences aggressively
    let clean = text
      .replace(/^```json\s*/im, '').replace(/^```\s*/im, '').replace(/\s*```\s*$/im, '')
      .replace(/^[^{[]*/, '')  // strip any text before first { or [
      .replace(/[^}\]]*$/, '')  // strip any text after last } or ]
      .trim();

    let out;
    try {
      out = JSON.parse(clean);
    } catch(e) {
      console.error('Parse failed. Clean attempt:', clean.slice(0, 300));
      // Last resort: try to extract just the JSON object
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { out = JSON.parse(match[0]); }
        catch(e2) {
          return res.status(422).json({ error: 'Receipt read but could not parse — image may be too dark or blurry', raw: text.slice(0,200) });
        }
      } else {
        return res.status(422).json({ error: 'Receipt read but could not parse — image may be too dark or blurry', raw: text.slice(0,200) });
      }
    }

    // Normalise line item amounts — handle trailing minus, currency symbols
    if (!isStatement && Array.isArray(out.line_items)) {
      out.line_items = out.line_items.map(function(li) {
        var raw = String(li.amount || '0').trim().replace(/&/g,'').trim(); // strip GST marker
        var trailingMinus = raw.endsWith('-');
        var leadingMinus  = raw.startsWith('-');
        var num = parseFloat(raw.replace(/[^0-9.]/g,'')) || 0;
        if (trailingMinus) {
          li.amount = +num;   // Costco trailing minus = discount = positive (reduces total)
        } else if (leadingMinus) {
          li.amount = -num;   // explicitly negative
        } else {
          // Claude may return amount already as a number
          // If Claude returned a number type, trust its sign
          if (typeof li.amount === 'number') {
            li.amount = li.amount; // keep as-is
          } else {
            li.amount = -num;   // string with no sign = purchase = negative
          }
        }
        return li;
      });
    }
    if (!isStatement) {
      if (!out.date || !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) out.date = today;
      // Use receipt_total as the authoritative total
      if (out.receipt_total) {
        out.amount = -Math.abs(parseFloat(out.receipt_total)||0);
        // Validate item sum vs total
        var itemSum = (out.line_items||[]).reduce(function(s,li){return s+Math.abs(parseFloat(li.amount)||0);},0);
        var diff = Math.abs(itemSum - Math.abs(out.receipt_total));
        if (diff > 1) {
          out.notes = (out.notes||'') + ' | Items sum $'+itemSum.toFixed(2)+' vs total $'+out.receipt_total;
          console.log('Amount mismatch: items='+itemSum.toFixed(2)+' total='+out.receipt_total);
        }
      }
    }
    if (isStatement && Array.isArray(out.transactions)) {
      out.transactions = out.transactions.map(t => {
        let amt = parseFloat(t.amount) || 0;
        if (t.type === 'debit' && amt > 0) amt = -amt;
        if (t.type === 'credit' && amt < 0) amt = -amt;
        return { ...t, amount: amt };
      });
    }

    return res.status(200).json({ success: true, data: out });

  } catch(err) {
    console.error('scan.js error:', err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '10mb' } } };

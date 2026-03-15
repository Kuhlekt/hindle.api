const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));
require("dotenv").config();
const express = require("express");
const cors = require("cors");
// Stripe — STRIPE_SECRET_KEY must be set in Railway env vars
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    console.log("[Stripe] Initialised OK");
  } else {
    console.warn("[Stripe] STRIPE_SECRET_KEY not set — payments disabled");
  }
} catch (e) { console.warn("[Stripe] Load error:", e.message); }
const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ─────────────────────────────────────────────
// IN-MEMORY RATE LIMITER  (per tenant, per minute)
// ─────────────────────────────────────────────
const rateBuckets = new Map(); // tenantId → { count, resetAt }
function checkRateLimit(tenantId, limit = 30) {
  const now = Date.now();
  let bucket = rateBuckets.get(tenantId);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60000 };
    rateBuckets.set(tenantId, bucket);
  }
  bucket.count++;
  if (bucket.count > limit) return false;
  return true;
}
// Clean up old buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets.entries()) {
    if (now > v.resetAt + 60000) rateBuckets.delete(k);
  }
}, 300000);

// ─────────────────────────────────────────────
// TYPING INDICATORS  (in-memory, TTL 5s)
// ─────────────────────────────────────────────
const typingState = new Map(); // conversationId → { agent: bool, visitor: bool, ts: number }
function setTyping(convId, role, val) {
  const cur = typingState.get(convId) || { agent: false, visitor: false };
  cur[role] = val;
  cur.ts = Date.now();
  typingState.set(convId, cur);
}
function getTyping(convId) {
  const s = typingState.get(convId);
  if (!s) return { agent: false, visitor: false };
  // Auto-expire after 5s inactivity
  if (Date.now() - s.ts > 5000) { typingState.delete(convId); return { agent: false, visitor: false }; }
  return s;
}


// ─────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  try {
    const result = await sql`SELECT version()`;
    res.json({ status: "ok", db: result[0].version });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Quick diagnostic — count conversations for an org

// ─────────────────────────────────────────────
// STRIPE — Checkout Session + Webhook
// ─────────────────────────────────────────────

// POST /api/stripe/checkout
// Body: { planId, billing, email, orgId?, promoCode? }
// Returns: { url } (redirect to Stripe Checkout)
app.post("/api/stripe/checkout", async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Payments not configured. STRIPE_SECRET_KEY missing." });
  const { planId, billing, email, orgId, promoCode, successUrl, cancelUrl } = req.body;
  if (!planId || !email) return res.status(400).json({ error: "planId and email required" });

  try {
    // Get pricing from admin config
    const [cfg] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`.catch(()=>[null]);
    const sc = cfg?.config?._superConfig || {};
    const planPrices = { starter: sc.plans?.starter?.usd || 49, professional: sc.plans?.professional?.usd || 149 };
    const monthlyUsd = planPrices[planId] || 49;
    const isAnnual = billing === "annual";
    const annualPct = sc.annualDiscountPct || 20;
    const unitAmount = isAnnual
      ? Math.round(monthlyUsd * (1 - annualPct / 100) * 12 * 100) // annual total in cents
      : Math.round(monthlyUsd * 100); // monthly in cents

    // Apply promo code discount if valid
    let discounts = [];
    if (promoCode && sc.promoCodes) {
      const promo = sc.promoCodes.find(p =>
        p.code === promoCode.toUpperCase() && p.active &&
        (p.used || 0) < (p.limit || 999) &&
        new Date(p.expiry) > new Date() &&
        (p.plans || []).includes(planId)
      );
      if (promo) {
        // Create or retrieve Stripe coupon
        const couponId = `HINDLE_${promo.code}`;
        try {
          await stripe.coupons.retrieve(couponId);
        } catch (_) {
          await stripe.coupons.create({ id: couponId, percent_off: promo.pct, duration: "once", name: promo.code });
        }
        discounts = [{ coupon: couponId }];
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: isAnnual ? "payment" : "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      metadata: { planId, billing, orgId: orgId || "", promoCode: promoCode || "" },
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `Hindle ${planId.charAt(0).toUpperCase() + planId.slice(1)} — ${isAnnual ? "Annual" : "Monthly"}` },
          ...(isAnnual
            ? { unit_amount: unitAmount }
            : { unit_amount: unitAmount, recurring: { interval: "month" } }
          ),
        },
        quantity: 1,
      }],
      discounts,
      success_url: (successUrl || "https://chatbot.hindleconsultants.com") + "?payment=success&session_id={CHECKOUT_SESSION_ID}&plan=" + planId,
      cancel_url: cancelUrl || "https://chatbot.hindleconsultants.com?payment=cancelled",
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (e) {
    console.error("[Stripe] Checkout error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stripe/webhook
// Stripe sends events here — activates org on payment success
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
      : JSON.parse(req.body);
  } catch (e) {
    return res.status(400).json({ error: "Webhook signature error: " + e.message });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { planId, orgId, promoCode } = session.metadata || {};
    const email = session.customer_email;
    try {
      // Find org by email or orgId and activate
      let org = null;
      if (orgId) {
        const rows = await sql`SELECT * FROM organisations WHERE id::text = ${orgId} LIMIT 1`;
        org = rows[0];
      }
      if (!org && email) {
        const rows = await sql`SELECT * FROM organisations WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
        org = rows[0];
      }
      if (org) {
        await sql`UPDATE organisations SET status = 'paid', plan = ${planId || org.plan}, updated_at = NOW() WHERE id = ${org.id}`;
        // Increment promo usage
        if (promoCode) {
          const [cfg] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`.catch(()=>[null]);
          if (cfg?.config?._superConfig?.promoCodes) {
            const codes = cfg.config._superConfig.promoCodes.map(p =>
              p.code === promoCode.toUpperCase() ? { ...p, used: (p.used || 0) + 1 } : p
            );
            const updated = { ...cfg.config, _superConfig: { ...cfg.config._superConfig, promoCodes: codes } };
            await sql`UPDATE tenant_configs SET config = ${JSON.stringify(updated)} WHERE tenant_id = 'platform'`;
          }
        }
        console.log(`[Stripe] Activated org ${org.id} on plan ${planId}`);
      }
    } catch (e) {
      console.error("[Stripe] Webhook activation error:", e.message);
    }
  }

  res.json({ received: true });
});

// GET /api/stripe/status?session_id=xxx
// Frontend polls this after redirect to confirm payment activated
app.get("/api/stripe/status", async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: "session_id required" });
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    res.json({
      status: session.payment_status,
      paid: session.payment_status === "paid",
      planId: session.metadata?.planId,
      email: session.customer_email,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/diag/convos", async (req, res) => {
  const { org_id } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  try {
    const total  = await sql`SELECT COUNT(*)::int as n FROM conversations WHERE org_id::text = ${org_id}`;
    const byStatus = await sql`SELECT status, COUNT(*)::int as n FROM conversations WHERE org_id::text = ${org_id} GROUP BY status`;
    const sample = await sql`SELECT id, org_id::text, status, visitor_name, created_at FROM conversations WHERE org_id::text = ${org_id} ORDER BY created_at DESC LIMIT 5`;
    res.json({ total: total[0]?.n, byStatus, sample });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// TYPING INDICATORS
// POST /api/typing  { conversationId, role, typing }
// GET  /api/typing/:conversationId
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// OFFLINE MESSAGE CAPTURE
// POST /api/offline-message
// Visitor leaves message when no agents available
// ─────────────────────────────────────────────
app.post("/api/offline-message", async (req, res) => {
  const { tenantId, name, email, message, page } = req.body;
  if (!tenantId || !message) return res.status(400).json({ error: "tenantId and message required" });
  try {
    // Resolve org
    const [org] = await sql`SELECT * FROM organisations WHERE id::text = ${tenantId} OR tenant_id = ${tenantId} LIMIT 1`;
    if (!org) return res.status(404).json({ error: "Tenant not found" });
    const orgId = org.id;

    // Store as a conversation with status 'offline_msg'
    await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS offline_message BOOLEAN DEFAULT FALSE`.catch(()=>{});
    const [conv] = await sql`
      INSERT INTO conversations (org_id, visitor_name, visitor_email, page, subject, status)
      VALUES (${orgId}, ${name || "Website Visitor"}, ${email || null}, ${page || "/"}, ${"Offline message"}, ${"open"})
      RETURNING *
    `;
    await sql`
      INSERT INTO messages (conversation_id, type, sender, content)
      VALUES (${conv.id}, ${"visitor"}, ${name || "Visitor"}, ${message})
    `;
    await sql`UPDATE conversations SET offline_message = TRUE WHERE id = ${conv.id}`.catch(()=>{});

    // Send email notification if ClickSend configured
    try {
      const [cfg] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${orgId} LIMIT 1`;
      const cs = cfg?.config?.clicksend || {};
      if (cs.username && cs.apiKey && (cs.notifEmail || org.email)) {
        const toEmail = cs.notifEmail || org.email;
        const emailBody = `New offline message from ${name || "visitor"} (${email || "no email"}):

"${message}"

Page: ${page || "/"}

Reply at: https://chatbot.hindleconsultants.com`;
        await fetch("https://rest.clicksend.com/v3/email/send", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from(cs.username + ":" + cs.apiKey).toString("base64") },
          body: JSON.stringify({ to: [{ email: toEmail, name: org.name || "Admin" }], from: { email_address_id: 1, name: cs.fromName || "Hindle" }, subject: `New offline message — ${name || "Visitor"}`, body: `<pre style="font-family:sans-serif">${emailBody}</pre>` }),
        }).catch(()=>{});
      }
    } catch (_) {}

    res.json({ ok: true, conversationId: conv.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/typing", (req, res) => {
  const { conversationId, role, typing } = req.body;
  if (!conversationId || !role) return res.status(400).json({ error: "conversationId and role required" });
  setTyping(conversationId, role === "agent" ? "agent" : "visitor", !!typing);
  res.json({ ok: true });
});
app.get("/api/typing/:conversationId", (req, res) => {
  res.json(getTyping(req.params.conversationId));
});

// ─────────────────────────────────────────────
// CSAT  — store rating on conversation
// POST /api/conversations/:id/csat  { rating: 1|0, comment? }
// ─────────────────────────────────────────────
app.post("/api/conversations/:id/csat", async (req, res) => {
  const { rating, comment } = req.body;
  if (rating === undefined) return res.status(400).json({ error: "rating required" });
  try {
    await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS csat_rating INT`.catch(() => {});
    await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS csat_comment TEXT`.catch(() => {});
    await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS csat_at TIMESTAMPTZ`.catch(() => {});
    await sql`
      UPDATE conversations
      SET csat_rating = ${rating}, csat_comment = ${comment || null}, csat_at = NOW(), updated_at = NOW()
      WHERE id = ${req.params.id}
    `;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// ANALYTICS  — first response time + CSAT summary
// GET /api/analytics/:orgId?days=30
// ─────────────────────────────────────────────
app.get("/api/analytics/:orgId", async (req, res) => {
  const { orgId } = req.params;
  const { days = "30" } = req.query;
  try {
    await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS csat_rating INT`.catch(() => {});
    await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ`.catch(() => {});
    const since = new Date(Date.now() - Number(days) * 86400000).toISOString();
    const csatRows = await sql`
      SELECT csat_rating, COUNT(*)::int as n FROM conversations
      WHERE org_id::text = ${orgId} AND csat_rating IS NOT NULL AND created_at >= ${since}
      GROUP BY csat_rating
    `;
    const csatTotal = csatRows.reduce((s, r) => s + r.n, 0);
    const csatPositive = csatRows.filter(r => r.csat_rating === 1).reduce((s, r) => s + r.n, 0);
    const csatScore = csatTotal === 0 ? null : Math.round(csatPositive / csatTotal * 100);
    const frtRows = await sql`
      SELECT c.id, EXTRACT(EPOCH FROM (MIN(m.created_at) - c.created_at)) AS frt_seconds
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id AND m.type = 'agent'
      WHERE c.org_id::text = ${orgId} AND c.created_at >= ${since}
      GROUP BY c.id, c.created_at
    `.catch(() => []);
    const frtValues = frtRows.map(r => Number(r.frt_seconds)).filter(v => v > 0 && v < 86400);
    const avgFrt = frtValues.length === 0 ? null : Math.round(frtValues.reduce((s, v) => s + v, 0) / frtValues.length);
    const medFrt = frtValues.length === 0 ? null : [...frtValues].sort((a, b) => a - b)[Math.floor(frtValues.length / 2)];
    const dailyRows = await sql`
      SELECT DATE(created_at) as day, COUNT(*)::int as total,
             SUM(CASE WHEN claimed_by_id IS NOT NULL OR status IN ('claimed','resolved') THEN 1 ELSE 0 END)::int as human,
             SUM(CASE WHEN csat_rating = 1 THEN 1 ELSE 0 END)::int as csat_pos,
             SUM(CASE WHEN csat_rating IS NOT NULL THEN 1 ELSE 0 END)::int as csat_total
      FROM conversations
      WHERE org_id::text = ${orgId} AND created_at >= ${since}
      GROUP BY DATE(created_at) ORDER BY day ASC
    `.catch(() => []);
    res.json({ csatScore, csatTotal, csatPositive, avgFrt, medFrt, frtCount: frtValues.length, dailyRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// ONBOARDING CHECKLIST
// GET /api/onboarding/:orgId
// ─────────────────────────────────────────────
app.get("/api/onboarding/:orgId", async (req, res) => {
  const { orgId } = req.params;
  try {
    const [org] = await sql`SELECT * FROM organisations WHERE id::text = ${orgId} LIMIT 1`.catch(() => [null]);
    const [cfg] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${orgId} LIMIT 1`.catch(() => [null]);
    const [convRow] = await sql`SELECT COUNT(*)::int as n FROM conversations WHERE org_id::text = ${orgId}`.catch(() => [{n:0}]);
    const [agentRow] = await sql`SELECT COUNT(*)::int as n FROM agents WHERE org_id::text = ${orgId}`.catch(() => [{n:0}]);
    const [kbRow] = await sql`SELECT COUNT(*)::int as n FROM kb_documents WHERE org_id::text = ${orgId}`.catch(() => [{n:0}]);
    const c = cfg?.config || {};
    const brand = c.brand || {};
    const steps = [
      { id: "profile",  label: "Complete organisation profile", done: !!(org?.name && c.org?.phone) },
      { id: "branding", label: "Set brand colours & widget name", done: !!(brand.primary && brand.widget_name) },
      { id: "logo",     label: "Upload custom logo",            done: !!(brand.customLogoUrl) },
      { id: "agent",    label: "Add at least one agent",        done: (agentRow?.n || 0) > 0 },
      { id: "kb",       label: "Add a knowledge base document", done: (kbRow?.n || 0) > 0 },
      { id: "faq",      label: "Add at least one FAQ",          done: Array.isArray(c.faqs) && c.faqs.length > 0 },
      { id: "widget",   label: "Install widget on your site",   done: !!(c.widgetInstalled) },
      { id: "convo",    label: "Receive your first chat",       done: (convRow?.n || 0) > 0 },
    ];
    const pct = Math.round(steps.filter(s => s.done).length / steps.length * 100);
    res.json({ steps, pct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─────────────────────────────────────────────
// AI CHAT  — routes messages through Claude
// POST /api/chat
// Body: { tenantId, system, messages: [{role, content}] }
// ─────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { system, messages, tenantId, conversationId, handoffCommands } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }

  // Rate limit: 30 AI calls per tenant per minute
  if (tenantId && !checkRateLimit(tenantId, 30)) {
    return res.status(429).json({ error: "Rate limit exceeded. Please wait a moment before sending another message.", rate_limited: true });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set on server" });

  // ── Handoff silence ─────────────────────────────────────────
  // When a conversation is in handoff the bot stays silent.
  // It only speaks if the visitor sends a recognised listening command.
  if (conversationId) {
    try {
      const [conv] = await sql`SELECT status, updated_at FROM conversations WHERE id = ${conversationId}`;
      if (conv && (conv.status === "handoff" || conv.status === "claimed")) {
        // Check last message time from DB — if >60s with no agent reply, let bot back in
        const [lastDbMsg] = await sql`
          SELECT created_at FROM messages WHERE conversation_id = ${conversationId}
          ORDER BY created_at DESC LIMIT 1
        `.catch(() => [null]);
        const lastMsgAge = lastDbMsg
          ? (Date.now() - new Date(lastDbMsg.created_at).getTime()) / 1000
          : 9999;
        // If no activity for >60s, fall through to normal AI response
        if (lastMsgAge <= 60) {
          const lastMsg = [...messages].reverse().find(m => m.role === "visitor" || m.role === "user");
          const text = (lastMsg?.content || lastMsg?.text || "").trim().toLowerCase();
          const defaults = ["/status", "/cancel", "/restart", "/help", "/agent"];
          const cmds = Array.isArray(handoffCommands)
            ? [...defaults, ...handoffCommands.map(c => c.toLowerCase())]
            : defaults;
          const matched = cmds.some(c => text === c || text.startsWith(c + " "));
          if (!matched) {
            return res.json({ reply: null, handoff_active: true });
          }
          const cmdSys = (system || "") +
            "\n\nThis conversation has been escalated to a human agent who is now handling it. " +
            "You may only respond to visitor commands (/status /cancel /restart /help /agent). " +
            "Keep replies under 2 sentences. Do not offer to help with the original issue.";
          const r2 = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514", max_tokens: 150, system: cmdSys,
              messages: messages.map(m => ({ role: m.role === "visitor" || m.role === "user" ? "user" : "assistant", content: m.content || m.text || "" })),
            }),
          });
          const d2 = await r2.json();
          const cmdReply = d2.content?.[0]?.text || "";
          try {
            await sql`INSERT INTO messages (conversation_id, type, sender, content) VALUES (${conversationId}, 'bot', 'AI', ${cmdReply})`;
            await sql`UPDATE conversations SET updated_at = NOW() WHERE id = ${conversationId}`;
          } catch (_) {}
          return res.json({ reply: cmdReply, handoff_active: true, command_matched: true });
        }
        // else: >60s inactivity — fall through to normal AI response
      }
    } catch (_) {}
  }

  // ── Normal AI response ──────────────────────────────────────
  try {
    // Build confidence-aware system prompt
    const { confidenceThreshold = 0.6, sessionHistory } = req.body;
    const confSystem = (system || "You are a helpful support assistant. Answer concisely and helpfully.") +
      "\n\nIMPORTANT: After your answer, on a new line write exactly: CONFIDENCE:[0.0-1.0] where the number reflects how confident you are in your answer (1.0 = certain, 0.5 = unsure, 0.0 = no idea). If confidence is below 0.6, end with: SUGGEST_HUMAN:true";

    // Include session history for conversation memory (last 6 turns from prior sessions)
    const fullMessages = sessionHistory && Array.isArray(sessionHistory)
      ? [...sessionHistory.slice(-6), ...messages]
      : messages;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 700,
        system: confSystem,
        messages: fullMessages.map(m => ({ role: m.role === "visitor" || m.role === "user" ? "user" : "assistant", content: m.content || m.text || "" })),
      }),
    });
    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: "Anthropic API error", detail: err });
    }
    const data = await response.json();
    let rawReply = data.content?.[0]?.text || "";

    // Parse confidence score and suggestion flag
    const confMatch = rawReply.match(/CONFIDENCE:\s*([\d.]+)/);
    const confidence = confMatch ? parseFloat(confMatch[1]) : 1.0;
    const suggestHuman = rawReply.includes("SUGGEST_HUMAN:true") || confidence < confidenceThreshold;

    // Strip the confidence annotation from the reply
    const reply = rawReply
      .replace(/\nCONFIDENCE:[\d.]+/g, "")
      .replace(/\nSUGGEST_HUMAN:(true|false)/g, "")
      .trim();

    if (conversationId) {
      try {
        await sql`INSERT INTO messages (conversation_id, type, sender, content) VALUES (${conversationId}, 'bot', 'AI', ${reply})`;
        await sql`UPDATE conversations SET updated_at = NOW() WHERE id = ${conversationId}`;
      } catch (_) {}
    }

    res.json({ reply, confidence, suggest_human: suggestHuman });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ─────────────────────────────────────────────
// TENANT CONFIG  — stores chatbot config so widget.js can fetch it
// POST /api/tenant-config        { tenantId, ...config }
// GET  /api/tenant-config/:id
// ─────────────────────────────────────────────

app.post("/api/tenant-config", async (req, res) => {
  const { tenantId, ...config } = req.body;
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  try {
    // Look up org to get the canonical UUID
    const orgs = await sql`SELECT id FROM organisations WHERE tenant_id = ${tenantId} LIMIT 1`;
    const orgId = orgs.length ? orgs[0].id : tenantId;
    // Deep-merge with existing config
    const existing = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${orgId} LIMIT 1`;
    const merged = existing.length ? { ...existing[0].config, ...config } : config;
    await sql`
      INSERT INTO tenant_configs (tenant_id, config)
      VALUES (${orgId}, ${JSON.stringify(merged)})
      ON CONFLICT (tenant_id) DO UPDATE SET config = ${JSON.stringify(merged)}
    `;
    res.json({ ok: true, tenantId: orgId });
  } catch (err) {
    console.error("POST /api/tenant-config error:", err.message);
    res.status(500).json({ error: "Failed to save config" });
  }
});

app.get("/api/tenant-config/:tenantId", async (req, res) => {
  const { tenantId } = req.params;
  try {
    const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${tenantId} LIMIT 1`;
    if (!rows.length) return res.json({});
    res.json(rows[0].config);
  } catch (err) {
    console.error("GET /api/tenant-config error:", err.message);
    res.status(500).json({ error: "Failed to load config" });
  }
});

// ─────────────────────────────────────────────
// ADMIN SETTINGS — super admin profile + platform config + github config
// Stored under tenant_id = 'platform' in tenant_configs
// GET  /api/admin-settings
// POST /api/admin-settings  { profile, platform, github }
// ─────────────────────────────────────────────
app.get("/api/admin-settings", async (req, res) => {
  try {
    const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`;
    if (!rows.length) return res.json({});
    const cfg = rows[0].config || {};
    res.json({
      profile:     cfg._adminProfile   || {},
      platform:    cfg._platformConfig || {},
      github:      cfg._githubConfig   || {},
      superConfig: cfg._superConfig    || {},
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin-settings", async (req, res) => {
  const { profile, platform, github, superConfig } = req.body;
  try {
    const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`;
    const existing = rows.length ? (rows[0].config || {}) : {};
    const merged = {
      ...existing,
      ...(profile     ? { _adminProfile:   profile     } : {}),
      ...(platform    ? { _platformConfig: platform    } : {}),
      ...(github      ? { _githubConfig:   github      } : {}),
      ...(superConfig ? { _superConfig:    superConfig } : {}),
    };
    await sql`
      INSERT INTO tenant_configs (tenant_id, config)
      VALUES ('platform', ${JSON.stringify(merged)})
      ON CONFLICT (tenant_id) DO UPDATE SET config = ${JSON.stringify(merged)}
    `;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// FETCH URL  — server-side fetch for KB URL import (avoids CORS)
// POST /api/fetch-url   { url }
// ─────────────────────────────────────────────
app.post("/api/fetch-url", async (req, res) => {
  const { url } = req.body;
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return res.status(400).json({ error: "Valid URL required" });
  }
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "HindleBot/1.0 (KB Importer)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return res.status(502).json({ error: `Remote returned ${r.status}` });
    const html = await r.text();
    // Strip HTML tags to extract readable text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 20000);
    res.json({ text, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// ORGANISATIONS (TENANTS)
// ─────────────────────────────────────────────
app.get("/api/tenants", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM organisations ORDER BY created_at DESC`;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/tenants/:id", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM organisations WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/tenants", async (req, res) => {
  const { name, email, plan = "free" } = req.body;
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  try {
    const rows = await sql`
      INSERT INTO organisations (name, email, plan)
      VALUES (${name}, ${email}, ${plan})
      RETURNING *
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/tenants/:id", async (req, res) => {
  const { name, email, plan, status } = req.body;
  try {
    const rows = await sql`
      UPDATE organisations SET
        name   = COALESCE(${name},   name),
        email  = COALESCE(${email},  email),
        plan   = COALESCE(${plan},   plan),
        status = COALESCE(${status}, status)
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/tenants/:id", async (req, res) => {
  try {
    await sql`DELETE FROM organisations WHERE id = ${req.params.id}`;
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// AGENTS
// ─────────────────────────────────────────────
app.get("/api/agents", async (req, res) => {
  try {
    const { org_id } = req.query;
    const rows = org_id
      ? await sql`SELECT * FROM agents WHERE org_id = ${org_id} ORDER BY name`
      : await sql`SELECT * FROM agents ORDER BY name`;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/agents/:id", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM agents WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/agents", async (req, res) => {
  const { org_id, name, email, mobile, role = "agent", sms_alerts = true } = req.body;
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  // Plan enforcement
  if (org_id) {
    const limitErr = await checkAgentLimit(org_id);
    if (limitErr) return res.status(403).json(limitErr);
  }
  const doInsert = async () => sql`
    INSERT INTO agents (org_id, name, email, mobile, role, sms_alerts)
    VALUES (${org_id}, ${name}, ${email}, ${mobile || null}, ${role}, ${sms_alerts})
    RETURNING *
  `;
  try {
    const rows = await doInsert();
    res.status(201).json(rows[0]);
  } catch (e) {
    const msg = e.message || "";
    // Duplicate email — return existing agent so invite can still send credentials
    if (msg.includes("duplicate") || msg.includes("unique") || msg.includes("already exists")) {
      try {
        const existing = await sql`SELECT * FROM agents WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
        if (existing.length) {
          // Update org_id if it was missing
          if (!existing[0].org_id && org_id) {
            await sql`UPDATE agents SET org_id = ${org_id} WHERE id = ${existing[0].id}`;
          }
          return res.status(201).json({ ...existing[0], _existed: true });
        }
      } catch (_) {}
      return res.status(409).json({ error: "An agent with that email already exists." });
    }
    // Missing columns — auto-migrate and retry
    if (msg.includes("column") || msg.includes("does not exist")) {
      try {
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS sms_alerts BOOLEAN DEFAULT true`;
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS password_hash TEXT`;
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false`;
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS magic_token TEXT`;
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS magic_token_at TIMESTAMPTZ`;
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`;
        const rows = await doInsert();
        return res.status(201).json(rows[0]);
      } catch (e2) { return res.status(500).json({ error: e2.message }); }
    }
    res.status(500).json({ error: msg || "Failed to create agent" });
  }
});

app.patch("/api/agents/:id", async (req, res) => {
  const { name, email, mobile, role, status, sms_alerts } = req.body;
  try {
    const rows = await sql`
      UPDATE agents SET
        name       = COALESCE(${name},       name),
        email      = COALESCE(${email},      email),
        mobile     = COALESCE(${mobile},     mobile),
        role       = COALESCE(${role},       role),
        status     = COALESCE(${status},     status),
        sms_alerts = COALESCE(${sms_alerts}, sms_alerts)
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/agents/:id", async (req, res) => {
  try {
    await sql`DELETE FROM agents WHERE id = ${req.params.id}`;
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agents/:id/password
app.post("/api/agents/:id/password", async (req, res) => {
  const { password } = req.body;
  if (!password || !password.trim()) return res.status(400).json({ error: "password required" });
  try {
    await sql`UPDATE agents SET password_hash = ${password.trim()}, must_change_password = false WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/invite-agent — create login credentials and notify agent via SMS
app.post("/api/invite-agent", async (req, res) => {
  const { tenantId, name, email, mobile } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  try {
    // Generate a readable temp password
    const adjectives = ["Blue","Fast","Bright","Clear","Bold","Swift","Sharp","Clean"];
    const nouns      = ["Eagle","River","Storm","Cloud","Stone","Ridge","Flame","Coast"];
    const tempPassword =
      adjectives[Math.floor(Math.random()*adjectives.length)] +
      nouns[Math.floor(Math.random()*nouns.length)] +
      Math.floor(Math.random()*900+100);

    // Set the password on the agent record so they can log in immediately
    await sql`
      UPDATE agents
      SET password_hash = ${tempPassword}, must_change_password = true
      WHERE LOWER(email) = LOWER(${email})
    `;

    // If no mobile, return password for manual sharing
    if (!mobile) {
      return res.json({ ok: false, passwordSet: true, tempPassword, sendErr: "No mobile number provided" });
    }

    // Load ClickSend creds (tenant first, then platform fallback)
    let cs = {};
    for (const tid of [tenantId, "platform"]) {
      if (!tid) continue;
      const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${tid} LIMIT 1`;
      if (rows.length && rows[0].config?.clicksend?.username) { cs = rows[0].config.clicksend; break; }
    }

    if (!cs.username || !cs.apiKey) {
      return res.json({ ok: false, passwordSet: true, tempPassword, sendErr: "ClickSend not configured" });
    }

    const loginUrl = "https://chatbot.hindleconsultants.com";
    const smsBody  = `Hi ${name || "there"}, you're invited to Hindle AI. Login: ${loginUrl} Email: ${email} Password: ${tempPassword} (change after first login)`;
    const auth     = "Basic " + Buffer.from(cs.username + ":" + cs.apiKey).toString("base64");

    let sent = false;
    let sendErr = null;
    try {
      const r = await fetch("https://rest.clicksend.com/v3/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({
          messages: [{ source: "sdk", to: mobile, from: (cs.smsSender || "HINDLE").substring(0, 11), body: smsBody, schedule: 0 }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      const d = await r.json();
      sent = d?.data?.messages?.[0]?.status === "SUCCESS";
      if (!sent) sendErr = d?.data?.messages?.[0]?.status || JSON.stringify(d).substring(0, 120);
    } catch (fetchErr) {
      sendErr = fetchErr.message;
    }

    res.json({ ok: sent, passwordSet: true, tempPassword, sendErr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// CONVERSATIONS
// ─────────────────────────────────────────────
app.get("/api/conversations", async (req, res) => {
  try {
    const { org_id, status } = req.query;
    let rows;
    if (org_id && status) {
      rows = await sql`
        SELECT c.*, a.name as agent_name FROM conversations c
        LEFT JOIN agents a ON c.assigned_agent_id = a.id
        WHERE (c.org_id::text = ${org_id} OR c.org_id::text = (SELECT id::text FROM organisations WHERE id::text = ${org_id} OR tenant_id = ${org_id} LIMIT 1))
          AND c.status = ${status}
        ORDER BY c.updated_at DESC
      `;
    } else if (org_id) {
      rows = await sql`
        SELECT c.*, a.name as agent_name FROM conversations c
        LEFT JOIN agents a ON c.assigned_agent_id = a.id
        WHERE c.org_id::text = ${org_id}
           OR c.org_id::text = (SELECT id::text FROM organisations WHERE id::text = ${org_id} OR tenant_id = ${org_id} LIMIT 1)
        ORDER BY c.updated_at DESC
      `;
    } else {
      rows = await sql`
        SELECT c.*, a.name as agent_name FROM conversations c
        LEFT JOIN agents a ON c.assigned_agent_id = a.id
        ORDER BY c.updated_at DESC
        LIMIT 500
      `;
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/conversations/:id", async (req, res) => {
  try {
    const rows = await sql`
      SELECT c.*, a.name as agent_name FROM conversations c
      LEFT JOIN agents a ON c.assigned_agent_id = a.id
      WHERE c.id = ${req.params.id}
    `;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/conversations", async (req, res) => {
  const { org_id, tenant_id, visitor_name, visitor_email, visitor_phone, visitor_company, visitor_location, page, subject, status } = req.body;
  // Resolve org_id: widget sends tenant_id (= organisations.id UUID), dashboard sends org_id
  let resolvedOrgId = org_id || null;
  if (!resolvedOrgId && tenant_id) {
    // tenant_id IS the org UUID — verify it exists
    try {
      const orgs = await sql`SELECT id FROM organisations WHERE id::text = ${tenant_id} OR tenant_id = ${tenant_id} LIMIT 1`;
      if (orgs.length) resolvedOrgId = orgs[0].id;
    } catch (_) {}
    if (!resolvedOrgId) resolvedOrgId = tenant_id;
  }
  // Plan enforcement — only block if we can resolve the org
  if (resolvedOrgId) {
    const limitErr = await checkConvoLimit(resolvedOrgId);
    if (limitErr) return res.status(403).json(limitErr);
  }
  try {
    const rows = await sql`
      INSERT INTO conversations (org_id, visitor_name, visitor_email, visitor_phone, visitor_company, visitor_location, page, subject, status)
      VALUES (${resolvedOrgId}, ${visitor_name || 'Website Visitor'}, ${visitor_email || null}, ${visitor_phone || null}, ${visitor_company || null}, ${visitor_location || null}, ${page || '/'}, ${subject || 'Chat'}, ${status || 'open'})
      RETURNING *
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    // Auto-add missing columns and retry
    if (e.message && (e.message.includes("column") || e.message.includes("does not exist"))) {
      try {
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visitor_phone TEXT`;
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visitor_company TEXT`;
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visitor_location TEXT`;
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS subject TEXT`;
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open'`;
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS claimed_by_id TEXT`;
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS claimed_by_name TEXT`;
        const rows = await sql`
          INSERT INTO conversations (org_id, visitor_name, visitor_email, page, status)
          VALUES (${resolvedOrgId}, ${visitor_name || 'Website Visitor'}, ${visitor_email || null}, ${page || '/'}, ${status || 'open'})
          RETURNING *
        `;
        return res.status(201).json(rows[0]);
      } catch (e2) { return res.status(500).json({ error: e2.message }); }
    }
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/conversations/:id", async (req, res) => {
  const { status, assigned_agent_id, claimed_by_id, claimed_by_name,
          visitor_name, visitor_email, visitor_phone, visitor_company, visitor_location } = req.body;
  try {
    const rows = await sql`
      UPDATE conversations SET
        status            = COALESCE(${status},            status),
        assigned_agent_id = COALESCE(${assigned_agent_id}, assigned_agent_id),
        claimed_by_id     = ${claimed_by_id    !== undefined ? claimed_by_id    : null},
        claimed_by_name   = ${claimed_by_name  !== undefined ? claimed_by_name  : null},
        visitor_name      = COALESCE(${visitor_name},      visitor_name),
        visitor_email     = COALESCE(${visitor_email},     visitor_email),
        visitor_phone     = COALESCE(${visitor_phone},     visitor_phone),
        visitor_company   = COALESCE(${visitor_company},   visitor_company),
        visitor_location  = COALESCE(${visitor_location},  visitor_location),
        updated_at        = NOW()
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    // Auto-add missing columns and retry with minimal update
    if (e.message && (e.message.includes("claimed_by") || e.message.includes("visitor_email") || e.message.includes("column"))) {
      try {
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS claimed_by_id TEXT`;
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS claimed_by_name TEXT`;
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visitor_email TEXT`;
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visitor_name TEXT`;
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visitor_phone TEXT`;
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visitor_company TEXT`;
        await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visitor_location TEXT`;
        const rows = await sql`
          UPDATE conversations SET
            status            = COALESCE(${status},            status),
            assigned_agent_id = COALESCE(${assigned_agent_id}, assigned_agent_id),
            claimed_by_id     = ${claimed_by_id   !== undefined ? claimed_by_id   : null},
            claimed_by_name   = ${claimed_by_name !== undefined ? claimed_by_name : null},
            updated_at        = NOW()
          WHERE id = ${req.params.id}
          RETURNING *
        `;
        if (!rows.length) return res.status(404).json({ error: "Not found" });
        return res.json(rows[0]);
      } catch (e2) { return res.status(500).json({ error: e2.message }); }
    }
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/conversations/:id", async (req, res) => {
  try {
    await sql`DELETE FROM conversations WHERE id = ${req.params.id}`;
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────
app.get("/api/conversations/:id/messages", async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM messages
      WHERE conversation_id = ${req.params.id}
      ORDER BY created_at ASC
    `;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/conversations/:id/messages", async (req, res) => {
  const { type, sender, content } = req.body;
  if (!type || !content) return res.status(400).json({ error: "type and content required" });
  try {
    const rows = await sql`
      INSERT INTO messages (conversation_id, type, sender, content)
      VALUES (${req.params.id}, ${type}, ${sender}, ${content})
      RETURNING *
    `;
    await sql`UPDATE conversations SET updated_at = NOW() WHERE id = ${req.params.id}`;
    // Track first agent response time (only set once, on first agent message)
    if (type === "agent") {
      await sql`
        UPDATE conversations SET first_response_at = NOW()
        WHERE id = ${req.params.id} AND first_response_at IS NULL
      `.catch(() => {});
    }
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// ALERT LOG
// ─────────────────────────────────────────────
app.get("/api/alert-log", async (req, res) => {
  try {
    const { org_id } = req.query;
    const rows = org_id
      ? await sql`SELECT * FROM alert_log WHERE org_id = ${org_id} ORDER BY created_at DESC`
      : await sql`SELECT * FROM alert_log ORDER BY created_at DESC`;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/alert-log", async (req, res) => {
  const { org_id, conversation_id, agent_name, mobile, visitor_name, page, token } = req.body;
  try {
    const rows = await sql`
      INSERT INTO alert_log (org_id, conversation_id, agent_name, mobile, visitor_name, page, token)
      VALUES (${org_id}, ${conversation_id}, ${agent_name}, ${mobile}, ${visitor_name}, ${page}, ${token})
      RETURNING *
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/alert-log/:id", async (req, res) => {
  const { status } = req.body;
  try {
    const rows = await sql`
      UPDATE alert_log SET status = ${status} WHERE id = ${req.params.id} RETURNING *
    `;
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// KNOWLEDGE BASE
// ─────────────────────────────────────────────
app.get("/api/kb", async (req, res) => {
  try {
    const { org_id } = req.query;
    const rows = org_id
      ? await sql`SELECT * FROM kb_documents WHERE org_id = ${org_id} ORDER BY created_at DESC`
      : await sql`SELECT * FROM kb_documents ORDER BY created_at DESC`;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/kb", async (req, res) => {
  const { org_id, name, category, sub_category, size_kb, chunks } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  // Plan enforcement
  if (org_id) {
    const limitErr = await checkKbLimit(org_id);
    if (limitErr) return res.status(403).json(limitErr);
  }
  try {
    const rows = await sql`
      INSERT INTO kb_documents (org_id, name, category, sub_category, size_kb, chunks)
      VALUES (${org_id}, ${name}, ${category}, ${sub_category}, ${size_kb}, ${chunks || 0})
      RETURNING *
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/kb/:id", async (req, res) => {
  const { name, category, sub_category, chunks, status } = req.body;
  try {
    const rows = await sql`
      UPDATE kb_documents SET
        name         = COALESCE(${name},         name),
        category     = COALESCE(${category},     category),
        sub_category = COALESCE(${sub_category}, sub_category),
        chunks       = COALESCE(${chunks},       chunks),
        status       = COALESCE(${status},       status),
        updated_at   = NOW()
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/kb/:id", async (req, res) => {
  try {
    await sql`DELETE FROM kb_documents WHERE id = ${req.params.id}`;
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ─────────────────────────────────────────────
// AUTH  — tenant admin login
// POST /api/auth  { email, password }
// Returns { ok, org_id, role, email, name }
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// UNIFIED AUTH — checks organisations (tenant admins) then agents
// POST /api/auth  { email, password }
// ─────────────────────────────────────────────
app.post("/api/auth", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: "email and password required" });

  // 1. Try tenant admin (organisations table)
  try {
    const rows = await sql`SELECT * FROM organisations WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1`;
    if (rows.length) {
      const org = rows[0];
      let storedPass = "admin";
      try {
        const cfg = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${org.id} LIMIT 1`;
        if (cfg.length && cfg[0].config?.admin_password) storedPass = cfg[0].config.admin_password;
      } catch (_) {}
      if (password !== storedPass) return res.status(401).json({ ok: false, error: "Incorrect password." });
      return res.json({ ok: true, org_id: org.id, role: "tenant_admin", email: org.email, name: org.name, plan: org.plan });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  // 2. Try agent (agents table)
  try {
    const rows = await sql`SELECT * FROM agents WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1`;
    if (!rows.length) return res.status(401).json({ ok: false, error: "No account found for that email address." });
    const agent = rows[0];
    if (agent.active === false) return res.status(403).json({ ok: false, error: "Account is disabled." });
    if (!agent.password_hash) return res.status(401).json({ ok: false, error: "No password set. Contact your administrator." });
    if (agent.password_hash !== password) return res.status(401).json({ ok: false, error: "Incorrect password." });
    let orgId = agent.org_id || null;
    if (!orgId) {
      try {
        const orgs = await sql`SELECT id FROM organisations LIMIT 1`;
        if (orgs.length) { orgId = orgs[0].id; await sql`UPDATE agents SET org_id = ${orgId} WHERE id = ${agent.id}`; }
      } catch (_) {}
    }
    return res.json({ ok: true, id: agent.id, org_id: orgId, role: agent.role || "agent", email: agent.email, name: agent.name, mustChangePassword: agent.must_change_password || false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────
// SMS TEST  — send a test SMS via ClickSend
// POST /api/sms-test  { username, apiKey, to, sender } OR { tenantId, to }
// ─────────────────────────────────────────────
app.post("/api/sms-test", async (req, res) => {
  let { username, apiKey, to, sender, tenantId } = req.body;
  // If tenantId supplied, load credentials from DB
  if (tenantId && (!username || !apiKey)) {
    try {
      // Try own tenant config first, then platform fallback
      for (const tid of [tenantId, "platform"]) {
        const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${tid} LIMIT 1`;
        if (rows.length && rows[0].config?.clicksend?.username) {
          username = rows[0].config.clicksend.username;
          apiKey   = rows[0].config.clicksend.apiKey;
          sender   = sender || rows[0].config.clicksend.smsSender || "HINDLE";
          break;
        }
      }
    } catch (_) {}
  }
  if (!username || !apiKey) return res.status(400).json({ ok: false, error: "ClickSend credentials not configured" });
  if (!to) return res.status(400).json({ ok: false, error: "to (phone number) required" });
  try {
    const body = { messages: [{ source: "sdk", body: "This is a test message from Hindle Consultants. If you received this, SMS is working.", to, from: sender || "HINDLE" }] };
    const r = await fetch("https://rest.clicksend.com/v3/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${username}:${apiKey}`).toString("base64") },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.response_code === "SUCCESS" || d.data?.messages?.[0]?.status === "SUCCESS") {
      res.json({ ok: true, detail: d });
    } else {
      res.status(400).json({ ok: false, error: d.response_msg || "ClickSend returned an error", detail: d });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────
// HANDOFF TOKEN  — resolve a magic link token
// GET /api/handoff-token/:token
// Returns { ok, org_id, conversation_id, agent: { name, email, mobile } }
// Marks token clicked on first use; returns 410 if expired (>5 min)
// ─────────────────────────────────────────────
app.get("/api/handoff-token/:token", async (req, res) => {
  const { token } = req.params;
  try {
    const rows = await sql`SELECT * FROM alert_log WHERE token = ${token} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ ok: false, error: "Token not found" });
    const row = rows[0];
    // Check expiry — 3 minutes
    const age = Date.now() - new Date(row.created_at).getTime();
    if (age > 3 * 60 * 1000) {
      await sql`UPDATE alert_log SET status = 'expired' WHERE id = ${row.id}`;
      return res.status(410).json({ ok: false, error: "This link has expired (3-minute limit)." });
    }
    // Mark clicked (first use only)
    if (row.status !== "clicked") {
      await sql`UPDATE alert_log SET status = 'clicked' WHERE id = ${row.id}`;
    }
    // Look up agent details if possible
    let agent = { name: row.agent_name, mobile: row.mobile, email: null };
    try {
      const agt = await sql`SELECT * FROM agents WHERE mobile = ${row.mobile} LIMIT 1`;
      if (agt.length) agent = { name: agt[0].name, email: agt[0].email, mobile: agt[0].mobile };
    } catch (_) {}
    res.json({ ok: true, org_id: row.org_id, conversation_id: row.conversation_id, agent });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/handoff  — visitor-initiated handoff + ClickSend SMS
// ─────────────────────────────────────────────
app.post("/api/handoff", async (req, res) => {
  const {
    tenantId,
    conversationId: existingConvId,
    visitorEmail,
    visitorName,
    visitorPhone,
    visitorCompany,
    page,
    history,
  } = req.body;

  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  // ── Load tenant config (with platform fallback for ClickSend creds) ──
  let tenantConfig = {};
  try {
    const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${tenantId} LIMIT 1`;
    if (rows.length) tenantConfig = rows[0].config;
  } catch (e) {}

  if (!tenantConfig?.clicksend?.username) {
    try {
      let pCfg = {};
      const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform'`;
      if (rows.length) pCfg = rows[0].config;
      if (pCfg?.clicksend?.username) {
        // Platform creds as base — only override with tenant values that are actually set
        const tCs = tenantConfig.clicksend || {};
        tenantConfig = { ...tenantConfig, clicksend: {
          ...pCfg.clicksend,
          ...(tCs.username ? { username: tCs.username } : {}),
          ...(tCs.apiKey   ? { apiKey:   tCs.apiKey   } : {}),
          ...(tCs.smsSender? { smsSender:tCs.smsSender} : {}),
        }};
      }
    } catch (e) {}
  }

  if (!tenantConfig?.clicksend?.username) {
    try {
      const rows = await sql`SELECT config FROM tenant_configs WHERE (config->'clicksend'->>'username') IS NOT NULL AND (config->'clicksend'->>'username') != '' LIMIT 1`;
      if (rows.length && rows[0].config?.clicksend?.username) {
        tenantConfig = { ...tenantConfig, clicksend: rows[0].config.clicksend };
      }
    } catch (e) {}
  }

  const cs         = tenantConfig.clicksend || {};
  const smsSender  = (cs.smsSender || "HINDLE").substring(0, 11);
  const visitorLabel = visitorName || visitorEmail || "A visitor";

  // ── Resolve org UUID ──────────────────────────────────────────────────
  let resolvedOrgId = null;
  try {
    const orgs = await sql`SELECT id FROM organisations WHERE tenant_id = ${tenantId} OR id::text = ${tenantId} LIMIT 1`;
    if (orgs.length) resolvedOrgId = orgs[0].id;
  } catch (e) {}

  // ── Load agents from DB ───────────────────────────────────────────────
  let agentsList = [];
  try {
    if (resolvedOrgId) {
      agentsList = await sql`SELECT * FROM agents WHERE org_id = ${resolvedOrgId} AND active != false`;
    }
  } catch (e) {}

  // ── Upsert conversation ───────────────────────────────────────────────
  let conversationId = existingConvId || null;
  try {
    if (!conversationId && resolvedOrgId) {
      const convRows = await sql`
        INSERT INTO conversations (org_id, visitor_name, visitor_email, page, status)
        VALUES (${resolvedOrgId}, ${visitorLabel}, ${visitorEmail || null}, ${page || "/"}, 'handoff')
        RETURNING id
      `;
      conversationId = convRows[0]?.id;
    } else if (conversationId) {
      await sql`UPDATE conversations SET status = 'handoff', updated_at = NOW() WHERE id = ${conversationId}`;
    }
  } catch (e) {}

  // ── Build magic link ──────────────────────────────────────────────────
  const handoffToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const magicUrl = `https://chatbot.hindleconsultants.com/?token=${handoffToken}`;

  // ── Log alert ─────────────────────────────────────────────────────────
  try {
    await sql`
      INSERT INTO alert_log (org_id, conversation_id, agent_name, mobile, visitor_name, page, token)
      VALUES (${resolvedOrgId}, ${conversationId || null}, ${"Widget Handoff"}, ${"—"}, ${visitorLabel}, ${page || "/"}, ${handoffToken})
    `;
  } catch (e) {}

  // ── Send SMS via ClickSend ────────────────────────────────────────────
  let smsSent = false, smsError = null, smsTargets = 0;

  if (cs.username && cs.apiKey) {
    const targets = agentsList.filter(a => a.mobile && a.sms_alerts !== false && a.active !== false);
    smsTargets = targets.length;
    if (targets.length) {
      try {
        const auth    = "Basic " + Buffer.from(cs.username + ":" + cs.apiKey).toString("base64");
        const smsBody = "[" + smsSender + "] " + visitorLabel + " on " + (page || "/") + " wants to chat. Join: " + magicUrl;
        const msgs    = targets.map(a => ({ source: "sdk", to: a.mobile, from: smsSender, body: smsBody, schedule: 0 }));
        const r = await fetch("https://rest.clicksend.com/v3/sms/send", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ messages: msgs }),
          signal: AbortSignal.timeout(8000),
        });
        const d = await r.json();
        smsSent  = d?.data?.messages?.every(m => m.status === "SUCCESS");
        smsError = smsSent ? null : (d?.data?.messages?.[0]?.status || "Send failed");
        try { await sql`UPDATE alert_log SET status = ${smsSent ? "sent" : "failed"} WHERE token = ${handoffToken}`; } catch (_) {}
      } catch (e) { smsError = e.message; }
    } else {
      smsError = "No agents with mobile + SMS alerts enabled";
    }
  } else {
    smsError = "ClickSend credentials not configured";
  }

  res.json({
    ok: true, smsSent, smsTargets, smsError, token: handoffToken, conversationId,
    message: smsSent ? "SMS sent to " + smsTargets + " agent(s)" : "Handoff logged — " + (smsError || "SMS not configured"),
  });
});

// ─────────────────────────────────────────────
// GET /api/handoff-token/:token  — magic link verification
// ─────────────────────────────────────────────
app.get("/api/handoff-token/:token", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM alert_log WHERE token = ${req.params.token} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: "Invalid or expired link" });
    const row = rows[0];
    // Check expiry (3 minutes)
    const age = Date.now() - new Date(row.created_at).getTime();
    if (age > 3 * 60 * 1000) {
      try { await sql`UPDATE alert_log SET status = 'expired' WHERE token = ${req.params.token}`; } catch (_) {}
      return res.status(410).json({ error: "Link expired", expired: true });
    }
    if (row.status === "expired") return res.status(410).json({ error: "Link expired", expired: true });
    // Mark clicked
    try { await sql`UPDATE alert_log SET status = 'clicked' WHERE token = ${req.params.token}`; } catch (_) {}
    const orgs   = await sql`SELECT * FROM organisations WHERE id = ${row.org_id} LIMIT 1`;
    const agents = await sql`SELECT * FROM agents WHERE org_id = ${row.org_id} AND role = 'tenant_admin' LIMIT 1`;
    res.json({ ok: true, token: row.token, org_id: row.org_id, conversation_id: row.conversation_id,
               visitor_name: row.visitor_name, page: row.page, org: orgs[0] || null, agent: agents[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// GET /api/org-by-email/:email
// ─────────────────────────────────────────────
app.get("/api/org-by-email/:email", async (req, res) => {
  try {
    const agents = await sql`SELECT * FROM agents WHERE LOWER(email) = LOWER(${req.params.email}) LIMIT 1`;
    if (agents.length && agents[0].org_id) {
      const orgs = await sql`SELECT * FROM organisations WHERE id = ${agents[0].org_id} LIMIT 1`;
      if (orgs.length) return res.json(orgs[0]);
    }
    const orgs = await sql`SELECT * FROM organisations WHERE LOWER(email) = LOWER(${req.params.email}) LIMIT 1`;
    if (orgs.length) return res.json(orgs[0]);
    const allOrgs = await sql`SELECT * FROM organisations ORDER BY created_at LIMIT 1`;
    if (allOrgs.length) return res.json(allOrgs[0]);
    return res.status(404).json({ error: "not found" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────
app.post("/api/auth/check-email", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  try {
    const rows = await sql`SELECT id, name, email, role, password_hash, org_id FROM agents WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: "no_account" });
    const a = rows[0];
    res.json({ exists: true, hasPassword: !!a.password_hash, name: a.name, role: a.role, org_id: a.org_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/magic-link", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  try {
    const rows = await sql`SELECT * FROM agents WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: "no_account" });
    const agent = rows[0];
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    // Store the token (reuse alert_log or a dedicated table — using a temp JSON in tenant_configs)
    // Simple approach: store in agent record temporarily
    await sql`UPDATE agents SET magic_token = ${token}, magic_token_at = NOW() WHERE id = ${agent.id}`;
    const link = `https://chatbot.hindleconsultants.com/?magic=${token}`;
    // In production send via email — for now return it (dev mode)
    res.json({ ok: true, link, message: "Magic link generated (send via email in production)" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/magic-verify", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token required" });
  try {
    const rows = await sql`SELECT * FROM agents WHERE magic_token = ${token} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: "invalid_token" });
    const agent = rows[0];
    const age = Date.now() - new Date(agent.magic_token_at || 0).getTime();
    if (age > 30 * 60 * 1000) return res.status(410).json({ error: "token_expired" });
    await sql`UPDATE agents SET magic_token = NULL, magic_token_at = NULL WHERE id = ${agent.id}`;
    let orgId = agent.org_id;
    if (!orgId) {
      try {
        const orgs = await sql`SELECT id FROM organisations WHERE LOWER(email) = LOWER(${agent.email}) LIMIT 1`;
        if (orgs.length) orgId = orgs[0].id;
      } catch (_) {}
    }
    res.json({ ok: true, id: agent.id, name: agent.name, email: agent.email, role: agent.role || "agent", org_id: orgId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/set-password", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  try {
    const rows = await sql`UPDATE agents SET password_hash = ${password}, must_change_password = false WHERE LOWER(email) = LOWER(${email}) RETURNING id, name, email, role`;
    if (!rows.length) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, ...rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// POST /api/sms-test  — test ClickSend credentials
// ─────────────────────────────────────────────
app.post("/api/sms-test", async (req, res) => {
  const { username, apiKey, to, sender } = req.body;
  if (!username || !apiKey || !to) return res.status(400).json({ error: "username, apiKey, and to are required" });
  try {
    const auth = "Basic " + Buffer.from(username + ":" + apiKey).toString("base64");
    const from = (sender || "HINDLE").substring(0, 11);
    const r = await fetch("https://rest.clicksend.com/v3/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ messages: [{ source: "sdk", to, from, body: "Hindle SMS test — your ClickSend integration is working correctly.", schedule: 0 }] }),
      signal: AbortSignal.timeout(8000),
    });
    const d = await r.json();
    const ok = d?.data?.messages?.[0]?.status === "SUCCESS";
    res.json({ ok, status: d?.data?.messages?.[0]?.status || "unknown", raw: d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────
async function ensureAuditTable() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS audit_log (
        id          BIGSERIAL PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        description TEXT,
        meta        JSONB,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS audit_log_tenant_idx ON audit_log (tenant_id, created_at DESC)`;
  } catch (_) {}
}
async function writeAudit(tenantId, eventType, description, meta) {
  try {
    await sql`
      INSERT INTO audit_log (tenant_id, event_type, description, meta)
      VALUES (${tenantId}, ${eventType}, ${description || null}, ${meta ? JSON.stringify(meta) : null})
    `;
  } catch (_) {}
}
ensureAuditTable();

app.get("/api/audit-log/:tenantId", async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM audit_log WHERE tenant_id = ${req.params.tenantId}
      ORDER BY created_at DESC LIMIT 200
    `;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/audit-log", async (req, res) => {
  // Super admin — all tenants
  try {
    const rows = await sql`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/audit-log", async (req, res) => {
  const { tenantId, eventType, description, meta } = req.body;
  if (!tenantId || !eventType) return res.status(400).json({ error: "tenantId and eventType required" });
  try {
    await writeAudit(tenantId, eventType, description, meta);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// PLAN ENFORCEMENT — usage limits per plan
// ─────────────────────────────────────────────
const PLAN_LIMITS = {
  free:         { agents: 1,  conversations_month: 100,  kb_docs: 0   },
  starter:      { agents: 5,  conversations_month: 500,  kb_docs: 5   },
  professional: { agents: 10, conversations_month: 2000, kb_docs: 999 },
  enterprise:   { agents: 999,conversations_month: 999999,kb_docs: 999 },
};

// Load admin-configured plan limits from DB (overrides hardcoded defaults)
async function getAdminPlanLimits() {
  try {
    const [cfg] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`;
    return cfg?.config?._superConfig?.planLimits || null;
  } catch (_) { return null; }
}

function getEffectiveLimits(org, adminPlanLimits) {
  // Priority: per-org custom_limits > admin-configured planLimits > hardcoded PLAN_LIMITS
  const planBase = (adminPlanLimits && adminPlanLimits[org.plan]) || PLAN_LIMITS[org.plan] || PLAN_LIMITS.free;
  const custom = (org.custom_limits && typeof org.custom_limits === "object") ? org.custom_limits : {};
  return {
    agents:              custom.agents              ?? planBase.agents,
    conversations_month: custom.conversations_month ?? planBase.conversations_month,
    kb_docs:             custom.kb_docs             ?? planBase.kb_docs,
  };
}

// Ensure account_notes and custom_limits columns exist
(async()=>{
  try{
    await sql`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS account_notes TEXT`;
    await sql`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS custom_limits JSONB DEFAULT '{}'`;
  }catch(_){}
})();

// Check agent limit before creating
async function checkAgentLimit(org_id) {
  try {
    const [org] = await sql`SELECT * FROM organisations WHERE id = ${org_id} LIMIT 1`;
    if (!org) return null;
    const apl = await getAdminPlanLimits();
    const limits = getEffectiveLimits(org, apl);
    if (limits.agents >= 999) return null;
    const [count] = await sql`SELECT COUNT(*)::int as c FROM agents WHERE org_id = ${org_id}`;
    if ((count?.c || 0) >= limits.agents) {
      return { error: `Agent limit reached for ${org.plan} plan (${limits.agents} agents). Upgrade your plan to add more.`, code: "LIMIT_AGENTS" };
    }
  } catch (_) {}
  return null;
}

// Check KB doc limit before creating
async function checkKbLimit(org_id) {
  try {
    const [org] = await sql`SELECT * FROM organisations WHERE id = ${org_id} LIMIT 1`;
    if (!org) return null;
    const apl = await getAdminPlanLimits();
    const limits = getEffectiveLimits(org, apl);
    if (limits.kb_docs >= 999) return null;
    if (limits.kb_docs === 0) return { error: `Knowledge base not available on ${org.plan} plan. Upgrade to Starter or above.`, code: "LIMIT_KB" };
    const [count] = await sql`SELECT COUNT(*)::int as c FROM kb_documents WHERE org_id = ${org_id}`;
    if ((count?.c || 0) >= limits.kb_docs) {
      return { error: `KB document limit reached for ${org.plan} plan (${limits.kb_docs} docs). Upgrade your plan to add more.`, code: "LIMIT_KB" };
    }
  } catch (_) {}
  return null;
}

// Check monthly conversation limit
async function checkConvoLimit(org_id) {
  try {
    const [org] = await sql`SELECT * FROM organisations WHERE id = ${org_id} LIMIT 1`;
    if (!org) return null;
    const apl = await getAdminPlanLimits();
    const limits = getEffectiveLimits(org, apl);
    if (limits.conversations_month >= 999999) return null;
    const [count] = await sql`
      SELECT COUNT(*)::int as c FROM conversations
      WHERE org_id = ${org_id} AND created_at >= DATE_TRUNC('month', NOW())
    `;
    if ((count?.c || 0) >= limits.conversations_month) {
      return { error: `Monthly conversation limit reached for ${org.plan} plan (${limits.conversations_month}/mo). Upgrade your plan to continue.`, code: "LIMIT_CONVOS" };
    }
  } catch (_) {}
  return null;
}

app.get("/api/tenants/:id/usage", async (req, res) => {
  try {
    const [org] = await sql`SELECT * FROM organisations WHERE id = ${req.params.id}`;
    if (!org) return res.status(404).json({ error: "Not found" });
    const plan = org.plan || "free";
    const apl = await getAdminPlanLimits();
    const limits = getEffectiveLimits(org, apl);
    const planLimits = (apl && apl[plan]) || PLAN_LIMITS[plan] || PLAN_LIMITS.free; // base plan limits without custom overrides
    // Count agents
    const [agentCount] = await sql`SELECT COUNT(*)::int as count FROM agents WHERE org_id = ${org.id} AND active != false`;
    // Count conversations this calendar month
    const [convCount] = await sql`
      SELECT COUNT(*)::int as count FROM conversations
      WHERE org_id = ${org.id}
        AND created_at >= DATE_TRUNC('month', NOW())
    `;
    // Count KB docs
    const [kbCount] = await sql`SELECT COUNT(*)::int as count FROM kb_documents WHERE org_id = ${org.id}`.catch(()=>[{count:0}]);
    res.json({
      plan, limits,
      plan_limits: planLimits, // base plan limits (no custom overrides) for display
      custom_limits: org.custom_limits || {},
      account_notes: org.account_notes || "",
      usage: {
        agents: agentCount?.count || 0,
        conversations_month: convCount?.count || 0,
        kb_docs: kbCount?.count || 0,
      },
      trial_start_date: org.trial_start_date || org.created_at,
      trial_day: org.trial_day || 0,
      status: org.status || "trial",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Plan management — change plan, extend trial, suspend/reactivate
app.post("/api/tenants/:id/manage", async (req, res) => {
  const { action, plan, note, trialDays } = req.body;
  try {
    const [org] = await sql`SELECT * FROM organisations WHERE id = ${req.params.id}`;
    if (!org) return res.status(404).json({ error: "Not found" });
    let updated;
    if (action === "change_plan") {
      [updated] = await sql`UPDATE organisations SET plan = ${plan}, status = 'active', updated_at = NOW() WHERE id = ${org.id} RETURNING *`.catch(async()=>{
        await sql`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`;
        const r = await sql`UPDATE organisations SET plan = ${plan}, status = 'active' WHERE id = ${org.id} RETURNING *`;
        return r;
      });
      await writeAudit(org.id, "plan_changed", `Plan changed to ${plan}${note?": "+note:""}`, { from: org.plan, to: plan });
    } else if (action === "extend_trial") {
      const days = parseInt(trialDays) || 7;
      [updated] = await sql`UPDATE organisations SET trial_day = GREATEST(0, COALESCE(trial_day,0) - ${days}), status = 'trial' WHERE id = ${org.id} RETURNING *`.catch(async()=>{
        await sql`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS trial_day INT DEFAULT 0`;
        const r = await sql`UPDATE organisations SET trial_day = 0, status = 'trial' WHERE id = ${org.id} RETURNING *`;
        return r;
      });
      await writeAudit(org.id, "trial_extended", `Trial extended by ${days} days${note?": "+note:""}`, { days });
    } else if (action === "suspend") {
      [updated] = await sql`UPDATE organisations SET status = 'suspended' WHERE id = ${org.id} RETURNING *`;
      await writeAudit(org.id, "suspended", note || "Account suspended by admin", {});
    } else if (action === "reactivate") {
      [updated] = await sql`UPDATE organisations SET status = 'active' WHERE id = ${org.id} RETURNING *`;
      await writeAudit(org.id, "reactivated", note || "Account reactivated by admin", {});
    } else if (action === "reset_trial") {
      [updated] = await sql`UPDATE organisations SET trial_day = 0, status = 'trial', trial_start_date = NOW() WHERE id = ${org.id} RETURNING *`.catch(async()=>{
        await sql`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS trial_start_date TIMESTAMPTZ DEFAULT NOW()`;
        await sql`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS trial_day INT DEFAULT 0`;
        const r = await sql`UPDATE organisations SET trial_day = 0, status = 'trial', trial_start_date = NOW() WHERE id = ${org.id} RETURNING *`;
        return r;
      });
      await writeAudit(org.id, "trial_reset", note || "Trial reset by admin", {});
    } else if (action === "update_limits") {
      // Custom per-account limit overrides (discretionary)
      const custom = {};
      if (req.body.custom_agents     != null) custom.agents              = parseInt(req.body.custom_agents)     || null;
      if (req.body.custom_convos     != null) custom.conversations_month = parseInt(req.body.custom_convos)     || null;
      if (req.body.custom_kb         != null) custom.kb_docs             = parseInt(req.body.custom_kb)         || null;
      // Remove nulls — null means "use plan default"
      Object.keys(custom).forEach(k => { if (custom[k] == null) delete custom[k]; });
      [updated] = await sql`UPDATE organisations SET custom_limits = ${JSON.stringify(custom)} WHERE id = ${org.id} RETURNING *`
        .catch(async () => {
          await sql`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS custom_limits JSONB DEFAULT '{}'`;
          return sql`UPDATE organisations SET custom_limits = ${JSON.stringify(custom)} WHERE id = ${org.id} RETURNING *`;
        });
      await writeAudit(org.id, "limits_updated", `Custom limits updated${note ? ": " + note : ""}`, { custom });
    } else if (action === "update_notes") {
      [updated] = await sql`UPDATE organisations SET account_notes = ${req.body.notes || null} WHERE id = ${org.id} RETURNING *`
        .catch(async () => {
          await sql`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS account_notes TEXT`;
          return sql`UPDATE organisations SET account_notes = ${req.body.notes || null} WHERE id = ${org.id} RETURNING *`;
        });
      await writeAudit(org.id, "notes_updated", "Account notes updated by admin", {});
    } else {
      return res.status(400).json({ error: "Unknown action" });
    }
    res.json({ ok: true, tenant: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// TRIAL EMAIL SCHEDULER
// Runs once on startup, then every hour
// Days 12, 13, 14: sends reminder via ClickSend email
// ─────────────────────────────────────────────
async function runTrialScheduler() {
  try {
    // Ensure columns exist
    await sql`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS trial_start_date TIMESTAMPTZ`;
    // Backfill trial_start_date from created_at where null
    await sql`UPDATE organisations SET trial_start_date = created_at WHERE trial_start_date IS NULL`.catch(()=>{});
    await sql`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS trial_day INT DEFAULT 0`;
    await sql`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS trial_reminded JSONB DEFAULT '[]'`;

    // Update trial_day for all trialling orgs
    await sql`
      UPDATE organisations
      SET trial_day = EXTRACT(DAY FROM (NOW() - COALESCE(trial_start_date, created_at)))::int
      WHERE status IS NULL OR status IN ('trial', 'active')
    `.catch(()=>{});

    // Fetch orgs that need a reminder (day 12, 13, or 14) and haven't been reminded yet for that day
    const orgs = await sql`
      SELECT * FROM organisations
      WHERE (status IS NULL OR status IN ('trial'))
        AND trial_day BETWEEN 12 AND 14
    `.catch(()=>[]);

    if (!orgs.length) return;

    // Load platform ClickSend creds
    let cs = {};
    try {
      const [cfg] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`;
      if (cfg?.config?.clicksend?.username) cs = cfg.config.clicksend;
    } catch (_) {}
    if (!cs.username || !cs.apiKey) return; // no email configured

    const auth = "Basic " + Buffer.from(cs.username + ":" + cs.apiKey).toString("base64");

    for (const org of orgs) {
      const reminded = Array.isArray(org.trial_reminded) ? org.trial_reminded : [];
      const day = org.trial_day || 0;
      if (reminded.includes(day)) continue; // already sent for this day

      const daysLeft = 14 - day;
      const subject = daysLeft <= 0
        ? `Your Hindle AI trial has ended — upgrade to keep access`
        : `${daysLeft} day${daysLeft !== 1 ? "s" : ""} left on your Hindle AI trial`;

      const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
<h2 style="color:#2563EB;margin-bottom:8px">Hindle AI</h2>
<p style="color:#334155">Hi ${org.name || "there"},</p>
<p style="color:#334155">${daysLeft <= 0
  ? "Your 14-day free trial has ended. Upgrade now to continue using Hindle AI — your data and settings are saved."
  : `Your free trial ends in <strong>${daysLeft} day${daysLeft !== 1 ? "s" : ""}</strong>. Upgrade before it expires to keep your chatbot running without interruption.`
}</p>
<div style="margin:24px 0">
  <a href="https://chatbot.hindleconsultants.com" style="background:#2563EB;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">
    ${daysLeft <= 0 ? "Upgrade Now →" : "Upgrade Before Trial Ends →"}
  </a>
</div>
<p style="color:#94A3B8;font-size:12px">You received this because you have an active trial on Hindle AI. Questions? Reply to this email.</p>
</div>`;

      try {
        const r = await fetch("https://rest.clicksend.com/v3/email/send", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({
            to: [{ email: org.email, name: org.name || "Tenant" }],
            from: { email: cs.username, name: cs.smsSender || "Hindle Consultants" },
            subject,
            body: htmlBody,
          }),
          signal: AbortSignal.timeout(10000),
        });
        const d = await r.json();
        const sent = d?.response_code === "SUCCESS" || r.ok;

        // Mark this day as reminded
        const newReminded = [...reminded, day];
        await sql`UPDATE organisations SET trial_reminded = ${JSON.stringify(newReminded)} WHERE id = ${org.id}`.catch(()=>{});

        // Write to audit log
        await writeAudit(org.id, "trial_reminder_sent", `Day ${day} reminder email ${sent ? "sent" : "failed"} to ${org.email}`, {
          day, daysLeft, sent, email: org.email,
        });

        console.log(`[TrialScheduler] Day ${day} reminder ${sent ? "sent" : "FAILED"} → ${org.email}`);
      } catch (err) {
        console.warn(`[TrialScheduler] Error sending to ${org.email}:`, err.message);
        await writeAudit(org.id, "trial_reminder_failed", `Day ${day} reminder failed: ${err.message}`, { day, email: org.email });
      }
    }

    // Expire orgs past day 14
    await sql`
      UPDATE organisations SET status = 'expired'
      WHERE (status IS NULL OR status = 'trial') AND trial_day > 14
    `.catch(()=>{});

  } catch (err) {
    console.error("[TrialScheduler] Error:", err.message);
  }
}

// Run immediately on startup, then every hour
runTrialScheduler();
setInterval(runTrialScheduler, 60 * 60 * 1000);

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Hindle API running on port ${PORT}`);
});

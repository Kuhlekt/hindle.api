require("dotenv").config();
const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");

// Safe fetch using built-in https/http — avoids node-fetch ESM issues
// Follows redirects (301, 302, 307, 308) up to 5 hops
const fetch = (url, opts = {}, _redirectCount = 0) => new Promise((resolve, reject) => {
  if (_redirectCount > 5) return reject(new Error("Too many redirects"));
  const parsed = new URL(url);
  const mod = parsed.protocol === "https:" ? https : http;
  // Default browser-like headers so sites don't block as a bot
  const defaultHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-AU,en;q=0.9",
    "Accept-Encoding": "identity",
  };
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: opts.method || "GET",
    headers: { ...defaultHeaders, ...(opts.headers || {}) },
    timeout: opts.timeout || 15000,
  };
  const body = opts.body;
  if (body && !options.headers["Content-Length"]) {
    options.headers["Content-Length"] = Buffer.byteLength(body);
  }
  const req = mod.request(options, (res) => {
    // Follow redirects
    if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
      const nextUrl = res.headers.location.startsWith("http")
        ? res.headers.location
        : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
      // Drain the body to free socket
      res.resume();
      return resolve(fetch(nextUrl, {...opts, body: [301,302].includes(res.statusCode) ? undefined : opts.body, method: [301,302].includes(res.statusCode) ? "GET" : opts.method}, _redirectCount + 1));
    }
    const chunks = [];
    res.on("data", c => chunks.push(c));
    res.on("end", () => {
      const buf = Buffer.concat(chunks);
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage,
        json: () => Promise.resolve(JSON.parse(buf.toString())),
        text: () => Promise.resolve(buf.toString()),
        buffer: () => Promise.resolve(buf),
      });
    });
  });
  req.on("error", reject);
  if (body) req.write(body);
  req.end();
});

// Prevent unhandled rejections from crashing the server
process.on("unhandledRejection", (reason) => {
  console.error("[Server] Unhandled rejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[Server] Uncaught exception:", err.message);
})

// ── Email template variable substitution ─────────────────────────────────────
function renderEmailTemplate(template, vars) {
  return template
    .replace(/\{name\}/g,    vars.name    || "there")
    .replace(/\{plan\}/g,    vars.plan    || "")
    .replace(/\{amount\}/g,  vars.amount  || "")
    .replace(/\{days\}/g,    vars.days    || "")
    .replace(/\{last4\}/g,   vars.last4   || "")
    .replace(/\{expiry\}/g,  vars.expiry  || "")
    .replace(/\{month\}/g,   vars.month   || "")
    .replace(/\{company\}/g, vars.company || "");
}
// ─────────────────────────────────────────────────────────────────────────────


// ── Universal email sender ─────────────────────────────────────────────────────
// Tries tenant SMTP first, falls back to platform ClickSend.
// smtpCfg: { host, port, secure, user, pass, fromEmail, fromName }
// csCfg:   { username, apiKey, emailAddressId, emailName }
async function sendEmail({ to, toName, subject, body, smtpCfg, csCfg }) {
  // ── Path 1: Tenant SMTP via nodemailer ──────────────────────────────────────
  if (smtpCfg?.host && smtpCfg?.user && smtpCfg?.pass) {
    let nodemailer;
    try { nodemailer = require("nodemailer"); } catch (_) {
      console.warn("[Email] nodemailer not installed — run: npm install nodemailer");
    }
    if (nodemailer) {
      try {
        const transporter = nodemailer.createTransport({
          host:   smtpCfg.host,
          port:   parseInt(smtpCfg.port || 587, 10),
          secure: smtpCfg.secure === true || smtpCfg.port == 465,
          auth:   { user: smtpCfg.user, pass: smtpCfg.pass },
          tls:    { rejectUnauthorized: false }, // allow self-signed for on-prem servers
        });
        await transporter.sendMail({
          from:    `"${smtpCfg.fromName || "Support"}" <${smtpCfg.fromEmail || smtpCfg.user}>`,
          to:      toName ? `"${toName}" <${to}>` : to,
          subject,
          html:    body,
        });
        console.log(`[Email] SMTP sent to ${to} via ${smtpCfg.host}`);
        return { ok: true, provider: "smtp" };
      } catch (e) {
        console.error(`[Email] SMTP failed (${smtpCfg.host}):`, e.message);
        // Fall through to ClickSend
      }
    }
  }

  // ── Path 2: Platform ClickSend fallback ─────────────────────────────────────
  if (csCfg?.username && csCfg?.apiKey) {
    const fromId = parseInt(csCfg.emailAddressId || csCfg.email_address_id || 0, 10);
    if (!fromId) {
      console.warn("[Email] ClickSend fallback skipped — emailAddressId not set");
      return { ok: false, error: "No SMTP config and ClickSend emailAddressId not set" };
    }
    try {
      const r = await fetch("https://rest.clicksend.com/v3/email/send", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Basic " + Buffer.from(csCfg.username + ":" + csCfg.apiKey).toString("base64"),
        },
        body: JSON.stringify({
          to:      [{ email: to, name: toName || "Recipient", list_id: 0 }],
          from:    { email_address_id: fromId, name: csCfg.emailName || "Hindle" },
          subject,
          body,
        }),
      });
      const rawText = await r.text();
      let d = {};
      try { d = JSON.parse(rawText); } catch (_) {}
      const ok = d?.response_code === "SUCCESS";
      console.log(`[Email] ClickSend ${ok?"sent":"failed"} to ${to}: ${d?.response_code}`);
      return { ok, provider: "clicksend", response: d };
    } catch (e) {
      console.error("[Email] ClickSend error:", e.message);
      return { ok: false, error: e.message };
    }
  }

  return { ok: false, error: "No email provider configured (no SMTP, no ClickSend)" };
}

// Helper: load email config for a given org (tenant SMTP + platform ClickSend fallback)
async function loadEmailConfig(orgId) {
  let smtpCfg  = null;
  let csCfg    = null;
  try {
    // Tenant SMTP config
    if (orgId) {
      const [tenantRow] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${orgId} LIMIT 1`.catch(()=>[null]);
      smtpCfg = tenantRow?.config?.smtp || null;
    }
    // Platform ClickSend (always loaded as fallback)
    const [platRow] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`.catch(()=>[null]);
    const platCs = platRow?.config?._superConfig?.clicksend || platRow?.config?.clicksend || {};
    if (platCs.username) csCfg = platCs;
  } catch (e) { console.error("[loadEmailConfig]", e.message); }
  return { smtpCfg, csCfg };
}
// ──────────────────────────────────────────────────────────────────────────────


// ── Canonical org UUID resolver ──────────────────────────────────────────────
// Accepts: UUID (org.id), tenant_id string slug, or org email
// Always returns the canonical UUID from organisations.id
async function resolveOrgId(val) {
  if (!val) return null;
  try {
    const rows = await sql`
      SELECT id FROM organisations
      WHERE id::text = ${val}
         OR tenant_id = ${val}
         OR LOWER(email) = LOWER(${val})
      LIMIT 1
    `;
    return rows[0]?.id || null;
  } catch (e) {
    console.error("[resolveOrgId] error:", e.message);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────


// ── ClickSend email helper ──────────────────────────────────────────────────
// ClickSend v3 email API requires:
//   from: { email_address_id: <numeric>, name: string }
//   to:   [{ email, name, list_id: 0 }]   (list_id:0 = non-list send)
function buildCsEmail({ to, toName, subject, body, fromId, fromName, listId }) {
  return {
    to:      [{ email: to, name: toName || "Customer", list_id: listId || 0 }],
    from:    { email_address_id: parseInt(fromId, 10) || 1, name: fromName || "Hindle" },
    subject: subject || "(no subject)",
    body:    body    || "",
  };
}
// ──────────────────────────────────────────────────────────────────────────────

;

// Check optional packages for KB file extraction
// Add to package.json: "busboy", "pdf-parse", "mammoth"
// Then redeploy — Railway will install them automatically
["busboy","pdf-parse","mammoth","nodemailer","bcryptjs"].forEach(pkg => {
  try { require(pkg); console.log(`[KB] ${pkg} ✓`); }
  catch (_) { console.log(`[KB] ${pkg} not installed — PDF/DOCX upload will return 503. Run: npm install ${pkg}`); }
});
// Stripe — loaded dynamically so missing package never crashes the server
let stripe = null;
(function() {
  try {
    if (process.env.STRIPE_SECRET_KEY) {
      const Stripe = require("stripe");
      stripe = Stripe(process.env.STRIPE_SECRET_KEY);
      console.log("[Stripe] Initialised OK");
    } else {
      console.log("[Stripe] STRIPE_SECRET_KEY not set — payments disabled");
    }
  } catch (e) {
    console.log("[Stripe] Module not installed — payments disabled. Run: npm install stripe");
  }
}());
const { neon } = require("@neondatabase/serverless");

const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const sql = neon(process.env.DATABASE_URL);



// fetchWithRedirects is an alias for the custom fetch above
const fetchWithRedirects = fetch;

// ── RLS Context Helpers ───────────────────────────────────────────────────────
// sqlForOrg(orgId) — runs a single query with the tenant RLS context set
// Usage: const rows = await sqlForOrg(orgId, sql`SELECT * FROM conversations`);
//
// For super admin (orgId = null/undefined/''), sets empty string → policies allow all rows.
// For tenant (orgId = UUID), policies enforce org_id isolation at DB level.

async function sqlForOrg(orgId, query) {
  const ctx = orgId ? String(orgId) : '';
  try {
    const results = await sql.transaction([
      sql`SELECT set_config('app.current_org_id', ${ctx}, true)`,
      query,
    ]);
    return results[1]; // results[0] is set_config result
  } catch (e) {
    // Fallback: if transaction not supported, run query directly
    // (RLS still applies at DB level if enabled)
    console.error('[RLS] transaction error, falling back:', e.message);
    return await query;
  }
}

// sqlManyForOrg — run multiple queries in one transaction under the same RLS context
async function sqlManyForOrg(orgId, queries) {
  const ctx = orgId ? String(orgId) : '';
  try {
    const results = await sql.transaction([
      sql`SELECT set_config('app.current_org_id', ${ctx}, true)`,
      ...queries,
    ]);
    return results.slice(1); // drop set_config result
  } catch (e) {
    console.error('[RLS] multi-transaction error:', e.message);
    return await Promise.all(queries.map(q => q));
  }
}
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ── Bulk website scraper for KB ───────────────────────────────────────────────
function extractTextFromHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function scrapeAndStore(url, org_id, category) {
  const r = await fetchWithRedirects(url, { timeout: 15000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  // Detect Cloudflare/bot protection pages
  if (html.includes('cf-browser-verification') || html.includes('challenge-platform') || 
      html.includes('Just a moment') || html.includes('Enable JavaScript') ||
      html.length < 500) {
    throw new Error("Bot protection or empty page — try Import URL manually");
  }
  const text = extractTextFromHtml(html);
  if (text.length < 100) throw new Error("Content too short");
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const name = (h1Match ? h1Match[1].trim() : titleMatch ? titleMatch[1].trim() : url).slice(0, 120);
  const content = text.slice(0, 10000);
  const size_kb = Math.round(content.length / 1024 * 10) / 10;
  const existing = await sql`SELECT id FROM kb_documents WHERE org_id = ${org_id} AND name = ${name} LIMIT 1`.catch(()=>[]);
  if (existing.length) {
    await sql`UPDATE kb_documents SET content = ${content}, size_kb = ${size_kb}, updated_at = NOW() WHERE id = ${existing[0].id}`;
    return { ok: true, action: "updated", name };
  } else {
    await sql`INSERT INTO kb_documents (org_id, name, content, category, size_kb, chunks, status) VALUES (${org_id}, ${name}, ${content}, ${category||"Website"}, ${size_kb}, ${1}, ${"indexed"})`;
    return { ok: true, action: "created", name };
  }
}

app.post("/api/kb/scrape-site", async (req, res) => {
  const { org_id, urls, category } = req.body;
  if (!org_id || !urls || !Array.isArray(urls)) {
    return res.status(400).json({ error: "org_id and urls array required" });
  }
  const results = [];
  for (const url of urls.slice(0, 80)) {
    try {
      const result = await scrapeAndStore(url, org_id, category);
      results.push({ url, ...result });
    } catch (e) {
      results.push({ url, ok: false, error: e.message });
    }
  }
  res.json({ ok: true, results, imported: results.filter(r => r.ok).length });
});

// ── Auto-discover and scrape all pages from a base URL ──────────────────────
app.post("/api/kb/scrape-discover", async (req, res) => {
  const { org_id, base_url, category } = req.body;
  if (!org_id || !base_url) return res.status(400).json({ error: "org_id and base_url required" });

  const visited = new Set();
  const toVisit = [base_url.replace(/\/$/, "")];
  const results = [];
  const base = new URL(base_url);

  while (toVisit.length > 0 && visited.size < 60) {
    const url = toVisit.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const r = await fetchWithRedirects(url, { timeout: 10000 });
      if (!r.ok) { results.push({ url, ok: false, error: `HTTP ${r.status}` }); continue; }
      const html = await r.text();

      // Discover more links on same domain
      const linkMatches = html.matchAll(/href=["']([^"'#?]+)["']/gi);
      for (const [, href] of linkMatches) {
        try {
          const abs = new URL(href, base_url).href;
          if (abs.startsWith(base.origin) && !visited.has(abs) && !toVisit.includes(abs)) {
            // Skip assets, images, PDFs etc
            if (!/\.(jpg|jpeg|png|gif|svg|ico|css|js|pdf|zip|mp4|mp3|woff|ttf)(\?|$)/i.test(abs)) {
              toVisit.push(abs);
            }
          }
        } catch (_) {}
      }

      // Store the page
      const text = extractTextFromHtml(html);
      if (text.length < 100) { results.push({ url, ok: false, error: "Too short" }); continue; }
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      const name = (h1Match ? h1Match[1].trim() : titleMatch ? titleMatch[1].trim() : url).slice(0, 120);
      const content = text.slice(0, 10000);
      const size_kb = Math.round(content.length / 1024 * 10) / 10;
      const existing = await sql`SELECT id FROM kb_documents WHERE org_id = ${org_id} AND name = ${name} LIMIT 1`.catch(()=>[]);
      if (existing.length) {
        await sql`UPDATE kb_documents SET content = ${content}, size_kb = ${size_kb}, updated_at = NOW() WHERE id = ${existing[0].id}`;
        results.push({ url, ok: true, action: "updated", name });
      } else {
        await sql`INSERT INTO kb_documents (org_id, name, content, category, size_kb, chunks, status) VALUES (${org_id}, ${name}, ${content}, ${category||"Website"}, ${size_kb}, ${1}, ${"indexed"})`;
        results.push({ url, ok: true, action: "created", name });
      }
    } catch (e) {
      results.push({ url, ok: false, error: e.message });
    }
  }

  res.json({ ok: true, results, imported: results.filter(r => r.ok).length, pagesVisited: visited.size });
});
// ─────────────────────────────────────────────────────────────────────────────


// ── Serve widget.js ──────────────────────────────────────────────────────────
// Proxies from Vercel with correct content-type (Vercel serves it as text/html)
app.get("/widget.js", async (req, res) => {
  try {
    const r = await fetch("https://chatbot.hindleconsultants.com/widget.js");
    const text = await r.text();
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(text);
  } catch(e) {
    res.status(500).send("// widget unavailable");
  }
});
// ─────────────────────────────────────────────────────────────────────────────



// Also add tertiary to GET /api/kb so conversations panel can use it


// Stripe webhook MUST receive raw body for signature verification
// Register this route BEFORE express.json() middleware
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
      : JSON.parse(req.body.toString());
  } catch (e) {
    console.error("[Stripe] Webhook signature error:", e.message);
    return res.status(400).json({ error: "Webhook signature error: " + e.message });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { planId, orgId, promoCode } = session.metadata || {};
    const email = session.customer_email;
    try {
      let org = null;
      if (orgId && orgId !== "") {
        const rows = await sql`SELECT * FROM organisations WHERE id::text = ${orgId} LIMIT 1`;
        org = rows[0] || null;
      }
      if (!org && email) {
        const rows = await sql`SELECT * FROM organisations WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
        org = rows[0] || null;
      }
      if (org) {
        await sql`UPDATE organisations SET status = 'paid', plan = ${planId || org.plan}, updated_at = NOW() WHERE id = ${org.id}`;
        // Snapshot plan at time of payment
        try {
          const [sCfg] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`.catch(()=>[null]);
          const sSc = sCfg?.config?._superConfig || {};
          const sApl = sSc.planLimits || null;
          const sPlan = planId || org.plan;
          const sPlanBase = (sApl && sApl[sPlan]) || PLAN_LIMITS[sPlan] || PLAN_LIMITS.free;
          const sSnap = { plan: sPlan, snapped_at: new Date().toISOString(), limits: { ...sPlanBase }, features: sSc.planFeatures ? (sSc.planFeatures[sPlan] || []) : [] };
          await sql`UPDATE organisations SET plan_snapshot = ${JSON.stringify(sSnap)} WHERE id = ${org.id}`.catch(()=>{});
        } catch (_) {}
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
        console.log(`[Stripe] Activated org ${org.id} (${org.email}) on plan ${planId}`);
        // Send payment confirmation email
        try {
          const [pCfg] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`.catch(()=>[null]);
          const cs = pCfg?.config?._superConfig?.clicksend || pCfg?.config?.clicksend || {};
          const fromId = parseInt(cs.emailAddressId || cs.email_address_id || 0, 10);
          if (cs.username && cs.apiKey && fromId && org.email) {
            // Load email template from super config if set, else use default
            const tpls = pCfg?.config?._superConfig?.emailTemplates || [];
            const tpl = tpls.find(t => t.id === "payment");
            const subject = tpl ? renderEmailTemplate(tpl.subj, { name: org.name, plan: planId }) : `✅ Payment confirmed — ${planId} plan active`;
            const body = tpl
              ? `<p>${renderEmailTemplate(tpl.body, { name: org.name, plan: planId, amount: session.amount_total ? (session.amount_total/100).toFixed(2) : "", last4: session.payment_method_types?.[0] || "" })}</p>`
              : `<p>Hi ${org.name || "there"},<br><br>Your payment has been confirmed and your <strong>${planId}</strong> plan is now active.<br><br>Thank you for choosing Hindle AI.</p>`;
            await sendEmail({ to: org.email, toName: org.name||"Customer", subject, body, smtpCfg: null, csCfg: cs })
              .catch(e => console.error("[Stripe] Payment email error:", e.message));            console.log(`[Stripe] Payment confirmation email sent to ${org.email}`);
          }
        } catch (emailErr) { console.error("[Stripe] Payment email error:", emailErr.message); }
        // Write audit
        await writeAudit(org.id, "payment_confirmed", `Payment confirmed — plan ${planId}`, { plan: planId, email }).catch(()=>{});
      } else {
        console.warn(`[Stripe] Webhook: could not find org for email=${email} orgId=${orgId}`);
      }
    } catch (e) {
      console.error("[Stripe] Webhook activation error:", e.message);
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ── Import from Kuhlekt KB API ────────────────────────────────────────────────
app.post("/api/kb/import-from-kb-api", async (req, res) => {
  const { org_id, kb_api_url, kb_api_key } = req.body;
  if (!org_id || !kb_api_url) return res.status(400).json({ error: "org_id and kb_api_url required" });

  const results = [];
  try {
    // Fetch all articles from the KB API
    const apiUrl = `${kb_api_url}?key=${kb_api_key || ""}&q=&limit=200`;
    const r = await fetch(apiUrl, { timeout: 15000 });
    if (!r.ok) throw new Error(`KB API returned HTTP ${r.status}`);
    const data = await r.json();

    const articles = Array.isArray(data) ? data : (data.articles || data.results || data.data || []);
    if (!articles.length) return res.json({ ok: false, error: "No articles returned from KB API", raw: data });

    for (const article of articles) {
      try {
        const name = (article.title || article.name || article.question || "Untitled").slice(0, 120);
        const content = article.content || article.body || article.answer || article.text || "";
        if (!content || content.length < 20) continue;
        const category = article.category || article.section || "Knowledge Base";
        const size_kb = Math.round(content.length / 1024 * 10) / 10;

        const existing = await sql`SELECT id FROM kb_documents WHERE org_id = ${org_id} AND name = ${name} LIMIT 1`.catch(()=>[]);
        if (existing.length) {
          await sql`UPDATE kb_documents SET content = ${content}, size_kb = ${size_kb}, updated_at = NOW() WHERE id = ${existing[0].id}`;
          results.push({ ok: true, action: "updated", name });
        } else {
          await sql`INSERT INTO kb_documents (org_id, name, content, category, size_kb, chunks, status) VALUES (${org_id}, ${name}, ${content}, ${category}, ${size_kb}, ${1}, ${"indexed"})`;
          results.push({ ok: true, action: "created", name });
        }
      } catch(e) {
        results.push({ ok: false, name: article.title || "unknown", error: e.message });
      }
    }
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  res.json({ ok: true, results, imported: results.filter(r => r.ok).length });
});
// ─────────────────────────────────────────────────────────────────────────────



// ── RLS default context middleware ────────────────────────────────────────────
// Sets app.current_org_id = '' (super admin / bypass) for every request.
// Individual endpoints override this with sqlForOrg(orgId, ...) which wraps
// the query in a transaction that sets the correct tenant context first.
// This ensures RLS never hard-blocks a request due to missing context.
app.use(async (req, res, next) => {
  try {
    await sql`SELECT set_config('app.current_org_id', '', true)`;
  } catch (_) {}
  next();
});
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// SUPER ADMIN 2FA
// POST /api/auth/2fa/send   — generate code, email it
// POST /api/auth/2fa/verify — verify code
// ─────────────────────────────────────────────
const twoFaCodes = new Map(); // email → { code, expiresAt, attempts }

app.post("/api/auth/2fa/send", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });

  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
  twoFaCodes.set(email.toLowerCase(), { code, expiresAt, attempts: 0 });

  // Send via ClickSend email
  try {
    const [cfg] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`.catch(() => [null]);
    const cs = cfg?.config?._superConfig?.clicksend || cfg?.config?.clicksend || cfg?.config?._platformConfig?.clicksend || {};
    const username = cs.username || process.env.CLICKSEND_USERNAME;
    const apiKey   = cs.apiKey   || process.env.CLICKSEND_API_KEY;

    // Load org's SMTP config if available, fall back to platform ClickSend
    const { smtpCfg: tfaSmtp, csCfg: tfaCs } = await loadEmailConfig(null); // 2FA = platform level
    const tfaBody = `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 8px">Login verification code</h2>
  <p style="color:#64748b;margin:0 0 20px">Enter this code to complete your sign in:</p>
  <div style="background:#f1f5f9;border-radius:8px;padding:20px;text-align:center;font-size:36px;font-weight:800;letter-spacing:8px;color:#1e293b">${code}</div>
  <p style="color:#94a3b8;font-size:12px;margin:16px 0 0">This code expires in 10 minutes. If you did not request this, change your password immediately.</p>
</div>`;
    const tfaResult = await sendEmail({ to: email, toName: "Admin", subject: "Your Hindle Admin login code", body: tfaBody, smtpCfg: tfaSmtp, csCfg: tfaCs });
    if (!tfaResult.ok) {
      console.log(`[2FA] CODE for ${email}: ${code} (email failed: ${tfaResult.error||"unknown"})`);
    }
  } catch (e) {
    console.error("[2FA] Email error:", e.message);
  }

  res.json({ ok: true, expires: expiresAt });
});

app.post("/api/auth/2fa/verify", (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: "email and code required" });

  const entry = twoFaCodes.get(email.toLowerCase());
  if (!entry) return res.status(400).json({ error: "No code found — request a new one" });
  if (Date.now() > entry.expiresAt) {
    twoFaCodes.delete(email.toLowerCase());
    return res.status(400).json({ error: "Code expired — request a new one" });
  }
  entry.attempts++;
  if (entry.attempts > 5) {
    twoFaCodes.delete(email.toLowerCase());
    return res.status(429).json({ error: "Too many attempts — request a new code" });
  }
  if (code.trim() !== entry.code) {
    return res.status(400).json({ error: `Incorrect code (${5 - entry.attempts} attempts remaining)` });
  }

  twoFaCodes.delete(email.toLowerCase());
  res.json({ ok: true });
});


// ─────────────────────────────────────────────
// AI AGENT TOOLS
// ─────────────────────────────────────────────

// POST /api/ai/suggest-replies
// Body: { conversationId, messages[] }
// Returns: { suggestions: string[] }
app.post("/api/ai/suggest-replies", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "AI not configured" });
  const { messages = [], orgId } = req.body;
  try {
    const recent = messages.slice(-6).map(m =>
      `${m.type === "visitor" ? "Visitor" : m.type === "agent" ? "Agent" : "AI"}: ${m.content}`
    ).join("\n");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 400,
        system: "You are helping a customer support agent. Generate exactly 3 short, helpful reply suggestions for the agent to send next. Format as a JSON array of strings only, no other text. Each suggestion should be 1-2 sentences, professional, and directly relevant to the conversation.",
        messages: [{ role: "user", content: `Conversation so far:\n${recent}\n\nGenerate 3 reply suggestions as a JSON array.` }],
      }),
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || "[]";
    const clean = text.replace(/```json|```/g, "").trim();
    const suggestions = JSON.parse(clean);
    res.json({ suggestions: Array.isArray(suggestions) ? suggestions : [] });
  } catch (e) {
    res.json({ suggestions: [] });
  }
});

// POST /api/ai/summarise
// Body: { conversationId }
// Returns: { summary: string }
app.post("/api/ai/summarise", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "AI not configured" });
  const { conversationId } = req.body;
  if (!conversationId) return res.status(400).json({ error: "conversationId required" });
  try {
    const msgs = await sql`SELECT type, sender, content FROM messages WHERE conversation_id = ${conversationId} ORDER BY created_at ASC LIMIT 50`;
    const transcript = msgs.map(m => `${m.sender} (${m.type}): ${m.content}`).join("\n");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 300,
        system: "Summarise this customer support conversation in 2-4 bullet points. Cover: main issue, what was tried, outcome/status, any follow-up needed. Be concise and factual.",
        messages: [{ role: "user", content: transcript || "No messages yet." }],
      }),
    });
    const data = await response.json();
    res.json({ summary: data.content?.[0]?.text || "No summary available." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ai/sentiment
// Body: { text: string }
// Returns: { sentiment: "positive"|"neutral"|"negative"|"frustrated", score: number }
app.post("/api/ai/sentiment", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ sentiment: "neutral", score: 0.5 });
  const { text } = req.body;
  if (!text) return res.json({ sentiment: "neutral", score: 0.5 });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 60,
        system: 'Analyse the sentiment of the customer message. Respond only with JSON: {"sentiment":"positive|neutral|negative|frustrated","score":0.0-1.0}',
        messages: [{ role: "user", content: text.slice(0, 500) }],
      }),
    });
    const data = await response.json();
    const raw = data.content?.[0]?.text || "{}";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    res.json({ sentiment: parsed.sentiment || "neutral", score: parsed.score ?? 0.5 });
  } catch (e) {
    res.json({ sentiment: "neutral", score: 0.5 });
  }
});


// GET /api/analytics/:orgId/export?days=30&format=csv
app.get("/api/analytics/:orgId/export", async (req, res) => {
  const { orgId } = req.params;
  const days = parseInt(req.query.days) || 30;
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const convos = await sql`
      SELECT c.id, c.visitor_name, c.visitor_email, c.visitor_phone, c.visitor_company,
             c.visitor_location, c.page, c.subject, c.status, c.priority,
             c.claimed_by_name, c.csat_rating, c.first_response_at,
             c.created_at, c.updated_at
      FROM conversations c
      WHERE c.org_id = ${orgId} AND c.created_at >= ${since}
      ORDER BY c.created_at DESC
      LIMIT 5000
    `;
    const headers = ["ID","Visitor","Email","Phone","Company","Location","Page","Subject","Status","Priority","Agent","CSAT","First Response","Created","Updated"];
    const rows = convos.map(c => [
      c.id, c.visitor_name||"", c.visitor_email||"", c.visitor_phone||"",
      c.visitor_company||"", c.visitor_location||"", c.page||"",
      c.subject||"", c.status||"", c.priority||"", c.claimed_by_name||"",
      c.csat_rating!=null?c.csat_rating:"", c.first_response_at||"",
      c.created_at||"", c.updated_at||""
    ].map(v => `"${String(v).replace(/"/g,'""')}"`));
    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="hindle-export-${days}d.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/conversations/:id/snooze
// Body: { until: ISO datetime }
app.post("/api/conversations/:id/snooze", async (req, res) => {
  const { until } = req.body;
  try {
    await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ`.catch(()=>{});
    await sql`UPDATE conversations SET snoozed_until = ${until||null}, status = 'parked', updated_at = NOW() WHERE id = ${req.params.id}`;
    res.json({ ok: true, snoozed_until: until });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/conversations/:id/email-reply
// Body: { to, subject, body, agentName }
app.post("/api/conversations/:id/email-reply", async (req, res) => {
  const { to, subject, body, agentName } = req.body;
  if (!to || !body) return res.status(400).json({ error: "to and body required" });
  try {
    const [conv] = await sql`SELECT org_id FROM conversations WHERE id = ${req.params.id} LIMIT 1`;
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    const { smtpCfg, csCfg } = await loadEmailConfig(conv.org_id);
    const result = await sendEmail({ to, toName: "Customer", subject: subject || "Re: Your support request", body, smtpCfg, csCfg });
    if (!result.ok) return res.status(503).json({ error: result.error || "Email send failed" });
    await sql`INSERT INTO messages (conversation_id, type, sender, content) VALUES (${req.params.id}, 'agent', ${agentName||'Agent'}, ${("[Email sent to " + to + "]: " + body.replace(/<[^>]+>/g,"").slice(0,200))})`;
    res.json({ ok: true, provider: result.provider });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─────────────────────────────────────────────
// KB — URL Import: fetch page text server-side
// POST /api/kb/import-url  { org_id, url }
// ─────────────────────────────────────────────
app.post("/api/kb/import-url", async (req, res) => {
  const { org_id, url } = req.body;
  if (!org_id || !url) return res.status(400).json({ error: "org_id and url required" });
  if (!url.startsWith("http://") && !url.startsWith("https://"))
    return res.status(400).json({ error: "URL must start with http:// or https://" });
  try {
    const limitErr = await checkKbLimit(org_id);
    if (limitErr) return res.status(403).json(limitErr);

    // Fetch the page
    const pageRes = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HindleBot/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!pageRes.ok) return res.status(502).json({ error: `Page returned ${pageRes.status}` });
    const html = await pageRes.text();

    // Strip HTML tags, collapse whitespace
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 50000); // cap at 50k chars

    const slug = url.split("/").filter(Boolean).pop() || "page";
    const name = slug.slice(0, 80) + " (imported)";

    await sql`ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS content TEXT`.catch(()=>{});
    const rows = await sql`
      INSERT INTO kb_documents (org_id, name, content, size_kb, chunks, status)
      VALUES (${org_id}, ${name}, ${text}, ${Math.round(text.length/1024)}, ${Math.ceil(text.length/500)}, 'indexed')
      RETURNING *
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ─────────────────────────────────────────────
// KB — File Upload with text extraction
// POST /api/kb/upload-file
// Accepts multipart with field "file" + body field "org_id"
// Extracts text from PDF/DOCX/TXT/MD/JSON/XML/CSV
// ─────────────────────────────────────────────
app.post("/api/kb/upload-file", async (req, res) => {
  // Parse multipart manually using busboy
  let busboy;
  try { busboy = require("busboy"); } catch (_) {
    return res.status(503).json({ error: "busboy not installed — run: npm install busboy" });
  }

  const org_id = req.headers["x-org-id"] || req.query.org_id;
  if (!org_id) return res.status(400).json({ error: "org_id required (header X-Org-Id or query param)" });

  const limitErr = await checkKbLimit(org_id).catch(() => null);
  if (limitErr) return res.status(403).json(limitErr);

  const bb = busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });
  const fileBuffers = [];
  let fileName = "upload";
  let fileType = "";

  bb.on("file", (name, file, info) => {
    fileName = info.filename || "upload";
    fileType = fileName.split(".").pop().toLowerCase();
    const chunks = [];
    file.on("data", c => chunks.push(c));
    file.on("end", () => fileBuffers.push(Buffer.concat(chunks)));
  });

  bb.on("finish", async () => {
    if (!fileBuffers.length) return res.status(400).json({ error: "No file received" });
    const buf = fileBuffers[0];
    let text = "";

    try {
      if (fileType === "pdf") {
        try {
          const pdfParse = require("pdf-parse");
          const data = await pdfParse(buf);
          text = data.text || "";
        } catch (_) {
          return res.status(503).json({ error: "pdf-parse not installed — run: npm install pdf-parse" });
        }
      } else if (fileType === "docx" || fileType === "doc") {
        try {
          const mammoth = require("mammoth");
          const result = await mammoth.extractRawText({ buffer: buf });
          text = result.value || "";
        } catch (_) {
          return res.status(503).json({ error: "mammoth not installed — run: npm install mammoth" });
        }
      } else if (["txt","md","csv","json","xml"].includes(fileType)) {
        text = buf.toString("utf8");
        if (fileType === "json") {
          try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
        } else if (fileType === "xml") {
          text = text.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
        }
      } else {
        return res.status(400).json({ error: `Unsupported file type: .${fileType}. Supported: pdf, docx, txt, md, csv, json, xml` });
      }

      text = text.replace(/\r\n/g, "\n").replace(/\t/g, " ").replace(/ {3,}/g, "  ").trim().slice(0, 80000);
      if (!text) return res.status(400).json({ error: "Could not extract text from file" });

      await sql`ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS content TEXT`.catch(()=>{});
      const rows = await sql`
        INSERT INTO kb_documents (org_id, name, content, size_kb, chunks, status)
        VALUES (${org_id}, ${fileName}, ${text}, ${Math.round(buf.length / 1024)}, ${Math.ceil(text.length / 500)}, 'indexed')
        RETURNING *
      `;
      res.status(201).json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  bb.on("error", e => res.status(500).json({ error: e.message }));
  req.pipe(bb);
});


// ─────────────────────────────────────────────
// KB — JSON import: parse and return preview for mapper
// POST /api/kb/parse-json  { org_id, json_text }
// Returns: { keys, sample, items_count, suggested_mapping }
// ─────────────────────────────────────────────
// Temporary in-memory cache for parsed JSON items (cleared after 30 min)
const _parseCache = new Map();
const _parseCacheExpiry = new Map();
setInterval(()=>{
  const now = Date.now();
  for(const [id, exp] of _parseCacheExpiry){
    if(now > exp){ _parseCache.delete(id); _parseCacheExpiry.delete(id); }
  }
}, 5 * 60 * 1000);

app.post("/api/kb/parse-json", async (req, res) => {
  const { json_text, org_id } = req.body;
  if (!json_text) return res.status(400).json({ error: "json_text required" });
  try {
    const raw = JSON.parse(json_text);
    let items = [];

    if (Array.isArray(raw)) {
      items = raw;
    } else if (typeof raw === "object") {
      const keys = Object.keys(raw);
      const firstVal = raw[keys[0]];
      if (Array.isArray(firstVal)) {
        keys.forEach(cat => {
          const arr = Array.isArray(raw[cat]) ? raw[cat] : [];
          arr.forEach(item => items.push({ ...item, _detected_category: cat }));
        });
      } else if (typeof firstVal === "string") {
        items = Object.entries(raw).map(([k, v]) => ({ title: k, content: v }));
      } else {
        items = [raw];
      }
    }

    if (!items.length) return res.status(400).json({ error: "No items found in JSON" });

    const keySet = new Set();
    items.slice(0, 20).forEach(item => Object.keys(item).forEach(k => keySet.add(k)));
    const keys = [...keySet];

    const suggest = (candidates) => keys.find(k => candidates.some(c => k.toLowerCase().includes(c))) || "";
    const suggested = {
      title:        suggest(["title","name","question","q","heading","subject","topic"]),
      content:      suggest(["content","answer","a","body","description","text","detail","response"]),
      category:     suggest(["category","cat","group","section","type","module","_detected_category"]),
      sub_category: suggest(["sub","subcategory","sub_category","subtopic","tag"]),
      tertiary:     suggest(["tertiary","third","level3","tier"]),
    };

    // Store in cache so import-mapped can retrieve without re-sending all items
    const parseId = `p_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    _parseCache.set(parseId, items);
    _parseCacheExpiry.set(parseId, Date.now() + 30 * 60 * 1000);

    // Return sample + keys + parseId (not full items, to keep response small)
    const sample = items.slice(0, 3);
    res.json({ keys, sample, items_count: items.length, suggested, parseId,
      // Include full items only if small (<= 100 items, < 500kb)
      items: items.length <= 100 ? items : [] });
  } catch (e) {
    res.status(400).json({ error: "Invalid JSON: " + e.message });
  }
});

// POST /api/kb/import-mapped
// Body: { org_id, items[], mapping: {title, content, category, sub_category, tertiary} }
// Saves each mapped item as a kb_document row
app.post("/api/kb/import-mapped", async (req, res) => {
  let { org_id, items, mapping, parseId } = req.body;
  // If items not sent (large file), retrieve from cache
  if ((!items || !items.length) && parseId && _parseCache.has(parseId)) {
    items = _parseCache.get(parseId);
    _parseCache.delete(parseId);
    _parseCacheExpiry.delete(parseId);
  }
  if (!org_id || !items?.length || !mapping?.title || !mapping?.content) {
    return res.status(400).json({ error: "org_id, items, mapping.title and mapping.content required" });
  }
  try {
    await sql`ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS content TEXT`.catch(()=>{});
    await sql`ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS tertiary TEXT`.catch(()=>{});

    const limitErr = await checkKbLimit(org_id);
    if (limitErr) return res.status(403).json(limitErr);

    const saved = [];
    for (const item of items) {
      const name    = String(item[mapping.title]    || "").trim().slice(0, 200) || "Untitled";
      const content = String(item[mapping.content]  || "").trim().slice(0, 80000);
      const category     = mapping.category     ? String(item[mapping.category]     || "").trim() : null;
      const sub_category = mapping.sub_category ? String(item[mapping.sub_category] || "").trim() : null;
      const tertiary     = mapping.tertiary     ? String(item[mapping.tertiary]     || "").trim() : null;
      if (!content) continue;
      const rows = await sql`
        INSERT INTO kb_documents (org_id, name, content, category, sub_category, tertiary, size_kb, chunks, status)
        VALUES (${org_id}, ${name}, ${content}, ${category}, ${sub_category}, ${tertiary},
                ${Math.round(content.length/1024)}, ${Math.ceil(content.length/500)}, 'indexed')
        RETURNING *
      `.catch(e => { console.error("[KB import]", e.message); return []; });
      if (rows[0]) saved.push(rows[0]);
    }
    res.json({ saved: saved.length, items: saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Also add tertiary to GET /api/kb so conversations panel can use it


// ── Tenant plan snapshot endpoint ─────────────────────────────────────────────
// Returns the plan snapshot locked at signup time for a given org
app.get("/api/plan-snapshot/:orgId", async (req, res) => {
  try {
    const orgId = await resolveOrgId(req.params.orgId).catch(() => req.params.orgId);
    const [org] = await sql`SELECT plan, plan_snapshot, custom_limits FROM organisations WHERE id = ${orgId} LIMIT 1`.catch(()=>[null]);
    if (!org) return res.status(404).json({ error: "Not found" });
    // If no snapshot yet, build one from current platform config
    if (!org.plan_snapshot) {
      const apl = await getAdminPlanLimits();
      const planBase = (apl && apl[org.plan]) || PLAN_LIMITS[org.plan] || PLAN_LIMITS.free;
      return res.json({ plan: org.plan, limits: planBase, features: [], snapped_at: null, is_live: true });
    }
    res.json({ ...org.plan_snapshot, is_live: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ─────────────────────────────────────────────────────────────────────────────


// ── SMTP Test endpoint ────────────────────────────────────────────────────────
app.post("/api/test-smtp", async (req, res) => {
  const { orgId, smtp, to } = req.body;
  if (!smtp?.host || !smtp?.user || !smtp?.pass) return res.json({ ok: false, error: "Host, user and password required" });
  if (!to) return res.json({ ok: false, error: "to address required" });
  let nodemailer;
  try { nodemailer = require("nodemailer"); } catch (_) {
    return res.json({ ok: false, error: "nodemailer not installed — run: npm install nodemailer" });
  }
  try {
    const transporter = nodemailer.createTransport({
      host:   smtp.host,
      port:   parseInt(smtp.port || 587, 10),
      secure: smtp.secure === true || smtp.port == 465,
      auth:   { user: smtp.user, pass: smtp.pass },
      tls:    { rejectUnauthorized: false },
    });
    await transporter.verify();
    await transporter.sendMail({
      from:    `"${smtp.fromName || "Hindle Test"}" <${smtp.fromEmail || smtp.user}>`,
      to,
      subject: "Hindle SMTP Test — Connection Verified",
      html:    `<p>SMTP connection verified successfully.<br><br>Host: <strong>${smtp.host}:${smtp.port}</strong><br>From: <strong>${smtp.fromEmail || smtp.user}</strong></p>`,
    });
    res.json({ ok: true, message: `Email sent to ${to} via ${smtp.host}` });
  } catch (e) {
    console.error("[SMTP Test] Error:", e.message);
    res.json({ ok: false, error: e.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────


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

// Webhook handled above (before express.json middleware)

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
        const { smtpCfg: offSmtp, csCfg: offCs } = await loadEmailConfig(org.id).catch(()=>({smtpCfg:null,csCfg:cs}));
        await sendEmail({ to: toEmail, toName: org.name||"Admin", subject: `New offline message — ${name || "Visitor"}`, body: `<pre style="font-family:sans-serif">${emailBody}</pre>`, smtpCfg: offSmtp, csCfg: offCs }).catch(()=>{});
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
  const canonicalAnalyticsId = await resolveOrgId(orgId).catch(() => orgId);
  try {
    await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS csat_rating INT`.catch(() => {});
    await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ`.catch(() => {});
    const since = new Date(Date.now() - Number(days) * 86400000).toISOString();
    const csatRows = await sql`
      SELECT csat_rating, COUNT(*)::int as n FROM conversations
      WHERE org_id = ${canonicalAnalyticsId} AND csat_rating IS NOT NULL AND created_at >= ${since}
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
      WHERE org_id = ${canonicalAnalyticsId} AND created_at >= ${since}
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
    const [convRow] = await sqlForOrg(orgId, sql`SELECT COUNT(*)::int as n FROM conversations WHERE org_id::text = ${orgId}`).catch(() => [{n:0}]);
    const [agentRow] = await sqlForOrg(orgId, sql`SELECT COUNT(*)::int as n FROM agents WHERE org_id::text = ${orgId}`).catch(() => [{n:0}]);
    const [kbRow] = await sqlForOrg(orgId, sql`SELECT COUNT(*)::int as n FROM kb_documents WHERE org_id::text = ${orgId}`).catch(() => [{n:0}]);
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
  const { system, messages, tenantId, conversationId, handoffCommands, handoffInactivityTimeout, additionalInstructions } = req.body;

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
        // Check last AGENT message time — if no agent reply within silenceSecs, let bot back in
        const [lastAgentMsg] = await sql`
          SELECT created_at FROM messages
          WHERE conversation_id = ${conversationId} AND type IN ('agent','note')
          ORDER BY created_at DESC LIMIT 1
        `.catch(() => [null]);

        const silenceSecs = (handoffInactivityTimeout && handoffInactivityTimeout > 0) ? handoffInactivityTimeout : 120;

        // If agent has responded recently, stay silent
        const agentMsgAge = lastAgentMsg
          ? (Date.now() - new Date(lastAgentMsg.created_at).getTime()) / 1000
          : silenceSecs + 1; // no agent message ever → let bot respond

        if (agentMsgAge <= silenceSecs) {
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

    // ── Fetch KB documents from database and inject into system prompt ──
    let kbContext = "";
    if (tenantId) {
      try {
        // Resolve org UUID from tenantId
        const orgs = await sql`SELECT id FROM organisations WHERE id::text = ${tenantId} OR tenant_id = ${tenantId} LIMIT 1`;
        const orgId = orgs.length ? orgs[0].id : tenantId;
        // Search KB for docs relevant to the visitor's question
        const lastMsg = messages[messages.length - 1];
        const searchText = (lastMsg?.content || lastMsg?.text || "").slice(0, 200).toLowerCase();
        // Extract keywords (words > 3 chars)
        const keywords = searchText.match(/\b\w{4,}\b/g) || [];
        const searchPattern = keywords.slice(0, 5).join('|') || 'kuhlekt';

        const kbDocs = await sql`
          SELECT name, LEFT(content, 2000) as content FROM kb_documents
          WHERE org_id = ${orgId}
            AND status = 'indexed'
            AND content IS NOT NULL
            AND content != ''
            AND (
              content ILIKE ${'%' + (keywords[0] || 'kuhlekt') + '%'}
              OR content ILIKE ${'%' + (keywords[1] || 'kuhlekt') + '%'}
              OR name ILIKE ${'%' + (keywords[0] || 'kuhlekt') + '%'}
            )
          LIMIT 8
        `;
        // If no keyword matches, fall back to most recent docs
        const fallbackDocs = kbDocs.length === 0 ? await sql`
          SELECT name, LEFT(content, 1000) as content FROM kb_documents
          WHERE org_id = ${orgId} AND status = 'indexed' AND content IS NOT NULL AND content != ''
          ORDER BY created_at DESC LIMIT 5
        ` : [];
        const finalDocs = kbDocs.length > 0 ? kbDocs : fallbackDocs;
        if (finalDocs.length > 0) {
          kbContext = "\n\n---\nKNOWLEDGE BASE — Use the following to answer questions. Do NOT say 'I don't know' — find the closest relevant answer or ask to clarify.\n\n" +
            finalDocs.map(doc => `[${doc.name}]\n${doc.content}`).join("\n\n---\n\n");
        }
      } catch (_) {}
    }

    const KUHLEKT_BASELINE = `You are the AI assistant for Kuhlekt — a B2B Invoice-to-Cash (I2C) SaaS platform specialising in accounts receivable (AR) automation, credit management, collections and dunning for Australian and international businesses.

KEY DOMAIN KNOWLEDGE you must always be able to answer:
- Dunning: The process of systematically communicating with customers to collect overdue payments. Dunning involves sending a series of increasingly urgent payment reminders (dunning letters/emails/SMS) at set intervals after an invoice becomes overdue.
- Accounts Receivable (AR): Money owed to a business by its customers for goods/services already delivered. AR automation speeds up collections and reduces debtor days.
- Invoice-to-Cash (I2C): The end-to-end process from issuing an invoice to receiving payment. Kuhlekt automates this entire cycle.
- Days Sales Outstanding (DSO): Average number of days it takes to collect payment after a sale. Kuhlekt helps reduce DSO.
- Credit management: Assessing and managing the risk of extending credit to customers.
- Collections: The process of recovering overdue debts from customers.
- Kuhlekt features include: automated dunning, AR automation, credit risk scoring, payment portals, remittance matching, cash application, dispute management, and analytics dashboards.
- Kuhlekt serves B2B businesses typically with $2M–$500M+ in annual revenue across industries including distribution, manufacturing, professional services, and wholesale.

Always answer questions about AR, collections, dunning, credit management and related topics confidently using your knowledge. Never say "I don't know" for standard industry terminology.`;

    const confSystem = (system || KUHLEKT_BASELINE) +
      kbContext +
      (additionalInstructions ? "\n\nAdditional instructions:\n" + additionalInstructions : "") +
      "\n\nIMPORTANT: After your answer, on a new line write exactly: CONFIDENCE:[0.0-1.0] where the number reflects how confident you are in your answer (1.0 = certain, 0.5 = unsure, 0.0 = no idea). If confidence is below 0.6, end with: SUGGEST_HUMAN:true";

    // Include session history for conversation memory (last 6 turns from prior sessions)
    const fullMessages = sessionHistory && Array.isArray(sessionHistory)
      ? [...sessionHistory.slice(-6), ...messages]
      : messages;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 1000,
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
      profile:         cfg._adminProfile   || {},
      platform:        cfg._platformConfig || {},
      github:          cfg._githubConfig   || {},
      superConfig:     cfg._superConfig    || {},
      adminPassword:   cfg._adminPassword  || null,
      adminAccounts:   cfg._adminAccounts  || [],
      _adminPasswords: cfg._adminPasswords || {},
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin-settings", async (req, res) => {
  const { profile, platform, github, superConfig, adminPassword, adminAccounts, adminPasswordFor, testSMS, testEmail } = req.body;

  // ── Test SMS ──────────────────────────────────────────────────
  if (testSMS) {
    const dbg = [];
    try {
      const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`;
      const cfg = rows.length ? rows[0].config : {};
      const cs = cfg._superConfig?.clicksend || cfg.clicksend || {};
      dbg.push(`config_source: ${cfg._superConfig?.clicksend ? "_superConfig.clicksend" : cfg.clicksend ? "clicksend" : "none"}`);
      const username = cs.username || process.env.CLICKSEND_USERNAME;
      const apiKey = cs.apiKey || process.env.CLICKSEND_API_KEY;
      const sender = cs.smsSender || "HINDLE";
      dbg.push(`credentials: username=${username?"set":"MISSING"} apiKey=${apiKey?"set":"MISSING"}`);
      dbg.push(`sender: ${sender} | to: ${testSMS}`);
      if (!username || !apiKey) { console.log("[TEST SMS] FAIL - missing creds"); return res.json({ ok: false, smsError: "ClickSend credentials not set", debug: dbg }); }
      const payload = { messages: [{ source: "sdk", to: testSMS, body: `[TEST] Hindle SMS test from ${sender}.`, from: sender }] };
      dbg.push(`payload: ${JSON.stringify(payload)}`);
      console.log("[TEST SMS] Sending:", JSON.stringify(payload));
      const r = await fetch("https://rest.clicksend.com/v3/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from(username + ":" + apiKey).toString("base64") },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      const msgStatus = d?.data?.messages?.[0]?.status;
      const ok = msgStatus === "SUCCESS";
      dbg.push(`http: ${r.status} | msg_status: ${msgStatus} | response: ${JSON.stringify(d).slice(0,400)}`);
      console.log("[TEST SMS] Response:", JSON.stringify(d));
      return res.json({ ok, smsSent: ok, smsError: ok ? null : (msgStatus || "Send failed"), debug: dbg });
    } catch (e) { console.error("[TEST SMS] Exception:", e.message); return res.json({ ok: false, smsError: e.message, debug: dbg }); }
  }

  if (testEmail) {
    const dbg = [];
    try {
      const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`;
      const cfg = rows.length ? rows[0].config : {};
      const cs = cfg._superConfig?.clicksend || cfg.clicksend || {};
      dbg.push(`config_source: ${cfg._superConfig?.clicksend ? "_superConfig.clicksend" : cfg.clicksend ? "clicksend" : "none"}`);
      const username = cs.username || process.env.CLICKSEND_USERNAME;
      const apiKey = cs.apiKey || process.env.CLICKSEND_API_KEY;
      const fromName = cs.emailName || "Hindle Platform";
      const fromId = parseInt(cs.emailAddressId || cs.email_address_id || 0, 10);
      dbg.push(`credentials: username=${username?"set":"MISSING"} apiKey=${apiKey?"set":"MISSING"}`);
      dbg.push(`email_address_id: ${fromId} (raw stored: "${cs.emailAddressId||cs.email_address_id||"not set"}")`);
      dbg.push(`from_name: ${fromName} | to: ${testEmail}`);
      if (!username || !apiKey) { console.log("[TEST EMAIL] FAIL - missing creds"); return res.json({ ok: false, emailError: "ClickSend credentials not set", debug: dbg }); }
      if (!fromId) { console.log("[TEST EMAIL] FAIL - email_address_id is 0"); return res.json({ ok: false, emailError: "Email Address ID not set — add it in Integrations → SMS & Email Credentials", debug: dbg }); }
      const htmlBody = `<p>Test email from Hindle.<br>email_address_id: ${fromId}<br>from_name: ${fromName}<br>Sent: ${new Date().toISOString()}</p>`;
      const payload = {
        to: [{ email: testEmail, name: "Test Recipient", list_id: 0 }],
        from: { email_address_id: fromId, name: fromName },
        subject: "Hindle — Test Email Delivery",
        body: htmlBody,
      };
      dbg.push(`payload: ${JSON.stringify(payload)}`);
      console.log("[TEST EMAIL] === ABOUT TO CALL CLICKSEND ===");
      console.log("[TEST EMAIL] URL: https://rest.clicksend.com/v3/email/send");
      console.log("[TEST EMAIL] Auth: Basic", Buffer.from(username + ":" + apiKey).toString("base64").slice(0,8)+"...");
      console.log("[TEST EMAIL] Payload:", JSON.stringify(payload));
      const r = await fetch("https://rest.clicksend.com/v3/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from(username + ":" + apiKey).toString("base64") },
        body: JSON.stringify(payload),
      });
      const rawText = await r.text();
      let d = {};
      try { d = JSON.parse(rawText); } catch(_) { d = { raw: rawText }; }
      // Only treat as success when ClickSend explicitly says SUCCESS
      const ok = d?.response_code === "SUCCESS";
      dbg.push(`http: ${r.status} | response_code: ${d?.response_code} | response_msg: ${d?.response_msg} | raw: ${rawText.slice(0,600)}`);
      console.log("[TEST EMAIL] HTTP Status:", r.status);
      console.log("[TEST EMAIL] Raw Response:", rawText.slice(0, 1000));
      const errMsg = ok ? null : (d?.response_code || d?.response_msg || `HTTP ${r.status}` || "Send failed - no SUCCESS response_code");
      return res.json({ ok, emailSent: ok, emailError: errMsg, debug: dbg });
    } catch (e) { console.error("[TEST EMAIL] Exception:", e.message); return res.json({ ok: false, emailError: e.message, debug: dbg }); }
  }
  try {
    const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`;
    const existing = rows.length ? (rows[0].config || {}) : {};
    const merged = {
      ...existing,
      ...(profile         ? { _adminProfile:   profile       } : {}),
      ...(platform        ? { _platformConfig: platform      } : {}),
      ...(github          ? { _githubConfig:   github        } : {}),
      // Deep-merge _superConfig so partial saves don't wipe other keys
      ...(superConfig ? { _superConfig: { ...(existing._superConfig||{}), ...superConfig } } : {}),
      // Mirror clicksend to top-level for backward-compat with tenant-config path
      ...(superConfig?.clicksend ? { clicksend: { ...(existing.clicksend||{}), ...superConfig.clicksend } } : {}),
      ...(adminPassword   ? { _adminPassword:  adminPassword } : {}),
      ...(adminAccounts   ? { _adminAccounts:  adminAccounts } : {}),
    };
    // Per-account password: store as _adminPasswords[email]
    if (adminPasswordFor?.email && adminPasswordFor?.password) {
      const passwords = { ...(existing._adminPasswords || {}), [adminPasswordFor.email]: adminPasswordFor.password };
      merged._adminPasswords = passwords;
    }
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
    const org = rows[0];
    // Snapshot current plan features+limits at time of creation
    try {
      const [platCfg] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`.catch(()=>[null]);
      const sc = platCfg?.config?._superConfig || {};
      const apl = sc.planLimits || null;
      const planBase = (apl && apl[plan]) || PLAN_LIMITS[plan] || PLAN_LIMITS.free;
      const planFeatures = sc.planFeatures || null;
      const snapshot = {
        plan,
        snapped_at: new Date().toISOString(),
        limits: { ...planBase },
        features: planFeatures ? (planFeatures[plan] || []) : [],
      };
      await sql`UPDATE organisations SET plan_snapshot = ${JSON.stringify(snapshot)} WHERE id = ${org.id}`.catch(()=>{});
    } catch (_) {}
    res.status(201).json(org);
    // Send welcome email (fire-and-forget)
    try {
      const [pCfg] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`.catch(()=>[null]);
      const cs = pCfg?.config?._superConfig?.clicksend || pCfg?.config?.clicksend || {};
      const fromId = parseInt(cs.emailAddressId || cs.email_address_id || 0, 10);
      if (cs.username && cs.apiKey && fromId) {
        const tpls = pCfg?.config?._superConfig?.emailTemplates || [];
        const tpl = tpls.find(t => t.id === "welcome");
        const vars = { name: name || "there", plan, company: name };
        const subj = tpl ? renderEmailTemplate(tpl.subj, vars) : "Welcome to Hindle! 🎉";
        const body = tpl
          ? `<p>${renderEmailTemplate(tpl.body, vars)}</p>`
          : `<p>Hi ${name || "there"},<br><br>Your Hindle AI account is ready. Log in at <a href="https://chatbot.hindleconsultants.com">chatbot.hindleconsultants.com</a> to get started.<br><br>Your plan: <strong>${plan}</strong></p>`;
        await sendEmail({ to: email, toName: name||"Tenant", subject: subj, body, smtpCfg: null, csCfg: cs })
          .catch(e => console.error("[Tenants] Welcome email error:", e.message));
        console.log(`[Tenants] Welcome email sent to ${email}`);
      }
    } catch (e) { console.error("[Tenants] Welcome email error:", e.message); }
    // Audit
    await writeAudit(org.id, "tenant_created", `Tenant account created — plan ${plan}`, { name, email, plan }).catch(()=>{});
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
    // Audit significant changes
    const updated = rows[0];
    if (status) await writeAudit(req.params.id, `tenant_${status}`, `Tenant status changed to ${status}`, { status }).catch(()=>{});
    if (plan)   await writeAudit(req.params.id, "plan_changed", `Plan changed to ${plan}`, { plan }).catch(()=>{});
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/tenants/:id", async (req, res) => {
  try {
    const [org] = await sql`SELECT name, email FROM organisations WHERE id = ${req.params.id} LIMIT 1`.catch(()=>[null]);
    await sql`DELETE FROM organisations WHERE id = ${req.params.id}`;
    await writeAudit(req.params.id, "tenant_deleted", `Tenant deleted: ${org?.name||"unknown"} (${org?.email||""})`, { name: org?.name, email: org?.email }).catch(()=>{});
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
      ? await sqlForOrg(org_id, sql`SELECT * FROM agents WHERE org_id = ${org_id} ORDER BY name`)
      : await sqlForOrg(null, sql`SELECT * FROM agents ORDER BY name`);
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
  const { name, email, mobile, role, status, sms_alerts, restrict_to_mine } = req.body;
  try {
    // Auto-add columns that may not exist yet
    await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS restrict_to_mine BOOLEAN DEFAULT false`.catch(()=>{});
    // Build update — only set fields that were actually sent
    const rtm = restrict_to_mine !== undefined && restrict_to_mine !== null ? Boolean(restrict_to_mine) : null;
    const rows = await sql`
      UPDATE agents SET
        name             = COALESCE(${name},         name),
        email            = COALESCE(${email},        email),
        mobile           = COALESCE(${mobile},       mobile),
        role             = COALESCE(${role},         role),
        status           = COALESCE(${status},       status),
        sms_alerts       = COALESCE(${sms_alerts},   sms_alerts),
        restrict_to_mine = COALESCE(${rtm},          restrict_to_mine)
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
    const _agentPwHash = await bcrypt.hash(password.trim(), 10);
    await sql`UPDATE agents SET password_hash = ${_agentPwHash}, must_change_password = false WHERE id = ${req.params.id}`;
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
      SET password_hash = ${await bcrypt.hash(tempPassword, 10)}, must_change_password = true
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
    console.log(`[Conversations GET] org_id="${org_id||"none"}" status="${status||"none"}"`);
    
    // Always resolve to canonical UUID — handles slug, UUID, or email
    let canonicalOrgId = org_id ? await resolveOrgId(org_id) : null;
    console.log(`[Conversations GET] resolved="${canonicalOrgId||"none"}"`);
    
    let rows;
    if (canonicalOrgId && status) {
      [rows] = await sqlManyForOrg(canonicalOrgId, [
        sql`SELECT c.*, a.name as agent_name FROM conversations c LEFT JOIN agents a ON c.assigned_agent_id = a.id WHERE c.org_id = ${canonicalOrgId} AND c.status = ${status} ORDER BY c.updated_at DESC`
      ]);
    } else if (canonicalOrgId) {
      [rows] = await sqlManyForOrg(canonicalOrgId, [
        sql`SELECT c.*, a.name as agent_name FROM conversations c LEFT JOIN agents a ON c.assigned_agent_id = a.id WHERE c.org_id = ${canonicalOrgId} ORDER BY c.updated_at DESC`
      ]);
    } else {
      // Super admin — empty context = see all
      [rows] = await sqlManyForOrg(null, [
        sql`SELECT c.*, a.name as agent_name FROM conversations c LEFT JOIN agents a ON c.assigned_agent_id = a.id ORDER BY c.updated_at DESC LIMIT 500`
      ]);
    }
    console.log(`[Conversations GET] returning ${rows?.length||0} rows for resolved="${canonicalOrgId||"none"}"`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/conversations/:id", async (req, res) => {
  try {
    // Use null orgId = super admin context; endpoint validates ownership via id
    const rows = await sqlForOrg(null, sql`SELECT c.*, a.name as agent_name FROM conversations c LEFT JOIN agents a ON c.assigned_agent_id = a.id WHERE c.id = ${req.params.id}`);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/conversations", async (req, res) => {
  const { org_id, tenant_id, visitor_name, visitor_email, visitor_phone, visitor_company, visitor_location, page, subject, status } = req.body;
  // Resolve org_id: widget sends tenant_id (= organisations.id UUID), dashboard sends org_id
  let resolvedOrgId = await resolveOrgId(org_id || tenant_id);
  // If still nothing, use the raw value as fallback (will fail gracefully)
  if (!resolvedOrgId && (org_id || tenant_id)) resolvedOrgId = org_id || tenant_id;
  // Plan enforcement — only block if we can resolve the org
  if (resolvedOrgId) {
    const limitErr = await checkConvoLimit(resolvedOrgId);
    if (limitErr) return res.status(403).json(limitErr);
  }
  // Auto-detect location from IP if not supplied
  let resolvedLocation = visitor_location || null;
  if (!resolvedLocation) {
    try {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
      if (ip && ip !== "127.0.0.1" && ip !== "::1" && !ip.startsWith("::ffff:127")) {
        // Try ip-api.com first (generous free tier, no auth needed)
        let geoResolved = false;
        try {
          const geoR = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country`);
          if (geoR.ok) {
            const geo = await geoR.json();
            if (geo.status === "success" && (geo.city || geo.country)) {
              resolvedLocation = [geo.city, geo.regionName, geo.country].filter(Boolean).join(", ");
              geoResolved = true;
              console.log(`[Conversations POST] geo (ip-api): "${resolvedLocation}" ip="${ip}"`);
            }
          }
        } catch (_) {}
        // Fallback to ipapi.co
        if (!geoResolved) {
          try {
            const geoR2 = await fetch(`https://ipapi.co/${ip}/json/`);
            if (geoR2.ok) {
              const geo2 = await geoR2.json();
              if (geo2.city || geo2.country_name) {
                resolvedLocation = [geo2.city, geo2.region, geo2.country_name].filter(Boolean).join(", ");
                console.log(`[Conversations POST] geo (ipapi.co): "${resolvedLocation}" ip="${ip}"`);
              } else {
                console.log(`[Conversations POST] geo: no result from either provider ip="${ip}"`);
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  try {
    const rows = await sql`
      INSERT INTO conversations (org_id, visitor_name, visitor_email, visitor_phone, visitor_company, visitor_location, page, subject, status)
      VALUES (${resolvedOrgId}, ${visitor_name || 'Website Visitor'}, ${visitor_email || null}, ${visitor_phone || null}, ${visitor_company || null}, ${resolvedLocation || null}, ${page || '/'}, ${subject || 'Chat'}, ${status || 'open'})
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
          visitor_name, visitor_email, visitor_phone, visitor_company, visitor_location,
          priority } = req.body;
  try {
    await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS priority TEXT`.catch(()=>{});
    // Get org for this conversation to set RLS context
    const [convOrg] = await sql`SELECT org_id FROM conversations WHERE id = ${req.params.id} LIMIT 1`.catch(()=>[null]);
    const rows = await sqlForOrg(convOrg?.org_id, sql`
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
        priority          = COALESCE(${priority},          priority),
        updated_at        = NOW()
      WHERE id = ${req.params.id}
      RETURNING *
    `);
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
    const [dOrg] = await sql`SELECT org_id FROM conversations WHERE id = ${req.params.id} LIMIT 1`.catch(()=>[null]);
    await sqlForOrg(dOrg?.org_id, sql`DELETE FROM conversations WHERE id = ${req.params.id}`);
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
    // Fetch the conversation's org_id first so RLS context is correct
    const [conv] = await sql`SELECT org_id FROM conversations WHERE id = ${req.params.id} LIMIT 1`.catch(() => [null]);
    const orgId = conv?.org_id || null;
    const rows = await sqlForOrg(orgId, sql`SELECT * FROM messages WHERE conversation_id = ${req.params.id} ORDER BY created_at ASC`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/conversations/:id/messages", async (req, res) => {
  const { type, sender, content, file_url } = req.body;
  if (!type || (!content && !file_url)) return res.status(400).json({ error: "type and content or file_url required" });
  // Allowed types: visitor, agent, bot, system, note
  const validTypes = ["visitor","agent","bot","system","note"];
  const msgType = validTypes.includes(type) ? type : "agent";
  try {
    await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_url TEXT`.catch(()=>{});
    const rows = await sql`
      INSERT INTO messages (conversation_id, type, sender, content, file_url)
      VALUES (${req.params.id}, ${msgType}, ${sender}, ${content||""}, ${file_url||null})
      RETURNING *
    `;
    await sql`UPDATE conversations SET updated_at = NOW() WHERE id = ${req.params.id}`;
    if (msgType === "agent") {
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
    const canonicalId = org_id ? await resolveOrgId(org_id) : null;
    const rows = canonicalId
      ? await sqlForOrg(canonicalId, sql`SELECT * FROM alert_log WHERE org_id = ${canonicalId} ORDER BY created_at DESC`)
      : await sqlForOrg(null, sql`SELECT * FROM alert_log ORDER BY created_at DESC`);
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
    if (!org_id) return res.status(400).json({ error: "org_id required" });
    const canonicalId = await resolveOrgId(org_id);
    if (!canonicalId) return res.status(404).json({ error: "Organisation not found" });
    const [rows] = await sqlManyForOrg(canonicalId, [sql`SELECT * FROM kb_documents WHERE org_id = ${canonicalId} ORDER BY created_at DESC`]); // sqlManyForOrg already sets RLS context
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
    await sql`ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS content TEXT`.catch(()=>{});
    await sql`ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS tertiary TEXT`.catch(()=>{});
    const rows = await sql`
      INSERT INTO kb_documents (org_id, name, category, sub_category, tertiary, size_kb, chunks, content)
      VALUES (${org_id}, ${name}, ${category}, ${sub_category}, ${size_kb}, ${chunks || 0}, ${req.body.content || null})
      RETURNING *
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/kb/:id", async (req, res) => {
  const { name, category, sub_category, tertiary, chunks, status, org_id, content } = req.body;
  try {
    if (org_id) {
      const check = await sql`SELECT id FROM kb_documents WHERE id = ${req.params.id} AND org_id = ${org_id} LIMIT 1`;
      if (!check.length) return res.status(403).json({ error: "Not authorised" });
    }
    await sql`ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS content TEXT`.catch(()=>{});
    await sql`ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS tertiary TEXT`.catch(()=>{});
    const rows = await sql`
      UPDATE kb_documents SET
        name         = CASE WHEN ${name}         IS NOT NULL THEN ${name}         ELSE name END,
        category     = CASE WHEN ${category}     IS NOT NULL THEN NULLIF(${category},'')     ELSE category END,
        sub_category = CASE WHEN ${sub_category} IS NOT NULL THEN NULLIF(${sub_category},'') ELSE sub_category END,
        tertiary     = CASE WHEN ${tertiary}     IS NOT NULL THEN NULLIF(${tertiary},'')     ELSE tertiary END,
        chunks       = COALESCE(${chunks},       chunks),
        status       = COALESCE(${status},       status),
        content      = CASE WHEN ${content}      IS NOT NULL THEN ${content}      ELSE content END,
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
    const { org_id } = req.query;
    if (org_id) {
      const check = await sql`SELECT id FROM kb_documents WHERE id = ${req.params.id} AND org_id = ${org_id} LIMIT 1`;
      if (!check.length) return res.status(403).json({ error: "Not authorised" });
    }
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
// ── Forgot Password ───────────────────────────────────────────────────────────
// Sends a password reset link via email. Works for both tenant admins and agents.
// Always returns success (avoids email enumeration).
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  const emailLower = email.toLowerCase().trim();
  res.json({ ok: true }); // Always respond OK immediately (no enumeration)

  // Run lookup + email send async (fire-and-forget)
  (async () => {
    try {
      // Check tenant admins first
      let org = null;
      let agent = null;
      let name = "";
      let orgId = null;

      const orgRows = await sql`SELECT * FROM organisations WHERE email = ${emailLower} LIMIT 1`.catch(()=>[]);
      if (orgRows.length) {
        org = orgRows[0];
        orgId = org.id;
        name = org.name || "there";
      } else {
        // Check agents table
        const agentRows = await sql`SELECT a.*, o.id as org_id FROM agents a JOIN organisations o ON o.id = a.org_id WHERE a.email = ${emailLower} LIMIT 1`.catch(()=>[]);
        if (agentRows.length) {
          agent = agentRows[0];
          orgId = agent.org_id;
          name = agent.name || "there";
        }
      }

      if (!orgId) return; // No account — silent exit

      // Generate a time-limited reset token (valid 1 hour)
      const token = crypto.randomBytes(32).toString("hex");
      const expiry = new Date(Date.now() + 3600000).toISOString();

      // Store token in tenant_configs for this org
      const [existing] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${orgId} LIMIT 1`.catch(()=>[null]);
      const cfg = existing?.config || {};
      cfg._resetToken = { token, expiry, email: emailLower };
      await sql`
        INSERT INTO tenant_configs (tenant_id, config)
        VALUES (${orgId}, ${JSON.stringify(cfg)})
        ON CONFLICT (tenant_id) DO UPDATE SET config = ${JSON.stringify(cfg)}
      `.catch(()=>{});

      // Build reset URL
      const baseUrl = "https://chatbot.hindleconsultants.com";
      const resetUrl = `${baseUrl}?reset=${token}&org=${orgId}`;

      // Send email
      const { smtpCfg, csCfg } = await loadEmailConfig(orgId).catch(()=>({smtpCfg:null,csCfg:null}));
      await sendEmail({
        to: emailLower,
        toName: name,
        subject: "Reset your Hindle password",
        body: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 12px;color:#1e293b">Reset your password</h2>
  <p style="color:#64748b;margin:0 0 20px">Hi ${name},<br><br>We received a request to reset your Hindle password. Click the button below to set a new password. This link expires in 1 hour.</p>
  <a href="${resetUrl}" style="display:inline-block;background:#3B82F6;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:15px;margin-bottom:20px">Reset Password →</a>
  <p style="color:#94a3b8;font-size:12px;margin:16px 0 0">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
</div>`,
        smtpCfg,
        csCfg,
      }).catch(e => console.error("[ForgotPW] email error:", e.message));

      console.log(`[ForgotPW] Reset link sent to ${emailLower}`);
    } catch (e) {
      console.error("[ForgotPW] error:", e.message);
    }
  })();
});

// ── Reset Password (token verify + set new password) ─────────────────────────
app.post("/api/auth/reset-password", async (req, res) => {
  const { token, orgId, newPassword } = req.body;
  if (!token || !orgId || !newPassword) return res.status(400).json({ error: "Missing fields" });
  if (newPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  try {
    const [cfgRow] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${orgId} LIMIT 1`.catch(()=>[null]);
    const cfg = cfgRow?.config || {};
    const rt = cfg._resetToken;
    if (!rt || rt.token !== token) return res.status(400).json({ error: "Invalid or expired reset link" });
    if (new Date(rt.expiry) < new Date()) return res.status(400).json({ error: "Reset link has expired. Please request a new one." });

    const hash = await bcrypt.hash(newPassword, 10);
    const email = rt.email;

    // Update org (tenant admin) or agent password
    const orgRows = await sql`SELECT id FROM organisations WHERE email = ${email} AND id = ${orgId} LIMIT 1`.catch(()=>[]);
    if (orgRows.length) {
      // Tenant admin — store hashed password in tenant_configs
      const updated = { ...cfg, _adminPasswordHash: hash };
      delete updated._resetToken;
      await sql`UPDATE tenant_configs SET config = ${JSON.stringify(updated)} WHERE tenant_id = ${orgId}`;
    } else {
      // Agent
      await sql`UPDATE agents SET password_hash = ${hash}, must_change_password = false WHERE email = ${email} AND org_id = ${orgId}`.catch(()=>{});
      const updated = { ...cfg };
      delete updated._resetToken;
      await sql`UPDATE tenant_configs SET config = ${JSON.stringify(updated)} WHERE tenant_id = ${orgId}`;
    }

    await writeAudit(orgId, "password_reset", `Password reset for ${email}`, { email }).catch(()=>{});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────


app.post("/api/auth", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: "email and password required" });

  // 1. Try tenant admin (organisations table)
  try {
    const rows = await sql`SELECT * FROM organisations WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1`;
    if (rows.length) {
      const org = rows[0];
      let storedPass = null;
      let isHashed = false;
      try {
        const cfg = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${org.id} LIMIT 1`;
        if (cfg.length) {
          // Check bcrypt hash first (set via password reset)
          if (cfg[0].config?._adminPasswordHash) { storedPass = cfg[0].config._adminPasswordHash; isHashed = true; }
          // Fall back to plain text password
          else if (cfg[0].config?.admin_password) { storedPass = cfg[0].config.admin_password; isHashed = false; }
        }
      } catch (_) {}
      if (!storedPass) storedPass = "admin"; // default if nothing set
      const passOk = isHashed ? await bcrypt.compare(password, storedPass) : (password === storedPass);
      if (!passOk) return res.status(401).json({ ok: false, error: "Incorrect password." });
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
    // Support both plain-text (legacy) and bcrypt-hashed passwords
    const agentPassOk = agent.password_hash.startsWith("$2") 
      ? await bcrypt.compare(password, agent.password_hash)
      : agent.password_hash === password;
    if (!agentPassOk) return res.status(401).json({ ok: false, error: "Incorrect password." });
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
    visitorLocation: widgetLocation,
    page,
    url,
    history,
  } = req.body;

  console.log(`[Handoff] ▶ tenantId="${tenantId}" existingConvId="${existingConvId||"none"}" visitor="${visitorName||visitorEmail||"anon"}"`);

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
  let resolvedOrgId = await resolveOrgId(tenantId);
  console.log(`[Handoff] org lookup → tenantId="${tenantId}" resolvedOrgId="${resolvedOrgId||"NOT FOUND"}"`);
  if (!resolvedOrgId) {
    console.error(`[Handoff] CRITICAL: cannot resolve org for tenantId="${tenantId}" — conv will NOT be created`);
  }

  // ── Resolve visitor location ─────────────────────────────────────────
  let resolvedLocation = widgetLocation || null;
  if (!resolvedLocation) {
    try {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
      if (ip && ip !== "127.0.0.1" && ip !== "::1" && !ip.startsWith("::ffff:127")) {
        // Try ip-api.com first (generous free tier)
        let geoOk = false;
        try {
          const geoR = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country`);
          if (geoR.ok) {
            const geo = await geoR.json();
            if (geo.status === "success" && (geo.city || geo.country)) {
              resolvedLocation = [geo.city, geo.regionName, geo.country].filter(Boolean).join(", ");
              geoOk = true;
              console.log(`[Handoff] geo (ip-api): "${resolvedLocation}" ip="${ip}"`);
            }
          }
        } catch (_) {}
        if (!geoOk) {
          try {
            const geoR2 = await fetch(`https://ipapi.co/${ip}/json/`);
            if (geoR2.ok) {
              const geo2 = await geoR2.json();
              if (geo2.city || geo2.country_name) {
                resolvedLocation = [geo2.city, geo2.region, geo2.country_name].filter(Boolean).join(", ");
                console.log(`[Handoff] geo (ipapi.co): "${resolvedLocation}" ip="${ip}"`);
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

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
        INSERT INTO conversations (org_id, visitor_name, visitor_email, visitor_phone, visitor_company, visitor_location, page, subject, status)
        VALUES (${resolvedOrgId}, ${visitorLabel}, ${visitorEmail || null}, ${visitorPhone || null}, ${visitorCompany || null}, ${resolvedLocation || null}, ${page || "/"}, ${("Handoff: " + (visitorLabel || "visitor")).slice(0,80)}, 'handoff')
        RETURNING *
      `;
      conversationId = convRows[0]?.id;
      console.log(`[Handoff] created conv id="${conversationId}" org="${resolvedOrgId}" loc="${resolvedLocation||"none"}"`)
    } else if (conversationId) {
      await sql`
        UPDATE conversations SET
          status           = 'handoff',
          visitor_name     = COALESCE(NULLIF(${visitorLabel},''), visitor_name),
          visitor_email    = COALESCE(${visitorEmail||null}, visitor_email),
          visitor_phone    = COALESCE(${visitorPhone||null}, visitor_phone),
          visitor_company  = COALESCE(${visitorCompany||null}, visitor_company),
          visitor_location = COALESCE(${resolvedLocation||null}, visitor_location),
          updated_at       = NOW()
        WHERE id = ${conversationId}
      `;
      console.log(`[Handoff] updated conv id="${conversationId}" status=handoff loc="${resolvedLocation||"none"}"`)
    } else {
      console.log(`[Handoff] WARNING: no conversationId and no resolvedOrgId — conv not created!`);
    }
  } catch (e) { console.error("[Handoff] conv upsert error:", e.message); }

  // ── Build magic link ──────────────────────────────────────────────────
  const handoffToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const magicUrl = `https://chatbot.hindleconsultants.com/?token=${handoffToken}${conversationId?"&conv="+conversationId:""}`;

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
    const hashedPw = await bcrypt.hash(password, 10);
    const rows = await sql`UPDATE agents SET password_hash = ${hashedPw}, must_change_password = false WHERE LOWER(email) = LOWER(${email}) RETURNING id, name, email, role`;
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
    await sql`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS plan_snapshot JSONB DEFAULT NULL`;
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
      plan_snapshot: org.plan_snapshot || null,
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
      // Snapshot plan limits+features at time of change
      try {
        const [snCfg] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`.catch(()=>[null]);
        const snSc = snCfg?.config?._superConfig || {};
        const snApl = snSc.planLimits || null;
        const snBase = (snApl && snApl[plan]) || PLAN_LIMITS[plan] || PLAN_LIMITS.free;
        const snSnap = { plan, snapped_at: new Date().toISOString(), limits: { ...snBase }, features: snSc.planFeatures ? (snSc.planFeatures[plan] || []) : [], changed_by: "admin", note: note||"" };
        await sql`UPDATE organisations SET plan_snapshot = ${JSON.stringify(snSnap)} WHERE id = ${org.id}`.catch(()=>{});
      } catch(_) {}
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
    } else if (action === "snapshot_plan") {
      // Manually snapshot current plan limits+features for this tenant
      const apl = await getAdminPlanLimits();
      const planBase = (apl && apl[org.plan]) || PLAN_LIMITS[org.plan] || PLAN_LIMITS.free;
      const [platCfg] = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform' LIMIT 1`.catch(()=>[null]);
      const sc = platCfg?.config?._superConfig || {};
      const snapshot = {
        plan: org.plan,
        snapped_at: new Date().toISOString(),
        limits: { ...planBase },
        features: sc.planFeatures ? (sc.planFeatures[org.plan] || []) : [],
      };
      [updated] = await sql`UPDATE organisations SET plan_snapshot = ${JSON.stringify(snapshot)} WHERE id = ${org.id} RETURNING *`;
      await writeAudit(org.id, "plan_snapshotted", `Plan snapshot taken for ${org.plan}`, { plan: org.plan, limits: planBase });
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
        const { smtpCfg: trSmtp, csCfg: trCs } = await loadEmailConfig(org.id).catch(()=>({smtpCfg:null,csCfg:cs}));
        const trResult = await sendEmail({ to: org.email, toName: org.name||"Tenant", subject, body: htmlBody, smtpCfg: trSmtp, csCfg: trCs });
        const sent = trResult.ok;

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

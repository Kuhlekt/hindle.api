const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { neon } = require("@neondatabase/serverless");

const _sql = neon(process.env.DATABASE_URL);
// Retry wrapper — Neon serverless can fail on cold start; retry once after 800ms
const sql = new Proxy(_sql, {
  apply: async (target, thisArg, args) => {
    try { return await target.apply(thisArg, args); }
    catch (e) {
      if (e.message && (e.message.includes("connection") || e.message.includes("timeout") || e.message.includes("ECONNRESET"))) {
        await new Promise(r => setTimeout(r, 800));
        return await target.apply(thisArg, args);
      }
      throw e;
    }
  },
  get: (target, prop) => {
    const val = target[prop];
    return typeof val === "function" ? val.bind(target) : val;
  }
});
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const tenantConfigsMemory = {};

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
// AI CHAT
// ─────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { system, messages, tenantId, conversationId } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "messages array required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set on server" });

  let effectiveSystem = system || null;
  if (!effectiveSystem && tenantId) {
    try {
      let cfg = tenantConfigsMemory[tenantId];
      if (!cfg) {
        const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${tenantId}`;
        if (rows.length) { cfg = rows[0].config; tenantConfigsMemory[tenantId] = cfg; }
      }
      if (cfg && cfg.systemPrompt) {
        effectiveSystem = cfg.systemPrompt;
        if (cfg.kb && cfg.kb.length) {
          const kbCtx = cfg.kb.filter(d => d.content).map(d => "=== " + (d.title||d.name) + " ===\n" + d.content).join("\n\n");
          if (kbCtx) effectiveSystem += "\n\nAnswer from the knowledge base below. Do not answer questions about topics not covered here — say you will connect the visitor to a human instead.\n\n" + kbCtx;
        }
      }
    } catch (_) {}
  }
  if (system && tenantId) {
    try {
      let cfg = tenantConfigsMemory[tenantId];
      if (!cfg) {
        const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${tenantId}`;
        if (rows.length) { cfg = rows[0].config; tenantConfigsMemory[tenantId] = cfg; }
      }
      if (cfg && cfg.kb && cfg.kb.length) {
        const kbCtx = cfg.kb.filter(d => d.content).map(d => "=== " + (d.title||d.name) + " ===\n" + d.content).join("\n\n");
        if (kbCtx && !effectiveSystem.includes("knowledge base")) {
          effectiveSystem += "\n\nAnswer from the knowledge base below. Do not answer questions about topics not covered here — say you will connect the visitor to a human instead.\n\n" + kbCtx;
        }
      }
    } catch (_) {}
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        system: effectiveSystem || "You are a helpful support assistant. Answer concisely and helpfully.",
        messages: messages.map((m) => ({
          role: m.role === "visitor" || m.role === "user" ? "user" : "assistant",
          content: m.content || m.text || "",
        })),
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: "Anthropic API error", detail: err });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || "";

    if (conversationId) {
      try {
        await sql`UPDATE conversations SET updated_at = NOW() WHERE id = ${conversationId}`;
      } catch (_) {}
    }

    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// TENANT CONFIG
// ─────────────────────────────────────────────
app.post("/api/tenant-config", async (req, res) => {
  const { tenantId, ...config } = req.body;
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  try {
    // Deep-merge with existing config so partial saves (e.g. just clicksend) don't wipe other keys
    const existing = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${tenantId}`;
    const merged = existing.length ? { ...existing[0].config, ...config } : config;
    // Deep-merge nested objects (clicksend, brand, etc.)
    for (const key of Object.keys(config)) {
      if (config[key] && typeof config[key] === "object" && !Array.isArray(config[key]) && existing.length && existing[0].config[key]) {
        merged[key] = { ...existing[0].config[key], ...config[key] };
      }
    }
    const payload = JSON.stringify(merged);
    await sql`
      INSERT INTO tenant_configs (tenant_id, config, updated_at)
      VALUES (${tenantId}, ${payload}::jsonb, NOW())
      ON CONFLICT (tenant_id) DO UPDATE
        SET config = ${payload}::jsonb, updated_at = NOW()
    `;
    const orgName = merged.widget_name || (merged.brand && merged.brand.name) || null;
    if (orgName) {
      try { await sql`UPDATE organisations SET tenant_id = ${tenantId} WHERE name = ${orgName} AND (tenant_id IS NULL OR tenant_id = ${tenantId})`; } catch (_) {}
    }
    tenantConfigsMemory[tenantId] = { ...merged, updatedAt: new Date().toISOString() };
    res.json({ ok: true, tenantId, storage: "db" });
  } catch (e) {
    tenantConfigsMemory[tenantId] = { ...tenantConfigsMemory[tenantId], ...config, updatedAt: new Date().toISOString() };
    console.error("tenant-config DB error:", e.message);
    res.json({ ok: true, tenantId, storage: "memory", warning: e.message });
  }
});

app.get("/api/tenant-config/:tenantId", async (req, res) => {
  const { tenantId } = req.params;
  try {
    const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${tenantId}`;
    if (rows.length) return res.json(rows[0].config);
    const orgRows = await sql`SELECT id FROM organisations WHERE tenant_id = ${tenantId} OR id::text = ${tenantId} LIMIT 1`;
    if (orgRows.length) {
      const uuid  = orgRows[0].id;
      const rows2 = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${uuid}`;
      if (rows2.length) return res.json(rows2[0].config);
    }
  } catch (e) {
    console.error("tenant-config GET error:", e.message);
    return res.status(500).json({ error: "DB error: " + e.message });
  }
  const cfg = tenantConfigsMemory[tenantId];
  if (!cfg) return res.status(404).json({ error: "No config found" });
  res.json(cfg);
});

// ─────────────────────────────────────────────
// HANDOFF  — notify agents via ClickSend SMS with magic link
// POST /api/handoff
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

  // Load tenant config
  let tenantConfig = tenantConfigsMemory[tenantId] || {};
  try {
    const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${tenantId}`;
    if (rows.length) tenantConfig = rows[0].config;
  } catch (e) {}

  // If tenant has no clicksend credentials, fall back to platform-level creds
  if (!tenantConfig?.clicksend?.username) {
    try {
      let pCfg = tenantConfigsMemory["platform"] || {};
      if (!pCfg?.clicksend?.username) {
        const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform'`;
        if (rows.length) { pCfg = rows[0].config; tenantConfigsMemory["platform"] = pCfg; }
      }
      if (pCfg?.clicksend?.username) {
        tenantConfig = { ...tenantConfig, clicksend: { ...pCfg.clicksend, ...(tenantConfig.clicksend || {}) } };
      }
    } catch (e) {}
  }

  // Last resort — find any tenant_configs row with clicksend credentials
  if (!tenantConfig?.clicksend?.username) {
    try {
      const rows = await sql`SELECT config FROM tenant_configs WHERE (config->'clicksend'->>'username') IS NOT NULL AND (config->'clicksend'->>'username') != '' LIMIT 1`;
      if (rows.length && rows[0].config?.clicksend?.username) {
        tenantConfig = { ...tenantConfig, clicksend: { ...rows[0].config.clicksend, ...(tenantConfig.clicksend || {}) } };
      }
    } catch (e) {}
  }

  const csRaw      = tenantConfig.clicksend || {};
  const agents_cfg = tenantConfig.agents    || [];
  const smsSender  = csRaw.smsSender || "SUPPORT";
  const handoffToken = Math.random().toString(36).slice(2, 10).toUpperCase();
  const visitorLabel = visitorName || visitorEmail || "Website Visitor";

  // Build effective cs — credentials may come from fallback, configured flag must reflect actual creds
  const cs = { ...csRaw, configured: !!(csRaw.username && csRaw.apiKey) };

  // Load agents from DB (source of truth), fall back to config-embedded agents
  let agentsList = [];
  try {
    const orgRows2 = await sql`SELECT id FROM organisations WHERE tenant_id = ${tenantId} OR id::text = ${tenantId} LIMIT 1`;
    if (orgRows2.length) {
      const dbAgents = await sql`SELECT * FROM agents WHERE org_id = ${orgRows2[0].id} AND active = true`;
      agentsList = dbAgents.length ? dbAgents : agents_cfg;
      console.log(`[Handoff] org found: ${orgRows2[0].id}, agents: ${dbAgents.length}`);
    } else {
      agentsList = agents_cfg;
      console.log(`[Handoff] no org found for tenantId: ${tenantId}, using config agents: ${agents_cfg.length}`);
    }
  } catch (e) { agentsList = agents_cfg; console.log(`[Handoff] agent lookup error: ${e.message}`); }

  // ── Resolve / create conversation ─────────────────────────────────────────
  // IMPORTANT: declare conversationId BEFORE building magicUrl
  let conversationId = existingConvId || null;
  let resolvedOrgId = null;

  try {
    const orgRows = await sql`SELECT id FROM organisations WHERE tenant_id = ${tenantId} OR id::text = ${tenantId} LIMIT 1`;
    const orgId   = orgRows.length ? orgRows[0].id : null;
    resolvedOrgId = orgId;
    console.log(`[Handoff] conversation orgId: ${orgId}, conversationId: ${conversationId}`);

    if (conversationId) {
      await sql`
        UPDATE conversations
        SET status = 'handoff',
            visitor_name    = ${visitorLabel},
            visitor_email   = ${visitorEmail   || null},
            visitor_phone   = ${visitorPhone   || null},
            visitor_company = ${visitorCompany || null},
            updated_at      = NOW()
        WHERE id = ${conversationId}
      `;
    } else {
      const convRows = await sql`
        INSERT INTO conversations (org_id, visitor_name, visitor_email, visitor_phone, visitor_company, page, status)
        VALUES (${orgId}, ${visitorLabel}, ${visitorEmail || null}, ${visitorPhone || null}, ${visitorCompany || null}, ${page || "/"}, 'handoff')
        RETURNING id
      `;
      conversationId = convRows[0].id;
      if (history && history.length) {
        for (const msg of history.slice(-20)) {
          const mtype  = msg.role === "assistant" ? "bot" : "visitor";
          const sender = msg.role === "assistant" ? "AI" : visitorLabel;
          await sql`INSERT INTO messages (conversation_id, type, sender, content) VALUES (${conversationId}, ${mtype}, ${sender}, ${msg.content || msg.text || ""})`;
        }
      }
    }
    await sql`INSERT INTO messages (conversation_id, type, sender, content) VALUES (${conversationId}, 'system', 'System', ${"Visitor requested a human agent"})`;
  } catch (e) {
    console.warn("Handoff conversation error:", e.message);
  }

  // ── Build magic URL — conversationId is safely declared above ─────────────
  const magicUrl =
    "https://chatbot.hindleconsultants.com/?token=" +
    handoffToken +
    (conversationId ? "&conv=" + conversationId : "");

  // ── Log alert ──────────────────────────────────────────────────────────────
  try {
    await sql`
      INSERT INTO alert_log (org_id, conversation_id, agent_name, mobile, visitor_name, page, token)
      VALUES (${resolvedOrgId || tenantId}, ${conversationId || null}, ${"Widget Handoff"}, ${"—"}, ${visitorLabel}, ${page || "/"}, ${handoffToken})
    `;
  } catch (e) {}

  // ── Send SMS via ClickSend ─────────────────────────────────────────────────
  let smsSent = false, smsError = null, smsTargets = 0;

  if (cs.username && cs.apiKey) {
    const targets = agentsList.filter((a) => a.mobile && a.sms_alerts !== false && a.smsAlerts !== false && a.active !== false);
    smsTargets = targets.length;
    console.log(`[Handoff] SMS: creds ok, agents: ${agentsList.length}, targets with mobile+smsAlerts: ${targets.length}`);
    if (targets.length) {
      try {
        const auth    = "Basic " + Buffer.from(cs.username + ":" + cs.apiKey).toString("base64");
        const smsBody = "[" + smsSender + "] " + visitorLabel + " on " + (page || "/") + " wants to chat. Join: " + magicUrl;
        const msgs    = targets.map((a) => ({ source: "sdk", to: a.mobile, from: smsSender, body: smsBody, schedule: 0 }));
        const r = await fetch("https://rest.clicksend.com/v3/sms/send", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ messages: msgs }),
          signal: AbortSignal.timeout(8000),
        });
        const d = await r.json();
        smsSent  = d?.data?.messages?.every((m) => m.status === "SUCCESS");
        smsError = smsSent ? null : (d?.data?.messages?.[0]?.status || "Send failed");
        try { await sql`UPDATE alert_log SET status = ${smsSent ? "sent" : "failed"} WHERE token = ${handoffToken}`; } catch (_) {}
      } catch (e) { smsError = e.message; }
    } else {
      smsError = "No agents with mobile + SMS alerts enabled";
    }
  } else {
    smsError = "ClickSend credentials not available — check platform integration settings";
    console.log(`[Handoff] No ClickSend creds. cs.username=${cs.username||"none"}`);
  }

  res.json({
    ok: true, smsSent, smsTargets, smsError, token: handoffToken, conversationId,
    message: smsSent ? "SMS sent to " + smsTargets + " agent(s)" : "Handoff logged — " + (smsError || "SMS not configured"),
  });
});

// ─────────────────────────────────────────────
// FETCH URL (KB proxy)
// ─────────────────────────────────────────────
app.post("/api/fetch-url", async (req, res) => {
  const { url } = req.body;
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://")))
    return res.status(400).json({ error: "Valid URL required" });
  try {
    const r = await fetch(url, { headers: { "User-Agent": "HindleBot/1.0" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(502).json({ error: "Remote returned " + r.status });
    const html = await r.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 20000);
    res.json({ text, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// ORGANISATIONS
// ─────────────────────────────────────────────
app.get("/api/tenants", async (req, res) => {
  try { res.json(await sql`SELECT * FROM organisations ORDER BY created_at DESC`); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/org-by-email/:email", async (req, res) => {
  try {
    const agents = await sql`SELECT * FROM agents WHERE LOWER(email) = LOWER(${req.params.email}) LIMIT 1`;
    if (!agents.length) return res.status(404).json({ error: "not found" });
    const agent = agents[0];
    if (agent.org_id) {
      const orgs = await sql`SELECT * FROM organisations WHERE id = ${agent.org_id} LIMIT 1`;
      if (orgs.length) return res.json(orgs[0]);
    }
    const orgs = await sql`SELECT * FROM organisations WHERE LOWER(email) = LOWER(${req.params.email}) LIMIT 1`;
    if (orgs.length) return res.json(orgs[0]);
    const allOrgs = await sql`SELECT * FROM organisations ORDER BY created_at LIMIT 1`;
    if (allOrgs.length) return res.json(allOrgs[0]);
    return res.status(404).json({ error: "not found" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/tenants/:id", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM organisations WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/tenants", async (req, res) => {
  const { name, email, plan = "free" } = req.body;
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  try { res.status(201).json((await sql`INSERT INTO organisations (name, email, plan) VALUES (${name}, ${email}, ${plan}) RETURNING *`)[0]); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/tenants/:id", async (req, res) => {
  const { name, email, plan, status } = req.body;
  try {
    const rows = await sql`UPDATE organisations SET name=COALESCE(${name},name), email=COALESCE(${email},email), plan=COALESCE(${plan},plan), status=COALESCE(${status},status) WHERE id=${req.params.id} RETURNING *`;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/tenants/:id", async (req, res) => {
  try { await sql`DELETE FROM organisations WHERE id = ${req.params.id}`; res.json({ deleted: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────
app.post("/api/auth/check-email", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  try {
    const rows = await sql`SELECT id, name, email, role, active FROM agents WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: "no_account" });
    const a = rows[0];
    if (a.active === false) return res.status(403).json({ error: "disabled" });
    res.json({ ok: true, id: a.id, name: a.name, email: a.email, role: a.role || "agent" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const magicTokens = {};

app.post("/api/auth/magic-link", async (req, res) => {
  const { email, mobile } = req.body;
  if (!email && !mobile) return res.status(400).json({ error: "email or mobile required" });
  try {
    let rows;
    if (email) {
      rows = await sql`SELECT id, name, email, role, active FROM agents WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
    } else {
      rows = await sql`SELECT id, name, email, role, active, mobile FROM agents WHERE mobile = ${mobile} LIMIT 1`;
    }
    if (!rows.length) return res.status(404).json({ error: "no_account" });
    const agent = rows[0];
    if (agent.active === false) return res.status(403).json({ error: "disabled" });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const key  = email ? email.toLowerCase() : mobile;
    magicTokens[key] = { code, expires: Date.now() + 15 * 60 * 1000, id: agent.id, email: agent.email, role: agent.role || "agent", name: agent.name || "" };

    let sent = false;
    try {
      let csUser = process.env.CLICKSEND_USER || "";
      let csKey  = process.env.CLICKSEND_KEY  || "";
      if (!csUser) {
        for (const k of Object.keys(tenantConfigsMemory)) {
          const c = tenantConfigsMemory[k];
          if (c?.clicksend?.username && c?.clicksend?.apiKey) { csUser = c.clicksend.username; csKey = c.clicksend.apiKey; break; }
        }
      }
      if (!csUser) {
        const cfgRows = await sql`SELECT config FROM tenant_configs LIMIT 5`;
        for (const row of cfgRows) {
          const c = row.config;
          if (c?.clicksend?.username && c?.clicksend?.apiKey) { csUser = c.clicksend.username; csKey = c.clicksend.apiKey; break; }
        }
      }
      if (csUser && csKey) {
        const auth = Buffer.from(csUser + ":" + csKey).toString("base64");
        if (mobile) {
          const smsBody = { messages: [{ source: "sdk", body: "Your Hindle sign-in code: " + code + " (expires in 15 min)", to: mobile, _from: "Hindle" }] };
          const r = await fetch("https://rest.clicksend.com/v3/sms/send", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Basic " + auth }, body: JSON.stringify(smsBody) });
          sent = r.ok;
        } else {
          const emailBody = { to: [{ email: agent.email, name: agent.name || "" }], from: { email_address_id: 0, name: "Hindle Platform", email: csUser }, subject: "Your Hindle sign-in code: " + code, body: "<p>Hi " + (agent.name||"") + ",</p><p>Your sign-in code is: <strong style=\"font-size:28px\">" + code + "</strong></p><p>This code expires in 15 minutes.</p>" };
          const r = await fetch("https://rest.clicksend.com/v3/transactional-email/send", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Basic " + auth }, body: JSON.stringify(emailBody) });
          sent = r.ok;
        }
      }
    } catch (sendErr) { console.error("Magic link send error:", sendErr.message); }

    if (!sent) console.log("[Hindle] Magic code for", key, ":", code);
    res.json({ ok: true, sent, hint: sent ? undefined : code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/magic-verify", async (req, res) => {
  const { email, mobile, token } = req.body;
  const key = email ? email.toLowerCase() : mobile;
  if (!key || !token) return res.status(400).json({ error: "key and token required" });
  const record = magicTokens[key];
  if (!record) return res.status(400).json({ error: "No code found. Request a new one." });
  if (Date.now() > record.expires) { delete magicTokens[key]; return res.status(400).json({ error: "Code expired. Request a new one." }); }
  if (record.code !== String(token).trim()) return res.status(400).json({ error: "Incorrect code. Try again." });
  delete magicTokens[key];
  res.json({ ok: true, id: record.id, email: record.email, role: record.role, name: record.name });
});

app.post("/api/auth", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  try {
    const rows = await sql`SELECT * FROM agents WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: "no_account" });
    const agent = rows[0];
    if (agent.active === false) return res.status(403).json({ error: "disabled" });
    if (!agent.password_hash) return res.status(401).json({ error: "no_password" });
    if (agent.password_hash !== password) return res.status(401).json({ error: "wrong_password" });
    let orgId = agent.org_id || null;
    if (!orgId) {
      try {
        const orgByEmail = await sql`SELECT id FROM organisations WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
        if (orgByEmail.length) { orgId = orgByEmail[0].id; await sql`UPDATE agents SET org_id=${orgId} WHERE id=${agent.id}`; }
      } catch (_) {}
    }
    res.json({ ok: true, id: agent.id, name: agent.name, email: agent.email, role: agent.role || "agent", org_id: orgId, mustChangePassword: agent.must_change_password || false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/set-password", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  try {
    const rows = await sql`UPDATE agents SET password_hash=${password}, must_change_password=false WHERE LOWER(email)=LOWER(${email}) RETURNING id, name, email, role`;
    if (!rows.length) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, ...rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// AGENTS
// ─────────────────────────────────────────────
app.get("/api/agents", async (req, res) => {
  try {
    const { org_id } = req.query;
    res.json(org_id ? await sql`SELECT * FROM agents WHERE org_id=${org_id} ORDER BY name` : await sql`SELECT * FROM agents ORDER BY name`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/agents", async (req, res) => {
  const { org_id, name, email, mobile, role = "agent", password, mustChangePassword } = req.body;
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  try {
    const pw  = password || null;
    const mcp = mustChangePassword !== false;
    const existing = await sql`SELECT id FROM agents WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
    let rows;
    if (existing.length) {
      rows = await sql`
        UPDATE agents SET
          name = ${name},
          mobile = COALESCE(${mobile || null}, mobile),
          role = ${role},
          password_hash = CASE WHEN ${pw}::text IS NOT NULL THEN ${pw} ELSE password_hash END,
          must_change_password = ${mcp},
          active = true
        WHERE LOWER(email) = LOWER(${email})
        RETURNING *
      `;
    } else {
      rows = await sql`
        INSERT INTO agents (org_id, name, email, mobile, role, password_hash, must_change_password)
        VALUES (${org_id}, ${name}, ${email}, ${mobile || null}, ${role}, ${pw}, ${mcp})
        RETURNING *
      `;
    }
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error("POST /api/agents error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/agents/:id", async (req, res) => {
  const { name, email, mobile, role, status, sms_alerts, password, mustChangePassword, active } = req.body;
  try {
    const rows = await sql`
      UPDATE agents SET
        name=COALESCE(${name ?? null},name),
        email=COALESCE(${email ?? null},email),
        mobile=COALESCE(${mobile ?? null},mobile),
        role=COALESCE(${role ?? null},role),
        status=COALESCE(${status ?? null},status),
        sms_alerts=COALESCE(${sms_alerts ?? null},sms_alerts),
        password_hash=CASE WHEN ${password ?? null}::text IS NOT NULL THEN ${password ?? null} ELSE password_hash END,
        must_change_password=COALESCE(${mustChangePassword ?? null},must_change_password),
        active=COALESCE(${active ?? null},active)
      WHERE id=${req.params.id} RETURNING *`;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/agents/:id", async (req, res) => {
  try { await sql`DELETE FROM agents WHERE id=${req.params.id}`; res.json({ deleted: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// CONVERSATIONS
// ─────────────────────────────────────────────
app.get("/api/conversations", async (req, res) => {
  try {
    const { org_id, status } = req.query;
    if (!org_id && req.query.super !== "1") return res.json([]);
    let rows;
    if (org_id && status) rows = await sql`SELECT c.*, a.name as agent_name FROM conversations c LEFT JOIN agents a ON c.assigned_agent_id=a.id WHERE c.org_id=${org_id} AND c.status=${status} ORDER BY c.updated_at DESC`;
    else if (org_id) rows = await sql`SELECT c.*, a.name as agent_name FROM conversations c LEFT JOIN agents a ON c.assigned_agent_id=a.id WHERE c.org_id=${org_id} ORDER BY c.updated_at DESC`;
    else rows = await sql`SELECT c.*, a.name as agent_name FROM conversations c LEFT JOIN agents a ON c.assigned_agent_id=a.id ORDER BY c.updated_at DESC`;
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/conversations/:id", async (req, res) => {
  try {
    const rows = await sql`SELECT c.*, a.name as agent_name FROM conversations c LEFT JOIN agents a ON c.assigned_agent_id=a.id WHERE c.id=${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/conversations", async (req, res) => {
  const { org_id, visitor_name, visitor_email, page } = req.body;
  try { res.status(201).json((await sql`INSERT INTO conversations (org_id, visitor_name, visitor_email, page) VALUES (${org_id},${visitor_name},${visitor_email},${page}) RETURNING *`)[0]); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/conversations/:id", async (req, res) => {
  const { status, assigned_agent_id } = req.body;
  try {
    const rows = await sql`UPDATE conversations SET status=COALESCE(${status},status), assigned_agent_id=COALESCE(${assigned_agent_id},assigned_agent_id), updated_at=NOW() WHERE id=${req.params.id} RETURNING *`;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/conversations/:id", async (req, res) => {
  try { await sql`DELETE FROM conversations WHERE id=${req.params.id}`; res.json({ deleted: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────
app.get("/api/conversations/:id/messages", async (req, res) => {
  try { res.json(await sql`SELECT * FROM messages WHERE conversation_id=${req.params.id} ORDER BY created_at ASC`); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/conversations/:id/messages", async (req, res) => {
  const { type, sender, content } = req.body;
  if (!type || !content) return res.status(400).json({ error: "type and content required" });
  try {
    const rows = await sql`INSERT INTO messages (conversation_id, type, sender, content) VALUES (${req.params.id},${type},${sender},${content}) RETURNING *`;
    await sql`UPDATE conversations SET updated_at=NOW() WHERE id=${req.params.id}`;
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// ALERT LOG
// ─────────────────────────────────────────────
app.get("/api/alert-log", async (req, res) => {
  try {
    const { org_id } = req.query;
    if (!org_id && req.query.super !== "1") return res.json([]);
    res.json(org_id
      ? await sql`SELECT * FROM alert_log WHERE org_id=${org_id} ORDER BY created_at DESC`
      : await sql`SELECT * FROM alert_log ORDER BY created_at DESC`
    );
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/handoff-token/:token", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM alert_log WHERE token = ${req.params.token} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: "Invalid or expired link" });
    const row    = rows[0];
    const orgs   = await sql`SELECT * FROM organisations WHERE id = ${row.org_id} LIMIT 1`;
    const agents = await sql`SELECT * FROM agents WHERE org_id = ${row.org_id} AND role = 'tenant_admin' LIMIT 1`;
    res.json({ ok: true, token: row.token, org_id: row.org_id, conversation_id: row.conversation_id, visitor_name: row.visitor_name, page: row.page, org: orgs[0] || null, agent: agents[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/alert-log", async (req, res) => {
  const { org_id, conversation_id, agent_name, mobile, visitor_name, page, token } = req.body;
  try { res.status(201).json((await sql`INSERT INTO alert_log (org_id, conversation_id, agent_name, mobile, visitor_name, page, token) VALUES (${org_id},${conversation_id},${agent_name},${mobile},${visitor_name},${page},${token}) RETURNING *`)[0]); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/alert-log/:id", async (req, res) => {
  const { status } = req.body;
  try { res.json((await sql`UPDATE alert_log SET status=${status} WHERE id=${req.params.id} RETURNING *`)[0]); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// KNOWLEDGE BASE
// ─────────────────────────────────────────────
app.get("/api/kb", async (req, res) => {
  try {
    const { org_id } = req.query;
    res.json(org_id ? await sql`SELECT * FROM kb_documents WHERE org_id=${org_id} ORDER BY created_at DESC` : await sql`SELECT * FROM kb_documents ORDER BY created_at DESC`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/kb", async (req, res) => {
  const { org_id, name, category, sub_category, size_kb, chunks } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try { res.status(201).json((await sql`INSERT INTO kb_documents (org_id, name, category, sub_category, size_kb, chunks) VALUES (${org_id},${name},${category},${sub_category},${size_kb},${chunks||0}) RETURNING *`)[0]); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/kb/:id", async (req, res) => {
  const { name, category, sub_category, chunks, status } = req.body;
  try {
    const rows = await sql`UPDATE kb_documents SET name=COALESCE(${name},name), category=COALESCE(${category},category), sub_category=COALESCE(${sub_category},sub_category), chunks=COALESCE(${chunks},chunks), status=COALESCE(${status},status), updated_at=NOW() WHERE id=${req.params.id} RETURNING *`;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/kb/:id", async (req, res) => {
  try { await sql`DELETE FROM kb_documents WHERE id=${req.params.id}`; res.json({ deleted: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// SMS TEST  — send a real test SMS via ClickSend
// POST /api/sms-test
// Body: { to, username?, apiKey?, tenantId?, sender? }
// ─────────────────────────────────────────────
app.post("/api/sms-test", async (req, res) => {
  const { to, username: bodyUser, apiKey: bodyKey, tenantId, sender } = req.body;
  if (!to) return res.status(400).json({ error: "to (mobile number) required" });

  // Resolve credentials — explicit body creds take priority, then tenant config
  let csUser = bodyUser || "";
  let csKey  = bodyKey  || "";

  if ((!csUser || !csKey) && tenantId) {
    try {
      let cfg = tenantConfigsMemory[tenantId] || {};
      if (!cfg.clicksend) {
        const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${tenantId}`;
        if (rows.length) cfg = rows[0].config;
      }
      if (cfg?.clicksend?.username) { csUser = cfg.clicksend.username; csKey = cfg.clicksend.apiKey; }
    } catch (e) {}
  }

  // Fall back to platform-level credentials, then any configured tenant
  if (!csUser || !csKey) {
    try {
      let pCfg = tenantConfigsMemory["platform"] || {};
      if (!pCfg?.clicksend?.username) {
        const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = 'platform'`;
        if (rows.length) { pCfg = rows[0].config; tenantConfigsMemory["platform"] = pCfg; }
      }
      if (pCfg?.clicksend?.username) { csUser = pCfg.clicksend.username; csKey = pCfg.clicksend.apiKey; }
    } catch (e) {}
  }

  // Last resort — find any tenant_configs row that has clicksend credentials
  if (!csUser || !csKey) {
    try {
      const rows = await sql`SELECT config FROM tenant_configs WHERE (config->'clicksend'->>'username') IS NOT NULL AND (config->'clicksend'->>'username') != '' LIMIT 1`;
      if (rows.length && rows[0].config?.clicksend?.username) {
        csUser = rows[0].config.clicksend.username;
        csKey  = rows[0].config.clicksend.apiKey;
      }
    } catch (e) {}
  }

  if (!csUser || !csKey) return res.status(400).json({ error: "ClickSend credentials not found" });

  const from    = sender || "HINDLE";
  const smsBody = "[" + from + "] This is a test SMS from your Hindle chatbot platform. If you received this, SMS alerts are working correctly.";

  try {
    const auth = "Basic " + Buffer.from(csUser + ":" + csKey).toString("base64");
    const r = await fetch("https://rest.clicksend.com/v3/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ messages: [{ source: "sdk", to, body: smsBody, from }] }),
      signal: AbortSignal.timeout(8000),
    });
    const d = await r.json();
    const ok = d?.data?.messages?.[0]?.status === "SUCCESS";
    if (!ok) return res.status(502).json({ error: d?.data?.messages?.[0]?.status || "Send failed", detail: d });
    res.json({ ok: true, message: "Test SMS sent to " + to });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("Hindle API running on port " + PORT);
});

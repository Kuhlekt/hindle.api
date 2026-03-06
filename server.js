const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);
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

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        system: system || "You are a helpful support assistant. Answer concisely and helpfully.",
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
        await sql`INSERT INTO messages (conversation_id, type, sender, content) VALUES (${conversationId}, 'bot', 'AI', ${reply})`;
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
    const payload = JSON.stringify(config);
    await sql`
      INSERT INTO tenant_configs (tenant_id, config, updated_at)
      VALUES (${tenantId}, ${payload}::jsonb, NOW())
      ON CONFLICT (tenant_id) DO UPDATE
        SET config = ${payload}::jsonb, updated_at = NOW()
    `;
    // Also register tenant_id on the matching organisation by widget name
    const orgName = config.widget_name || (config.brand && config.brand.name) || null;
    if (orgName) {
      try { await sql`UPDATE organisations SET tenant_id = ${tenantId} WHERE name = ${orgName} AND (tenant_id IS NULL OR tenant_id = ${tenantId})`; } catch (_) {}
    }
    // Cache in memory too
    tenantConfigsMemory[tenantId] = { ...config, updatedAt: new Date().toISOString() };
    res.json({ ok: true, tenantId, storage: "db" });
  } catch (e) {
    // DB failed — fall back to memory
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
  } catch (e) {}
  const cfg = tenantConfigsMemory[tenantId];
  if (!cfg) return res.status(404).json({ error: "No config found" });
  res.json(cfg);
});

// ─────────────────────────────────────────────
// HANDOFF
// ─────────────────────────────────────────────
app.post("/api/handoff", async (req, res) => {
  const { tenantId, sessionId, conversationId: existingConvId, visitorEmail, visitorName, page, url, history } = req.body;
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  let tenantConfig = tenantConfigsMemory[tenantId] || {};
  try {
    const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${tenantId}`;
    if (rows.length) tenantConfig = rows[0].config;
  } catch (e) {}

  const cs = tenantConfig.clicksend || {};
  const agents = tenantConfig.agents || [];
  const smsSender = cs.smsSender || "SUPPORT";
  const token = Math.random().toString(36).slice(2, 10).toUpperCase();
  const visitorLabel = visitorName || visitorEmail || "Website Visitor";
  const magicUrl = (url || page || "/") + (url && url.includes("?") ? "&" : "?") + "token=" + token;

  let conversationId = existingConvId || null;
  try {
    const orgRows = await sql`SELECT id FROM organisations WHERE tenant_id = ${tenantId} LIMIT 1`;
    const orgId = orgRows.length ? orgRows[0].id : null;

    if (conversationId) {
      await sql`UPDATE conversations SET status='handoff', visitor_name=${visitorLabel}, visitor_email=${visitorEmail || null}, updated_at=NOW() WHERE id=${conversationId}`;
    } else {
      const convRows = await sql`
        INSERT INTO conversations (org_id, visitor_name, visitor_email, page, status)
        VALUES (${orgId}, ${visitorLabel}, ${visitorEmail || null}, ${page || "/"}, 'handoff')
        RETURNING id
      `;
      conversationId = convRows[0].id;
      if (history && history.length) {
        for (const msg of history.slice(-20)) {
          const mtype = msg.role === "assistant" ? "bot" : "visitor";
          const sender = msg.role === "assistant" ? "AI" : visitorLabel;
          await sql`INSERT INTO messages (conversation_id, type, sender, content) VALUES (${conversationId}, ${mtype}, ${sender}, ${msg.content || msg.text || ""})`;
        }
      }
    }
    await sql`INSERT INTO messages (conversation_id, type, sender, content) VALUES (${conversationId}, 'system', 'System', ${"Visitor requested a human agent"})`;
  } catch (e) {
    console.warn("Handoff conversation error:", e.message);
  }

  try {
    await sql`INSERT INTO alert_log (org_id, conversation_id, agent_name, mobile, visitor_name, page, token) VALUES (${tenantId}, ${conversationId || null}, ${"Widget Handoff"}, ${"—"}, ${visitorLabel}, ${page || "/"}, ${token})`;
  } catch (e) {}

  let smsSent = false, smsError = null, smsTargets = 0;
  if (cs.configured && cs.username && cs.apiKey) {
    const targets = agents.filter((a) => a.mobile && a.smsAlerts !== false && a.active !== false);
    smsTargets = targets.length;
    if (targets.length) {
      try {
        const auth = "Basic " + Buffer.from(cs.username + ":" + cs.apiKey).toString("base64");
        const smsBody = "[" + smsSender + "] " + visitorLabel + " on " + (page || "/") + " wants to chat. Join: " + magicUrl;
        const messages = targets.map((a) => ({ source: "sdk", to: a.mobile, from: smsSender, body: smsBody, schedule: 0 }));
        const r = await fetch("https://rest.clicksend.com/v3/sms/send", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ messages }), signal: AbortSignal.timeout(8000),
        });
        const d = await r.json();
        smsSent = d?.data?.messages?.every((m) => m.status === "SUCCESS");
        if (!smsSent) smsError = d?.data?.messages?.[0]?.status || "Send failed";
        try { await sql`UPDATE alert_log SET status = ${smsSent ? "sent" : "failed"} WHERE token = ${token}`; } catch (_) {}
      } catch (e) { smsError = e.message; }
    } else { smsError = "No agents with mobile + SMS alerts enabled"; }
  } else { smsError = "ClickSend not configured"; }

  res.json({ ok: true, smsSent, smsTargets, smsError, token, conversationId, message: smsSent ? "SMS sent to " + smsTargets + " agent(s)" : "Handoff logged — " + (smsError || "SMS not configured") });
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
    res.json({ ok: true, id: agent.id, name: agent.name, email: agent.email, role: agent.role || "agent", mustChangePassword: agent.must_change_password || false });
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
// Upsert does NOT rely on ON CONFLICT — uses explicit SELECT then INSERT/UPDATE
// to avoid failing when unique constraint is missing
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
    const pw = password || null;
    const mcp = mustChangePassword !== false;
    // Check if agent already exists
    const existing = await sql`SELECT id FROM agents WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
    let rows;
    if (existing.length) {
      // UPDATE — preserve existing password if new one not provided
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
      // INSERT
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
    let rows;
    if (org_id && status) rows = await sql`SELECT c.*, a.name as agent_name FROM conversations c LEFT JOIN agents a ON c.assigned_agent_id=a.id WHERE c.org_id=${org_id} AND c.status=${status} ORDER BY c.updated_at DESC`;
    else if (org_id) rows = await sql`SELECT c.*, a.name as agent_name FROM conversations c LEFT JOIN agents a ON c.assigned_agent_id=a.id WHERE c.org_id=${org_id} ORDER BY c.updated_at DESC`;
    else rows = await sql`SELECT c.*, a.name as agent_name FROM conversations c LEFT JOIN agents a ON c.assigned_agent_id=a.id ORDER BY c.updated_at DESC`;
    res.json(rows);
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
    res.json(org_id ? await sql`SELECT * FROM alert_log WHERE org_id=${org_id} ORDER BY created_at DESC` : await sql`SELECT * FROM alert_log ORDER BY created_at DESC`);
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
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("Hindle API running on port " + PORT);
});

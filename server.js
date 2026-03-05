const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

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
// AI CHAT  — routes messages through Claude
// POST /api/chat
// Body: { tenantId, system, messages: [{role, content}] }
// ─────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { system, messages, tenantId } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not set on server" });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
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

    // Optionally log the message to the DB if a conversationId is supplied
    if (req.body.conversationId) {
      try {
        await sql`
          INSERT INTO messages (conversation_id, type, sender, content)
          VALUES (${req.body.conversationId}, 'bot', 'AI', ${reply})
        `;
        await sql`
          UPDATE conversations SET updated_at = NOW()
          WHERE id = ${req.body.conversationId}
        `;
      } catch (_) {}
    }

    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// TENANT CONFIG  — stores chatbot config so widget.js can fetch it
// POST /api/tenant-config        { tenantId, ...config }
// GET  /api/tenant-config/:id
// ─────────────────────────────────────────────

// In-memory store (persists for the life of the Railway instance).
// Replace with a DB table if you want permanent storage across restarts.
const tenantConfigs = {};

app.post("/api/tenant-config", (req, res) => {
  const { tenantId, ...config } = req.body;
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  tenantConfigs[tenantId] = { ...tenantConfigs[tenantId], ...config, updatedAt: new Date().toISOString() };
  res.json({ ok: true, tenantId });
});

app.get("/api/tenant-config/:tenantId", (req, res) => {
  const cfg = tenantConfigs[req.params.tenantId];
  if (!cfg) return res.status(404).json({ error: "No config found for this tenant" });
  res.json(cfg);
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
  const { org_id, name, email, mobile, role = "agent" } = req.body;
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  try {
    const rows = await sql`
      INSERT INTO agents (org_id, name, email, mobile, role)
      VALUES (${org_id}, ${name}, ${email}, ${mobile}, ${role})
      RETURNING *
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
        WHERE c.org_id = ${org_id} AND c.status = ${status}
        ORDER BY c.updated_at DESC
      `;
    } else if (org_id) {
      rows = await sql`
        SELECT c.*, a.name as agent_name FROM conversations c
        LEFT JOIN agents a ON c.assigned_agent_id = a.id
        WHERE c.org_id = ${org_id}
        ORDER BY c.updated_at DESC
      `;
    } else {
      rows = await sql`
        SELECT c.*, a.name as agent_name FROM conversations c
        LEFT JOIN agents a ON c.assigned_agent_id = a.id
        ORDER BY c.updated_at DESC
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
  const { org_id, visitor_name, visitor_email, page } = req.body;
  try {
    const rows = await sql`
      INSERT INTO conversations (org_id, visitor_name, visitor_email, page)
      VALUES (${org_id}, ${visitor_name}, ${visitor_email}, ${page})
      RETURNING *
    `;
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/conversations/:id", async (req, res) => {
  const { status, assigned_agent_id } = req.body;
  try {
    const rows = await sql`
      UPDATE conversations SET
        status            = COALESCE(${status},            status),
        assigned_agent_id = COALESCE(${assigned_agent_id}, assigned_agent_id),
        updated_at        = NOW()
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
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
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Hindle API running on port ${PORT}`);
});

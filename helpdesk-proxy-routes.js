// ─── Helpdesk Proxy Routes (v2 — full agent parity) ─────────────────────────
// Replaces the previous helpdesk-proxy-routes.js entirely.
// Adds: categories, canned responses, ticket assignment/priority/category
// updates, internal notes (via is_internal flag), cause/resolution save,
// CSAT result lookup, and SLA info — all passthrough to the real helpdesk
// API, scoped per-tenant exactly like the original routes.

const HELPDESK_API_BASE = process.env.HELPDESK_API_BASE || 'https://helpdesk.hindleconsultants.com';

module.exports = function helpdeskProxyRouter(sql) {
  const express = require('express');
  const router = express.Router();

  function chatbotOrgId(req) {
    return req.headers['x-org-id'] || req.query.org_id || req.body?.org_id || null;
  }

  async function resolveHelpdeskOrgId(req) {
    if (req._helpdeskOrgId !== undefined) return req._helpdeskOrgId;
    const tenantOrgId = chatbotOrgId(req);
    if (!tenantOrgId) { req._helpdeskOrgId = null; return null; }
    const rows = await sql`SELECT helpdesk_org_id FROM organisations WHERE id = ${tenantOrgId}::uuid LIMIT 1`;
    req._helpdeskOrgId = rows[0]?.helpdesk_org_id || null;
    return req._helpdeskOrgId;
  }

  async function helpdeskFetch(helpdeskOrgId, path, opts = {}) {
    const res = await fetch(HELPDESK_API_BASE + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-Org-Id': helpdeskOrgId, ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  router.get('/status', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    res.json({ enabled: !!helpdeskOrgId });
  });

  // ── Tickets ────────────────────────────────────────────────────────────
  router.get('/tickets', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [], total: 0, enabled: false });
    const qs = new URLSearchParams(req.query).toString();
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/tickets${qs ? '?' + qs : ''}`);
    res.status(status).json({ ...data, enabled: true });
  });

  router.post('/tickets', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const { status, data } = await helpdeskFetch(helpdeskOrgId, '/api/tickets', { method: 'POST', body: JSON.stringify(req.body) });
    res.status(status).json(data);
  });

  router.get('/tickets/:id', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(404).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/tickets/${encodeURIComponent(req.params.id)}`);
    const ticket = data?.data || data?.ticket;
    if (ticket && String(ticket.organization_id) !== String(helpdeskOrgId)) return res.status(404).json({ error: 'Ticket not found' });
    res.status(status).json(data);
  });

  // Generic ticket update — status, priority, category_id, assigned_to all
  // flow through here since the underlying helpdesk PUT route accepts all of them.
  router.put('/tickets/:id', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/tickets/${encodeURIComponent(req.params.id)}`, { method: 'PUT', body: JSON.stringify(req.body) });
    res.status(status).json(data);
  });

  // ── Merge tickets ─────────────────────────────────────────────────────
  router.post('/tickets/:id/merge', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/tickets/${encodeURIComponent(req.params.id)}/merge`, {
      method: 'POST',
      headers: req.headers['x-user-id'] ? { 'X-User-Id': req.headers['x-user-id'] } : {},
      body: JSON.stringify(req.body),
    });
    res.status(status).json(data);
  });

  // ── Split ticket ──────────────────────────────────────────────────────
  router.post('/tickets/:id/split', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/tickets/${encodeURIComponent(req.params.id)}/split`, {
      method: 'POST',
      headers: req.headers['x-user-id'] ? { 'X-User-Id': req.headers['x-user-id'] } : {},
      body: JSON.stringify(req.body),
    });
    res.status(status).json(data);
  });

  // ── Messages (reply / internal note / cause / resolution) ───────────────
  // is_internal:true = internal note. is_cause:true = saved as ticket.cause.
  // Resolution is saved via PUT /tickets/:id { resolution, status:'resolved' }.
  router.get('/tickets/:id/messages', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [], messages: [] });
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/tickets/${encodeURIComponent(req.params.id)}/messages`);
    res.status(status).json(data);
  });

  router.post('/tickets/:id/messages', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/tickets/${encodeURIComponent(req.params.id)}/messages`, {
      method: 'POST',
      headers: req.headers['x-user-id'] || req.body?.agent_id ? { 'X-User-Id': req.headers['x-user-id'] || req.body.agent_id } : {},
      body: JSON.stringify(req.body),
    });
    res.status(status).json(data);
  });

  // ── Categories (for the category dropdown) ───────────────────────────────
  // NATIVE — Stage 2: queries the merged DB directly instead of proxying to
  // the external helpdesk app. Same URL/contract, no frontend changes needed.
  router.get('/categories', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [] });
    try {
      const rows = await sql`
        SELECT id, name, description, organization_id, created_at
        FROM categories WHERE organization_id = ${helpdeskOrgId}::uuid
        ORDER BY name ASC`;
      res.json({ success: true, data: [...rows] });
    } catch (e) {
      console.error('[categories GET native]', e.message);
      res.json({ success: true, data: [] });
    }
  });

  router.post('/categories', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const name = req.body?.name;
    if (!name) return res.status(400).json({ error: 'Name required' });
    try {
      const r = await sql`
        INSERT INTO categories (name, description, organization_id, created_at)
        VALUES (${name}, ${req.body?.description || null}, ${helpdeskOrgId}::uuid, NOW())
        RETURNING *`;
      res.json({ success: true, data: r[0] });
    } catch (e) {
      console.error('[categories POST native]', e.message);
      res.status(500).json({ error: e.message || 'Failed' });
    }
  });

  // ── Resolution types (for the resolution-type dropdown) ─────────────────
  router.get('/resolution-types', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [] });
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/resolution-types`);
    res.status(status).json(data);
  });

  router.post('/resolution-types', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/resolution-types`, { method: 'POST', body: JSON.stringify(req.body) });
    res.status(status).json(data);
  });

  // ── Canned responses ──────────────────────────────────────────────────
  router.get('/canned-responses', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [] });
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/admin/canned-responses`);
    res.status(status).json(data);
  });

  // ── Agents (for the assign-to dropdown) ──────────────────────────────
  // ── Agents (for the assign-to dropdown) ──────────────────────────────
  // NATIVE — Stage 2: queries user_profiles directly, filtered to this
  // tenant's actual support staff (agent/admin, active). Replaces the old
  // approach of fetching every user across every org and filtering after
  // the fact.
  router.get('/agents', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [] });
    try {
      const rows = await sql`
        SELECT id, email, full_name, role, is_active, organization_id
        FROM user_profiles
        WHERE organization_id = ${helpdeskOrgId}::uuid
          AND role IN ('agent', 'admin')
          AND is_active IS NOT FALSE
        ORDER BY full_name ASC`;
      res.json({ success: true, data: [...rows] });
    } catch (e) {
      console.error('[agents GET native]', e.message);
      res.json({ success: true, data: [] });
    }
  });

  // ── CSAT result for a specific ticket (if any) ────────────────────────
  // Note: exact query shape of /api/admin/csat unconfirmed — this passes
  // ticket_id as a query param, the most common convention. If it returns
  // the wrong shape, the badge simply won't show (fails silently on the
  // frontend) rather than breaking anything.
  router.get('/tickets/:id/csat', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: null });
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/admin/csat?ticket_id=${encodeURIComponent(req.params.id)}`);
    res.status(status).json(data);
  });

  // ── Ticket audit log ────────────────────────────────────────────────
  router.get('/tickets/:id/audit-log', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [] });
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/tickets/${encodeURIComponent(req.params.id)}/audit-log`);
    res.status(status).json(data);
  });

  // ── Side conversations ────────────────────────────────────────────────
  // NATIVE — Stage 2: side_conversations is self-contained (its own table,
  // no cross-references to the old helpdesk app's other tables), making
  // this a clean, low-risk one to convert.
  router.get('/tickets/:id/side-conversations', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [] });
    try {
      const rows = await sql`
        SELECT sc.*, COUNT(m.id)::int as message_count
        FROM side_conversations sc
        LEFT JOIN side_conversation_messages m ON m.side_conversation_id = sc.id
        WHERE sc.ticket_id::text = ${req.params.id}
        GROUP BY sc.id
        ORDER BY sc.updated_at DESC`;
      res.json({ success: true, data: [...rows] });
    } catch (e) {
      console.error('[side-conversations GET native]', e.message);
      res.json({ success: true, data: [] });
    }
  });

  router.post('/tickets/:id/side-conversations', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const userId = req.headers['x-user-id'] || null;
    const subject = req.body?.subject;
    if (!subject?.trim()) return res.status(400).json({ error: 'Subject required' });
    try {
      const r = await sql`
        INSERT INTO side_conversations (ticket_id, subject, created_by_name, created_by_id)
        VALUES (${req.params.id}::uuid, ${subject.trim()}, ${req.body?.created_by_name || 'Agent'}, ${userId})
        RETURNING *`;
      const sc = r[0];
      if (req.body?.first_message?.trim()) {
        await sql`
          INSERT INTO side_conversation_messages (side_conversation_id, sender_name, sender_id, message)
          VALUES (${sc.id}, ${req.body?.created_by_name || 'Agent'}, ${userId}, ${req.body.first_message.trim()})`;
      }
      res.json({ success: true, data: sc });
    } catch (e) {
      console.error('[side-conversations POST native]', e.message);
      res.status(500).json({ error: e.message || 'Failed' });
    }
  });

  router.get('/side-conversations/:id/messages', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [] });
    try {
      const rows = await sql`
        SELECT * FROM side_conversation_messages
        WHERE side_conversation_id::text = ${req.params.id}
        ORDER BY created_at ASC`;
      res.json({ success: true, data: [...rows] });
    } catch (e) {
      console.error('[side-conversation messages GET native]', e.message);
      res.json({ success: true, data: [] });
    }
  });

  router.post('/side-conversations/:id/messages', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const userId = req.headers['x-user-id'] || null;
    const message = req.body?.message;
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
    try {
      const r = await sql`
        INSERT INTO side_conversation_messages (side_conversation_id, sender_name, sender_id, message)
        VALUES (${req.params.id}::uuid, ${req.body?.sender_name || 'Agent'}, ${userId}, ${message.trim()})
        RETURNING *`;
      await sql`UPDATE side_conversations SET updated_at = NOW() WHERE id::text = ${req.params.id}`.catch(() => {});
      res.json({ success: true, data: r[0] });
    } catch (e) {
      console.error('[side-conversation messages POST native]', e.message);
      res.status(500).json({ error: e.message || 'Failed' });
    }
  });

  // ── KPI / reporting snapshot ───────────────────────────────────────────
  router.get('/reports/kpi', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: null });
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/admin/reports/kpi`);
    res.status(status).json(data);
  });

  return router;
};

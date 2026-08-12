// ─── Helpdesk Proxy Routes ──────────────────────────────────────────────────
// Bridges the chatbot dashboard to the separate Helpdesk (v0-kuhlekt-help-desk)
// Next.js API, using the helpdesk_org_id mapping stored on each chatbot tenant.
//
// SECURITY: the helpdesk API trusts the X-Org-Id header verbatim (see its
// middleware.ts). This proxy is the ONLY place that header gets set, and it is
// always derived server-side from the CHATBOT tenant's own org_id via the
// organisations.helpdesk_org_id column — never forwarded verbatim from the
// browser's own X-Org-Id (that value identifies the CHATBOT tenant, not the
// helpdesk org — the two are different UUID spaces, this proxy is the bridge).
// The browser never talks to the helpdesk domain directly.
//
// Matches this codebase's existing convention: org_id comes from the
// X-Org-Id header or ?org_id= query param, same as the rest of server.js.
//
// Wire into server.js with:
//   const helpdeskProxy = require('./helpdesk-proxy-routes');
//   app.use('/api/helpdesk', helpdeskProxy(sql));

const HELPDESK_API_BASE = process.env.HELPDESK_API_BASE || 'https://helpdesk.hindleconsultants.com';

module.exports = function helpdeskProxyRouter(sql) {
  const express = require('express');
  const router = express.Router();

  function chatbotOrgId(req) {
    return req.headers['x-org-id'] || req.query.org_id || req.body?.org_id || null;
  }

  // Resolve the CHATBOT tenant's org_id to the corresponding HELPDESK org UUID.
  // Cached per-request via req._helpdeskOrgId so repeated calls don't hit the DB twice.
  async function resolveHelpdeskOrgId(req) {
    if (req._helpdeskOrgId !== undefined) return req._helpdeskOrgId;
    const tenantOrgId = chatbotOrgId(req);
    if (!tenantOrgId) {
      req._helpdeskOrgId = null;
      return null;
    }
    const rows = await sql`
      SELECT helpdesk_org_id FROM organisations WHERE id = ${tenantOrgId}::uuid LIMIT 1
    `;
    req._helpdeskOrgId = rows[0]?.helpdesk_org_id || null;
    return req._helpdeskOrgId;
  }

  // Shared fetch helper — always injects the resolved helpdesk org id.
  async function helpdeskFetch(helpdeskOrgId, path, opts = {}) {
    const res = await fetch(HELPDESK_API_BASE + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'X-Org-Id': helpdeskOrgId,
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // GET /api/helpdesk/status — tells the frontend whether helpdesk is enabled
  // for this tenant, so PHelpdesk can show a friendly "not enabled" state.
  router.get('/status', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    res.json({ enabled: !!helpdeskOrgId });
  });

  // GET /api/helpdesk/tickets?limit=&offset=&status=&priority=&q=
  router.get('/tickets', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) {
      return res.json({ success: true, data: [], total: 0, enabled: false });
    }
    const qs = new URLSearchParams(req.query).toString();
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/tickets${qs ? '?' + qs : ''}`);
    res.status(status).json({ ...data, enabled: true });
  });

  // POST /api/helpdesk/tickets — create a new ticket
  router.post('/tickets', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) {
      return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    }
    const { status, data } = await helpdeskFetch(helpdeskOrgId, '/api/tickets', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.status(status).json(data);
  });

  // GET /api/helpdesk/tickets/:id — ticket detail
  // Note: the helpdesk's own route doesn't filter by org on single-ticket GET,
  // so we defense-in-depth check the returned ticket's organization_id matches
  // before returning it to the caller.
  router.get('/tickets/:id', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) {
      return res.status(404).json({ error: 'Helpdesk is not enabled for this tenant.' });
    }
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/tickets/${encodeURIComponent(req.params.id)}`);
    const ticket = data?.data || data?.ticket;
    if (ticket && String(ticket.organization_id) !== String(helpdeskOrgId)) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    res.status(status).json(data);
  });

  // PUT /api/helpdesk/tickets/:id — update status/priority/assignee
  router.put('/tickets/:id', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) {
      return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    }
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/tickets/${encodeURIComponent(req.params.id)}`, {
      method: 'PUT',
      body: JSON.stringify(req.body),
    });
    res.status(status).json(data);
  });

  // GET /api/helpdesk/tickets/:id/messages
  router.get('/tickets/:id/messages', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) {
      return res.json({ success: true, data: [], messages: [] });
    }
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/tickets/${encodeURIComponent(req.params.id)}/messages`);
    res.status(status).json(data);
  });

  // POST /api/helpdesk/tickets/:id/messages — reply to a ticket
  router.post('/tickets/:id/messages', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) {
      return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    }
    const { status, data } = await helpdeskFetch(helpdeskOrgId, `/api/tickets/${encodeURIComponent(req.params.id)}/messages`, {
      method: 'POST',
      headers: req.headers['x-user-id'] || req.body?.agent_id ? { 'X-User-Id': req.headers['x-user-id'] || req.body.agent_id } : {},
      body: JSON.stringify(req.body),
    });
    res.status(status).json(data);
  });

  return router;
};

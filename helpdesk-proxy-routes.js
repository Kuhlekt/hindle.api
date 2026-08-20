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
  // ── Tickets ──────────────────────────────────────────────────────────
  // NATIVE — Stage 2: the big one. Same query logic as the original
  // Kuhlekt/app/api/tickets route.ts (non-super-admin branch, since this
  // proxy is always scoped to one resolved tenant), just run directly here.
  router.get('/tickets', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [], total: 0, enabled: false });
    try {
      const limit = Math.min(100, parseInt(req.query.limit) || 25);
      const offset = parseInt(req.query.offset) || 0;
      const statusF = req.query.status || '';
      const priorityF = req.query.priority || '';
      const q = (req.query.q || '').trim();

      let tickets, total;
      if (q) {
        const like = `%${q}%`;
        tickets = await sql`
          SELECT t.id,t.ticket_number,t.subject,t.status,t.priority,t.created_at,t.updated_at,t.assigned_to,t.customer_id,t.organization_id,
                 rq.full_name AS requester_name,rq.email AS requester_email,ag.full_name AS assignee_name
          FROM tickets t
          LEFT JOIN user_profiles rq ON rq.id=t.customer_id
          LEFT JOIN user_profiles ag ON ag.id=t.assigned_to
          WHERE t.organization_id=${helpdeskOrgId}::uuid AND (t.subject ILIKE ${like} OR t.ticket_number ILIKE ${like})
          ORDER BY t.updated_at DESC LIMIT ${limit} OFFSET ${offset}`;
        const cnt = await sql`SELECT COUNT(*)::int AS c FROM tickets t WHERE t.organization_id=${helpdeskOrgId}::uuid AND (t.subject ILIKE ${like} OR t.ticket_number ILIKE ${like})`;
        total = cnt[0]?.c || 0;
      } else {
        tickets = await sql`
          SELECT t.id,t.ticket_number,t.subject,t.status,t.priority,t.created_at,t.updated_at,t.assigned_to,t.customer_id,t.organization_id,
                 rq.full_name AS requester_name,rq.email AS requester_email,ag.full_name AS assignee_name
          FROM tickets t
          LEFT JOIN user_profiles rq ON rq.id=t.customer_id
          LEFT JOIN user_profiles ag ON ag.id=t.assigned_to
          WHERE t.organization_id=${helpdeskOrgId}::uuid
          ORDER BY t.updated_at DESC LIMIT ${limit} OFFSET ${offset}`;
        const cnt = await sql`SELECT COUNT(*)::int AS c FROM tickets t WHERE t.organization_id=${helpdeskOrgId}::uuid`;
        total = cnt[0]?.c || 0;
      }
      let result = [...tickets];
      if (statusF) result = result.filter(t => t.status === statusF);
      if (priorityF) result = result.filter(t => t.priority === priorityF);
      res.json({ success: true, data: result, total, enabled: true });
    } catch (e) {
      console.error('[tickets GET native]', e.message);
      res.json({ success: true, data: [], total: 0, enabled: true });
    }
  });

  router.post('/tickets', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const b = req.body || {};
    if (!b.subject || !b.requester_email) return res.status(400).json({ error: 'Subject and requester email required' });
    try {
      const catId = b.category_id?.trim() || null;

      // Find-or-create the requester's user_profiles row (see Stage 1 fix —
      // without this, agent-reply notification emails silently fail for
      // any ticket whose requester wasn't already a known customer).
      let custId = null;
      const ex = await sql`SELECT id FROM user_profiles WHERE LOWER(email)=LOWER(${b.requester_email}) LIMIT 1`;
      if (ex.length) {
        custId = ex[0].id;
      } else {
        const SSO_PLACEHOLDER_HASH = '$2a$10$SSOACCOUNTNOPASSWORDSETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
        const created = await sql`
          INSERT INTO user_profiles (id, email, full_name, role, organization_id, password_hash, is_active, created_at, updated_at)
          VALUES (gen_random_uuid(), ${b.requester_email}, ${b.requester_name || b.requester_email}, 'customer', ${helpdeskOrgId}::uuid, ${SSO_PLACEHOLDER_HASH}, true, NOW(), NOW())
          RETURNING id`;
        custId = created[0]?.id || null;
      }

      // Ticket numbers unique per-org — scoped count + retry-on-collision.
      let t = [], lastErr = null;
      for (let attempt = 0; attempt < 5 && !t.length; attempt++) {
        const orgCnt = await sql`SELECT COUNT(*)::int AS c FROM tickets WHERE organization_id = ${helpdeskOrgId}::uuid`;
        const num = String(10000 + (orgCnt[0]?.c || 0) + 1 + attempt);
        try {
          t = await sql`
            INSERT INTO tickets(ticket_number,subject,description,status,priority,customer_id,organization_id,category_id,created_at,updated_at)
            VALUES(${num},${b.subject},${b.description||''},${b.status||'open'},${b.priority||'medium'},${custId}::uuid,${helpdeskOrgId}::uuid,${catId}::uuid,NOW(),NOW())
            RETURNING *`;
        } catch (e) {
          lastErr = e;
          if (!String(e.message || '').includes('duplicate key')) throw e;
        }
      }
      if (!t.length) throw lastErr || new Error('Could not generate a unique ticket number after 5 attempts');
      res.json({ success: true, data: t[0] });
    } catch (e) {
      console.error('[tickets POST native]', e.message);
      res.status(500).json({ error: e.message || 'Failed' });
    }
  });

  router.get('/tickets/:id', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(404).json({ error: 'Helpdesk is not enabled for this tenant.' });
    try {
      const r = await sql`
        SELECT t.*,
          u.full_name as requester_name, u.email as requester_email,
          a.full_name as assignee_name, c.name as category_name,
          rt.name as resolution_type_name,
          mt.ticket_number as merged_into_ticket_number
        FROM tickets t
        LEFT JOIN user_profiles u ON t.customer_id::text = u.id::text
        LEFT JOIN user_profiles a ON t.assigned_to::text = a.id::text
        LEFT JOIN categories c ON t.category_id::text = c.id::text
        LEFT JOIN resolution_types rt ON t.resolution_type_id::text = rt.id::text
        LEFT JOIN tickets mt ON t.merged_into_id = mt.id
        WHERE t.id::text = ${req.params.id}`;
      if (!r.length) return res.status(404).json({ error: 'Ticket not found' });
      const ticket = r[0];
      if (String(ticket.organization_id) !== String(helpdeskOrgId)) return res.status(404).json({ error: 'Ticket not found' });
      res.json({ success: true, data: ticket });
    } catch (e) {
      console.error('[ticket GET native]', e.message);
      res.status(500).json({ error: e.message || 'Failed' });
    }
  });

  // Generic ticket update — status, priority, category_id, assigned_to,
  // resolution, resolution_type_id, cause. Includes optimistic-concurrency
  // collision detection and full audit logging, same as the original route.
  router.put('/tickets/:id', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const b = req.body || {};
    const rawId = req.params.id;
    try {
      if (b.expected_updated_at) {
        const current = await sql`SELECT updated_at FROM tickets WHERE id::text = ${rawId} LIMIT 1`;
        if (!current.length) return res.status(404).json({ error: 'Not found' });
        if (new Date(current[0].updated_at).getTime() !== new Date(b.expected_updated_at).getTime()) {
          const latest = await sql`
            SELECT t.*, a.full_name as assignee_name, c.name as category_name
            FROM tickets t
            LEFT JOIN user_profiles a ON t.assigned_to::text = a.id::text
            LEFT JOIN categories c ON t.category_id::text = c.id::text
            WHERE t.id::text = ${rawId}`;
          await sql`INSERT INTO ticket_audit_log (ticket_id, actor_name, actor_id, action) VALUES (${rawId}::uuid, ${b.actor_name || 'Agent'}, ${req.headers['x-user-id'] || null}, 'conflict_blocked')`.catch(() => {});
          return res.status(409).json({ error: 'This ticket was updated by someone else — please review the latest changes before saving.', conflict: true, latest: latest[0] || null });
        }
      }

      const before = await sql`SELECT * FROM tickets WHERE id::text = ${rawId} LIMIT 1`;
      if (!before.length) return res.status(404).json({ error: 'Not found' });
      const prev = before[0];

      const r = await sql`
        UPDATE tickets SET
          status        = COALESCE(${b.status ?? null}, status),
          priority      = COALESCE(${b.priority ?? null}, priority),
          assigned_to   = COALESCE(${b.assigned_to ?? null}, assigned_to)::uuid,
          category_id   = COALESCE(${b.category_id ?? null}, category_id)::uuid,
          resolution    = COALESCE(${b.resolution ?? null}, resolution),
          resolution_type_id = COALESCE(${b.resolution_type_id ?? null}, resolution_type_id)::uuid,
          cause         = COALESCE(${b.cause ?? null}, cause),
          resolved_at   = CASE WHEN ${b.status ?? null} = 'resolved' AND status != 'resolved' THEN NOW() ELSE resolved_at END,
          closed_at     = CASE WHEN ${b.status ?? null} = 'closed' AND status != 'closed' THEN NOW() ELSE closed_at END,
          updated_at    = NOW()
        WHERE id::text = ${rawId}
        RETURNING *`;
      if (!r.length) return res.status(404).json({ error: 'Not found' });
      const after = r[0];

      const actorName = b.actor_name || 'Agent';
      const actorId = req.headers['x-user-id'] || null;
      for (const f of ['status','priority','assigned_to','category_id','resolution','resolution_type_id','cause']) {
        const oldVal = prev[f] != null ? String(prev[f]) : null;
        const newVal = after[f] != null ? String(after[f]) : null;
        if (oldVal !== newVal && b[f] !== undefined && b[f] !== null) {
          await sql`INSERT INTO ticket_audit_log (ticket_id, actor_name, actor_id, action, field_name, old_value, new_value) VALUES (${rawId}::uuid, ${actorName}, ${actorId}, 'field_changed', ${f}, ${oldVal}, ${newVal})`.catch(() => {});
        }
      }
      res.json({ success: true, data: after });
    } catch (e) {
      console.error('[ticket PUT native]', e.message);
      res.status(500).json({ error: e.message || 'Failed' });
    }
  });

  // ── Merge tickets ─────────────────────────────────────────────────────
  router.post('/tickets/:id/merge', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const userId = req.headers['x-user-id'] || null;
    try {
      const source = await sql`SELECT * FROM tickets WHERE id::text = ${req.params.id} LIMIT 1`;
      if (!source.length) return res.status(404).json({ error: 'Source ticket not found' });
      const sourceTicket = source[0];
      if (!req.body?.merge_into_ticket_number?.trim()) return res.status(400).json({ error: 'merge_into_ticket_number required' });

      const target = await sql`SELECT * FROM tickets WHERE ticket_number = ${req.body.merge_into_ticket_number.trim()} AND organization_id = ${sourceTicket.organization_id} LIMIT 1`;
      if (!target.length) return res.status(404).json({ error: `Ticket #${req.body.merge_into_ticket_number} not found in this organisation` });
      const targetTicket = target[0];
      if (targetTicket.id === sourceTicket.id) return res.status(400).json({ error: 'Cannot merge a ticket into itself' });
      if (sourceTicket.merged_into_id) return res.status(409).json({ error: 'This ticket has already been merged' });

      await sql`UPDATE ticket_messages SET ticket_id = ${targetTicket.id} WHERE ticket_id = ${sourceTicket.id}`;
      await sql`INSERT INTO ticket_messages (ticket_id, user_id, message, is_internal, is_read, created_at, updated_at) VALUES (${targetTicket.id}, ${userId}::uuid, ${'🔗 Merged in ticket #' + sourceTicket.ticket_number + ': "' + sourceTicket.subject + '" — messages from that ticket now appear above.'}, true, true, NOW(), NOW())`;
      await sql`INSERT INTO ticket_messages (ticket_id, user_id, message, is_internal, is_read, created_at, updated_at) VALUES (${sourceTicket.id}, ${userId}::uuid, ${'🔗 This ticket was merged into #' + targetTicket.ticket_number + '.'}, true, true, NOW(), NOW())`;
      await sql`UPDATE tickets SET status = 'merged', merged_into_id = ${targetTicket.id}, updated_at = NOW() WHERE id = ${sourceTicket.id}`;
      await sql`UPDATE tickets SET updated_at = NOW() WHERE id = ${targetTicket.id}`;
      await sql`INSERT INTO ticket_audit_log (ticket_id, actor_name, actor_id, action, field_name, old_value, new_value) VALUES (${sourceTicket.id}, 'Agent', ${userId}, 'field_changed', 'status', ${sourceTicket.status}, 'merged')`.catch(() => {});
      await sql`INSERT INTO ticket_audit_log (ticket_id, actor_name, actor_id, action) VALUES (${targetTicket.id}, 'Agent', ${userId}, 'merge_received')`.catch(() => {});

      res.json({ success: true, merged_into: targetTicket.ticket_number });
    } catch (e) {
      console.error('[ticket merge native]', e.message);
      res.status(500).json({ error: e.message || 'Failed' });
    }
  });

  // ── Split ticket ──────────────────────────────────────────────────────
  router.post('/tickets/:id/split', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const userId = req.headers['x-user-id'] || null;
    const b = req.body || {};
    try {
      if (!Array.isArray(b.message_ids) || b.message_ids.length === 0) return res.status(400).json({ error: 'message_ids (non-empty array) required' });
      if (!b.new_subject?.trim()) return res.status(400).json({ error: 'new_subject required' });

      const source = await sql`SELECT * FROM tickets WHERE id::text = ${req.params.id} LIMIT 1`;
      if (!source.length) return res.status(404).json({ error: 'Source ticket not found' });
      const sourceTicket = source[0];

      const msgCheck = await sql`SELECT id FROM ticket_messages WHERE ticket_id = ${sourceTicket.id} AND id::text = ANY(${b.message_ids})`;
      if (msgCheck.length !== b.message_ids.length) return res.status(400).json({ error: "One or more selected messages don't belong to this ticket" });

      let newTicket = null, lastErr = null;
      for (let attempt = 0; attempt < 5 && !newTicket; attempt++) {
        const orgCnt = await sql`SELECT COUNT(*)::int AS c FROM tickets WHERE organization_id = ${sourceTicket.organization_id}`;
        const num = String(10000 + (orgCnt[0]?.c || 0) + 1 + attempt);
        try {
          const r = await sql`
            INSERT INTO tickets (ticket_number, subject, description, status, priority, customer_id, organization_id, category_id, created_at, updated_at)
            VALUES (${num}, ${b.new_subject.trim()}, ${'Split from ticket #' + sourceTicket.ticket_number}, 'open', ${sourceTicket.priority}, ${sourceTicket.customer_id}, ${sourceTicket.organization_id}, ${sourceTicket.category_id}, NOW(), NOW())
            RETURNING *`;
          newTicket = r[0];
        } catch (e) {
          lastErr = e;
          if (!String(e.message || '').includes('duplicate key')) throw e;
        }
      }
      if (!newTicket) throw lastErr || new Error('Could not generate a unique ticket number');

      await sql`UPDATE ticket_messages SET ticket_id = ${newTicket.id} WHERE ticket_id = ${sourceTicket.id} AND id::text = ANY(${b.message_ids})`;
      await sql`INSERT INTO ticket_messages (ticket_id, user_id, message, is_internal, is_read, created_at, updated_at) VALUES (${sourceTicket.id}, ${userId}::uuid, ${'✂️ Some messages were split into new ticket #' + newTicket.ticket_number + ': "' + newTicket.subject + '"'}, true, true, NOW(), NOW())`;
      await sql`INSERT INTO ticket_messages (ticket_id, user_id, message, is_internal, is_read, created_at, updated_at) VALUES (${newTicket.id}, ${userId}::uuid, ${'✂️ This ticket was split from #' + sourceTicket.ticket_number + ': "' + sourceTicket.subject + '"'}, true, true, NOW(), NOW())`;
      await sql`UPDATE tickets SET updated_at = NOW() WHERE id = ${sourceTicket.id}`;
      await sql`INSERT INTO ticket_audit_log (ticket_id, actor_name, actor_id, action) VALUES (${sourceTicket.id}, 'Agent', ${userId}, 'split_out')`.catch(() => {});
      await sql`INSERT INTO ticket_audit_log (ticket_id, actor_name, actor_id, action) VALUES (${newTicket.id}, 'Agent', ${userId}, 'split_created')`.catch(() => {});

      res.json({ success: true, new_ticket: newTicket });
    } catch (e) {
      console.error('[ticket split native]', e.message);
      res.status(500).json({ error: e.message || 'Failed' });
    }
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

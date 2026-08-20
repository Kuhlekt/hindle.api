// ─── Helpdesk Proxy Routes (v2 — full agent parity) ─────────────────────────
// Replaces the previous helpdesk-proxy-routes.js entirely.
// Adds: categories, canned responses, ticket assignment/priority/category
// updates, internal notes (via is_internal flag), cause/resolution save,
// CSAT result lookup, and SLA info — all passthrough to the real helpdesk
// API, scoped per-tenant exactly like the original routes.

const HELPDESK_API_BASE = process.env.HELPDESK_API_BASE || 'https://helpdesk.hindleconsultants.com';
const SELF_BASE_URL = process.env.SELF_BASE_URL || 'https://hindleapi-production.up.railway.app';

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
  // NATIVE — Stage 2: full logic ported from the perfected Kuhlekt
  // messages/route.ts (UUID validation, audit logging, reopen-on-reply).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  router.get('/tickets/:id/messages', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [], messages: [] });
    try {
      const msgs = await sql`
        SELECT m.id, m.ticket_id, m.user_id, m.message, m.message AS body,
               m.is_internal, m.is_read, m.created_at, m.updated_at,
               u.full_name AS author_name, u.role AS author_role
        FROM ticket_messages m
        LEFT JOIN user_profiles u ON u.id = m.user_id
        WHERE m.ticket_id::text = ${req.params.id}
        ORDER BY m.created_at ASC`;
      res.json({ success: true, data: [...msgs], messages: [...msgs] });
    } catch (e) {
      console.error('[messages GET native]', e.message);
      res.json({ success: true, data: [], messages: [] });
    }
  });

  router.post('/tickets/:id/messages', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const tid = req.params.id;
    const b = req.body || {};
    const userId = req.headers['x-user-id'] || req.body?.agent_id || null;
    const userIdForDb = userId && UUID_RE.test(userId) ? userId : null;
    const message = b.body || b.message || '';
    const isInternal = b.is_internal || false;
    if (!message.trim()) return res.status(400).json({ error: 'Message cannot be empty' });

    try {
      const ticket = await sql`SELECT id FROM tickets WHERE id::text = ${tid} OR ticket_number = ${tid} LIMIT 1`;
      if (!ticket.length) return res.status(404).json({ error: 'Ticket not found' });
      const ticketUUID = ticket[0].id;

      const r = await sql`
        INSERT INTO ticket_messages(ticket_id, user_id, message, is_internal, is_read, created_at, updated_at)
        VALUES(${ticketUUID}, ${userIdForDb}::uuid, ${message}, ${isInternal}, false, NOW(), NOW())
        RETURNING *`;
      const msg = r[0];

      const auditAction = b.is_cause ? 'cause_added' : isInternal ? 'internal_note' : 'reply';
      await sql`INSERT INTO ticket_audit_log (ticket_id, actor_name, actor_id, action) VALUES (${ticketUUID}::uuid, ${userId ? 'Agent' : 'Customer'}, ${userId}, ${auditAction})`.catch(() => {});

      if (b.is_cause && message) {
        await sql`UPDATE tickets SET cause=${message}, updated_at=NOW() WHERE id::text=${tid}`.catch(() => {});
      } else {
        await sql`UPDATE tickets SET updated_at=NOW() WHERE id::text=${tid}`.catch(() => {});
      }

      // Reopen-on-reply
      if (!isInternal && !b.is_cause) {
        const ticketNow = await sql`SELECT status FROM tickets WHERE id::text = ${tid} LIMIT 1`;
        const curStatus = ticketNow[0]?.status;
        if (curStatus === 'resolved' || curStatus === 'closed') {
          await sql`UPDATE tickets SET status = 'open', updated_at = NOW() WHERE id::text = ${tid}`.catch(() => {});
          await sql`INSERT INTO ticket_audit_log (ticket_id, actor_name, actor_id, action, field_name, old_value, new_value) VALUES (${ticketUUID}::uuid, ${userId ? 'Agent' : 'Customer'}, ${userId}, 'field_changed', 'status', ${curStatus}, 'open')`.catch(() => {});
        }
      }

      // Agent-reply email notification. Calls the existing, already-proven
      // /api/helpdesk/webhook/ticket-event endpoint (self-call, since we're
      // now running inside hindle_api itself rather than a separate app) —
      // reuses the exact same tested email logic rather than duplicating it.
      if (!isInternal && userId) {
        const ticketRow = await sql`
          SELECT t.ticket_number, t.subject, t.organization_id, u.full_name AS requester_name, u.email AS requester_email
          FROM tickets t LEFT JOIN user_profiles u ON u.id = t.customer_id
          WHERE t.id::text = ${tid} LIMIT 1`;
        const row = ticketRow[0];
        if (row?.organization_id && row?.requester_email && process.env.HELPDESK_WEBHOOK_SECRET) {
          fetch(`${SELF_BASE_URL}/api/helpdesk/webhook/ticket-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': process.env.HELPDESK_WEBHOOK_SECRET },
            body: JSON.stringify({
              event: 'agent_reply',
              helpdesk_org_id: String(row.organization_id),
              ticket_id: tid,
              ticket_number: row.ticket_number,
              subject: row.subject,
              requester_name: row.requester_name,
              requester_email: row.requester_email,
              reply_body: message,
            }),
          }).catch(e => console.error('[agent_reply notify self-call]', e.message));
        }
      }

      res.json({ success: true, data: { ...msg, body: msg.message } });
    } catch (e) {
      console.error('[messages POST native]', e.message);
      res.status(500).json({ error: e.message || 'Failed' });
    }
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
  // NATIVE — Stage 2
  router.get('/resolution-types', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [] });
    try {
      const rows = await sql`
        SELECT id, name, sort_order FROM resolution_types
        WHERE organization_id = ${helpdeskOrgId}::uuid
        ORDER BY sort_order ASC, name ASC`;
      res.json({ success: true, data: [...rows] });
    } catch (e) {
      console.error('[resolution-types GET native]', e.message);
      res.json({ success: true, data: [] });
    }
  });

  router.post('/resolution-types', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.status(400).json({ error: 'Helpdesk is not enabled for this tenant.' });
    const name = req.body?.name;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    try {
      const maxRow = await sql`SELECT COALESCE(MAX(sort_order),0) as m FROM resolution_types WHERE organization_id = ${helpdeskOrgId}::uuid`;
      const r = await sql`
        INSERT INTO resolution_types (organization_id, name, sort_order)
        VALUES (${helpdeskOrgId}::uuid, ${name.trim()}, ${(maxRow[0]?.m || 0) + 1})
        RETURNING id, name, sort_order`;
      res.json({ success: true, data: r[0] });
    } catch (e) {
      console.error('[resolution-types POST native]', e.message);
      res.status(500).json({ error: e.message || 'Failed' });
    }
  });

  // ── Canned responses ──────────────────────────────────────────────────
  // NATIVE — Stage 2 (read-only for now; admin CRUD for canned responses is
  // Tier 2 work, not yet needed by the dashboard UI which only reads them)
  router.get('/canned-responses', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [] });
    try {
      const rows = await sql`
        SELECT id, title, content, category, shortcut, use_count
        FROM canned_responses WHERE organization_id = ${helpdeskOrgId}::uuid
        ORDER BY title ASC`;
      res.json({ success: true, data: [...rows] });
    } catch (e) {
      console.error('[canned-responses GET native]', e.message);
      res.json({ success: true, data: [] });
    }
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
  // ── CSAT result for a specific ticket (if any) ────────────────────────
  // NATIVE — Stage 2: uses the confirmed csat_reviews schema (ticket_id,
  // organization_id, score, comment, created_at) from the Stage 1 migration.
  router.get('/tickets/:id/csat', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: null });
    try {
      const rows = await sql`
        SELECT score, comment, created_at FROM csat_reviews
        WHERE ticket_id::text = ${req.params.id}
        ORDER BY created_at DESC LIMIT 1`;
      res.json({ success: true, data: rows[0] || null });
    } catch (e) {
      console.error('[csat GET native]', e.message);
      res.json({ success: true, data: null });
    }
  });

  // ── Ticket audit log ────────────────────────────────────────────────
  // NATIVE — Stage 2
  router.get('/tickets/:id/audit-log', async (req, res) => {
    const helpdeskOrgId = await resolveHelpdeskOrgId(req);
    if (!helpdeskOrgId) return res.json({ success: true, data: [] });
    try {
      const rows = await sql`
        SELECT * FROM ticket_audit_log
        WHERE ticket_id::text = ${req.params.id}
        ORDER BY created_at ASC`;
      res.json({ success: true, data: [...rows] });
    } catch (e) {
      console.error('[audit-log GET native]', e.message);
      res.json({ success: true, data: [] });
    }
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

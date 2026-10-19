// ─── Customer-portal SSO (SAML) settings for the Ops Centre ─────────────────
// Reads/writes org_saml_settings in the shared Neon DB for the tenant's linked
// helpdesk organisation. The helpdesk portal owns the SAML flow itself and the
// per-org signing keys (encrypted with SAML_KEY_ENCRYPTION on Vercel); this
// API never touches private keys. Keys are created by calling the portal's
// public metadata endpoint, which generates them on first use.
//
// Mounted behind requireAuth. tenant_admin → own tenant only;
// super_admin → any tenant via ?tenant_id= / body.tenant_id.

const { DOMParser } = require("@xmldom/xmldom");

const HELPDESK_API_BASE = (process.env.HELPDESK_API_BASE || "https://helpdesk.hindleconsultants.com").replace(/\/+$/, "");
const PORTAL_PUBLIC_URL = (process.env.PORTAL_PUBLIC_URL || HELPDESK_API_BASE).replace(/\/+$/, "");

function spUrls(slug) {
  const base = `${PORTAL_PUBLIC_URL}/api/portal/${encodeURIComponent(slug)}/saml`;
  return { entityId: `${base}/metadata`, metadataUrl: `${base}/metadata`, acsUrl: `${base}/acs`, testUrl: `${base}/login?test=1` };
}

function normaliseDomains(input) {
  const list = Array.isArray(input) ? input : String(input || "").split(/[\s,;]+/);
  const out = new Set();
  for (const d of list) {
    const v = String(d).trim().toLowerCase().replace(/^@/, "");
    if (!v) continue;
    if (!/^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(v)) throw new Error(`"${v}" is not a valid email domain`);
    out.add(v);
  }
  return [...out];
}

const MD = "urn:oasis:names:tc:SAML:2.0:metadata";
const DS = "http://www.w3.org/2000/09/xmldsig#";
function parseIdpMetadata(xml) {
  if (!xml || xml.length > 500000) throw new Error("Metadata is empty or too large");
  if (/<!DOCTYPE/i.test(xml)) throw new Error("Metadata must not contain a DOCTYPE");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const all = (ns, tag, root = doc) => Array.from(root.getElementsByTagNameNS(ns, tag));
  const ed = all(MD, "EntityDescriptor")[0];
  if (!ed) throw new Error("No EntityDescriptor found — is this identity provider metadata?");
  const idp = all(MD, "IDPSSODescriptor", ed)[0];
  if (!idp) throw new Error("No IDPSSODescriptor found — this looks like SP metadata, not IdP metadata");
  const pick = (tag) => {
    const els = all(MD, tag, idp);
    const by = (b) => els.find((e) => (e.getAttribute("Binding") || "").endsWith(b));
    const el = by("HTTP-Redirect") || by("HTTP-POST") || els[0];
    return el ? el.getAttribute("Location") : null;
  };
  const certs = all(MD, "KeyDescriptor", idp)
    .filter((k) => !k.getAttribute("use") || k.getAttribute("use") === "signing")
    .flatMap((k) => all(DS, "X509Certificate", k).map((c) => String(c.textContent || "").replace(/\s+/g, "")))
    .filter(Boolean);
  const entityId = ed.getAttribute("entityID");
  const ssoUrl = pick("SingleSignOnService");
  if (!entityId || !ssoUrl || !certs.length) throw new Error("Metadata is missing entityID, SingleSignOnService or a signing certificate");
  return { entityId, ssoUrl, sloUrl: pick("SingleLogoutService"), cert: certs[0] };
}

async function fetchText(url, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "error" });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } finally { clearTimeout(t); }
}

async function fetchIdpMetadata(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error("Metadata address is not a valid URL"); }
  if (u.protocol !== "https:") throw new Error("Metadata address must use https://");
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.)/i.test(u.hostname)) {
    throw new Error("Metadata address must be a public host");
  }
  const r = await fetchText(u.toString());
  if (!r.ok) throw new Error(`Metadata fetch failed (HTTP ${r.status})`);
  return r.text;
}

module.exports = function ssoSettingsRouter(sql) {
  const express = require("express");
  const router = express.Router();

  // Resolve tenant → linked helpdesk org + portal slug, enforcing role/tenant scope.
  async function resolve(req, bodyTenantId) {
    const role = req.auth?.role;
    let tenantId = null;
    if (role === "super_admin") tenantId = bodyTenantId || req.query.tenant_id || null;
    else if (role === "tenant_admin" || role === "admin") tenantId = req.auth.org_id;
    else return { status: 403, error: "Only tenant admins can manage single sign-on." };
    if (!tenantId) return { status: 400, error: "Choose a tenant first." };

    const t = await sql`SELECT id, name, helpdesk_org_id FROM organisations WHERE id::text = ${String(tenantId)} LIMIT 1`;
    if (!t[0]) return { status: 404, error: "Tenant not found." };
    if (!t[0].helpdesk_org_id) return { status: 400, error: "This tenant isn't linked to a helpdesk portal yet, so portal SSO isn't available." };
    const h = await sql`SELECT id, name, slug FROM organizations WHERE id = ${t[0].helpdesk_org_id}::uuid LIMIT 1`;
    if (!h[0] || !h[0].slug) return { status: 400, error: "The linked helpdesk organisation has no portal address (slug)." };
    return { tenant: t[0], org: h[0] };
  }

  // Ask the portal to create the settings row + signing keys if missing.
  async function ensureSettings(org) {
    const got = await sql`SELECT * FROM org_saml_settings WHERE organization_id = ${org.id}::uuid LIMIT 1`.catch(() => []);
    if (got[0] && got[0].sp_cert && got[0].sp_key_enc) return got[0];
    const r = await fetchText(spUrls(org.slug).metadataUrl, 20000).catch((e) => ({ ok: false, status: 0, text: e.message }));
    if (!r.ok) {
      let msg = r.text;
      try { msg = JSON.parse(r.text).error || msg; } catch {}
      throw new Error(`Helpdesk portal could not prepare SSO keys: ${String(msg).slice(0, 200)}`);
    }
    const again = await sql`SELECT * FROM org_saml_settings WHERE organization_id = ${org.id}::uuid LIMIT 1`;
    if (!again[0]) throw new Error("SSO settings were not created by the portal.");
    return again[0];
  }

  function view(s, ctx) {
    const u = spUrls(ctx.org.slug);
    const configured = !!(s.sp_cert && s.sp_key_enc && s.idp_entity_id && s.idp_sso_url && s.idp_cert);
    return {
      tenant: { id: ctx.tenant.id, name: ctx.tenant.name },
      portal: { slug: ctx.org.slug, name: ctx.org.name, login_url: `${PORTAL_PUBLIC_URL}/t/${encodeURIComponent(ctx.org.slug)}/login` },
      enabled: !!s.enabled, sso_only: !!s.sso_only, auto_create: s.auto_create !== false,
      allowed_domains: s.allowed_domains || [],
      idp_entity_id: s.idp_entity_id, idp_sso_url: s.idp_sso_url, idp_slo_url: s.idp_slo_url,
      idp_cert_set: !!s.idp_cert, idp_metadata_url: s.idp_metadata_url,
      last_test_ok_at: s.last_test_ok_at, last_test_email: s.last_test_email,
      configured,
      sp: { entity_id: u.entityId, acs_url: u.acsUrl, metadata_url: u.metadataUrl, cert: s.sp_cert },
      test_url: u.testUrl,
    };
  }

  router.get("/settings", async (req, res) => {
    try {
      const ctx = await resolve(req);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      const s = await ensureSettings(ctx.org);
      res.json({ success: true, data: view(s, ctx) });
    } catch (e) {
      console.error("[sso settings GET]", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.put("/settings", async (req, res) => {
    try {
      const b = req.body || {};
      const ctx = await resolve(req, b.tenant_id);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      const orgId = ctx.org.id;
      const cur = await ensureSettings(ctx.org);

      let idp = { entity: cur.idp_entity_id, sso: cur.idp_sso_url, slo: cur.idp_slo_url, cert: cur.idp_cert, mdUrl: cur.idp_metadata_url };
      if (b.idp_metadata_xml || b.idp_metadata_url) {
        const xml = b.idp_metadata_xml ? String(b.idp_metadata_xml) : await fetchIdpMetadata(String(b.idp_metadata_url));
        const m = parseIdpMetadata(xml);
        idp = { entity: m.entityId, sso: m.ssoUrl, slo: m.sloUrl, cert: m.cert, mdUrl: b.idp_metadata_url ? String(b.idp_metadata_url) : null };
      }
      for (const u of [idp.sso, idp.slo]) if (u && !/^https:\/\//i.test(u)) return res.status(400).json({ error: "Identity provider addresses must use https://" });
      const idpChanged = idp.entity !== cur.idp_entity_id || idp.sso !== cur.idp_sso_url || idp.cert !== cur.idp_cert;

      let domains = cur.allowed_domains || [];
      if (b.allowed_domains !== undefined) domains = normaliseDomains(b.allowed_domains);
      if (domains.length) {
        const clash = await sql`SELECT 1 FROM org_saml_settings WHERE organization_id <> ${orgId}::uuid AND allowed_domains && ${domains}::text[] LIMIT 1`;
        if (clash.length) return res.status(409).json({ error: "One of these domains is already used for single sign-on by another organisation." });
      }
      const domainsChanged = JSON.stringify([...domains].sort()) !== JSON.stringify([...(cur.allowed_domains || [])].sort());

      // Any change to the IdP or domains invalidates the previous test and switches SSO off.
      const resetTest = idpChanged || domainsChanged;
      let enabled = b.enabled !== undefined ? !!b.enabled : !!cur.enabled;
      if (resetTest) enabled = false;
      if (enabled && !cur.enabled) {
        if (!(idp.entity && idp.sso && idp.cert && cur.sp_cert && cur.sp_key_enc)) return res.status(400).json({ error: "Import the identity provider before switching single sign-on on." });
        if (!domains.length) return res.status(400).json({ error: "Add at least one allowed email domain before switching single sign-on on." });
        if (!cur.last_test_ok_at) return res.status(400).json({ error: "Run a successful Test sign-in with the current settings before switching single sign-on on." });
      }

      await sql`
        UPDATE org_saml_settings SET
          idp_entity_id = ${idp.entity}, idp_sso_url = ${idp.sso}, idp_slo_url = ${idp.slo}, idp_cert = ${idp.cert},
          idp_metadata_url = ${idp.mdUrl}, allowed_domains = ${domains}::text[],
          enabled = ${enabled},
          sso_only = ${b.sso_only !== undefined ? !!b.sso_only && enabled : !!cur.sso_only && enabled},
          auto_create = ${b.auto_create !== undefined ? !!b.auto_create : cur.auto_create !== false},
          last_test_ok_at = ${resetTest ? null : cur.last_test_ok_at},
          last_test_email = ${resetTest ? null : cur.last_test_email},
          updated_at = NOW()
        WHERE organization_id = ${orgId}::uuid`;
      const s = (await sql`SELECT * FROM org_saml_settings WHERE organization_id = ${orgId}::uuid LIMIT 1`)[0];
      console.log("[sso settings] updated", { tenant: ctx.tenant.id, by: req.auth?.email, enabled: s.enabled, resetTest });
      res.json({ success: true, data: view(s, ctx) });
    } catch (e) {
      console.error("[sso settings PUT]", e.message);
      res.status(400).json({ error: e.message || "Save failed" });
    }
  });

  // One-time test link (10 min, single use). The portal accepts ?test_ticket=
  // in place of a portal admin session, so Ops Centre admins can run a test.
  router.post("/test-link", async (req, res) => {
    try {
      const ctx = await resolve(req, (req.body || {}).tenant_id);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      const s = await ensureSettings(ctx.org);
      if (!(s.idp_entity_id && s.idp_sso_url && s.idp_cert)) return res.status(400).json({ error: "Import the identity provider first." });
      if (!(s.allowed_domains || []).length) return res.status(400).json({ error: "Add at least one allowed email domain first." });
      await sql`CREATE TABLE IF NOT EXISTS saml_test_tickets (
        token TEXT PRIMARY KEY, organization_id UUID NOT NULL, created_by TEXT,
        expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ)`;
      await sql`DELETE FROM saml_test_tickets WHERE expires_at < NOW()`.catch(() => {});
      const token = require("crypto").randomBytes(24).toString("hex");
      await sql`INSERT INTO saml_test_tickets (token, organization_id, created_by, expires_at)
                VALUES (${token}, ${ctx.org.id}::uuid, ${req.auth?.email || null}, ${new Date(Date.now() + 10 * 60000)})`;
      const base = `${PORTAL_PUBLIC_URL}/api/portal/${encodeURIComponent(ctx.org.slug)}/saml/login`;
      res.json({ success: true, url: `${base}?test=1&test_ticket=${token}` });
    } catch (e) {
      console.error("[sso test-link]", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};

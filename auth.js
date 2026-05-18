const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

function getDb() { return neon(process.env.DATABASE_URL || process.env.POSTGRES_URL); }

// ── PIN hashing ──────────────────────────────────────────────────────────────
// Always pass a salt for new hashes. Legacy unsalted hashes still verified
// via fallback for accounts that haven't logged in since v0.5.185.
function hashPin(p, salt) {
  if (salt) return crypto.createHash('sha256').update(salt + ':' + String(p)).digest('hex');
  return crypto.createHash('sha256').update(String(p)).digest('hex'); // legacy only
}
function makeSalt()  { return crypto.randomBytes(16).toString('hex'); }
function makeToken() { return crypto.randomBytes(32).toString('hex'); }

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

// ── Rate limiting constants ───────────────────────────────────────────────────
const MAX_ATTEMPTS    = 5;   // failed logins before lockout
const LOCKOUT_MINUTES = 15;  // lockout duration

async function recordFailedAttempt(sql, userId, identifier, ip) {
  await sql`
    INSERT INTO auth_attempts (identifier, ip, success)
    VALUES (${identifier}, ${ip||null}, false)
  `.catch(() => {});
  if (!userId) return;
  // Increment counter; apply lock when threshold reached
  await sql`
    UPDATE users SET
      failed_attempts = failed_attempts + 1,
      locked_until = CASE
        WHEN (failed_attempts + 1) >= ${MAX_ATTEMPTS}
        THEN NOW() + (${LOCKOUT_MINUTES} || ' minutes')::interval
        ELSE locked_until
      END
    WHERE id = ${userId}
  `.catch(() => {});
}

async function clearFailedAttempts(sql, userId, identifier, ip) {
  await sql`
    INSERT INTO auth_attempts (identifier, ip, success)
    VALUES (${identifier}, ${ip||null}, true)
  `.catch(() => {});
  if (!userId) return;
  await sql`
    UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ${userId}
  `.catch(() => {});
}

// ── Audit logging ─────────────────────────────────────────────────────────────
async function logAudit(sql, userId, action, details, ip) {
  await sql`
    INSERT INTO audit_log (user_id, action, details, ip)
    VALUES (${userId||null}, ${action}, ${JSON.stringify(details||{})}::jsonb, ${ip||null})
  `.catch(() => {}); // never let audit failures break auth
}

// ── Dev user check (server-side) ──────────────────────────────────────────────
const DEV_EMAILS = ['ian@hindle.biz', 'ian.hindle@kuhlekt.com'];
function isDevEmail(email) {
  return DEV_EMAILS.includes((email || '').toLowerCase());
}

// ── sqlForUser (mirrors data.js — used for RLS-protected inserts in setup) ────
function sqlForUser(sql, userId) {
  return function(strings, ...values) {
    if (typeof sql.transaction === 'function') {
      return sql.transaction([
        sql`SELECT set_config('app.current_user_id', ${String(userId)}, true)`,
        sql(strings, ...values)
      ]).then(function(results) { return results[1]; });
    }
    return sql(strings, ...values);
  };
}

// ── IP extraction ─────────────────────────────────────────────────────────────
function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || null;
}

module.exports = async function (req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;
  const sql = getDb();
  const ip  = getIp(req);

  // ── Setup ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'setup') {
    const {
      name, email, pin, hasPersonal, hasBusiness,
      profiles, entities, accounts, categoryIds
    } = req.body;
    if (!name || !pin || pin.length < 4)
      return res.status(400).json({ error: 'Name and 4-digit PIN required' });
    if (email) {
      const ex = await sql`SELECT id FROM users WHERE email=${email} LIMIT 1`;
      if (ex.length) return res.status(409).json({ error: 'Email already registered' });
    }
    const pinSalt = makeSalt();
    const pinHash = hashPin(pin, pinSalt);
    const token   = makeToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const rows = await sql`
      INSERT INTO users (name,email,pin_hash,pin_salt,session_token,token_expires,
                         has_personal,has_business,setup_complete)
      VALUES (${name},${email||null},${pinHash},${pinSalt},${token},${expires},
              ${!!hasPersonal},${!!hasBusiness},true)
      RETURNING id,name,email,has_personal,has_business
    `;
    const user = rows[0];
    const usql = sqlForUser(sql, user.id); // RLS-aware helper for data table inserts

    let primaryProfile = null;
    if (hasPersonal && profiles?.length) {
      for (let i = 0; i < profiles.length; i++) {
        const p = profiles[i];
        const profSalt = makeSalt();
        const profilePin = i === 0
          ? hashPin(pin, profSalt)
          : (p.pin && p.pin.length >= 4 ? hashPin(p.pin, profSalt) : null);
        const pr = await sql`
          INSERT INTO profiles (user_id,name,avatar,is_primary,pin_hash,pin_salt)
          VALUES (${user.id},${p.name},${p.avatar||'👤'},${i===0},${profilePin},${profSalt})
          RETURNING id,name,avatar
        `;
        if (i === 0) primaryProfile = pr[0];
      }
    }

    if (hasBusiness && entities?.length) {
      for (const e of entities) {
        await sql`
          INSERT INTO entities (user_id,name,abn,type,is_primary)
          VALUES (${user.id},${e.name},${e.abn||null},${e.type||'Company'},true)
        `;
      }
    }

    if (accounts?.length) {
      for (let i = 0; i < accounts.length; i++) {
        const a = accounts[i];
        if (!a.name?.trim()) continue;
        await usql`
          INSERT INTO accounts (user_id,name,institution,balance,color,is_primary,last4)
          VALUES (${user.id},${a.name},${a.institution||null},${parseFloat(a.balance)||0},
                  ${a.color||'#2563eb'},${i===0},${a.last4||null})
        `;
      }
    }

    if (categoryIds?.length) {
      const sc = await sql`SELECT * FROM categories WHERE user_id IS NULL AND id=ANY(${categoryIds})`;
      for (const c of sc) {
        await usql`
          INSERT INTO categories (user_id,label,icon,color,mode,is_system,sort_order)
          VALUES (${user.id},${c.label},${c.icon},${c.color},${c.mode},false,${c.sort_order})
        `;
      }
    }

    await logAudit(sql, user.id, 'setup.complete', { name, email }, ip);
    return res.status(201).json({ success: true, token, user, profile: primaryProfile });
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'login') {
    const { name, email, pin } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN required' });
    const identifier = email || name || 'unknown';

    // 1. Try profile login (Leesa, Graeme etc.)
    try {
      const profRows = await sql`
        SELECT p.id as pid, p.name as pname, p.avatar,
               p.pin_hash as phash, p.pin_salt as psalt,
               u.id, u.name, u.email, u.has_personal, u.has_business, u.setup_complete,
               u.plan, u.plan_billing, u.feature_overrides, u.encryption_enabled,
               u.failed_attempts, u.locked_until
        FROM profiles p JOIN users u ON u.id = p.user_id
        WHERE p.is_primary = false AND p.is_active = true
          AND (
            (p.email IS NOT NULL AND LOWER(p.email) = LOWER(${email||'__none__'}))
            OR (${name||''} <> '' AND LOWER(p.name) = LOWER(${name||''}))
          )
        LIMIT 5
      `;
      const prof = profRows.find(r =>
        r.phash === hashPin(pin, r.psalt||null) || r.phash === hashPin(pin)
      );
      if (prof) {
        if (prof.locked_until && new Date(prof.locked_until) > new Date()) {
          await logAudit(sql, prof.id, 'login.locked', { identifier }, ip);
          return res.status(429).json({
            error: 'Account temporarily locked. Please try again later.',
            locked_until: prof.locked_until
          });
        }
        const token   = makeToken();
        const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await sql`UPDATE users SET session_token=${token}, token_expires=${expires},
                  failed_attempts=0, locked_until=NULL WHERE id=${prof.id}`;
        await clearFailedAttempts(sql, prof.id, identifier, ip);
        await logAudit(sql, prof.id, 'login.success', { profile: prof.pname }, ip);
        const isDev = isDevEmail(prof.email);
        return res.status(200).json({
          success: true, token,
          user: {
            id: prof.id, name: prof.name, has_personal: prof.has_personal,
            has_business: prof.has_business, setup_complete: prof.setup_complete,
            plan: isDev ? 'business' : (prof.plan || 'free'),
            plan_billing: prof.plan_billing,
            feature_overrides: prof.feature_overrides || {},
            encryption_enabled: !!prof.encryption_enabled,
            is_dev: isDev
          },
          profile: { id: prof.pid, name: prof.pname, avatar: prof.avatar, notify_receive: true }
        });
      }
    } catch(e) { console.error('Profile login error:', e.message); }

    // 2. Main user login
    try {
      const uRows = email
        ? await sql`SELECT * FROM users WHERE LOWER(email) = LOWER(${email}) LIMIT 5`
        : await sql`SELECT * FROM users WHERE LOWER(name)  = LOWER(${name||''}) LIMIT 5`;

      const user = uRows.find(r =>
        r.pin_hash === hashPin(pin, r.pin_salt||null) || r.pin_hash === hashPin(pin)
      );

      if (!user) {
        const target = uRows[0] || null;
        await recordFailedAttempt(sql, target?.id || null, identifier, ip);
        await logAudit(sql, target?.id || null, 'login.fail', { identifier }, ip);
        return res.status(401).json({ error: 'Email or PIN incorrect' });
      }

      // Check lockout
      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        await logAudit(sql, user.id, 'login.locked', { identifier }, ip);
        return res.status(429).json({
          error: 'Account temporarily locked. Please try again later.',
          locked_until: user.locked_until
        });
      }

      const token   = makeToken();
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await sql`UPDATE users SET session_token=${token}, token_expires=${expires},
                failed_attempts=0, locked_until=NULL WHERE id=${user.id}`;

      // Auto-migrate legacy unsalted hash on first login after v0.5.195
      if (!user.pin_salt) {
        const migrSalt = makeSalt();
        const migrHash = hashPin(pin, migrSalt);
        await sql`UPDATE users SET pin_hash=${migrHash}, pin_salt=${migrSalt} WHERE id=${user.id}`;
      }

      await clearFailedAttempts(sql, user.id, identifier, ip);
      await logAudit(sql, user.id, 'login.success', { email: user.email }, ip);

      const prim = await sql`
        SELECT id,name,avatar FROM profiles
        WHERE user_id=${user.id} AND is_primary=true LIMIT 1
      `;
      const isDev = isDevEmail(user.email);
      return res.status(200).json({
        success: true, token,
        user: {
          id: user.id, name: user.name, has_personal: user.has_personal,
          has_business: user.has_business, setup_complete: user.setup_complete,
          plan: isDev ? 'business' : (user.plan || 'free'),
          plan_billing: user.plan_billing,
          feature_overrides: user.feature_overrides || {},
          encryption_enabled: !!user.encryption_enabled,
          is_dev: isDev
        },
        profile: prim[0] ? { ...prim[0], notify_receive: true } : null
      });
    } catch(e) {
      console.error('User login error:', e.message);
      return res.status(500).json({ error: 'Login error: ' + e.message });
    }
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'verify') {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });
    const rows = await sql`
      SELECT id, name, email, has_personal, has_business, setup_complete,
             plan, plan_billing, plan_activated_at, feature_overrides, encryption_enabled
      FROM users WHERE session_token=${token} AND token_expires > NOW() LIMIT 1
    `;
    if (!rows.length) return res.status(401).json({ error: 'Session expired' });
    const user = rows[0];
    const isDev = isDevEmail(user.email);
    // Auto-refresh token expiry on every verify — keeps active users logged in
    const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await sql`UPDATE users SET token_expires=${newExpiry} WHERE id=${user.id}`.catch(() => {});

    let profile = null;
    const profileId = req.query.profile_id;
    try {
      if (profileId && parseInt(profileId)) {
        const pRows = await sql`
          SELECT id,name,avatar,notify_receive FROM profiles
          WHERE id=${parseInt(profileId)} AND user_id=${user.id} LIMIT 1
        `;
        profile = pRows[0] || null;
      }
      if (!profile) {
        const pRows = await sql`
          SELECT id,name,avatar,notify_receive FROM profiles
          WHERE user_id=${user.id} AND is_primary=true LIMIT 1
        `;
        profile = pRows[0] || null;
      }
      if (profile) profile.notify_receive = profile.notify_receive !== false;
    } catch(e) { /* notify_receive column may not exist yet */ }

    return res.status(200).json({
      success: true,
      user: {
        ...user,
        plan: isDev ? 'business' : (user.plan || 'free'),
        feature_overrides: user.feature_overrides || {},
        is_dev: isDev
      },
      profile
    });
  }

  // ── System categories ─────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'system-categories') {
    const rows = await sql`
      SELECT id,label,icon,color,mode,sort_order
      FROM categories WHERE user_id IS NULL ORDER BY mode,sort_order
    `;
    return res.status(200).json({ success: true, categories: rows });
  }

  // ── Profiles list ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'profiles') {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Unauthorised' });
    const u = await sql`SELECT id FROM users WHERE session_token=${token} AND token_expires>NOW() LIMIT 1`;
    if (!u.length) return res.status(401).json({ error: 'Session expired' });
    const rows = await sql`
      SELECT id, name, avatar, is_primary, is_active, (pin_hash IS NOT NULL) as has_pin
      FROM profiles WHERE user_id=${u[0].id} ORDER BY is_primary DESC, id ASC
    `;
    return res.status(200).json({ success: true, profiles: rows });
  }

  // ── Forgot PIN ────────────────────────────────────────────────────────────
  // Always returns 200 — prevents user enumeration
  if (req.method === 'POST' && action === 'forgot-pin') {
    const { email } = req.body;
    if (!email) return res.status(200).json({ success: true });

    let targetId = null, targetName = null, isProfile = false, profileId = null;
    const uRow = await sql`SELECT id,name FROM users WHERE LOWER(email)=LOWER(${email}) LIMIT 1`;
    if (uRow.length) {
      targetId = uRow[0].id; targetName = uRow[0].name;
    } else {
      const pRow = await sql`
        SELECT p.id as pid, p.name as pname, u.id as uid
        FROM profiles p JOIN users u ON u.id=p.user_id
        WHERE LOWER(p.email)=LOWER(${email}) AND p.is_active=true LIMIT 1
      `;
      if (pRow.length) {
        targetId = pRow[0].uid; profileId = pRow[0].pid;
        targetName = pRow[0].pname; isProfile = true;
      }
    }

    if (targetId) {
      const code    = String(Math.floor(100000 + Math.random() * 900000));
      const expires = new Date(Date.now() + 15 * 60 * 1000);
      if (isProfile) {
        await sql`
          UPDATE profiles SET reset_code=${code}, reset_expires=${expires} WHERE id=${profileId}
        `.catch(()=>{});
      } else {
        await sql`
          INSERT INTO pin_resets (user_id, user_type, code, expires_at, email)
          VALUES (${targetId}, 'user', ${code}, ${expires}, ${email.toLowerCase()})
          ON CONFLICT (email) DO UPDATE SET code=${code}, expires_at=${expires}
        `.catch(() => console.error('pin_resets table missing — run migration_v1.sql'));
      }
      const resetLink = (process.env.APP_URL||'https://track.hindle.biz')
        + '?reset_pin=' + code + '&email=' + encodeURIComponent(email)
        + (isProfile ? '&profile=1' : '');
      const csUser = process.env.CLICKSEND_USERNAME;
      const csKey  = process.env.CLICKSEND_API_KEY;
      if (csUser && csKey) {
        await fetch('https://rest.clicksend.com/v3/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(csUser+':'+csKey).toString('base64') },
          body: JSON.stringify({
            to: [{ email, name: targetName }],
            from: { email_address_id: 6504, name: 'Activities App' },
            subject: 'Reset your Activities PIN',
            body: `<p>Hi ${targetName},</p><p>Your PIN reset code is: <strong>${code}</strong></p>`
              + `<p>Or click here: <a href="${resetLink}">${resetLink}</a></p>`
              + `<p>Expires in 15 minutes.</p>`
          })
        }).catch(e => console.error('Email error:', e));
      } else {
        // PIN reset code not logged — sent via ClickSend only
      }
      await logAudit(sql, targetId, 'pin.reset_requested', { email }, ip);
    }
    return res.status(200).json({ success: true });
  }

  // ── Verify PIN reset ──────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'verify-pin-reset') {
    const { email, code, newPin } = req.body;
    if (!email || !code || !newPin || newPin.length < 4)
      return res.status(400).json({ error: 'All fields required' });

    // Always salt on reset
    const newSalt = makeSalt();
    const newHash = hashPin(newPin, newSalt);
    const token   = makeToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // Try pin_resets table first
    let uRow = [];
    try {
      const resetRow = await sql`
        SELECT * FROM pin_resets
        WHERE LOWER(email)=LOWER(${email}) AND code=${code}
          AND expires_at > NOW() AND user_type='user' LIMIT 1
      `;
      if (resetRow.length) {
        uRow = await sql`SELECT * FROM users WHERE id=${resetRow[0].user_id} LIMIT 1`;
        if (uRow.length) {
          await sql`DELETE FROM pin_resets WHERE email=${email.toLowerCase()}`.catch(()=>{});
        }
      }
    } catch(e) {}

    // Fallback: legacy session_token-as-code
    if (!uRow.length) {
      uRow = await sql`
        SELECT * FROM users WHERE LOWER(email)=LOWER(${email})
          AND session_token=${code} AND token_expires > NOW() LIMIT 1
      `;
    }

    if (uRow.length) {
      await sql`
        UPDATE users SET pin_hash=${newHash}, pin_salt=${newSalt},
          session_token=${token}, token_expires=${expires}
        WHERE id=${uRow[0].id}
      `;
      await sql`
        UPDATE profiles SET pin_hash=${newHash}, pin_salt=${newSalt}
        WHERE user_id=${uRow[0].id} AND is_primary=true
      `;
      await logAudit(sql, uRow[0].id, 'pin.changed', { via: 'reset' }, ip);
      return res.status(200).json({
        success: true, token,
        user: {
          id: uRow[0].id, name: uRow[0].name,
          has_personal: uRow[0].has_personal, has_business: uRow[0].has_business,
          setup_complete: uRow[0].setup_complete
        }
      });
    }

    // Try profile reset
    const pRow = await sql`
      SELECT p.*, u.id as uid, u.name as uname, u.has_personal, u.has_business, u.setup_complete
      FROM profiles p JOIN users u ON u.id=p.user_id
      WHERE LOWER(p.email)=LOWER(${email}) AND p.reset_code=${code}
        AND p.reset_expires > NOW() AND p.is_active=true LIMIT 1
    `.catch(()=>[]);
    if (pRow.length) {
      await sql`
        UPDATE profiles SET pin_hash=${newHash}, pin_salt=${newSalt},
          reset_code=NULL, reset_expires=NULL WHERE id=${pRow[0].id}
      `;
      await sql`UPDATE users SET session_token=${token}, token_expires=${expires} WHERE id=${pRow[0].uid}`;
      await logAudit(sql, pRow[0].uid, 'pin.changed', { via: 'profile_reset' }, ip);
      return res.status(200).json({
        success: true, token,
        user: {
          id: pRow[0].uid, name: pRow[0].uname,
          has_personal: pRow[0].has_personal, has_business: pRow[0].has_business,
          setup_complete: pRow[0].setup_complete
        },
        profile: { id: pRow[0].id, name: pRow[0].name, avatar: pRow[0].avatar }
      });
    }

    return res.status(401).json({ error: 'Invalid or expired reset code' });
  }

  // ── Request PIN reset (legacy — kept for compatibility) ───────────────────
  // FIX: no longer overwrites active session_token — uses pin_resets table
  if (req.method === 'POST' && action === 'request-reset') {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
    const rows = await sql`SELECT id FROM users WHERE name ILIKE ${name} AND email ILIKE ${email} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: 'No account found with that name and email' });
    const code    = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    await sql`
      INSERT INTO pin_resets (user_id, user_type, code, expires_at, email)
      VALUES (${rows[0].id}, 'user', ${code}, ${expires}, ${email.toLowerCase()})
      ON CONFLICT (email) DO UPDATE SET code=${code}, expires_at=${expires}
    `.catch(async () => {
      // Fallback only if migration not yet run
      await sql`UPDATE users SET session_token=${code}, token_expires=${expires} WHERE id=${rows[0].id}`;
    });
    const csUser = process.env.CLICKSEND_USERNAME;
    const csKey  = process.env.CLICKSEND_API_KEY;
    if (csUser && csKey) {
      await fetch('https://rest.clicksend.com/v3/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(csUser+':'+csKey).toString('base64') },
        body: JSON.stringify({
          to: [{ email, name }],
          from: { email_address_id: 6504, name: process.env.CLICKSEND_SENDER_NAME || 'Activities by Hindle Consultants' },
          subject: 'Your PIN reset code',
          body: `<p>Your PIN reset code is: <strong>${code}</strong></p><p>Expires in 15 minutes.</p>`
        })
      });
    } else {
      // PIN reset code not logged — sent via ClickSend only
    }
    return res.status(200).json({ success: true });
  }

  // ── Confirm PIN reset (legacy) ────────────────────────────────────────────
  if (req.method === 'POST' && action === 'confirm-reset') {
    const { name, email, code, newPin } = req.body;
    if (!name || !email || !code || !newPin || newPin.length < 4)
      return res.status(400).json({ error: 'All fields required' });

    let targetUser = null;
    // Try pin_resets table
    try {
      const resetRow = await sql`
        SELECT pr.user_id FROM pin_resets pr JOIN users u ON u.id=pr.user_id
        WHERE LOWER(pr.email)=LOWER(${email}) AND pr.code=${code}
          AND pr.expires_at > NOW() AND u.name ILIKE ${name} LIMIT 1
      `;
      if (resetRow.length) {
        const uRows = await sql`SELECT * FROM users WHERE id=${resetRow[0].user_id} LIMIT 1`;
        if (uRows.length) {
          targetUser = uRows[0];
          await sql`DELETE FROM pin_resets WHERE email=${email.toLowerCase()}`.catch(()=>{});
        }
      }
    } catch(e) {}

    // Fallback: legacy session_token
    if (!targetUser) {
      const rows = await sql`
        SELECT * FROM users WHERE name ILIKE ${name} AND email ILIKE ${email}
          AND session_token=${code} AND token_expires > NOW() LIMIT 1
      `;
      if (rows.length) targetUser = rows[0];
    }

    if (!targetUser) return res.status(401).json({ error: 'Invalid or expired code' });

    const newSalt = makeSalt();
    const newHash = hashPin(newPin, newSalt);
    const token   = makeToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await sql`
      UPDATE users SET pin_hash=${newHash}, pin_salt=${newSalt},
        session_token=${token}, token_expires=${expires}
      WHERE id=${targetUser.id}
    `;
    await sql`
      UPDATE profiles SET pin_hash=${newHash}, pin_salt=${newSalt}
      WHERE user_id=${targetUser.id} AND is_primary=true
    `;
    await logAudit(sql, targetUser.id, 'pin.changed', { via: 'confirm_reset' }, ip);
    return res.status(200).json({
      success: true, token,
      user: {
        id: targetUser.id, name: targetUser.name,
        has_personal: targetUser.has_personal, has_business: targetUser.has_business,
        setup_complete: targetUser.setup_complete
      }
    });
  }

  // ── Send Email ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'send-email') {
    const tok = req.headers.authorization?.replace('Bearer ','');
    if (!tok) return res.status(401).json({ error: 'Unauthorised' });
    const users = await sql`SELECT id,name FROM users WHERE session_token=${tok} AND token_expires>NOW() LIMIT 1`;
    if (!users.length) return res.status(401).json({ error: 'Session expired' });
    const { to, subject, body, csvData } = req.body;
    if (!to || !subject) return res.status(400).json({ error: 'To and subject required' });
    const csUser = process.env.CLICKSEND_USERNAME;
    const csKey  = process.env.CLICKSEND_API_KEY;
    if (!csUser || !csKey) return res.status(500).json({ error: 'Email not configured' });
    const senderName = users[0].name;
    let htmlBody = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">';
    htmlBody += '<div style="background:#0a0f2e;padding:20px;border-radius:8px 8px 0 0"><h1 style="color:#fff;font-size:20px;margin:0">💰 Activities</h1></div>';
    htmlBody += '<div style="padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">';
    htmlBody += '<p>' + body.replace(/\n/g,'<br>') + '</p>';
    if (csvData) {
      htmlBody += '<p style="color:#64748b;font-size:13px">Transaction data is included below.</p>';
      htmlBody += '<pre style="background:#f8fafc;padding:12px;border-radius:8px;font-size:11px;overflow-x:auto">' + csvData.slice(0,2000) + '...</pre>';
    }
    htmlBody += '<hr style="border-color:#e2e8f0;margin:20px 0"/><p style="color:#94a3b8;font-size:12px">Sent via Activities — track.hindle.biz</p></div></div>';
    const emailResp = await fetch('https://rest.clicksend.com/v3/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(csUser+':'+csKey).toString('base64') },
      body: JSON.stringify({
        to: [{ email: to, name: to }],
        from: { email_address_id: 6504, name: senderName + ' via Activities' },
        subject, body: htmlBody
      })
    });
    const emailResult = await emailResp.json();
    if (emailResult.http_code === 200 || emailResult.response_code === 'SUCCESS') {
      return res.status(200).json({ success: true });
    } else {
      return res.status(500).json({ error: 'Email failed: ' + (emailResult.response_msg||'unknown') });
    }
  }

  // ── Add Profile ───────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'add-profile') {
    const tok = req.headers.authorization?.replace('Bearer ','');
    if (!tok) return res.status(401).json({ error: 'Unauthorised' });
    const users = await sql`SELECT id FROM users WHERE session_token=${tok} AND token_expires>NOW() LIMIT 1`;
    if (!users.length) return res.status(401).json({ error: 'Session expired' });
    const userId = users[0].id;
    const { name, pin, email, sendEmail } = req.body;
    if (!name || !pin || pin.length < 4) return res.status(400).json({ error: 'Name and PIN required' });
    // Always salt profile PINs
    const profSalt = makeSalt();
    const pinHash  = hashPin(pin, profSalt);
    await sql`
      INSERT INTO profiles (user_id, name, pin_hash, pin_salt, is_primary, is_active, avatar)
      VALUES (${userId}, ${name}, ${pinHash}, ${profSalt}, false, true, '👤')
    `;
    if (sendEmail && email) {
      const csUser = process.env.CLICKSEND_USERNAME;
      const csKey  = process.env.CLICKSEND_API_KEY;
      if (csUser && csKey) {
        try {
          const senderUser = await sql`SELECT name FROM users WHERE id=${userId} LIMIT 1`;
          const senderName = senderUser[0]?.name || 'Your team';
          await fetch('https://rest.clicksend.com/v3/email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json',
              'Authorization': 'Basic ' + Buffer.from(csUser+':'+csKey).toString('base64') },
            body: JSON.stringify({
              to: [{ email, name }],
              from: { email_address_id: 6504, name: process.env.CLICKSEND_SENDER_NAME || 'Activities by Hindle Consultants' },
              subject: senderName + ' has invited you to Activities',
              body: '<p>Hi ' + name + ',</p><p>' + senderName + ' has added you to their Activities account.</p>'
                + '<p>Open <a href="https://track.hindle.biz">track.hindle.biz</a> and log in with your name and the temporary PIN you were given.</p>'
            })
          });
        } catch(e) { console.error('Email error:', e); }
      }
    }
    await logAudit(sql, userId, 'profile.added', { name }, ip);
    return res.status(201).json({ success: true });
  }

  // ── Change PIN ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'change-pin') {
    const tok = req.headers.authorization?.replace('Bearer ','');
    if (!tok) return res.status(401).json({ error: 'Unauthorised' });
    const users = await sql`SELECT id FROM users WHERE session_token=${tok} AND token_expires>NOW() LIMIT 1`;
    if (!users.length) return res.status(401).json({ error: 'Session expired' });
    const { newPin } = req.body;
    if (!newPin || newPin.length < 4) return res.status(400).json({ error: 'PIN must be 4 digits' });
    const newSalt = makeSalt();
    const newHash = hashPin(newPin, newSalt);
    await sql`UPDATE users SET pin_hash=${newHash}, pin_salt=${newSalt} WHERE id=${users[0].id}`;
    await sql`UPDATE profiles SET pin_hash=${newHash}, pin_salt=${newSalt} WHERE user_id=${users[0].id} AND is_primary=true`;
    await logAudit(sql, users[0].id, 'pin.changed', { via: 'settings' }, ip);
    return res.status(200).json({ success: true });
  }

  // ── Set Encryption ────────────────────────────────────────────────────────
  if (req.method === 'PUT' && action === 'set-encryption') {
    const tok = req.headers.authorization?.replace('Bearer ','');
    if (!tok) return res.status(401).json({ error: 'Unauthorised' });
    const users = await sql`SELECT id FROM users WHERE session_token=${tok} AND token_expires>NOW() LIMIT 1`;
    if (!users.length) return res.status(401).json({ error: 'Session expired' });
    const { encryption_enabled } = req.body || {};
    await sql`UPDATE users SET encryption_enabled=${!!encryption_enabled} WHERE id=${users[0].id}`;
    await logAudit(sql, users[0].id, 'encryption.changed', { enabled: !!encryption_enabled }, ip);
    return res.status(200).json({ success: true, encryption_enabled: !!encryption_enabled });
  }


  // ── ADMIN: verify admin password ──────────────────────────────────────────
  const ADMIN_PW    = process.env.ADMIN_PW    || 'Hindle@Admin2026';
  const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@hindleconsultants.com').toLowerCase();
  const adminPw = req.headers['x-admin-password'] || (req.body && req.body.adminPassword);
  const isAdmin = ADMIN_PW && adminPw === ADMIN_PW;

  // ── Admin: login (validates password server-side) ─────────────────────────
  if (req.method === 'POST' && action === 'admin-login') {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (email.toLowerCase() !== ADMIN_EMAIL)
      return res.status(401).json({ error: 'Invalid credentials' });
    if (!ADMIN_PW || password !== ADMIN_PW)
      return res.status(401).json({ error: 'Invalid credentials', debug: 'pw_mismatch', pw_set: !!ADMIN_PW });
    await logAudit(sql, null, 'admin.login', { email }, ip);
    return res.status(200).json({ success: true });
  }

  // ── Admin: list all users ──────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'admin-users') {
    if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
    let users;
    try {
      users = await sql`
        SELECT u.id, u.email, u.name, u.plan, u.plan_billing, u.plan_activated_at,
               u.is_active, u.feature_overrides, u.encryption_enabled, u.has_business,
               u.account_notes, u.created_at, u.last_login,
               (SELECT COUNT(*) FROM transactions t WHERE t.user_id=u.id AND t.deleted_at IS NULL) AS txn_count
        FROM users u
        ORDER BY u.created_at DESC
      `;
    } catch(e) {
      console.error('admin-users query error:', e.message);
      return res.status(500).json({ error: 'Query failed: ' + e.message });
    }
    // Determine trial_end and status for each user
    const data = users.map(u => {
      let trialEnd = null;
      let status = u.is_active === false ? 'suspended' : 'active';
      if (u.plan_activated_at) {
        const trialDays = { free: 0, pro: 14, business: 14 }[u.plan] || 14;
        const activated = new Date(u.plan_activated_at);
        const endDate = new Date(activated);
        endDate.setDate(endDate.getDate() + trialDays);
        if (endDate > new Date() && u.plan_billing !== 'paid') {
          trialEnd = endDate.toISOString().split('T')[0];
          status = 'trial';
        }
      }
      return { ...u, plan_trial_ends: trialEnd, plan_status: status, scan_count: 0, plan_snapshot: null, account_count: 0, search_credits: 0 };
    });
    return res.status(200).json({ success: true, data });
  }

  if (req.method === 'POST' && action === 'set-plan') {
    if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const { userId, plan, status } = req.body || {};
    if (!userId || !plan) return res.status(400).json({ error: 'userId and plan required' });
    const validPlans = ['free', 'pro', 'business'];
    if (!validPlans.includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
    const isActive = status === 'suspended' ? false : true;
    // Snapshot the plan features at the time of plan change so future FEATURES_CFG edits
    // don't affect existing subscribers. The snapshot is stored as JSONB on the user row.
    // It is used by scan.js and data.js for limit enforcement.
    const planFeatureDefaults = {
      free:     { accounts:'1', ai_scans:'5',    forecast:'8 weeks',  team:'N/A',      deals:false, csv_export:false, business:false, stmt_import:false },
      pro:      { accounts:'Unlimited', ai_scans:'Unlimited', forecast:'36 weeks', team:'N/A',      deals:true,  csv_export:true,  business:true,  stmt_import:true  },
      business: { accounts:'Unlimited', ai_scans:'Unlimited', forecast:'36 weeks', team:'Up to 5', deals:true,  csv_export:true,  business:true,  stmt_import:true  },
    };
    const snapshot = planFeatureDefaults[plan] || planFeatureDefaults['free'];
    await sql`
      UPDATE users
      SET plan = ${plan},
          is_active = ${isActive},
          plan_activated_at = COALESCE(plan_activated_at, NOW()),
          feature_overrides = '{}'::jsonb,
          plan_snapshot = ${JSON.stringify(snapshot)}::jsonb
      WHERE id = ${userId}
    `;
    await logAudit(sql, userId, 'admin.set_plan', { plan, status }, ip);
    return res.status(200).json({ success: true, snapshot });
  }

  // ── Admin: get per-tenant detail (usage refresh) ───────────────────────────
  if (req.method === 'GET' && action === 'admin-users-detail') {
    if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const rows = await sql`
      SELECT u.id, u.email, u.name, u.plan, u.plan_billing, u.plan_activated_at,
             u.is_active, u.feature_overrides, u.plan_snapshot, u.encryption_enabled, u.has_business,
             u.account_notes, u.created_at, u.last_login,
             (SELECT COUNT(*) FROM transactions t WHERE t.user_id=u.id AND t.deleted_at IS NULL) AS txn_count,
             (SELECT COUNT(*) FROM accounts a WHERE a.user_id=u.id AND a.is_active=true) AS account_count,
             COALESCE((SELECT su.scan_count FROM scan_usage su WHERE su.user_id=u.id AND su.month=TO_CHAR(NOW(),'YYYY-MM') LIMIT 1), 0) AS scan_count,
             COALESCE((SELECT sc.credits FROM search_credits sc WHERE sc.user_id=u.id::text LIMIT 1), 0) AS search_credits
      FROM users u WHERE u.id=${parseInt(userId)} LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    return res.status(200).json({ success: true, data: rows[0] });
  }

  // ── Admin: send limit warning notification ────────────────────────────────
  if (req.method === 'POST' && action === 'admin-notify') {
    if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const { userId, subject, message } = req.body || {};
    if (!userId || !subject || !message) return res.status(400).json({ error: 'userId, subject and message required' });
    const uRows = await sql`SELECT id, email, name FROM users WHERE id=${parseInt(userId)} LIMIT 1`;
    if (!uRows.length) return res.status(404).json({ error: 'User not found' });
    const u = uRows[0];
    const csUser = process.env.CLICKSEND_USERNAME;
    const csKey  = process.env.CLICKSEND_API_KEY;
    if (!csUser || !csKey) return res.status(500).json({ error: 'ClickSend not configured' });
    try {
      const r = await fetch('https://rest.clicksend.com/v3/email/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(csUser+':'+csKey).toString('base64')
        },
        body: JSON.stringify({
          to: [{ email: u.email, name: u.name }],
          from: { email_address_id: 6504, name: 'Activities by Hindle Consultants' },
          subject: subject,
          body: `<p>Hi ${u.name},</p>${message}<p style="color:#64748b;font-size:12px">— Activities by Hindle Consultants</p>`
        })
      });
      const j = await r.json();
      await logAudit(sql, userId, 'admin.notify_sent', { subject }, ip);
      return res.status(200).json({ success: true, clicksend: j });
    } catch(e) {
      return res.status(500).json({ error: 'Email send failed: ' + e.message });
    }
  }

  // ── Admin: extend trial ────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'extend-trial') {
    if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const { userId, days, reset } = req.body || {};
    if (!userId || !days) return res.status(400).json({ error: 'userId and days required' });
    if (reset) {
      // Reset trial: set plan_activated_at to now so trial starts fresh
      await sql`UPDATE users SET plan_activated_at = NOW(), is_active = true WHERE id = ${userId}`;
    } else {
      // Extend: push plan_activated_at back by N days
      await sql`
        UPDATE users
        SET plan_activated_at = COALESCE(plan_activated_at, NOW()) - (${days}::int * INTERVAL '1 day'),
            is_active = true
        WHERE id = ${userId}
      `;
    }
    await logAudit(sql, userId, 'admin.extend_trial', { days, reset: !!reset }, ip);
    return res.status(200).json({ success: true });
  }

  // ── Admin: set feature override ────────────────────────────────────────────
  if (req.method === 'POST' && action === 'set-feature-override') {
    if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const { userId, key, value } = req.body || {};
    if (!userId || !key) return res.status(400).json({ error: 'userId and key required' });
    await sql`
      UPDATE users
      SET feature_overrides = COALESCE(feature_overrides, '{}'::jsonb) || ${JSON.stringify({ [key]: value })}::jsonb
      WHERE id = ${userId}
    `;
    await logAudit(sql, userId, 'admin.set_override', { key, value }, ip);
    return res.status(200).json({ success: true });
  }

  // ── Admin: clear feature override ─────────────────────────────────────────
  if (req.method === 'POST' && action === 'clear-feature-override') {
    if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const { userId, key } = req.body || {};
    if (!userId || !key) return res.status(400).json({ error: 'userId and key required' });
    await sql`
      UPDATE users
      SET feature_overrides = COALESCE(feature_overrides, '{}'::jsonb) - ${key}
      WHERE id = ${userId}
    `;
    await logAudit(sql, userId, 'admin.clear_override', { key }, ip);
    return res.status(200).json({ success: true });
  }

  // ── Admin: save account notes ──────────────────────────────────────────────
  if (req.method === 'POST' && action === 'save-notes') {
    if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const { userId, notes } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    await sql`UPDATE users SET account_notes = ${notes || ''} WHERE id = ${userId}`;
    await logAudit(sql, userId, 'admin.save_notes', {}, ip);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

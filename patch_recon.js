// patch_recon.js — run with: node patch_recon.js
// Adds reconcile-batch resource to server.js
// Run from: /c/users/ian/github/hindle_api

const fs = require('fs');
const path = './server.js';

if (!fs.existsSync(path)) {
  console.error('server.js not found in current directory');
  process.exit(1);
}

let src = fs.readFileSync(path, 'utf8');

// 1. Add reconciled_at, recon_date to SELECT
if (src.includes('reconciled_at')) {
  console.log('reconciled_at already present');
} else {
  const pats = [
    [/SELECT id, account_id, user_id, category_id, amount, date, description, mode, notes/g,
     'SELECT id, account_id, user_id, category_id, amount, date, description, mode, notes, reconciled_at, recon_date'],
    [/SELECT id, account_id, category_id, amount, date, description, mode, notes/g,
     'SELECT id, account_id, category_id, amount, date, description, mode, notes, reconciled_at, recon_date'],
  ];
  let done = false;
  for (const [p, r] of pats) {
    if (p.test(src)) { src = src.replace(p, r); done = true; break; }
  }
  console.log(done ? 'Patched SELECT' : 'SELECT not found — add reconciled_at manually');
}

// 2. Add reconcile-batch handler
if (src.includes('reconcile-batch')) {
  console.log('reconcile-batch already present');
} else {
  const handler = `
  // reconcile-batch: mark transactions reconciled
  if (resource === 'reconcile-batch' && req.method === 'POST') {
    const { txn_ids, recon_date } = req.body || {};
    if (!txn_ids || !txn_ids.length) return res.status(400).json({ error: 'txn_ids required' });
    if (!recon_date) return res.status(400).json({ error: 'recon_date required' });
    try {
      const numIds = txn_ids.map(Number).filter(Boolean);
      await sql\`UPDATE transactions SET reconciled_at=NOW(), recon_date=\${recon_date} WHERE id=ANY(\${numIds}) AND user_id=\${userId} AND deleted_at IS NULL\`;
      return res.json({ success: true, updated: numIds.length });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }
`;
  const lastIdx = src.lastIndexOf("return res.status(405)");
  if (lastIdx > 0) {
    src = src.slice(0, lastIdx) + handler + '\n  ' + src.slice(lastIdx);
    console.log('Inserted reconcile-batch handler');
  } else {
    console.log('WARNING: insertion point not found — add handler manually');
  }
}

fs.writeFileSync(path, src);
console.log('Done. Now run DB migrations in Neon:');
console.log('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ DEFAULT NULL;');
console.log('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recon_date DATE DEFAULT NULL;');

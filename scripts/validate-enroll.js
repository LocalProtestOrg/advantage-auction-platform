// Validate the FIXED /api/sellers/enroll route in-process against the connected DB.
// Mounts the real route + auth + a server.js-equivalent error handler, then exercises
// every scenario over HTTP and cleans up. Run: railway run --service <svc> node scripts/validate-enroll.js
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../src/db');

const app = express();
app.use(express.json());
app.use('/api/sellers', require('../src/routes/sellers'));
// Mirror server.js global error handler (production shape: { error }).
app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: 'Internal server error' }));

const results = [];
const ok = (name, pass, extra) => { results.push([pass, name + (extra ? ' :: ' + extra : '')]); };

(async () => {
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const seeded = [];
  const mk = async (role) => {
    const email = 'venroll-' + crypto.randomUUID().slice(0, 8) + '@example.test';
    const id = (await db.query("INSERT INTO users (email, password_hash, role) VALUES ($1,'x',$2) RETURNING id", [email, role])).rows[0].id;
    seeded.push(id);
    return { id, token: jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
  };
  const post = (token, body) => fetch(base + '/api/sellers/enroll', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

  try {
    // 1. Valid buyer enables selling -> 201 + seller role + token.
    const buyer = await mk('buyer');
    const r1 = await post(buyer.token, { seller_type: 'private', legal_name: 'Val Buyer', phone: '(313) 555-1234' });
    ok('valid buyer enroll -> 201', r1.status === 201 && r1.json.success === true && r1.json.data.role === 'seller' && !!r1.json.token, 'status=' + r1.status);

    // 2. Name + phone saved; buyer promoted (not replaced) -> history intact (same id).
    const urow = (await db.query('SELECT role, full_name, phone FROM users WHERE id=$1', [buyer.id])).rows[0];
    ok('name + phone saved, role promoted to seller', urow.role === 'seller' && urow.full_name === 'Val Buyer' && /5551234$/.test((urow.phone || '').replace(/\D/g, '')), JSON.stringify(urow));

    // 3. Idempotent re-enroll -> 200, no duplicate profile.
    const r2 = await post(buyer.token, { seller_type: 'private', legal_name: 'Val Buyer', phone: '3135551234' });
    const profCount = (await db.query('SELECT count(*)::int n FROM seller_profiles WHERE user_id=$1', [buyer.id])).rows[0].n;
    ok('idempotent re-enroll -> 200, single profile', r2.status === 200 && profCount === 1, 'status=' + r2.status + ' profiles=' + profCount);

    // 4. Invalid phone (new user) -> 400 with the specific message.
    const b2 = await mk('buyer');
    const r3 = await post(b2.token, { seller_type: 'private', legal_name: 'Bad Phone', phone: '123' });
    ok('invalid phone -> 400 specific message', r3.status === 400 && /valid phone number/i.test(r3.json.message || ''), 'status=' + r3.status + ' msg=' + (r3.json.message || r3.json.error));
    ok('invalid phone wrote NO profile (rollback)', (await db.query('SELECT count(*)::int n FROM seller_profiles WHERE user_id=$1', [b2.id])).rows[0].n === 0);

    // 5. Missing phone (new user) -> 400 with the specific message.
    const b3 = await mk('buyer');
    const r4 = await post(b3.token, { seller_type: 'private', legal_name: 'No Phone' });
    ok('missing phone -> 400 specific message', r4.status === 400 && /phone number is required/i.test(r4.json.message || ''), 'status=' + r4.status);

    // 6. Stale token for a removed user -> 401 with a re-auth message (not a generic 500).
    const gone = await mk('buyer');
    await db.query('DELETE FROM users WHERE id=$1', [gone.id]);
    const r5 = await post(gone.token, { seller_type: 'private', legal_name: 'Ghost', phone: '3135550000' });
    ok('deleted-user token -> 401 (not 500)', r5.status === 401 && /session is no longer valid/i.test(r5.json.message || ''), 'status=' + r5.status);

    // 7. Unauthorized (no token) -> 401.
    const r6 = await post(null, { seller_type: 'private', legal_name: 'Anon', phone: '3135550001' });
    ok('no token -> 401', r6.status === 401, 'status=' + r6.status);
  } finally {
    for (const id of seeded) {
      await db.query('DELETE FROM seller_terms WHERE seller_profile_id IN (SELECT id FROM seller_profiles WHERE user_id=$1)', [id]).catch(() => {});
      await db.query('DELETE FROM seller_profiles WHERE user_id=$1', [id]).catch(() => {});
      await db.query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});
    }
    server.close(); await db.pool.end();
  }

  const pass = results.every(r => r[0]);
  results.forEach(([p, n]) => console.log((p ? 'PASS' : 'FAIL') + '  ' + n));
  console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

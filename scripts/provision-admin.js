#!/usr/bin/env node
/* Provision a single production admin account with SECURE, hidden, interactive
 * password entry. Uses the app's exact hashing (bcrypt cost 10). Guarded to the
 * production endpoint. Touches ONLY this one account. Never prints password/hash.
 *
 * RUN IN AN INTERACTIVE TERMINAL (TTY required for hidden input):
 *   railway run --service advantage-auction-platform --environment production node scripts/provision-admin.js
 */
const db = require('../src/db');
const bcrypt = require('bcrypt');

const EMAIL = 'tylerwitt2015@gmail.com';
const BCRYPT_COST = 10; // must match src/routes/auth.js (bcrypt.hash(password, 10))

if (!(process.env.DATABASE_URL || '').includes('ep-proud-leaf-an8pzkib')) {
  console.error('REFUSING: DATABASE_URL is not the production endpoint (ep-proud-leaf-an8pzkib).');
  process.exit(2);
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('No TTY — cannot read a password securely. Run this directly in an interactive terminal.'));
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let pw = '';
    const ENTER = ['\r', '\n'];
    const onData = (ch) => {
      const code = ch.charCodeAt(0);
      if (ENTER.includes(ch) || code === 4) {            // Enter or Ctrl-D
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
        process.stdout.write('\n'); resolve(pw);
      } else if (code === 3) {                            // Ctrl-C
        stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n^C\n'); process.exit(130);
      } else if (code === 127 || code === 8) {            // Backspace / Delete
        pw = pw.slice(0, -1);
      } else if (code >= 32) {                            // printable
        pw += ch;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const existing = await db.query(
    'SELECT email, role, is_active FROM users WHERE lower(email) = lower($1)', [EMAIL]
  );

  if (existing.rowCount) {
    const u = existing.rows[0];
    console.log(`Account EXISTS — current role=${u.role}, is_active=${u.is_active}`);
    if (u.role !== 'admin' || u.is_active !== true) {
      await db.query("UPDATE users SET role='admin', is_active=true WHERE lower(email)=lower($1)", [EMAIL]);
      console.log('Updated: role=admin, is_active=true.');
    } else {
      console.log('No change needed (already admin + active).');
    }
    console.log('(Existing account — password NOT modified, per requirements.)');
  } else {
    const pw  = await promptHidden(`Enter password for ${EMAIL} (hidden): `);
    const pw2 = await promptHidden('Confirm password (hidden): ');
    if (pw !== pw2)     { console.error('Passwords do not match. Aborting — no changes made.'); process.exit(1); }
    if (pw.length < 10) { console.error('Password too short (min 10). Aborting — no changes made.'); process.exit(1); }
    const hash = await bcrypt.hash(pw, BCRYPT_COST);
    await db.query(
      "INSERT INTO users (email, password_hash, role, is_active) VALUES ($1, $2, 'admin', true)",
      [EMAIL, hash]
    );
    console.log('Created admin account.');
  }

  // Verify + print ONLY the requested non-sensitive fields
  const v = await db.query(
    `SELECT email, role, is_active,
            (created_at >= now() - interval '10 minutes') AS just_created
       FROM users WHERE lower(email) = lower($1)`, [EMAIL]
  );
  const r = v.rows[0];
  console.log('\n--- RESULT ---');
  console.log('email:     ' + r.email);
  console.log('role:      ' + r.role);
  console.log('is_active: ' + r.is_active);
  console.log('state:     ' + (r.just_created ? 'CREATED (new)' : 'UPDATED / pre-existing'));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

#!/usr/bin/env node
/* rollback-082.js — reverse 082_email_verification.sql. DESTRUCTIVE (drops verification table + columns).
 * Also revert the 082 code (auth welcome hook + emailVerificationService). Guarded:
 * CONFIRM_ROLLBACK_082=YES; production also CONFIRM_ROLLBACK_082_PROD=YES + owner approval. */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const SQL = `
BEGIN;
  DROP TABLE IF EXISTS email_verification_tokens;
  ALTER TABLE users DROP COLUMN IF EXISTS email_verified;
  ALTER TABLE users DROP COLUMN IF EXISTS email_verified_at;
  DELETE FROM schema_migrations WHERE filename = '082_email_verification.sql';
COMMIT;
`;
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (process.env.CONFIRM_ROLLBACK_082 !== 'YES') { console.error('REFUSE: set CONFIRM_ROLLBACK_082=YES (destructive).'); return 2; }
  if (raw.includes(PROD_EP) && process.env.CONFIRM_ROLLBACK_082_PROD !== 'YES') {
    console.error('REFUSE: PRODUCTION — also set CONFIRM_ROLLBACK_082_PROD=YES (and obtain owner approval).'); return 2;
  }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const dbn = (await c.query('SELECT current_database() d')).rows[0].d;
    console.log('ROLLBACK 082 on: ' + dbn + (raw.includes(PROD_EP) ? ' (PRODUCTION)' : ''));
    await c.query(SQL);
    const gone = (await c.query("SELECT to_regclass('public.email_verification_tokens') AS t")).rows[0].t === null;
    console.log('RESULT: ' + (gone ? 'ROLLED BACK' : 'FAIL'));
    return gone ? 0 : 1;
  } catch (e) { console.error('ROLLBACK FAILED:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });

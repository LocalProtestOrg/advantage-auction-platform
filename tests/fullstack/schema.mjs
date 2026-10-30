// Full production schema on PGlite: every migration in db/migrations, in order, with three compatibility shims for
// historical files that never applied verbatim (production's schema came from the same files, applied around them).
// Used by the isolated full-stack environment (dbServer.mjs) that browser tests and the watchdog's state-changing
// journeys run against. Never connects to any real database.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'db', 'migrations');

// file → (sql) => sql. Each shim keeps the migration's intent and only removes what cannot apply.
export const SHIMS = {
  // A table-level UNIQUE constraint cannot carry a WHERE clause; the intent is a partial unique index.
  '008_add_missed_pickup_handling.sql': (sql) => sql
    .replace(/,\s*--[^\n]*\n\s*CONSTRAINT one_active_missed_per_lot UNIQUE \(lot_id\) WHERE status IN \('missed', 'rescheduled'\)/,
      '')
    + "\nCREATE UNIQUE INDEX IF NOT EXISTS one_active_missed_per_lot ON missed_pickups(lot_id) WHERE status IN ('missed', 'rescheduled');\n",
  // lots from 001 has no status column (lot state lives elsewhere); only the default change cannot apply.
  '017_alter_lots_add_columns.sql': (sql) => sql.replace(/ALTER TABLE lots\s+ALTER COLUMN status SET DEFAULT 'draft';/, ''),
};

// Production parity (compared column-by-column with production's information_schema, 2026-10-30): three objects in
// production differ from the migration files. Applied after the chain so the isolated app sees production's shape.
export const PARITY_SQL = `
DROP TABLE IF EXISTS notification_preferences CASCADE;
CREATE TABLE notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_enabled boolean NOT NULL DEFAULT true,
  sms_enabled boolean NOT NULL DEFAULT false,
  phone_number text,
  sms_consent boolean NOT NULL DEFAULT false,
  sms_consent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  follower_emails_enabled boolean NOT NULL DEFAULT true);
ALTER TABLE lots ADD COLUMN IF NOT EXISTS pickup_category text;
ALTER TABLE users DROP COLUMN IF EXISTS last_login;
`;

export function migrationFiles() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
}

/** Apply every migration to a PGlite instance. Returns the list of files applied; throws on the first failure. */
export async function applyAll(db) {
  const applied = [];
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  for (const f of migrationFiles()) {
    let sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    if (SHIMS[f]) sql = SHIMS[f](sql);
    try { await db.exec(sql); } catch (e) { throw new Error(`${f}: ${e.message}`); }
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
    applied.push(f);
  }
  await db.exec(PARITY_SQL);
  return applied;
}

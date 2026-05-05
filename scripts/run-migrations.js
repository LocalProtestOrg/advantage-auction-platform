#!/usr/bin/env node
// Migration runner — applies db/migrations/*.sql in order against DATABASE_URL.
// Tracks applied migrations in a `schema_migrations` table (created on first run).
// Safe to re-run: already-applied migrations are skipped.

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");

async function ensureTrackingTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedSet(client) {
  const { rows } = await client.query("SELECT filename FROM schema_migrations");
  return new Set(rows.map((r) => r.filename));
}

async function run() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  console.log(`\nFound ${files.length} migration files.\n`);

  const client = await pool.connect();
  try {
    await ensureTrackingTable(client);
    const applied = await appliedSet(client);

    let passed = 0;
    let skipped = 0;
    let failed = 0;

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  SKIP  ${file}`);
        skipped++;
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.log(`  OK    ${file}`);
        passed++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  FAIL  ${file}`);
        console.error(`        ${err.message}`);
        failed++;
        // continue with remaining migrations
      }
    }

    console.log(`\n────────────────────────────────`);
    console.log(`  Applied : ${passed}`);
    console.log(`  Skipped : ${skipped}`);
    console.log(`  Failed  : ${failed}`);
    console.log(`────────────────────────────────`);

    // Print final table list
    const { rows } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    console.log(`\nTables in DB (${rows.length}):`);
    rows.forEach((r) => console.log(`  ${r.table_name}`));
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

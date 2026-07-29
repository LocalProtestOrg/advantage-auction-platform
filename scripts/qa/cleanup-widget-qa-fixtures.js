'use strict';
/**
 * Cleanup for the Widget Visual QA fixtures. Deletes ONLY records carrying the exact marker
 * widget_visual_qa_2026_07 (auctions.admin_notes->>'qa_marker', events.review_reason).
 *
 * SAFETY:
 *  - Selects the exact target ids FIRST, prints them, and re-scopes every DELETE to that id list.
 *  - Belt-and-suspenders guard: every candidate id is re-checked to carry the marker; if ANY unmarked
 *    id ever entered the set the script ABORTS and deletes nothing.
 *  - Dry-run by default. Pass --apply to actually delete. Prod-endpoint guarded.
 *  - Only ever touches: event_images (of marked events), events (marked), auctions (marked).
 *    Marked auctions have NO lots/bids/invoices/payouts (created without them), so no financial rows.
 */
const REPO = 'C:/Users/tyler/OneDrive/Documents/Projects/advantage-auction-platform';
const { Pool } = require(REPO + '/node_modules/pg');
const MARKER = 'widget_visual_qa_2026_07';
const APPLY = process.argv.includes('--apply');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const host = (process.env.DATABASE_URL || '').split('@')[1] || '';
  if (!/proud-leaf/.test(host)) { console.error('Refusing: not the prod endpoint (' + host.split('/')[0] + ')'); process.exit(1); }
  const c = await pool.connect();
  try {
    const aIds = (await c.query("SELECT id, title, admin_notes->>'qa_marker' m FROM auctions WHERE admin_notes->>'qa_marker' = $1", [MARKER])).rows;
    const eIds = (await c.query("SELECT id, title, review_reason m FROM events WHERE review_reason = $1", [MARKER])).rows;

    // Guard: every candidate MUST carry the exact marker. Any mismatch → abort, delete nothing.
    const bad = [...aIds, ...eIds].filter((r) => r.m !== MARKER || !/^TEST — /.test(r.title));
    if (bad.length) { console.error('ABORT: candidate without exact marker or TEST title:', bad); process.exit(1); }

    console.log('Marked auctions: ' + aIds.length + ', marked events: ' + eIds.length);
    [...aIds, ...eIds].forEach((r) => console.log('  ' + r.id + '  ' + r.title));
    if (!aIds.length && !eIds.length) { console.log('Nothing to clean up.'); process.exit(0); }

    if (!APPLY) { console.log('\nDRY RUN — no rows deleted. Re-run with --apply to delete the above (and only the above).'); process.exit(0); }

    const aList = aIds.map((r) => r.id), eList = eIds.map((r) => r.id);
    await c.query('BEGIN');
    // Re-scope every DELETE to BOTH the exact id list AND the marker predicate.
    const imgDel = eList.length ? await c.query('DELETE FROM event_images WHERE event_id = ANY($1)', [eList]) : { rowCount: 0 };
    const eDel = eList.length ? await c.query('DELETE FROM events WHERE id = ANY($1) AND review_reason = $2', [eList, MARKER]) : { rowCount: 0 };
    const aDel = aList.length ? await c.query("DELETE FROM auctions WHERE id = ANY($1) AND admin_notes->>'qa_marker' = $2", [aList, MARKER]) : { rowCount: 0 };
    await c.query('COMMIT');
    console.log('\nDELETED — event_images: ' + imgDel.rowCount + ', events: ' + eDel.rowCount + ', auctions: ' + aDel.rowCount);
  } catch (e) { await c.query('ROLLBACK'); console.error('ERROR (rolled back):', e.message); process.exit(1); }
  finally { c.release(); await pool.end(); }
})();

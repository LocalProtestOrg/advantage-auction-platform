'use strict';

/**
 * growthLabReportService — the Owner Growth Lab report, built FROM DURABLE RECORDS (not agent prose).
 * Failures + inconclusive results get equal prominence to wins. Authority remaining is reported as a
 * DOLLAR amount. There is intentionally NO authority-utilization percentage — unspent authority is a
 * normal, successful outcome. Internal seller-package 60/40 economics never appear.
 */
const db = require('../db');
const growthRes = require('./growthReservationService');

async function build({ month } = {}) {
  const byObjectiveBand = (await db.query(
    `SELECT objective, band, COALESCE(verdict,'(none)') verdict, status, count(*)::int n
       FROM marketing_experiments GROUP BY objective, band, verdict, status ORDER BY objective`)).rows;
  const verdicts = (await db.query(
    `SELECT COALESCE(verdict,'(none)') verdict, count(*)::int n FROM marketing_experiments GROUP BY verdict`)).rows;
  const earlyStops = (await db.query(`SELECT count(*)::int n FROM marketing_experiments WHERE stop_reason IS NOT NULL`)).rows[0].n;
  const spendByChannel = (await db.query(
    `SELECT COALESCE((metadata->>'channel'),'unattributed') channel, entry_type, COALESCE(SUM(amount_cents),0)::bigint cents
       FROM growth_pool_ledger WHERE entry_type IN ('SPEND','ADDITIONAL_AUTHORITY_SPEND') GROUP BY 1,2`)).rows;
  const learnings = (await db.query(
    `SELECT verdict, count(*)::int n FROM marketing_learnings WHERE superseded_by IS NULL GROUP BY verdict`)).rows;
  const superseded = (await db.query(`SELECT count(*)::int n FROM marketing_learnings WHERE superseded_by IS NOT NULL`)).rows[0].n;
  const escalations = (await db.query(`SELECT count(*)::int n FROM marketing_experiments WHERE within_authority = false`)).rows[0].n;
  const authority = await growthRes.remainingAuthority({ month });

  return {
    what_we_tried: byObjectiveBand,
    what_it_cost: { spend_by_channel: spendByChannel },
    what_happened: { by_verdict: verdicts, early_stops: earlyStops },
    what_we_learned: { findings_by_verdict: learnings, superseded_or_retired: superseded },
    whats_different: { superseded_or_retired: superseded },
    needs_you: { escalations_requiring_authority_change: escalations },
    authority_remaining_dollars: (authority.remaining_cents / 100).toFixed(2), // DOLLAR amount, never a %
    // NOTE: intentionally NO authority_utilization_pct / "% of budget used" — unspent authority is success.
  };
}

module.exports = { build };

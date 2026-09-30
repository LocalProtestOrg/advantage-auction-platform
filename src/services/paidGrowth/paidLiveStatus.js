'use strict';

/**
 * paidLiveStatus — the LIVE paid-growth position, read from the same sources that govern real spend:
 *   platform_config  marketing.paid_growth.mode · marketing.paid.execution_enabled · marketing.paid.global_kill
 *   marketing_paid_budget_ledger (kind 'actual', reconciled to the provider by the hourly spend sync)
 *   marketing_paid_budget_months (ceiling) · marketing_paid_campaigns (state) · marketing_paid_spend_syncs (freshness)
 *
 * Reports (paidGrowthReport, directorReportService, runtime readiness) read THIS instead of static shadow-era values,
 * so they can never say "no paid campaign is running" while money is being spent. Read-only; it never acts.
 * Returned state: LIVE (real campaigns/spend) · PAUSED (global kill engaged) · SHADOW (no live execution configured).
 */
const db = require('../../db');
const { normalizeCampaignKey } = require('../../lib/paidCampaignKey');

const TERMINAL = ['COMPLETED', 'BUDGET_EXHAUSTED', 'STOPPED', 'FAILED'];

function monthStart(d = new Date()) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10); }

async function safeRows(r, sql, p) { try { return (await r.query(sql, p || [])).rows; } catch (_) { return []; } }

async function status({ month = null } = {}, runner) {
  const r = runner || db;
  const m = month ? String(month).slice(0, 7) + '-01' : monthStart();
  const cfgRows = await safeRows(r, `SELECT key, value FROM platform_config WHERE key IN
      ('marketing.paid_growth.mode','marketing.paid.execution_enabled','marketing.paid.global_kill','marketing.paid_growth.monthly_ceiling_usd')`);
  const cfg = Object.fromEntries(cfgRows.map((x) => [x.key, x.value]));
  const mode = cfg['marketing.paid_growth.mode'] === 'live' ? 'live' : 'shadow';
  const executionEnabled = cfg['marketing.paid.execution_enabled'] === true || cfg['marketing.paid.execution_enabled'] === 'true';
  const globalKill = cfg['marketing.paid.global_kill'] === true || cfg['marketing.paid.global_kill'] === 'true';

  const monthRow = (await safeRows(r, `SELECT ceiling_cents, actual_cents FROM marketing_paid_budget_months WHERE month = $1::date`, [m]))[0] || null;
  const ceilingCents = monthRow ? Number(monthRow.ceiling_cents) : Math.round(Number(cfg['marketing.paid_growth.monthly_ceiling_usd'] || 1000) * 100);
  const ledgerMonth = await safeRows(r, `SELECT campaign_key, COALESCE(sum(amount_cents),0)::bigint cents FROM marketing_paid_budget_ledger
      WHERE kind = 'actual' AND month = $1::date GROUP BY campaign_key`, [m]);
  const ledgerLifetime = await safeRows(r, `SELECT campaign_key, COALESCE(sum(amount_cents),0)::bigint cents FROM marketing_paid_budget_ledger
      WHERE kind = 'actual' GROUP BY campaign_key`);
  const monthActualCents = ledgerMonth.reduce((a, x) => a + Number(x.cents), 0);
  const lifetimeActualCents = ledgerLifetime.reduce((a, x) => a + Number(x.cents), 0);

  const campaigns = (await safeRows(r, `SELECT campaign_key, state, funnel, market_key, budget_cents, activated_at, stopped_at FROM marketing_paid_campaigns ORDER BY created_at`))
    .map((c) => {
      const k = normalizeCampaignKey(c.campaign_key);
      const month_actual_cents = ledgerMonth.filter((x) => normalizeCampaignKey(x.campaign_key) === k).reduce((a, x) => a + Number(x.cents), 0);
      const lifetime_actual_cents = ledgerLifetime.filter((x) => normalizeCampaignKey(x.campaign_key) === k).reduce((a, x) => a + Number(x.cents), 0);
      return { campaign_key: k, state: c.state, funnel: c.funnel, market_key: c.market_key || null, authorized_cents: Number(c.budget_cents) || 0,
        month_actual_cents, lifetime_actual_cents, activated_at: c.activated_at, stopped_at: c.stopped_at };
    });
  const active = campaigns.filter((c) => c.state === 'ACTIVE');
  const lastSync = (await safeRows(r, `SELECT finished_at, ok, reconciliation_state FROM marketing_paid_spend_syncs ORDER BY started_at DESC LIMIT 1`))[0] || null;

  const live = executionEnabled && mode === 'live';
  const state = globalKill ? 'PAUSED' : (live ? 'LIVE' : 'SHADOW');
  return {
    state, mode, execution_enabled: executionEnabled, global_kill: globalKill, month: m,
    ceiling_cents: ceilingCents, month_actual_cents: monthActualCents, lifetime_actual_cents: lifetimeActualCents,
    remaining_cents: Math.max(0, ceilingCents - monthActualCents),
    running_campaigns: active.map((c) => c.campaign_key),
    finished_campaigns: campaigns.filter((c) => TERMINAL.includes(c.state)).map((c) => c.campaign_key),
    campaigns,
    last_sync: lastSync ? { at: lastSync.finished_at, ok: lastSync.ok, reconciliation: lastSync.reconciliation_state } : null,
    source: 'live paid budget ledger (reconciled to the provider by the spend sync) + marketing.paid.* configuration',
  };
}

module.exports = { status, TERMINAL };

'use strict';

/**
 * /api/admin/watchdog — the site watchdog dashboard (admin only).
 *   GET  /      status, open findings (severity, feature, evidence, reproduction, recovery), recently resolved, runs, checks
 *   POST /run   run the non-destructive server checks now (all, or { ids: [...] }); at most once a minute
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const db = require('../db');
const registry = require('../services/watchdog/registry');
const store = require('../services/watchdog/findingsStore');
const runner = require('../services/watchdog/runner');

router.use(auth, role(['admin']), express.json({ limit: '16kb' }));

router.get('/', async (req, res, next) => {
  try {
    const summary = await runner.summary(db);
    if (!summary) return res.json({ success: true, data: { installed: false } });
    const state = new Map((await db.query('SELECT * FROM watchdog_check_state')).rows.map((r) => [r.check_id, r]));
    const checks = registry.ALL().map((c) => {
      const s = state.get(c.id) || {};
      return { ...c, interval_minutes: c.kind === 'browser' ? null : registry.TIER_INTERVAL_MIN[c.tier], last_run_at: s.last_run_at || null,
        last_status: s.last_status || null, consecutive_failures: s.consecutive_failures || 0, last_duration_ms: s.last_duration_ms || null };
    });
    const runs = (await db.query(`SELECT id, source, started_at, finished_at, checks_run, checks_failed, checks_skipped, opened, resolved, error
                                     FROM watchdog_runs ORDER BY started_at DESC LIMIT 30`)).rows;
    return res.json({ success: true, data: { installed: true, summary, open: await store.openFindings(db), resolved: await store.recentlyResolved(db), runs, checks } });
  } catch (e) { next(e); }
});

let lastManual = 0;
router.post('/run', async (req, res, next) => {
  try {
    if (Date.now() - lastManual < 60 * 1000) return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'A check run started less than a minute ago. Please wait.' });
    lastManual = Date.now();
    const known = registry.SERVER_CHECKS.map((c) => c.id);
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter((x) => known.includes(x)) : null;
    const out = await runner.runServerChecks({ db, ids: ids && ids.length ? ids : null, force: true, source: 'manual' });
    await runner.sendAlerts({ db }).catch((e) => console.error('[watchdog] alert failed:', e.message));
    return res.json({ success: true, data: out });
  } catch (e) { next(e); }
});

module.exports = router;

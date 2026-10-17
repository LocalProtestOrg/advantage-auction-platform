# Known technical maintenance issues

Separate from feature milestones. Each entry: symptom, evidence, impact, next step. Do not fold these into unrelated
milestones; do act if a genuine production reliability problem is found.

## MI-1 — Intermittent Phone Sasha real-time timing test (recorded 2026-10-16)
- **Symptom:** `tests/sasha-phone/conversation-ux.test.js` › "multi-turn reliability on the live socket" occasionally
  fails during the full `npm run gate` run (2 of 6 full runs on 2026-10-16; earlier ~1 in 22).
- **Evidence:** the same test passes every time when run on its own (3/3 and 72/72 tests on 2026-10-16), and the full
  gate passes on re-run. It drives a live WebSocket call simulation with real timers, so it is sensitive to CPU load
  when ~300 suites run in parallel.
- **Production impact:** none observed. Phone Sasha remains public and healthy; production calls are not affected by
  test-runner load. Treat as a test-reliability issue unless production evidence says otherwise.
- **Next step (separate maintenance task):** make the test deterministic (fake timers or longer per-turn deadlines for
  that file, or run it in-band), and confirm no production-path timing bug is masked by doing so.

## MI-2 — Public-page link check read another suite's temporary files (FIXED 2026-10-16)
- `tests/seller-progress-public-nav.test.js` read `__*.html` fixtures that `tests/analyticsTag.test.js` writes into
  `public/` during the run. Fixed by skipping those fixtures and tolerating a vanished file (commit 3a0bb5e).

'use strict';

/**
 * Owner decision 2026-11-08: the paid-advertising emergency stop is engaged as part of the controlled deployment, without
 * clearing or bypassing it, and with all campaign history preserved. The deployment script only turns the kill switch
 * ON through the audited safety-stop path; it never contacts Meta (the Emergency Stop button's provider sweep would) and
 * can never turn the switch off.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prod-engage-ad-kill-switch.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '');

test('production only, dry run by default', () => {
  expect(code).toMatch(/if \(raw\.includes\(STG_EP\) \|\| !raw\.includes\(PROD_EP\)\) \{ console\.error\('REFUSE: PRODUCTION endpoint only\.'\); return 2; \}/);
  expect(code).toMatch(/if \(!APPLY\) \{/);
});

test('only engages the switch, through the audited safety-stop path; never clears it; never calls Meta', () => {
  expect(code).toMatch(/setPlatformConfig\('marketing\.paid\.global_kill', true, \{\s*safetyStop: true/);
  expect(code).not.toMatch(/global_kill', false|clearKill|emergencyKill|pauseProviderActive|metaAdsProvider|meta\.|pauseCampaign/);
  expect(code).toMatch(/campaign records unchanged/);
});

test('turning the kill switch on is a safety stop (allowed without the owner); turning it off is not', () => {
  const s = require('../src/lib/sensitiveConfig');
  expect(s.isSafetyStopValue('marketing.paid.global_kill', true)).toBe(true);
  expect(s.isSafetyStopValue('marketing.paid.global_kill', false)).toBe(false);
});

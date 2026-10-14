'use strict';

/**
 * The Phone Sasha certification makes billable model calls. Owner rule (2026-10-14): it must print a cost estimate and
 * refuse to start without explicit approval (--approved). This test runs the real entry point with no model key and
 * checks it stops before booting anything; it never calls a model.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const RUN = path.join(__dirname, '..', '..', 'certification', 'sasha-phone', 'run.js');
const runCert = (args) => spawnSync(process.execPath, [RUN, ...args], {
  encoding: 'utf8', timeout: 60000, env: { ...process.env, ANTHROPIC_API_KEY: '', DATABASE_URL: '' },
});

describe('certification cost guard', () => {
  test('without --approved it prints the estimate and does not start', () => {
    const r = runCert([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/BILLABLE run: \d+ scenarios · estimated model cost \$\d+\.\d\d–\$\d+\.\d\d/);
    expect(r.stdout).toMatch(/Not started\. Get the owner's approval for this cost, then rerun with --approved\./);
    expect(r.stdout).not.toMatch(/\[certify\] \d+\/\d+/);   // no scenario ran
  });
  test('a filtered run is estimated on its own size', () => {
    const r = runCert(['--filter', 'sms.optin', '--no-judge']);
    expect(r.stdout).toMatch(/BILLABLE run: 4 scenarios/);
    expect(r.stdout).toMatch(/Not started/);
  });
});

'use strict';

/**
 * The watchdog's isolated-journey report tells infrastructure apart from the application (2026-11-04: seven criticals
 * were one test-environment setup that timed out on the CI runner, so none of those tests had run). Failed suites are
 * retried once, one at a time (.github/workflows/site-watchdog.yml), and the report classifies what is left.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { journeysResult } = require('../scripts/watchdog-browser');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-journeys-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (testResults) => { const f = path.join(dir, `r${++n}.json`); fs.writeFileSync(f, JSON.stringify({ testResults })); return f; };
const HOOK = 'thrown: "Exceeded timeout of 180000 ms for a hook.\n    at Object.beforeAll (tests/browser/seller-agreement.browser.test.js:33:1)';
const suite = (name, tests, status) => ({ name: '/repo/tests/browser/' + name, status: status || (tests.some((t) => t.status === 'failed') ? 'failed' : 'passed'),
  assertionResults: tests.map((t) => ({ ancestorTitles: ['signing'], title: t.title, status: t.status, failureMessages: t.msg ? [t.msg] : [] })) });
const codes = (r) => r.issues.map((i) => i.code + ':' + i.severity);

test('everything passed: no findings', () => {
  expect(journeysResult(file([suite('a.browser.test.js', [{ title: 'x', status: 'passed' }])]))).toMatchObject({ status: 'ok', issues: [] });
});

test('the environment did not start (setup timeout) and the retry passed: a flaky warning, not a critical', () => {
  const first = file([suite('seller-agreement.browser.test.js', [{ title: 'signs', status: 'failed', msg: HOOK }, { title: 'revokes', status: 'failed', msg: HOOK }])]);
  const retry = file([suite('seller-agreement.browser.test.js', [{ title: 'signs', status: 'passed' }, { title: 'revokes', status: 'passed' }])]);
  const r = journeysResult(first, retry);
  expect(codes(r)).toEqual(['JOURNEY_FLAKY:warning', 'JOURNEY_FLAKY:warning']);
  expect(r.status).toBe('ok');
});

test('the environment failed to start twice: "not tested" (high), never reported as a product failure', () => {
  const first = file([suite('seller-agreement.browser.test.js', [{ title: 'signs', status: 'failed', msg: HOOK }])]);
  const retry = file([suite('seller-agreement.browser.test.js', [{ title: 'signs', status: 'failed', msg: HOOK }])]);
  const r = journeysResult(first, retry);
  expect(codes(r)).toEqual(['TEST_ENVIRONMENT_FAILED:high']);
  expect(r.issues[0].detail).toMatch(/not tested/);
  expect(r.status).toBe('fail');
});

test('a test that fails inside its own steps, twice, is a critical product failure', () => {
  const msg = 'expect(received).toBe(expected)\nExpected: "Signed"';
  const first = file([suite('seller-agreement.browser.test.js', [{ title: 'signs', status: 'failed', msg }])]);
  const retry = file([suite('seller-agreement.browser.test.js', [{ title: 'signs', status: 'failed', msg }])]);
  expect(codes(journeysResult(first, retry))).toEqual(['JOURNEY_FAILED:critical']);
});

test('without a retry (it did not run), a failure stays critical: nothing is excused by default', () => {
  const first = file([suite('seller-agreement.browser.test.js', [{ title: 'signs', status: 'failed', msg: HOOK }])]);
  expect(codes(journeysResult(first, path.join(dir, 'missing.json')))).toEqual(['JOURNEY_FAILED:critical']);
  expect(codes(journeysResult(first))).toEqual(['JOURNEY_FAILED:critical']);
});

test('no results at all (the run never started) is critical', () => {
  expect(codes(journeysResult(path.join(dir, 'nothing.json')))).toEqual(['JOURNEY_RUN_FAILED:critical']);
});

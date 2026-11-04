'use strict';

/**
 * Credential-exposure prevention (owner request 2026-11-04): API keys, secrets, tokens, passwords and database addresses
 * with passwords are caught before they are committed (pre-commit hook + CI), printed in test output (CI scans the test
 * log), put on a command line (process / desktop-config scan) or written to the app's logs (console redaction).
 * Every credential-shaped value below is assembled at run time, so this file itself never contains one.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { findSecrets, redact } = require('../src/lib/secretPatterns');

const j = (...p) => p.join('');
const R = 'Q7vX2mK9pL4tR8wZ3nB6cD1fG5hJ0sYa';   // random-looking body
const HEX = j('b1946ac9', '2492d234', '7c6235b4', 'd2611184');   // shaped like a directory API key
const REAL = {
  stripe: j('sk_', 'live_', R),
  stripeTest: j('sk_', 'test_', '51', R),
  webhook: j('whsec_', R),
  aws: j('AKIA', 'Q7VX2MK9PL4TR8WZ'),
  github: j('ghp_', R, 'abcd'),
  anthropic: j('sk-ant-', 'api03-', R),
  google: j('AIza', R, 'xyz'),
  neon: j('napi_', R, R),
  dbUrl: j('postgres', 'ql://neondb_owner:', 'Zp8qR2vT9xLm', '@ep-cool-host-123.us-east-1.aws.neon.tech/neondb'),
  jwt: j('eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6', '.eyJ', 'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'),
  privateKey: j('-----BEGIN ', 'RSA PRIVATE KEY-----'),
};

describe('credential shapes are found, never repeated', () => {
  test.each(Object.entries(REAL))('%s is found', (name, value) => {
    const f = findSecrets('config: ' + value + ' end');
    expect(f.length).toBeGreaterThan(0);
    expect(JSON.stringify(f)).not.toContain(value.slice(8, 20));   // a finding shows the kind and length, never the value
  });
  test('a key written after its name, on a command line, or as a bearer token', () => {
    expect(findSecrets(j('BD_API_', 'KEY=', R)).map((f) => f.id)).toContain('named_secret_value');
    expect(findSecrets(j('npx server --api-', 'key ', R)).map((f) => f.id)).toContain('command_line_secret');
    expect(findSecrets(j('--to', 'ken=', R)).map((f) => f.id)).toContain('command_line_secret');
    expect(findSecrets(j('Authorization: Bear', 'er ', R, R)).map((f) => f.id)).toContain('bearer_token');
    expect(findSecrets(j('{"api', 'Key": "', R, '"}')).map((f) => f.id)).toContain('named_secret_value');
  });
  test('labelled test values, placeholders, examples and code references are allowed', () => {
    for (const ok of ["process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaa'",
      "STRIPE_SECRET_KEY: 'sk_test_isolated_placeholder'", "process.env.STRIPE_SECRET_KEY = 'sk_test_fixture_not_a_real_key'",
      'JWT_SECRET=change-this-to-a-long-random-secret-min-32-chars', 'DB_PASSWORD=your-local-db-password',
      'DATABASE_URL=postgres://postgres:password@localhost:5432/aap', 'postgres://postgres@127.0.0.1:5432/postgres',
      "const SECRET = 'noprod-bridge-secret-long-enough-xx'", 'apiKey: config.brilliantDirectories.apiKey']) {
      expect([ok, findSecrets(ok)]).toEqual([ok, []]);
    }
  });
  test('a real test-mode key is still a credential (the "test" in sk_test_ is not a label)', () => {
    expect(findSecrets('key ' + REAL.stripeTest).map((f) => f.id)).toEqual(['stripe_secret_key']);
  });
});

describe('the app\'s log lines are redacted', () => {
  test('redact() replaces only the credential', () => {
    const line = 'connect ' + REAL.dbUrl + ' with ' + REAL.stripe + ' for order 42';
    const out = redact(line);
    expect(out).not.toContain(REAL.stripe); expect(out).not.toContain('Zp8qR2vT9xLm');
    expect(out).toMatch(/^connect \[REDACTED:database_url_with_password\]\/neondb with \[REDACTED:stripe_secret_key\] for order 42$/);
    expect(redact(j('BD_API_', 'KEY=', R))).toBe('BD_API_KEY=[REDACTED:named_secret_value]');
    expect(redact('an ordinary line, order MO-001025, $45.00')).toBe('an ordinary line, order MO-001025, $45.00');
  });
  test('console redaction: objects, errors and format strings', () => {
    const lines = [];
    const fakeConsole = { log: (...a) => lines.push(a.join(' ')), info() {}, warn() {}, error: (...a) => lines.push(a.join(' ')), debug() {} };
    // a fresh module so install() wraps this target
    jest.isolateModules(() => require('../src/lib/logRedaction').install(fakeConsole));
    fakeConsole.log('user %s key %s', 'ann', REAL.anthropic);
    fakeConsole.error(new Error('failed with ' + REAL.webhook));
    fakeConsole.log({ headers: { authorization: j('Bear', 'er ', R, R) } });
    fakeConsole.log('nothing secret here', 42);
    expect(lines.join('\n')).not.toMatch(new RegExp([REAL.anthropic, REAL.webhook, R + R].map((v) => v.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')));
    expect(lines[0]).toBe('user ann key [REDACTED:anthropic_api_key]');
    expect(lines[3]).toBe('nothing secret here 42');
  });
  test('the server installs it first thing, and every background worker loads it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(src.split('\n').slice(0, 4).join('\n')).toMatch(/require\('\.\/src\/lib\/logRedaction'\)\.install\(\);/);
    expect(src).toMatch(/execArgv: \[\.\.\.process\.execArgv, '--require', path\.join\(__dirname, 'src\/lib\/logRedactionPreload\.js'\)\]/);
  });
});

describe('the scanner: files, test output, commits and desktop configuration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (args) => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'check-secrets.js'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };

  test('a test-output file with a key fails, names the line, and never prints the key', () => {
    const f = path.join(dir, 'jest-output.txt');
    fs.writeFileSync(f, 'PASS tests/a.test.js\n  debug: using ' + REAL.stripe + '\nTests: 1 passed\n');
    const r = run(['--file', f]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/jest-output\.txt:2\s+stripe_secret_key\s+\[\d+ characters\]/);
    expect(r.out).not.toContain(REAL.stripe);
    fs.writeFileSync(f, 'PASS tests/a.test.js\nTests: 1 passed\n');
    expect(run(['--file', f]).code).toBe(0);
  });
  test('a desktop integration config with a key in its arguments fails; the same key in "env" passes', () => {
    const f = path.join(dir, 'claude_desktop_config.json');
    fs.writeFileSync(f, JSON.stringify({ mcpServers: { bd: { command: 'npx', args: ['bd-mcp', '--api-key', HEX] } } }));
    const bad = run(['--config', f]);
    expect(bad.code).toBe(1); expect(bad.out).toMatch(/credential_flag_value/); expect(bad.out).not.toContain(HEX);
    fs.writeFileSync(f, JSON.stringify({ mcpServers: { bd: { command: 'npx', args: ['bd-mcp'], env: { BD_API_KEY: HEX } } } }));
    expect(run(['--config', f]).code).toBe(0);
  });
  test('the repository itself is clean (the same check CI runs)', () => {
    const r = run(['--all']);
    expect([r.code, r.out.trim()]).toEqual([0, '[secret-scan] clean']);
  });
  test('the pre-commit hook runs the staged check; CI runs the repository check and scans the test output', () => {
    const hook = fs.readFileSync(path.join(__dirname, '..', '.githooks', 'pre-commit'), 'utf8');
    expect(hook).toMatch(/node scripts\/check-secrets\.js --staged/);
    const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'playwright.yml'), 'utf8');
    expect(ci).toMatch(/node scripts\/check-secrets\.js --all/);
    expect(ci).toMatch(/node scripts\/check-secrets\.js --file jest-output\.txt/);
  });
});

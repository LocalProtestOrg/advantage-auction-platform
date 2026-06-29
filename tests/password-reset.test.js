// passwordResetService — unit tests. db + emailService are fully mocked, so these
// tests never open a real connection (safe to run anywhere). Covers: success, expired
// token, reused token, invalid token, unknown email (no enumeration), and password
// validation.
process.env.PUBLIC_APP_URL = 'https://bid.advantage.bid';

jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue({ messageId: 'test' }) }));

const db = require('../src/db');
const { sendEmail } = require('../src/services/emailService');
const svc = require('../src/services/passwordResetService');

beforeEach(() => { jest.clearAllMocks(); });

describe('requestReset — no account enumeration', () => {
  test('unknown email → ok:true, no token written, no email sent', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // user lookup → none
    const r = await svc.requestReset('nobody@example.com', { ip: '1.2.3.4' });
    expect(r).toEqual({ ok: true });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledTimes(1); // only the lookup; no DELETE/INSERT
  });

  test('suspended account → ok:true, no email (identical to unknown)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'u1', email: 'a@b.com', is_active: false }] });
    const r = await svc.requestReset('a@b.com');
    expect(r).toEqual({ ok: true });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('known active user → stores HASH (not raw token) + emails a reset link', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'u1', email: 'a@b.com', is_active: true }] }) // lookup
      .mockResolvedValueOnce({ rowCount: 0 })  // DELETE prior unused tokens
      .mockResolvedValueOnce({ rowCount: 1 }); // INSERT new token

    const r = await svc.requestReset('a@b.com', { ip: '9.9.9.9', baseUrl: 'https://bid.advantage.bid' });
    expect(r).toEqual({ ok: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe('a@b.com');
    expect(mail.subject).toMatch(/Advantage\.Bid/i);

    // The emailed link carries a 64-hex raw token pointing at the reset page.
    const m = (mail.html + '\n' + mail.text).match(/reset-password\.html\?token=([a-f0-9]{64})/);
    expect(m).toBeTruthy();
    const rawToken = m[1];

    // What's persisted is the SHA-256 hash of the raw token — never the raw token.
    const insertParams = db.query.mock.calls[2][1]; // [user_id, token_hash, expires_at, ip]
    expect(insertParams[1]).toBe(svc.hashToken(rawToken));
    expect(insertParams[1]).not.toBe(rawToken);
    expect(insertParams[3]).toBe('9.9.9.9');
  });
});

describe('resetPassword', () => {
  const NOW = Date.now();

  // Build a fake pooled client whose token SELECT returns `tokenRow` (or none).
  function fakeClient(tokenRow) {
    const calls = [];
    return {
      _calls: calls,
      query: jest.fn(async (sql, params) => {
        calls.push(String(sql).trim());
        if (/SELECT .* FROM password_reset_tokens/i.test(sql)) {
          return { rows: tokenRow ? [tokenRow] : [] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: jest.fn(),
    };
  }
  const sqlOf = (client) => client._calls.join('\n');

  test('valid token → password updated + token consumed + committed', async () => {
    const client = fakeClient({ id: 't1', user_id: 'u1', expires_at: new Date(NOW + 600000), used_at: null });
    db.connect.mockResolvedValueOnce(client);

    const r = await svc.resetPassword('rawtoken', 'newpassword1');
    expect(r.ok).toBe(true);
    expect(r.userId).toBe('u1');
    const sql = sqlOf(client);
    expect(sql).toMatch(/UPDATE users SET password_hash/i);
    expect(sql).toMatch(/UPDATE password_reset_tokens SET used_at/i);
    expect(sql).toMatch(/COMMIT/);
    expect(sql).not.toMatch(/ROLLBACK/);
  });

  test('expired token → TOKEN_EXPIRED, password NOT changed, rolled back', async () => {
    const client = fakeClient({ id: 't1', user_id: 'u1', expires_at: new Date(NOW - 1000), used_at: null });
    db.connect.mockResolvedValueOnce(client);

    const r = await svc.resetPassword('rawtoken', 'newpassword1');
    expect(r).toEqual({ ok: false, code: 'TOKEN_EXPIRED' });
    expect(sqlOf(client)).not.toMatch(/UPDATE users/i);
    expect(sqlOf(client)).toMatch(/ROLLBACK/);
  });

  test('already-used token → TOKEN_USED, password NOT changed', async () => {
    const client = fakeClient({ id: 't1', user_id: 'u1', expires_at: new Date(NOW + 600000), used_at: new Date(NOW - 100) });
    db.connect.mockResolvedValueOnce(client);

    const r = await svc.resetPassword('rawtoken', 'newpassword1');
    expect(r).toEqual({ ok: false, code: 'TOKEN_USED' });
    expect(sqlOf(client)).not.toMatch(/UPDATE users/i);
  });

  test('unknown/invalid token → INVALID_TOKEN', async () => {
    const client = fakeClient(null);
    db.connect.mockResolvedValueOnce(client);

    const r = await svc.resetPassword('does-not-exist', 'newpassword1');
    expect(r).toEqual({ ok: false, code: 'INVALID_TOKEN' });
    expect(sqlOf(client)).not.toMatch(/UPDATE users/i);
  });

  test('weak password → WEAK_PASSWORD, no DB work at all', async () => {
    const r = await svc.resetPassword('rawtoken', 'short');
    expect(r).toEqual({ ok: false, code: 'WEAK_PASSWORD' });
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('missing token → INVALID_TOKEN, no DB work', async () => {
    const r = await svc.resetPassword('', 'newpassword1');
    expect(r).toEqual({ ok: false, code: 'INVALID_TOKEN' });
    expect(db.connect).not.toHaveBeenCalled();
  });
});

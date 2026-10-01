'use strict';

/**
 * Sasha IMAP ingestion (migration 183, Stage 0/1). A FAKE IMAP server (same method surface as ImapFlow, including
 * every mutating method, all recorded) and an in-memory database (unique keys, advisory lock) exercise the real
 * reader, the real mail parser and the real Sasha filters. No network, no real mailbox, no credentials.
 */

// ── in-memory database (the service and emailChannel/settings share it through the mocked src/db) ─────────
const mockStore = { state: new Map(), msgs: [], cs: [], cfg: {}, lockHeld: false, seq: 0, queries: [] };
function mockQuery(sql, p = []) {
  const S = mockStore; const q = String(sql).replace(/\s+/g, ' ').trim(); S.queries.push(q);
  const rows = (r) => Promise.resolve({ rows: r, rowCount: r.length });
  if (/FROM platform_config WHERE key = ANY/.test(q)) return rows(Object.entries(S.cfg).map(([key, value]) => ({ key, value })));
  if (/^INSERT INTO imap_mailbox_state/.test(q)) { if (!S.state.has(p[0])) S.state.set(p[0], { mailbox: p[0], status: 'idle', consecutive_failures: 0, messages_today: 0, updated_at: new Date() }); return rows([]); }
  if (/^SELECT \* FROM imap_mailbox_state/.test(q) || /^SELECT mailbox, uidvalidity/.test(q)) return rows(S.state.has(p[0]) ? [{ ...S.state.get(p[0]) }] : []);
  if (/^UPDATE imap_mailbox_state SET lease_owner = \$2, lease_until/.test(q)) {
    const st = S.state.get(p[0]); const now = S.dbNow ? S.dbNow() : Date.now();
    const free = !st.lease_owner || !st.lease_until || st.lease_until.getTime() < now || st.lease_owner === p[1];
    if (!free) return rows([]);
    st.lease_owner = p[1]; st.lease_until = new Date(now + Number(p[2])); return rows([{ mailbox: p[0] }]);
  }
  if (/^UPDATE imap_mailbox_state SET lease_owner = NULL/.test(q)) {
    const st = S.state.get(p[0]); if (st.lease_owner === p[1]) { st.lease_owner = null; st.lease_until = null; } return rows([]);
  }
  if (/advisory/.test(q)) throw new Error('advisory locks are not pooler-safe and must not be used');
  if (/^UPDATE imap_mailbox_state SET (?!messages_today = CASE)(?!lease_owner)/.test(q)) {
    const st = S.state.get(p[0]); const re = /(\w+) = \$(\d+)/g; let m;
    while ((m = re.exec(q))) st[m[1]] = p[Number(m[2]) - 1];
    st.updated_at = new Date(); return rows([]);
  }
  if (/^UPDATE imap_mailbox_state SET messages_today = CASE/.test(q)) {
    const st = S.state.get(p[0]); const day = p[1];
    const same = st.messages_today_date instanceof Date && st.messages_today_date.toISOString().slice(0, 10) === day;
    st.messages_today = same ? st.messages_today + p[2] : p[2];
    st.messages_today_date = new Date(day + 'T00:00:00Z');          // the pg driver returns DATE as a JS Date
    return rows([]);
  }
  if (/^INSERT INTO imap_inbound_messages/.test(q)) {
    const [mailbox, uidvalidity, uid, message_id, content_fingerprint, from_email, subject, internal_date, size_bytes, raw_sha256] = p;
    if (S.msgs.some((r) => r.mailbox === mailbox && Number(r.uidvalidity) === Number(uidvalidity) && Number(r.uid) === Number(uid))) return rows([]);
    const row = { id: 'row-' + (++S.seq), mailbox, uidvalidity, uid, message_id, content_fingerprint, from_email, subject, internal_date, size_bytes, raw_sha256, status: 'recorded', attempts: 0, outcome: {} };
    S.msgs.push(row); return rows([{ ...row }]);
  }
  if (/^UPDATE imap_inbound_messages SET attempts = attempts \+ 1/.test(q)) { S.msgs.find((r) => r.id === p[0]).attempts++; return rows([]); }
  if (/^UPDATE imap_inbound_messages SET status = 'failed'/.test(q)) { Object.assign(S.msgs.find((r) => r.id === p[0]), { status: 'failed', last_error: p[1] }); return rows([]); }
  if (/^UPDATE imap_inbound_messages SET status = \$2/.test(q)) { Object.assign(S.msgs.find((r) => r.id === p[0]), { status: p[1], outcome: JSON.parse(p[2]), conversation_id: p[3], last_error: p[4] }); return rows([]); }
  if (/^SELECT id FROM imap_inbound_messages WHERE id <> \$1/.test(q)) {
    return rows(S.msgs.filter((r) => r.id !== p[0] && r.mailbox === p[1] && r.status !== 'failed' && ((r.message_id && r.message_id === p[2]) || (r.content_fingerprint && r.content_fingerprint === p[3]))).map((r) => ({ id: r.id })));
  }
  if (/^SELECT \* FROM imap_inbound_messages WHERE mailbox = \$1 AND uidvalidity = \$2 AND status IN/.test(q)) {
    return rows(S.msgs.filter((r) => r.mailbox === p[0] && Number(r.uidvalidity) === Number(p[1]) && ['recorded', 'failed'].includes(r.status) && r.attempts < p[2]).map((r) => ({ ...r })));
  }
  if (/^SELECT status, count\(\*\)::int n FROM imap_inbound_messages/.test(q)) return rows([]);
  if (/FROM cs_messages WHERE direction = 'inbound' AND email_message_id = \$1/.test(q)) return rows(S.cs.filter((m) => m.email_message_id === p[0]).map((m) => ({ conversation_id: m.conversation_id })));
  if (/FROM cs_messages WHERE direction = 'inbound' AND email_message_id IS NULL AND content_fingerprint = \$1/.test(q)) return rows(S.cs.filter((m) => m.content_fingerprint === p[0]).map((m) => ({ conversation_id: m.conversation_id })));
  return rows([]);
}
jest.mock('../../src/db', () => ({
  query: jest.fn((s, p) => mockQuery(s, p)),
  connect: jest.fn(async () => ({ query: (s, p) => mockQuery(s, p), release: () => {} })),
}));

const fs = require('fs');
const path = require('path');
const settings = require('../../src/services/sasha/settings');
const safe = require('../../src/services/sasha/imap/safeImapClient');
const ingest = require('../../src/services/sasha/imap/imapIngestService');
const emailChannel = require('../../src/services/sasha/emailChannel');
const engine = require('../../src/services/sasha/engine');

// ── fake IMAP server ─────────────────────────────────────────────────────────────────────────────
const MUTATORS = ['messageDelete', 'messageMove', 'messageCopy', 'messageFlagsSet', 'messageFlagsAdd', 'messageFlagsRemove', 'setFlagColor',
  'append', 'mailboxCreate', 'mailboxRename', 'mailboxDelete', 'mailboxSubscribe', 'mailboxUnsubscribe', 'mailboxClose'];
function fakeServer({ uidValidity = 100, messages = [], connectError = null, confirmReadOnly = true } = {}) {
  const server = { uidValidity, messages: messages.map((m) => ({ seen: false, ...m })), constructed: 0, options: null, calls: [], mutations: [], connectError, confirmReadOnly };
  class FakeImapFlow {
    constructor(options) { server.constructed++; server.options = options; this.mailbox = null;
      for (const name of MUTATORS) this[name] = (...a) => { server.mutations.push(name); return Promise.resolve(a); }; }
    async connect() { server.calls.push('connect'); if (server.connectError) throw server.connectError; }
    async mailboxOpen(p, opts) { server.calls.push('open:' + p + ':' + (opts && opts.readOnly ? 'EXAMINE' : 'SELECT'));
      const uidNext = Math.max(0, ...server.messages.map((m) => m.uid)) + 1;
      this.mailbox = { path: p, readOnly: !!(opts && opts.readOnly) && server.confirmReadOnly, uidValidity: server.uidValidity, uidNext, exists: server.messages.length };
      return this.mailbox; }
    async search(query) { server.calls.push('search');
      if (query.uid) { const from = Number(String(query.uid).split(':')[0]); const hits = server.messages.filter((m) => m.uid >= from).map((m) => m.uid);
        return hits.length ? hits : [Math.max(0, ...server.messages.map((m) => m.uid))].filter(Boolean); }   // IMAP "n:*" returns the last message even if n is beyond it
      return server.messages.filter((m) => !query.since || m.internalDate >= query.since).map((m) => m.uid); }
    async *fetch(range, query) { server.calls.push('fetch:' + (query.source ? 'BODY.PEEK[]' : '?'));
      const want = String(range).split(',').map(Number);
      for (const m of server.messages.filter((x) => want.includes(x.uid))) yield { uid: m.uid, source: Buffer.from(m.raw), internalDate: m.internalDate, size: m.raw.length }; }
    async logout() { server.calls.push('logout'); }
  }
  return { server, ImapFlow: FakeImapFlow };
}

const CFG = { host: 'mail.example.test', user: 'info@advantage.bid', pass: 'TEST-ONLY-not-a-real-password', port: 993, mailbox: 'INBOX', servername: 'mail.example.test', configured: true };
const LABEL = safe.mailboxLabel(CFG);
let NOW = new Date('2026-10-01T15:00:00Z');
const raw = ({ from = 'Pat Customer <pat@example.org>', subject = 'Selling some furniture', body = 'I have about 40 items. How do I start an auction?', messageId = '<cust-1@example.org>', headers = [] } = {}) =>
  ['From: ' + from, 'To: info@advantage.bid', 'Subject: ' + subject, messageId ? 'Message-ID: ' + messageId : null, 'Date: Thu, 01 Oct 2026 14:58:00 +0000',
    ...headers, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, ''].filter((l) => l !== null).join('\r\n');

function reset(cfg = {}) {
  Object.assign(mockStore, { state: new Map(), msgs: [], cs: [], seq: 0, queries: [] });
  mockStore.cfg = { 'sasha.enabled': true, 'sasha.engine_enabled': true, 'sasha.email_inbound_enabled': true, 'sasha.email_autoreply_enabled': true,
    'sasha.imap_read_enabled': true, 'sasha.imap_process_enabled': false, ...cfg };
  settings.clear();
  NOW = new Date('2026-10-01T15:00:00Z');
}
function deps(fake, extra = {}) {
  const handleInbound = jest.fn(async () => ({ status: 'processed', conversation_id: 'conv-1', reply: 'sent' }));
  const ownerAlert = { notifyAdminActionRequired: jest.fn(async () => ({ sent: 1 })) };
  const conversations = { createConversation: jest.fn(async () => ({ id: 'conv-old' })), addMessage: jest.fn(async () => ({ id: 'm' })), requestHandoff: jest.fn(async () => {}) };
  return { ImapFlow: fake.ImapFlow, config: CFG, now: () => NOW, ownerAlert, conversations,
    emailChannel: { ...emailChannel, handleInbound }, handleInbound, ...extra };
}
async function baseline(fake, d) { const r = await ingest.pollOnce(d); expect(r.baseline).toBe(true); return r; }
beforeEach(() => { reset(); jest.restoreAllMocks(); });

// ── 1. The reader is read-only by construction ──────────────────────────────────────────────────────
describe('read-only by construction', () => {
  test('the session exposes only connect, openReadOnly, searchNewer, fetchSources, logout (frozen; no client handle)', () => {
    const { ImapFlow } = fakeServer();
    const s = safe.create(CFG, { ImapFlow });
    expect(Object.keys(s).sort()).toEqual(['connect', 'fetchSources', 'label', 'logout', 'openReadOnly', 'searchNewer']);
    expect(Object.isFrozen(s)).toBe(true);
    for (const m of MUTATORS) expect(s[m]).toBeUndefined();
  });
  test('no reader source file calls a mutating IMAP method', () => {
    const dir = path.join(__dirname, '..', '..', 'src', 'services', 'sasha', 'imap');
    const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), path.join(__dirname, '..', '..', 'src', 'workers', 'sashaImapWorker.js')];
    const call = new RegExp('\\.(' + [...MUTATORS, 'expunge', 'mailboxClose'].join('|') + ')\\s*\\(');
    for (const f of files) expect([f, call.test(fs.readFileSync(f, 'utf8'))]).toEqual([f, false]);
  });
  test('the mailbox is opened with EXAMINE and messages are fetched with BODY.PEEK[]; nothing is marked read or changed', async () => {
    const fake = fakeServer({ messages: [{ uid: 1, raw: raw({ messageId: '<old@x>' }), internalDate: new Date('2026-09-01') }] });
    const d = deps(fake);
    await baseline(fake, d);
    fake.server.messages.push({ uid: 2, raw: raw(), internalDate: NOW });
    await ingest.pollOnce(d);
    expect(fake.server.calls).toContain('open:INBOX:EXAMINE');
    expect(fake.server.calls).not.toContain('open:INBOX:SELECT');
    expect(fake.server.calls).toContain('fetch:BODY.PEEK[]');
    expect(fake.server.mutations).toEqual([]);
    expect(fake.server.messages.some((m) => m.seen === true)).toBe(false);
    expect(fake.server.calls.filter((c) => c === 'logout')).toHaveLength(2);
  });
  test('refuses to continue when the server does not confirm the mailbox is read-only', async () => {
    const fake = fakeServer({ confirmReadOnly: false });
    const r = await ingest.pollOnce(deps(fake));
    expect(r.error).toBe('transport');
    expect(mockStore.state.get(LABEL).last_error).toMatch(/did not open read-only/);
    expect(fake.server.calls).not.toContain('search');
  });
  test('the raw client is additionally locked: every mutating method throws, reads pass through', async () => {
    const calls = [];
    const raw = { search: async () => [1], messageDelete: () => calls.push('DELETE'), append: () => calls.push('APPEND'), messageFlagsAdd: () => calls.push('FLAG'), mailboxClose: () => calls.push('CLOSE') };
    const locked = safe._lockedProxy(raw);
    for (const m of ['messageDelete', 'append', 'messageFlagsAdd', 'messageFlagsSet', 'messageFlagsRemove', 'messageMove', 'messageCopy', 'mailboxClose', 'mailboxDelete', 'expunge']) {
      expect(() => locked[m]()).toThrow(/not permitted/);
    }
    expect(calls).toEqual([]);
    await expect(locked.search()).resolves.toEqual([1]);
  });
});

// ── 2. TLS and credentials ─────────────────────────────────────────────────────────────────────────
describe('TLS verification and credentials', () => {
  test('TLS with certificate verification is always on; there is no way to turn it off', () => {
    const fake = fakeServer();
    safe.create({ ...CFG }, { ImapFlow: fake.ImapFlow });
    expect(fake.server.options).toMatchObject({ secure: true, logger: false, tls: { rejectUnauthorized: true, servername: 'mail.example.test' } });
    const cfg = safe.config({ SASHA_IMAP_HOST: 'mail.advantage.bid', SASHA_IMAP_USER: 'info@advantage.bid', SASHA_IMAP_PASSWORD: 'x', NODE_TLS_REJECT_UNAUTHORIZED: '0',
      SASHA_IMAP_TLS_REJECT_UNAUTHORIZED: 'false', SASHA_IMAP_TLS_SERVERNAME: 'server.host.example' });
    safe.create(cfg, { ImapFlow: fake.ImapFlow });
    expect(fake.server.options.tls.rejectUnauthorized).toBe(true);
    expect(fake.server.options.tls.servername).toBe('server.host.example');
  });
  test('credentials come only from SASHA_IMAP_* environment variables; missing ones mean "not configured"', () => {
    expect(safe.config({}).configured).toBe(false);
    expect(safe.config({ SASHA_IMAP_HOST: 'h', SASHA_IMAP_USER: 'u' }).configured).toBe(false);
    expect(safe.config({ SASHA_IMAP_HOST: 'h', SASHA_IMAP_USER: 'u', SASHA_IMAP_PASSWORD: 'p' })).toMatchObject({ configured: true, port: 993, mailbox: 'INBOX' });
  });
  test('the password never appears in stored errors, results or logs', async () => {
    const logs = [];
    jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    jest.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
    const fake = fakeServer({ connectError: new Error('socket closed while sending LOGIN info@advantage.bid ' + CFG.pass) });
    const r = await ingest.pollOnce(deps(fake));
    const everything = JSON.stringify([r, [...mockStore.state.values()], logs, mockStore.msgs]);
    expect(everything).not.toContain(CFG.pass);
    expect(safe.redact('password=' + CFG.pass, CFG)).not.toContain(CFG.pass);
  });
  test('no credential or value is committed in source, tests or docs (only variable names)', () => {
    const root = path.join(__dirname, '..', '..');
    for (const f of ['src/services/sasha/imap/safeImapClient.js', 'src/services/sasha/imap/imapIngestService.js', 'src/workers/sashaImapWorker.js', 'db/migrations/183_sasha_imap_ingestion.sql']) {
      expect(fs.readFileSync(path.join(root, f), 'utf8')).not.toMatch(/SASHA_IMAP_PASSWORD\s*=\s*['"][^'"]/);
    }
  });
});

// ── 3. Switches and inertness ─────────────────────────────────────────────────────────────────────
describe('switches', () => {
  test('read switch OFF: no connection attempt at all', async () => {
    reset({ 'sasha.imap_read_enabled': false });
    const fake = fakeServer();
    expect(await ingest.pollOnce(deps(fake))).toEqual({ skipped: 'disabled' });
    expect(fake.server.constructed).toBe(0);
  });
  test('global Sasha switch OFF: no connection even if the read switch is on', async () => {
    reset({ 'sasha.enabled': false });
    const fake = fakeServer();
    expect((await ingest.pollOnce(deps(fake))).skipped).toBe('disabled');
    expect(fake.server.constructed).toBe(0);
  });
  test('credentials not configured: no connection', async () => {
    const fake = fakeServer();
    expect(await ingest.pollOnce({ ...deps(fake), config: { ...CFG, configured: false } })).toEqual({ skipped: 'not_configured' });
    expect(fake.server.constructed).toBe(0);
  });
  test('processing requires reading; both new switches are known and typed', async () => {
    reset({ 'sasha.imap_read_enabled': false, 'sasha.imap_process_enabled': true });
    expect((await settings.effective()).imap_process).toBe(false);
    expect(settings.KEYS).toEqual(expect.arrayContaining(['sasha.imap_read_enabled', 'sasha.imap_process_enabled']));
    await expect(settings.set('sasha.imap_read_enabled', 'yes')).rejects.toThrow(/true or false/);
  });
  test('migration 183 seeds both switches OFF; the worker is started by the server', () => {
    const root = path.join(__dirname, '..', '..');
    const sql = fs.readFileSync(path.join(root, 'db/migrations/183_sasha_imap_ingestion.sql'), 'utf8');
    expect(sql).toMatch(/'sasha\.imap_read_enabled',\s*'false'::jsonb/);
    expect(sql).toMatch(/'sasha\.imap_process_enabled',\s*'false'::jsonb/);
    expect(sql).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    expect(fs.readFileSync(path.join(root, 'server.js'), 'utf8')).toMatch(/spawnWorker\(path\.join\(__dirname, 'src\/workers\/sashaImapWorker\.js'\)\)/);
  });
});

// ── 4. Backlog, bookmark and idempotency ─────────────────────────────────────────────────────────────
describe('backlog and idempotency', () => {
  test('first connection sets the bookmark at the newest message and answers nothing from the backlog', async () => {
    const fake = fakeServer({ messages: [1, 2, 3].map((u) => ({ uid: u, raw: raw({ messageId: '<old' + u + '@x>' }), internalDate: new Date('2026-09-20') })) });
    const d = deps(fake);
    const r = await ingest.pollOnce(d);
    expect(r).toMatchObject({ baseline: true, baseline_uid: 3 });
    expect(mockStore.state.get(LABEL)).toMatchObject({ last_seen_uid: 3, uidvalidity: 100 });
    expect(mockStore.msgs).toHaveLength(0);
    expect(d.handleInbound).not.toHaveBeenCalled();
    expect(fake.server.calls).not.toContain('fetch:BODY.PEEK[]');
  });
  test('shadow mode: a new message is recorded and classified, never handed to Sasha', async () => {
    const fake = fakeServer({ messages: [{ uid: 5, raw: raw({ messageId: '<old@x>' }), internalDate: NOW }] });
    const d = deps(fake);
    await baseline(fake, d);
    fake.server.messages.push({ uid: 6, raw: raw(), internalDate: NOW });
    const r = await ingest.pollOnce(d);
    expect(r).toMatchObject({ recorded: 1 });
    expect(mockStore.msgs[0]).toMatchObject({ uid: 6, status: 'shadow', message_id: '<cust-1@example.org>', from_email: 'pat@example.org' });
    expect(mockStore.msgs[0].outcome).toMatchObject({ shadow: true, would: 'process' });
    expect(d.handleInbound).not.toHaveBeenCalled();
    expect(mockStore.state.get(LABEL).last_seen_uid).toBe(6);
  });
  test('replaying the same mailbox position never records or processes it twice', async () => {
    reset({ 'sasha.imap_process_enabled': true });
    const fake = fakeServer({ messages: [{ uid: 1, raw: raw({ messageId: '<a@x>' }), internalDate: NOW }] });
    const d = deps(fake);
    await baseline(fake, d);
    fake.server.messages.push({ uid: 2, raw: raw(), internalDate: NOW });
    await ingest.pollOnce(d);
    await ingest.pollOnce(d);                                    // no new mail: search "3:*" returns uid 2 → filtered out
    mockStore.state.get(LABEL).last_seen_uid = 1;                // force a replay of uid 2
    await ingest.pollOnce(d);
    expect(mockStore.msgs).toHaveLength(1);
    expect(d.handleInbound).toHaveBeenCalledTimes(1);
  });
  test('cross-route duplicate: the same Message-ID already received through SES is not processed again', async () => {
    reset({ 'sasha.imap_process_enabled': true });
    mockStore.cs.push({ email_message_id: '<cust-1@example.org>', conversation_id: 'conv-ses' });
    const spy = jest.spyOn(engine, 'respond');
    const fake = fakeServer({ messages: [{ uid: 1, raw: raw({ messageId: '<a@x>' }), internalDate: NOW }] });
    const d = deps(fake, {});
    d.emailChannel = emailChannel;                               // the REAL Sasha entry point
    await baseline(fake, d);
    fake.server.messages.push({ uid: 2, raw: raw(), internalDate: NOW });
    await ingest.pollOnce(d);
    expect(mockStore.msgs[0]).toMatchObject({ status: 'duplicate', conversation_id: 'conv-ses' });
    expect(spy).not.toHaveBeenCalled();
  });
  test('mail without a Message-ID is deduplicated by fingerprint (e.g. seen again after a renumbering)', async () => {
    reset({ 'sasha.imap_process_enabled': true });
    const fake = fakeServer({ messages: [{ uid: 1, raw: raw({ messageId: '<a@x>' }), internalDate: NOW }] });
    const d = deps(fake);
    await baseline(fake, d);
    const noId = raw({ messageId: null, body: 'No message id here, please call me.' });
    fake.server.messages.push({ uid: 2, raw: noId, internalDate: NOW }, { uid: 3, raw: noId, internalDate: NOW });
    await ingest.pollOnce(d);
    expect(mockStore.msgs.map((m) => m.status)).toEqual(['processed', 'duplicate']);
    expect(mockStore.msgs[0].content_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(d.handleInbound).toHaveBeenCalledTimes(1);
  });
  test('Sasha itself deduplicates by fingerprint across routes (no Message-ID)', async () => {
    const msg = { fromEmail: 'pat@example.org', subject: 'Hi', textBody: 'Same text', headers: { date: 'Thu, 01 Oct 2026 14:58:00 +0000' }, messageIdHeader: null };
    mockStore.cs.push({ email_message_id: null, content_fingerprint: emailChannel.contentFingerprint(msg), conversation_id: 'conv-x' });
    mockStore.cfg = { 'sasha.enabled': true, 'sasha.email_inbound_enabled': true }; settings.clear();
    expect(await emailChannel.handleInbound(msg, {})).toEqual({ status: 'duplicate', conversation_id: 'conv-x' });
  });
  test('mailbox renumbering (UIDVALIDITY change): re-scan 48 hours, drop repeats, alert the Owner', async () => {
    reset({ 'sasha.imap_process_enabled': true });
    const fake = fakeServer({ messages: [{ uid: 1, raw: raw({ messageId: '<a@x>' }), internalDate: NOW }] });
    const d = deps(fake);
    await baseline(fake, d);
    fake.server.messages.push({ uid: 2, raw: raw(), internalDate: NOW });
    await ingest.pollOnce(d);                                    // processed once
    fake.server.uidValidity = 200;                               // server renumbers
    fake.server.messages = [{ uid: 1, raw: raw(), internalDate: NOW }, { uid: 2, raw: raw({ messageId: '<new@x>', body: 'A new question' }), internalDate: NOW }];
    const r = await ingest.pollOnce(d);
    expect(r.rescan).toBe(true);
    const renumbered = mockStore.msgs.filter((m) => Number(m.uidvalidity) === 200);
    expect(renumbered.map((m) => [m.message_id, m.status])).toEqual([['<cust-1@example.org>', 'duplicate'], ['<new@x>', 'processed']]);
    expect(d.handleInbound).toHaveBeenCalledTimes(2);
    expect(d.ownerAlert.notifyAdminActionRequired).toHaveBeenCalledWith(expect.objectContaining({ actionType: 'sasha_imap_health', entityId: 'uidvalidity:200' }));
    expect(mockStore.state.get(LABEL)).toMatchObject({ uidvalidity: 200, last_seen_uid: 2 });
  });
  test('only one poller at a time: while another live poller holds the lease nothing connects', async () => {
    await ingest.status(require('../../src/db'), CFG);                     // ensure the row exists
    mockStore.state.set(LABEL, { mailbox: LABEL, status: 'ok', consecutive_failures: 0, messages_today: 0, lease_owner: 'other-host:1:abcd', lease_until: new Date(Date.now() + 5 * 60000) });
    const fake = fakeServer();
    expect(await ingest.pollOnce({ ...deps(fake), leaseOwner: 'this-host:2:ef01' })).toEqual({ skipped: 'locked' });
    expect(fake.server.constructed).toBe(0);
  });
  test('a lease left behind by a dead process expires and polling resumes (the stranded-lock incident cannot recur)', async () => {
    mockStore.state.set(LABEL, { mailbox: LABEL, status: 'ok', consecutive_failures: 0, messages_today: 0, lease_owner: 'dead-host:9:dead', lease_until: new Date(Date.now() - 1000) });
    const fake = fakeServer({ messages: [{ uid: 1, raw: raw({ messageId: '<a@x>' }), internalDate: NOW }] });
    const r = await ingest.pollOnce({ ...deps(fake), leaseOwner: 'new-host:3:beef' });
    expect(r.baseline).toBe(true);
    expect(fake.server.constructed).toBe(1);
  });
  test('the lease is released after every poll, so consecutive polls (and other instances) are never blocked', async () => {
    const fake = fakeServer({ messages: [{ uid: 1, raw: raw({ messageId: '<a@x>' }), internalDate: NOW }] });
    await ingest.pollOnce({ ...deps(fake), leaseOwner: 'host-a:1:aaaa' });
    expect(mockStore.state.get(LABEL).lease_owner).toBeNull();
    fake.server.messages.push({ uid: 2, raw: raw(), internalDate: NOW });
    const r = await ingest.pollOnce({ ...deps(fake), leaseOwner: 'host-b:2:bbbb' });   // a different process/instance
    expect(r.recorded).toBe(1);
    expect(mockStore.state.get(LABEL).lease_owner).toBeNull();
  });
  test('the poller never uses a session advisory lock (not safe through the production connection pooler)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'services', 'sasha', 'imap', 'imapIngestService.js'), 'utf8');
    expect(src).not.toMatch(/pg_try_advisory_lock|pg_advisory_lock|pg_advisory_unlock/);
    const sql = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'db', 'migrations', '184_imap_poller_lease.sql'), 'utf8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS lease_owner/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS lease_until/);
  });
  test('a failed processing attempt is retried on the next poll (bounded)', async () => {
    reset({ 'sasha.imap_process_enabled': true });
    const fake = fakeServer({ messages: [{ uid: 1, raw: raw({ messageId: '<a@x>' }), internalDate: NOW }] });
    const d = deps(fake);
    await baseline(fake, d);
    fake.server.messages.push({ uid: 2, raw: raw(), internalDate: NOW });
    d.emailChannel.handleInbound = jest.fn().mockRejectedValueOnce(new Error('database busy')).mockResolvedValueOnce({ status: 'processed', conversation_id: 'c2' });
    await ingest.pollOnce(d);
    expect(mockStore.msgs[0].status).toBe('failed');
    await ingest.pollOnce(d);
    expect(mockStore.msgs[0]).toMatchObject({ status: 'processed', attempts: 2 });
    expect(mockStore.msgs).toHaveLength(1);
  });
});

// ── 5. The same Sasha protections apply ─────────────────────────────────────────────────────────────
describe('Sasha protections on IMAP mail', () => {
  async function one(msgRaw, cfg = { 'sasha.imap_process_enabled': true }, internalDate = NOW) {
    reset(cfg);
    const fake = fakeServer({ messages: [{ uid: 1, raw: raw({ messageId: '<a@x>' }), internalDate: NOW }] });
    const d = deps(fake);
    await baseline(fake, d);
    fake.server.messages.push({ uid: 2, raw: msgRaw, internalDate });
    await ingest.pollOnce(d);
    return { row: mockStore.msgs[0], d };
  }
  test('processing ON: new customer mail goes to the SAME Sasha entry point, once', async () => {
    const { row, d } = await one(raw());
    expect(row.status).toBe('processed');
    expect(d.handleInbound).toHaveBeenCalledTimes(1);
    const [msg, receipt] = d.handleInbound.mock.calls[0];
    expect(msg).toMatchObject({ fromEmail: 'pat@example.org', messageIdHeader: '<cust-1@example.org>', subject: 'Selling some furniture' });
    expect(receipt).toMatchObject({ source: 'imap' });
  });
  test('automated mail (out of office, Auto-Submitted) is ignored', async () => {
    const { row, d } = await one(raw({ subject: 'Automatic reply: Out of Office', headers: ['Auto-Submitted: auto-replied'] }));
    expect(row).toMatchObject({ status: 'ignored' });
    expect(d.handleInbound).not.toHaveBeenCalled();
  });
  test('Sasha\'s own mail and advantage.bid senders are ignored (no loops)', async () => {
    const a = await one(raw({ from: 'Sasha at Advantage.Bid <info@advantage.bid>', headers: ['X-Advantage-Sasha: SABC234'] }));
    expect(a.row.status).toBe('ignored'); expect(a.d.handleInbound).not.toHaveBeenCalled();
    const b = await one(raw({ from: 'Staff <someone@advantage.bid>' }));
    expect(b.row.outcome.reason).toBe('own_mail');
  });
  test('a copy of a Claimed Listing / Event Partner thread is left to that programme', async () => {
    const { row } = await one(raw({ headers: ['Cc: listings+l0123456789abcdef01234567@reply.advantage.bid'] }));
    expect(row.outcome.reason).toBe('outreach_thread');
  });
  test('mail the server marked as spam is never processed', async () => {
    const { row, d } = await one(raw({ headers: ['X-Spam-Flag: YES'] }));
    expect(row.status).toBe('spam_flagged');
    expect(d.handleInbound).not.toHaveBeenCalled();
  });
  test('mail older than 48 hours is handed to staff, never auto-answered', async () => {
    const { row, d } = await one(raw(), { 'sasha.imap_process_enabled': true }, new Date('2026-09-27T10:00:00Z'));
    expect(row.status).toBe('too_old');
    expect(d.handleInbound).not.toHaveBeenCalled();
    expect(d.conversations.requestHandoff).toHaveBeenCalledWith('conv-old', expect.objectContaining({ reasonCode: 'other' }));
  });
  test('shadow classification reports what would happen, including cross-route duplicates', async () => {
    reset();
    mockStore.cs.push({ email_message_id: '<cust-1@example.org>', conversation_id: 'c' });
    const fake = fakeServer({ messages: [{ uid: 1, raw: raw({ messageId: '<a@x>' }), internalDate: NOW }] });
    const d = deps(fake);
    await baseline(fake, d);
    fake.server.messages.push({ uid: 2, raw: raw(), internalDate: NOW }, { uid: 3, raw: raw({ messageId: '<b@x>', headers: ['Auto-Submitted: auto-generated'] }), internalDate: NOW });
    await ingest.pollOnce(d);
    expect(mockStore.msgs.map((m) => [m.status, m.outcome.would])).toEqual([['shadow', 'duplicate'], ['shadow', 'ignore']]);
  });
});

// ── 6. Failures fail closed; health alerts ─────────────────────────────────────────────────────────
describe('failures and health', () => {
  test('a rejected login FAILS CLOSED: alert once, then no further login attempts until a Super Admin clears it', async () => {
    const fake = fakeServer({ connectError: Object.assign(new Error('Authentication failed'), { authenticationFailed: true, serverResponseCode: 'AUTHENTICATIONFAILED' }) });
    const d = deps(fake);
    expect(await ingest.pollOnce(d)).toEqual({ error: 'auth_failed' });
    expect(mockStore.state.get(LABEL)).toMatchObject({ status: 'auth_failed' });
    expect(d.ownerAlert.notifyAdminActionRequired).toHaveBeenCalledTimes(1);
    NOW = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);
    expect(await ingest.pollOnce(d)).toEqual({ skipped: 'auth_failed_latched' });
    expect(await ingest.pollOnce(d)).toEqual({ skipped: 'auth_failed_latched' });
    expect(fake.server.calls.filter((c) => c === 'connect')).toHaveLength(1);
    await ingest.clearAuthBlock(require('../../src/db'), CFG);
    fake.server.connectError = null;
    expect((await ingest.pollOnce(d)).baseline).toBe(true);
  });
  test('network trouble backs off (no hammering) and never disables TLS checks', async () => {
    const fake = fakeServer({ connectError: new Error('ECONNRESET') });
    const d = deps(fake);
    const r = await ingest.pollOnce(d);
    expect(r).toMatchObject({ error: 'transport', retry_in_ms: 2 * 60 * 1000 });
    expect(await ingest.pollOnce(d)).toEqual({ skipped: 'backoff' });
    expect(fake.server.constructed).toBe(1);
    NOW = new Date(NOW.getTime() + 3 * 60 * 1000);
    expect((await ingest.pollOnce(d)).retry_in_ms).toBe(4 * 60 * 1000);
  });
  test('a certificate failure is reported as a TLS problem and retried later, verification stays on', async () => {
    const fake = fakeServer({ connectError: Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) });
    const r = await ingest.pollOnce(deps(fake));
    expect(r.error).toBe('tls');
    expect(mockStore.state.get(LABEL).last_error).toMatch(/^TLS certificate check failed/);
    expect(fake.server.options.tls.rejectUnauthorized).toBe(true);
  });
  test('health: polling stopped for 15 minutes → one alert per incident; OFF → no checks', async () => {
    const fake = fakeServer({ messages: [{ uid: 1, raw: raw({ messageId: '<a@x>' }), internalDate: NOW }] });
    const d = deps(fake);
    await baseline(fake, d);
    NOW = new Date(NOW.getTime() + 20 * 60 * 1000);
    const h = await ingest.healthCheck(d);
    expect(h.alerts).toContain('stale');
    expect(d.ownerAlert.notifyAdminActionRequired).toHaveBeenCalledWith(expect.objectContaining({ actionType: 'sasha_imap_health' }));
    reset({ 'sasha.imap_read_enabled': false });
    expect(await ingest.healthCheck(d)).toEqual({ checked: false });
  });
  test('health: no new mail for 24 hours while checks succeed → alert', async () => {
    const fake = fakeServer({ messages: [{ uid: 1, raw: raw({ messageId: '<a@x>' }), internalDate: NOW }] });
    const d = deps(fake);
    await baseline(fake, d);
    NOW = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    await ingest.pollOnce(d);                                    // succeeds, nothing new
    expect((await ingest.healthCheck(d)).alerts).toEqual(['quiet']);
  });
  test('"messages today" counts every recorded message across polls and resets on a new UTC day', async () => {
    const fake = fakeServer({ messages: [{ uid: 1, raw: raw({ messageId: '<a@x>' }), internalDate: NOW }] });
    const d = deps(fake);
    await baseline(fake, d);
    fake.server.messages.push({ uid: 2, raw: raw(), internalDate: NOW });
    await ingest.pollOnce(d);
    expect(mockStore.state.get(LABEL).messages_today).toBe(1);
    await ingest.pollOnce(d);                                    // nothing new: the count must stay at 1 (was reset to 0)
    expect(mockStore.state.get(LABEL).messages_today).toBe(1);
    fake.server.messages.push({ uid: 3, raw: raw({ messageId: '<c@x>', body: 'Another question' }), internalDate: NOW });
    await ingest.pollOnce(d);
    expect(mockStore.state.get(LABEL).messages_today).toBe(2);
    NOW = new Date('2026-10-02T00:05:00Z');                       // next UTC day
    await ingest.pollOnce(d);
    expect(mockStore.state.get(LABEL).messages_today).toBe(0);
  });
  test('the owner alert type exists and routes to the owner recipients', () => {
    const oa = require('../../src/services/ownerAlertService');
    expect(oa.ALERT_TYPES.SASHA_IMAP_HEALTH).toBe('sasha_imap_health');
  });
});

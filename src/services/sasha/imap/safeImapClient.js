'use strict';

/**
 * safeImapClient — the ONLY way Advantage.Bid talks to a human mailbox over IMAP. READ-ONLY BY CONSTRUCTION.
 *
 * The returned object exposes exactly five operations: connect, openReadOnly, searchNewer, fetchSources, logout.
 * The underlying ImapFlow client is private to this closure and is never returned, so no caller can reach
 * delete / move / copy / flag / append / expunge / create / rename / close. On top of that:
 *   - the mailbox is always opened with EXAMINE (readOnly: true): the server itself refuses any change;
 *   - message sources are fetched with BODY.PEEK[] (ImapFlow's `source` fetch), which never sets \Seen;
 *   - the raw client is wrapped in a Proxy that throws on every mutating method name, as a second lock.
 *
 * Security:
 *   - TLS with certificate verification is mandatory (secure: true, rejectUnauthorized: true). There is no
 *     option to disable it; a TLS name mismatch must be fixed with SASHA_IMAP_TLS_SERVERNAME (the certificate's
 *     real host name), never by turning verification off.
 *   - Credentials come only from environment variables (sealed in Railway). They are never logged, never put in
 *     an error message (errors are redacted), and ImapFlow's own logger is disabled.
 */

const MUTATING = new Set(['messageDelete', 'messageMove', 'messageCopy', 'messageFlagsSet', 'messageFlagsAdd', 'messageFlagsRemove',
  'setFlagColor', 'append', 'mailboxCreate', 'mailboxRename', 'mailboxDelete', 'mailboxSubscribe', 'mailboxUnsubscribe',
  'mailboxClose', 'expunge', 'run', 'exec']);

function config(env = process.env) {
  const host = String(env.SASHA_IMAP_HOST || '').trim();
  const user = String(env.SASHA_IMAP_USER || '').trim();
  const pass = env.SASHA_IMAP_PASSWORD ? String(env.SASHA_IMAP_PASSWORD) : '';
  const port = Number(env.SASHA_IMAP_PORT || 993);
  const mailbox = String(env.SASHA_IMAP_MAILBOX || 'INBOX').trim() || 'INBOX';
  const servername = String(env.SASHA_IMAP_TLS_SERVERNAME || host).trim();
  return { host, user, pass, port, mailbox, servername, configured: !!(host && user && pass && Number.isFinite(port) && port > 0) };
}

/** A mailbox label for logs and the database: user + folder only, never a secret. */
function mailboxLabel(cfg) { return (cfg.user || 'unconfigured') + '/' + (cfg.mailbox || 'INBOX'); }

/** Remove anything credential-like from an error message before it is logged or stored. */
function redact(message, cfg = config()) {
  let m = String(message == null ? '' : message);
  if (cfg && cfg.pass) m = m.split(cfg.pass).join('[redacted]');
  m = m.replace(/(LOGIN|AUTHENTICATE)\s+\S+\s+\S+/gi, '$1 [redacted]').replace(/(password|pass|pwd)\s*[:=]\s*\S+/gi, '$1=[redacted]');
  return m.slice(0, 300);
}

/** Classify an ImapFlow/transport error. Authentication failures must fail closed (no retry against the server). */
function classify(err) {
  const m = String((err && (err.responseText || err.message)) || '').toLowerCase();
  const code = String((err && (err.serverResponseCode || err.code)) || '').toUpperCase();
  if ((err && err.authenticationFailed) || code === 'AUTHENTICATIONFAILED' || /authenticat|invalid credentials|login failed|\[auth/.test(m)) return 'auth';
  if (/certificate|self[- ]signed|altname|hostname\/ip does not match|unable to verify|cert_/i.test(m) || /CERT|ERR_TLS/.test(code)) return 'tls';
  return 'transport';
}

function lockedProxy(client) {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && MUTATING.has(prop)) {
        return () => { throw Object.assign(new Error('IMAP operation "' + prop + '" is not permitted (read-only mailbox reader)'), { code: 'IMAP_FORBIDDEN' }); };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/**
 * Create a read-only mailbox session. deps.ImapFlow lets tests inject a fake server client.
 * Returns { connect, openReadOnly, searchNewer, fetchSources, logout, label }.
 */
function create(cfg = config(), deps = {}) {
  if (!cfg.configured) throw Object.assign(new Error('IMAP is not configured'), { code: 'IMAP_NOT_CONFIGURED' });
  const ImapFlow = deps.ImapFlow || require('imapflow').ImapFlow;
  const options = {
    host: cfg.host, port: cfg.port, secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { rejectUnauthorized: true, servername: cfg.servername, minVersion: 'TLSv1.2' },
    logger: false, emitLogs: false, disableAutoIdle: true, disableCompression: true,
    connectionTimeout: 30000, greetingTimeout: 20000, socketTimeout: 120000,
  };
  const client = lockedProxy(new ImapFlow(options));
  let box = null;

  return Object.freeze({
    label: mailboxLabel(cfg),
    async connect() { await client.connect(); },
    /** EXAMINE the mailbox: the server rejects any change for the rest of the session. */
    async openReadOnly() {
      box = await client.mailboxOpen(cfg.mailbox, { readOnly: true });
      const readOnly = box && (box.readOnly === true || client.mailbox && client.mailbox.readOnly === true);
      if (!readOnly) throw Object.assign(new Error('mailbox did not open read-only; refusing to continue'), { code: 'IMAP_NOT_READONLY' });
      return { uidValidity: Number(box.uidValidity), uidNext: Number(box.uidNext), exists: Number(box.exists) };
    },
    /** UIDs strictly greater than afterUid (or messages since a date when afterUid is null). */
    async searchNewer({ afterUid = null, since = null } = {}) {
      const query = afterUid != null ? { uid: (Number(afterUid) + 1) + ':*' } : { since };
      const uids = (await client.search(query, { uid: true })) || [];
      return uids.map(Number).filter((u) => afterUid == null || u > Number(afterUid)).sort((a, b) => a - b);
    },
    /** Full RFC 822 sources via BODY.PEEK[] (never marks read). Yields { uid, source, internalDate, size }. */
    async *fetchSources(uids) {
      if (!uids || !uids.length) return;
      for await (const m of client.fetch(uids.join(','), { uid: true, source: true, internalDate: true, size: true }, { uid: true })) {
        yield { uid: Number(m.uid), source: m.source, internalDate: m.internalDate || null, size: m.size || (m.source ? m.source.length : null) };
      }
    },
    /** LOGOUT only (never CLOSE, which on some servers can expunge). */
    async logout() { try { await client.logout(); } catch (_e) { /* connection already gone */ } },
  });
}

module.exports = { create, config, mailboxLabel, redact, classify, MUTATING, _lockedProxy: lockedProxy };

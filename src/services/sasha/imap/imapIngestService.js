'use strict';

/**
 * imapIngestService — reads NEW mail from the info@advantage.bid mailbox (read-only) and hands it to the SAME Sasha
 * email pipeline the SES route uses (emailChannel.handleInbound): automated-mail detection, duplicate suppression,
 * loop protection, outreach isolation, threading, rate caps, takeover, privacy, handoff and the SES reply path.
 *
 * Switches (platform_config, both OFF by default; see settings.js):
 *   sasha.imap_read_enabled     connect + RECORD new messages; SHADOW: classify only, nothing is answered
 *   sasha.imap_process_enabled  hand newly recorded messages to Sasha (messages recorded in shadow are never answered)
 *
 * Safety:
 *   - The mailbox is only reached through safeImapClient (EXAMINE + BODY.PEEK; cannot delete/move/flag/append).
 *   - First connection: the bookmark is set to the NEWEST existing message and nothing is processed, so the
 *     historical backlog is never answered.
 *   - Idempotency: (1) UNIQUE (mailbox, uidvalidity, uid) + a bookmark that only moves forward after the row is
 *     committed; (2) the existing unique inbound Message-ID index in cs_messages (cross-route: IMAP and SES);
 *     (3) a content fingerprint for mail without a Message-ID.
 *   - A mailbox renumbering (UIDVALIDITY change) re-scans only the last 48 hours; layers 2 and 3 drop repeats.
 *   - Mail older than 48 hours when first read is never auto-answered: it is handed to staff.
 *   - A login failure FAILS CLOSED: no further login attempt until a Super Admin clears it (protects the real mailbox
 *     from lockout by the host's brute-force protection). Other failures back off exponentially.
 *   - One poller at a time: a LEASE on the mailbox row (taken with one atomic UPDATE, renewed while working, expires by
 *     itself). Not a session advisory lock: production reaches Postgres through a transaction-mode pooler, where a
 *     session lock and its unlock can land on different server connections and the lock is stranded (migration 184).
 *   - Health is stored in imap_mailbox_state; problems alert the Owner.
 */

const db = require('../../../db');
const settings = require('../settings');
const safe = require('./safeImapClient');

const LEASE_MS = 10 * 60 * 1000;              // poller lease; renewed after every message, expires if the process dies
const LEASE_OWNER = require('os').hostname() + ':' + process.pid + ':' + require('crypto').randomBytes(4).toString('hex');
const MAX_AGE_MS = 48 * 60 * 60 * 1000;       // older than this when first read → staff, never auto-answered
const RESCAN_MS = 48 * 60 * 60 * 1000;        // UIDVALIDITY change → re-scan this window
const MAX_PER_POLL = 50;                      // bounded work per poll; the rest follow next poll
const MAX_ATTEMPTS = 5;                       // processing retries per recorded message
const STALE_ALERT_MS = 15 * 60 * 1000;        // no successful poll for this long → alert
const QUIET_ALERT_MS = 24 * 60 * 60 * 1000;   // no new mail recorded for this long → alert
const BACKOFF_BASE_MS = 2 * 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;

const nowOf = (deps) => (deps.now ? deps.now() : new Date());

async function getState(label, runner) {
  await runner.query(`INSERT INTO imap_mailbox_state (mailbox) VALUES ($1) ON CONFLICT (mailbox) DO NOTHING`, [label]);
  return (await runner.query(`SELECT * FROM imap_mailbox_state WHERE mailbox = $1`, [label])).rows[0];
}
async function setState(label, fields, runner) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await runner.query(`UPDATE imap_mailbox_state SET ${sets}, updated_at = now() WHERE mailbox = $1`, [label, ...keys.map((k) => fields[k])]);
}

/** Take or renew the poller lease. True when this owner now holds it. */
async function takeLease(label, owner, runner) {
  const r = await runner.query(`UPDATE imap_mailbox_state SET lease_owner = $2, lease_until = now() + ($3 || ' milliseconds')::interval, updated_at = now()
      WHERE mailbox = $1 AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until < now() OR lease_owner = $2) RETURNING mailbox`,
  [label, owner, String(LEASE_MS)]);
  return r.rows.length === 1;
}
async function releaseLease(label, owner, runner) {
  await runner.query(`UPDATE imap_mailbox_state SET lease_owner = NULL, lease_until = NULL WHERE mailbox = $1 AND lease_owner = $2`, [label, owner]);
}

/**
 * "Messages today" counter (UTC day). Done in SQL: the driver returns a DATE column as a JS Date, so comparing it to a
 * "YYYY-MM-DD" string in JavaScript never matched and the counter reset to 0 on every poll.
 */
async function bumpToday(label, now, n, runner) {
  await runner.query(`UPDATE imap_mailbox_state
      SET messages_today = CASE WHEN messages_today_date = $2::date THEN messages_today + $3 ELSE $3 END,
          messages_today_date = $2::date, updated_at = now() WHERE mailbox = $1`, [label, now.toISOString().slice(0, 10), Number(n) || 0]);
}

/** Owner alert, deduplicated per incident key by ownerAlertService. Best effort; never throws. */
async function alert(deps, kind, incidentKey, headline, context) {
  try {
    const svc = deps.ownerAlert || require('../../ownerAlertService');
    return await svc.notifyAdminActionRequired({ actionType: 'sasha_imap_health', entityType: 'imap_mailbox', entityId: kind + ':' + incidentKey,
      headline, context, adminPath: '/admin/sasha.html', actionLabel: 'Open Sasha settings' });
  } catch (_e) { return null; }
}

const headerOf = (msg, name) => { const h = msg.headers || {}; return String(h[name] || h[name.toLowerCase()] || '').trim(); };
function spamFlagged(msg) {
  return /^yes\b/i.test(headerOf(msg, 'x-spam-flag')) || /^yes\b/i.test(headerOf(msg, 'x-spam-status'));
}
function messageDate(msg, internalDate) {
  const d = internalDate ? new Date(internalDate) : (headerOf(msg, 'date') ? new Date(headerOf(msg, 'date')) : null);
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

async function normalize(source, cfg, deps) {
  const n = deps.normalize || require('../../inboundMail/sesInbound').normalize;
  return n(Buffer.isBuffer(source) ? source : Buffer.from(String(source || '')), { recipients: [cfg.user], mailFrom: null, verdicts: {}, sesMessageId: null });
}

/** Record one fetched message (layer 1). Returns the new row, or null when this mailbox position was already recorded. */
async function record(label, uidValidity, m, msg, email, runner) {
  const fp = msg.messageIdHeader ? null : email.contentFingerprint(msg);
  const sha = require('crypto').createHash('sha256').update(Buffer.isBuffer(m.source) ? m.source : Buffer.from(String(m.source || ''))).digest('hex');
  const r = await runner.query(
    `INSERT INTO imap_inbound_messages (mailbox, uidvalidity, uid, message_id, content_fingerprint, from_email, subject, internal_date, size_bytes, raw_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (mailbox, uidvalidity, uid) DO NOTHING RETURNING *`,
    [label, uidValidity, m.uid, msg.messageIdHeader ? String(msg.messageIdHeader).trim() : null, fp, msg.fromEmail || null,
      msg.subject ? String(msg.subject).slice(0, 300) : null, m.internalDate || null, m.size || null, sha]);
  return r.rows[0] || null;
}
const deps0 = { emailChannel: () => require('../emailChannel') };

async function finish(id, status, fields, runner) {
  await runner.query(`UPDATE imap_inbound_messages SET status = $2, outcome = $3::jsonb, conversation_id = $4, last_error = $5,
      processed_at = now(), updated_at = now() WHERE id = $1`,
  [id, status, JSON.stringify(fields.outcome || {}), fields.conversationId || null, fields.error || null]);
}

/**
 * Decide what happens to one recorded message. Shadow (processing off): classify only — nothing is answered or
 * stored in Sasha's conversations. Processing on: the SAME emailChannel.handleInbound the SES route uses.
 */
async function handle(row, msg, internalDate, s, deps, runner) {
  const email = deps.emailChannel || deps0.emailChannel();
  if (spamFlagged(msg)) return finish(row.id, 'spam_flagged', { outcome: { reason: 'mail server marked it as spam' } }, runner);
  // Same message already recorded from this mailbox at another position (e.g. after a renumbering).
  if (row.message_id || row.content_fingerprint) {
    const other = (await runner.query(`SELECT id FROM imap_inbound_messages WHERE id <> $1 AND mailbox = $2 AND
        ((message_id IS NOT NULL AND message_id = $3) OR (content_fingerprint IS NOT NULL AND content_fingerprint = $4))
        AND status <> 'failed' LIMIT 1`, [row.id, row.mailbox, row.message_id, row.content_fingerprint])).rows[0];
    if (other) return finish(row.id, 'duplicate', { outcome: { reason: 'already recorded from this mailbox', other_id: other.id } }, runner);
  }
  const ignore = email.ignoreReason(msg);
  if (!s.imap_process) {
    let would = ignore ? 'ignore' : 'process';
    if (!ignore && row.message_id) {
      const seen = (await runner.query(`SELECT 1 FROM cs_messages WHERE direction = 'inbound' AND email_message_id = $1 LIMIT 1`, [row.message_id])).rows[0];
      if (seen) would = 'duplicate';
    }
    return finish(row.id, 'shadow', { outcome: { shadow: true, would, reason: ignore || null } }, runner);
  }
  if (ignore) return finish(row.id, 'ignored', { outcome: { reason: ignore } }, runner);
  const when = messageDate(msg, internalDate);
  if (when && nowOf(deps).getTime() - when.getTime() > MAX_AGE_MS) {
    // Never auto-answer stale mail: give it to a person.
    const conversations = deps.conversations || require('../conversationService');
    const dup = row.message_id ? (await runner.query(`SELECT conversation_id FROM cs_messages WHERE direction = 'inbound' AND email_message_id = $1`, [row.message_id])).rows[0] : null;
    if (dup) return finish(row.id, 'duplicate', { outcome: { reason: 'already in Sasha', route: 'cs_messages' }, conversationId: dup.conversation_id }, runner);
    const conv = await conversations.createConversation({ channel: 'email', subject: msg.subject, customerEmail: msg.fromEmail, customerName: msg.fromName });
    await conversations.addMessage(conv.id, { direction: 'inbound', author: 'customer', text: email.newText(msg) || '(no text)', emailMessageId: row.message_id,
      contentFingerprint: row.message_id ? null : row.content_fingerprint, inReplyTo: msg.inReplyTo || null, references: msg.references || null });
    await conversations.requestHandoff(conv.id, { reasonCode: 'other', reasonText: 'Older than 48 hours when first read from info@advantage.bid; not answered automatically. Please reply if still needed.', createdBy: 'system' });
    return finish(row.id, 'too_old', { outcome: { reason: 'older than 48 hours; handed to staff' }, conversationId: conv.id }, runner);
  }
  const r = await email.handleInbound(msg, { id: null, source: 'imap' }, deps);
  const status = r.status === 'ignored' ? 'ignored' : r.status === 'duplicate' ? 'duplicate' : 'processed';
  return finish(row.id, status, { outcome: { sasha: r.status, reason: r.reason || null, reply: r.reply || null }, conversationId: r.conversation_id || null }, runner);
}

async function processOne(label, uidValidity, m, s, cfg, deps, runner, existingRow = null) {
  const msg = await normalize(m.source, cfg, deps);
  const row = existingRow || (await record(label, uidValidity, m, msg, deps.emailChannel || deps0.emailChannel(), runner));
  if (!row) return { uid: m.uid, recorded: false };
  try {
    await runner.query(`UPDATE imap_inbound_messages SET attempts = attempts + 1, updated_at = now() WHERE id = $1`, [row.id]);
    await handle(row, msg, m.internalDate, s, deps, runner);
    return { uid: m.uid, recorded: true };
  } catch (e) {
    const err = safe.redact(e && e.message);
    await runner.query(`UPDATE imap_inbound_messages SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [row.id, err]);
    return { uid: m.uid, recorded: true, failed: true };
  }
}

/**
 * One poll. Connects ONLY when imap_read is on, credentials are configured, no auth failure is latched and no
 * backoff is pending. Returns a small summary (never a credential).
 */
async function pollOnce(deps = {}) {
  const runner = deps.db || db;
  const cfg = deps.config || safe.config();
  const label = safe.mailboxLabel(cfg);
  const s = await (deps.settings || settings).effective();
  const st = await getState(label, runner);
  const now = nowOf(deps);

  if (!s.imap_read) { if (st.status !== 'disabled') await setState(label, { status: 'disabled' }, runner); return { skipped: 'disabled' }; }
  if (!cfg.configured) { if (st.status !== 'not_configured') await setState(label, { status: 'not_configured' }, runner); return { skipped: 'not_configured' }; }
  if (st.auth_failed_at) return { skipped: 'auth_failed_latched' };
  if (st.next_attempt_at && new Date(st.next_attempt_at) > now) return { skipped: 'backoff' };

  // One poller at a time: take the lease (atomic; pooler-safe). A lease left by a dead process simply expires.
  const owner = deps.leaseOwner || LEASE_OWNER;
  if (!(await takeLease(label, owner, runner))) return { skipped: 'locked' };

  let session = null;
  const summary = { recorded: 0, processed: 0, failed: 0, baseline: false, rescan: false };
  try {
    await setState(label, { last_poll_at: now }, runner);
    session = safe.create(cfg, deps);
    await session.connect();
    const box = await session.openReadOnly();

    // First connection (or no bookmark yet): start at the newest message; answer nothing from the backlog.
    if (st.uidvalidity == null || st.last_seen_uid == null) {
      await setState(label, { uidvalidity: box.uidValidity, last_seen_uid: Math.max(0, box.uidNext - 1), baseline_at: now,
        status: 'ok', last_success_at: now, consecutive_failures: 0, last_error: null, next_attempt_at: null }, runner);
      summary.baseline = true;
      summary.baseline_uid = Math.max(0, box.uidNext - 1);
      return summary;
    }

    let uids;
    if (Number(st.uidvalidity) !== box.uidValidity) {
      summary.rescan = true;
      uids = await session.searchNewer({ since: new Date(now.getTime() - RESCAN_MS) });
      await setState(label, { uidvalidity_changed_at: now }, runner);
      await alert(deps, 'uidvalidity', String(box.uidValidity), 'Sasha mailbox renumbered',
        'The info@ mailbox was renumbered by the mail server. The last 48 hours were re-checked; duplicates are dropped.');
    } else {
      uids = await session.searchNewer({ afterUid: st.last_seen_uid });
    }

    // Retry messages recorded earlier whose processing did not finish (same numbering only).
    const pending = (await runner.query(`SELECT * FROM imap_inbound_messages WHERE mailbox = $1 AND uidvalidity = $2 AND status IN ('recorded','failed')
        AND attempts < $3 ORDER BY uid LIMIT 20`, [label, box.uidValidity, MAX_ATTEMPTS])).rows;
    const pendingByUid = new Map(pending.map((r) => [Number(r.uid), r]));

    const batch = uids.slice(0, MAX_PER_POLL);
    const want = [...new Set([...pendingByUid.keys(), ...batch])].sort((a, b) => a - b);
    let lastUid = Number(st.uidvalidity) === box.uidValidity ? Number(st.last_seen_uid) : 0;
    for await (const m of session.fetchSources(want)) {
      const r = await processOne(label, box.uidValidity, m, s, cfg, deps, runner, pendingByUid.get(m.uid) || null);
      await takeLease(label, owner, runner);
      if (r.recorded && !pendingByUid.has(m.uid)) summary.recorded++;
      if (r.failed) summary.failed++; else if (r.recorded) summary.processed++;
      // Advance the bookmark only past messages that are now durably recorded (layer 1).
      if (batch.includes(m.uid) && m.uid > lastUid) {
        lastUid = m.uid;
        await setState(label, { uidvalidity: box.uidValidity, last_seen_uid: lastUid }, runner);
      }
    }
    // After a re-scan, continue from the last recorded message if the window was larger than one batch.
    if (summary.rescan) await setState(label, { uidvalidity: box.uidValidity, last_seen_uid: uids.length > batch.length ? lastUid : Math.max(lastUid, box.uidNext - 1) }, runner);

    await setState(label, { status: 'ok', last_success_at: now, consecutive_failures: 0, last_error: null, next_attempt_at: null,
      ...(summary.recorded ? { last_message_at: now } : {}) }, runner);
    await bumpToday(label, now, summary.recorded, runner);
    return summary;
  } catch (e) {
    const kind = safe.classify(e);
    const err = safe.redact(e && (e.responseText || e.message), cfg);
    if (kind === 'auth') {
      // FAIL CLOSED: never retry a rejected login against the real mailbox.
      await setState(label, { status: 'auth_failed', auth_failed_at: now, last_error: 'login rejected by the mail server', consecutive_failures: (st.consecutive_failures || 0) + 1 }, runner);
      await alert(deps, 'auth', now.toISOString(), 'Sasha cannot sign in to info@',
        'The info@ mailbox rejected the login. Sasha stopped trying. Check the password in Railway, then clear the block in Sasha settings.');
      return { error: 'auth_failed' };
    }
    const n = (st.consecutive_failures || 0) + 1;
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 8));
    await setState(label, { status: 'error', last_error: (kind === 'tls' ? 'TLS certificate check failed: ' : '') + err, consecutive_failures: n,
      next_attempt_at: new Date(now.getTime() + wait) }, runner);
    return { error: kind, retry_in_ms: wait };
  } finally {
    if (session) await session.logout();
    try { await releaseLease(label, owner, runner); } catch (_e) { /* the lease expires by itself */ }
  }
}

/** Health check (no mailbox connection): alert when polling has stopped or no mail has been recorded for 24 hours. */
async function healthCheck(deps = {}) {
  const runner = deps.db || db;
  const cfg = deps.config || safe.config();
  const label = safe.mailboxLabel(cfg);
  const s = await (deps.settings || settings).effective();
  if (!s.imap_read || !cfg.configured) return { checked: false };
  const st = await getState(label, runner);
  const now = nowOf(deps).getTime();
  const out = { checked: true, alerts: [] };
  if (st.auth_failed_at) return out;   // already alerted when it happened
  const lastOk = st.last_success_at ? new Date(st.last_success_at).getTime() : null;
  const since = lastOk || (st.baseline_at ? new Date(st.baseline_at).getTime() : null) || new Date(st.updated_at).getTime();
  if (now - since > STALE_ALERT_MS) {
    out.alerts.push('stale');
    await alert(deps, 'stale', String(lastOk || 'never'), 'Sasha is not reading info@',
      'No successful check of the info@ mailbox for over 15 minutes. Last error: ' + (st.last_error || 'none'));
  }
  const lastMail = st.last_message_at ? new Date(st.last_message_at).getTime() : (st.baseline_at ? new Date(st.baseline_at).getTime() : null);
  if (lastOk && lastMail && now - lastMail > QUIET_ALERT_MS) {
    out.alerts.push('quiet');
    await alert(deps, 'quiet', new Date(now).toISOString().slice(0, 10), 'No new info@ mail for 24 hours',
      'Sasha has read the info@ mailbox but recorded no new mail for 24 hours. Please check the mailbox is receiving mail.');
  }
  return out;
}

/** Super Admin: clear the fail-closed login block after fixing the password (the next poll tries once). */
async function clearAuthBlock(runner = db, cfg = safe.config()) {
  const label = safe.mailboxLabel(cfg);
  await getState(label, runner);
  await setState(label, { auth_failed_at: null, next_attempt_at: null, status: 'idle', last_error: null, consecutive_failures: 0 }, runner);
  return { mailbox: label };
}

/** Admin view: state + message counts (no bodies, no credentials). */
async function status(runner = db, cfg = safe.config()) {
  const label = safe.mailboxLabel(cfg);
  const st = (await runner.query(`SELECT mailbox, uidvalidity, last_seen_uid, baseline_at, status, last_poll_at, last_success_at, last_message_at, last_error,
      consecutive_failures, next_attempt_at, auth_failed_at, uidvalidity_changed_at, messages_today, messages_today_date FROM imap_mailbox_state WHERE mailbox = $1`, [label]).catch(() => ({ rows: [] }))).rows[0] || null;
  const counts = (await runner.query(`SELECT status, count(*)::int n FROM imap_inbound_messages WHERE mailbox = $1 AND recorded_at > now() - interval '7 days' GROUP BY 1`, [label])
    .catch(() => ({ rows: [] }))).rows;
  return { configured: cfg.configured, mailbox: label, state: st, last_7_days: Object.fromEntries(counts.map((r) => [r.status, r.n])) };
}

module.exports = { pollOnce, healthCheck, clearAuthBlock, status, spamFlagged, LIMITS: { MAX_AGE_MS, RESCAN_MS, MAX_PER_POLL, MAX_ATTEMPTS, STALE_ALERT_MS, QUIET_ALERT_MS } };

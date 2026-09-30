'use strict';

/**
 * /api/admin/sasha — Shared Inbox, Sasha settings and support knowledge (Admin).
 *
 * Access: every route requires an authenticated staff session with support.view (reads) or support.manage (actions).
 * Super Admins hold both. Operational switches and the budget are Super-Admin only. Every change is audited.
 * Nothing here is reachable by a public or non-staff user (the auction-report IDOR class is avoided by gating the
 * whole router, validating ids, and never deriving access from request data).
 */

const express = require('express');
const auth = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const rbac = require('../lib/rbac');
const db = require('../db');
const auditService = require('../services/auditService');
const conversations = require('../services/sasha/conversationService');
const settings = require('../services/sasha/settings');
const helpIndex = require('../services/sasha/knowledge/helpIndex');
const platformFacts = require('../services/sasha/knowledge/platformFacts');
const emailChannel = require('../services/sasha/emailChannel');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const view = requirePermission('support.view');
const manage = requirePermission('support.manage');
const superAdminOnly = async (req, res, next) => {
  const ctx = await requirePermission.loadStaffContext(req);
  if (ctx && rbac.isSuperAdmin(ctx)) return next();
  return res.status(403).json({ success: false, message: 'Super Admin only.' });
};
const audit = (req, eventType, entityId, metadata) => auditService.logEvent(db, { eventType, entityType: 'cs_conversation', entityId, actorId: req.user.id, metadata })
  .catch((e) => console.error('[admin-sasha] audit failed', e.message));
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[admin-sasha]', e && e.message);
  res.status(e && e.status ? e.status : 500).json({ success: false, message: e && e.status ? e.message : 'Something went wrong.' });
});
const idParam = (req, res) => { if (!UUID.test(req.params.id || '')) { res.status(404).json({ success: false, message: 'Not found.' }); return null; } return req.params.id; };

router.use(auth, express.json({ limit: '64kb' }), view);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });

// ── Inbox ───────────────────────────────────────────────────────────────────────────────────────────────
router.get('/conversations', wrap(async (req, res) => {
  const q = req.query || {};
  const where = []; const p = [];
  if (q.view === 'handoff') where.push(`c.handoff_state = 'needed'`);
  else if (q.view === 'staff') where.push(`c.owner = 'staff' AND c.status NOT IN ('closed','resolved')`);
  else if (q.view === 'open') where.push(`c.status IN ('open','waiting_customer')`);
  else if (q.view === 'resolved') where.push(`c.status IN ('resolved','closed')`);
  else if (q.view === 'ignored') where.push(`c.status = 'ignored'`);
  else where.push(`c.status <> 'ignored'`);
  if (q.channel === 'email' || q.channel === 'chat') { p.push(q.channel); where.push(`c.channel = $${p.length}`); }
  if (q.q && String(q.q).trim()) {
    p.push('%' + String(q.q).trim().slice(0, 80).replace(/[%_]/g, '') + '%');
    where.push(`(c.customer_email ILIKE $${p.length} OR c.customer_name ILIKE $${p.length} OR c.subject ILIKE $${p.length} OR c.ref ILIKE $${p.length})`);
  }
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 100));
  p.push(limit);
  const { rows } = await db.query(
    `SELECT c.id, c.ref, c.channel, c.site, c.status, c.owner, c.handoff_state, c.handoff_reason, c.subject, c.customer_email, c.customer_name,
            c.user_id, u.email AS account_email, c.contact_match_user_id IS NOT NULL AS email_matches_account, c.message_count, c.auto_reply_count,
            c.last_message_at, c.created_at, s.full_name AS assigned_staff,
            (SELECT left(body_text, 160) FROM cs_messages m WHERE m.conversation_id = c.id AND m.direction <> 'note' ORDER BY created_at DESC LIMIT 1) AS last_text
       FROM cs_conversations c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN users s ON s.id = c.assigned_staff_id
      WHERE ${where.join(' AND ')} ORDER BY (c.handoff_state = 'needed') DESC, c.last_message_at DESC LIMIT $${p.length}`, p);
  const counts = (await db.query(`SELECT
      count(*) FILTER (WHERE handoff_state = 'needed')::int AS handoff,
      count(*) FILTER (WHERE owner = 'staff' AND status NOT IN ('closed','resolved'))::int AS staff,
      count(*) FILTER (WHERE status IN ('open','waiting_customer'))::int AS open
      FROM cs_conversations WHERE status <> 'ignored'`)).rows[0];
  res.json({ success: true, data: { conversations: rows, counts } });
}));

router.get('/conversations/:id', wrap(async (req, res) => {
  const id = idParam(req, res); if (!id) return;
  const c = (await db.query(`SELECT c.*, u.email AS account_email, u.full_name AS account_name, u.role AS account_role,
      mu.email AS matched_email, s.full_name AS assigned_staff
      FROM cs_conversations c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN users mu ON mu.id = c.contact_match_user_id
      LEFT JOIN users s ON s.id = c.assigned_staff_id WHERE c.id = $1`, [id])).rows[0];
  if (!c) return res.status(404).json({ success: false, message: 'Not found.' });
  delete c.chat_token_hash;
  const messages = (await db.query(`SELECT m.id, m.direction, m.author_type, m.body_text, m.created_at, m.auto_sent, m.delivery_status, m.delivery_error,
      m.attachments, u.full_name AS staff_name FROM cs_messages m LEFT JOIN users u ON u.id = m.staff_user_id
      WHERE m.conversation_id = $1 ORDER BY m.created_at ASC`, [id])).rows;
  const handoffs = (await db.query(`SELECT h.id, h.reason_code, h.reason_text, h.created_by, h.status, h.created_at, h.resolved_at, u.full_name AS taken_by
      FROM cs_handoffs h LEFT JOIN users u ON u.id = h.taken_by WHERE h.conversation_id = $1 ORDER BY h.created_at`, [id])).rows;
  const runs = (await db.query(`SELECT id, created_at, model, outcome, outcome_reason, tools_used, input_tokens, output_tokens, cost_micro_usd, latency_ms, error
      FROM cs_ai_runs WHERE conversation_id = $1 ORDER BY created_at`, [id])).rows;
  res.json({ success: true, data: { conversation: c, messages, handoffs, runs } });
}));

router.post('/conversations/:id/takeover', manage, wrap(async (req, res) => {
  const id = idParam(req, res); if (!id) return;
  const c = await conversations.takeOver(id, req.user.id);
  if (!c) return res.status(404).json({ success: false, message: 'Not found.' });
  await audit(req, 'sasha.conversation_taken_over', id, {});
  res.json({ success: true, data: { owner: c.owner } });
}));

router.post('/conversations/:id/return', manage, wrap(async (req, res) => {
  const id = idParam(req, res); if (!id) return;
  const c = await conversations.returnToSasha(id, req.user.id);
  if (!c) return res.status(404).json({ success: false, message: 'Not found.' });
  await audit(req, 'sasha.conversation_returned', id, {});
  res.json({ success: true, data: { owner: c.owner } });
}));

// Staff reply: replying takes the conversation over first (Sasha must never race a person).
router.post('/conversations/:id/reply', manage, wrap(async (req, res) => {
  const id = idParam(req, res); if (!id) return;
  const text = String((req.body && req.body.text) || '').trim().slice(0, 10000);
  if (!text) return res.status(400).json({ success: false, message: 'Write a reply first.' });
  let c = await conversations.get(id);
  if (!c) return res.status(404).json({ success: false, message: 'Not found.' });
  if (c.owner !== 'staff') c = await conversations.takeOver(id, req.user.id);
  let delivery = null, error = null, sent = null;
  if (c.channel === 'email') {
    if (!c.customer_email) return res.status(400).json({ success: false, message: 'This conversation has no email address to reply to.' });
    try { sent = await emailChannel.sendStaffEmail(c, text, req.user.id); delivery = sent && sent.skipped ? 'not_sent' : 'sent'; }
    catch (e) { delivery = 'failed'; error = String(e.message).slice(0, 300); }
  }
  const msg = await conversations.addMessage(id, { direction: 'outbound', author: 'staff', staffUserId: req.user.id, text, deliveryStatus: delivery,
    sesMessageId: sent && sent.sesMessageId, emailMessageId: sent && sent.messageId ? `<${String(sent.messageId).replace(/^<|>$/g, '')}>` : null });
  if (error) await db.query(`UPDATE cs_messages SET delivery_error = $2 WHERE id = $1`, [msg.id, error]);
  await audit(req, 'sasha.staff_reply', id, { channel: c.channel, delivery });
  res.json({ success: true, data: { message_id: msg.id, delivery, error } });
}));

router.post('/conversations/:id/note', manage, wrap(async (req, res) => {
  const id = idParam(req, res); if (!id) return;
  const text = String((req.body && req.body.text) || '').trim().slice(0, 5000);
  if (!text) return res.status(400).json({ success: false, message: 'Write a note first.' });
  if (!(await conversations.get(id))) return res.status(404).json({ success: false, message: 'Not found.' });
  await conversations.addMessage(id, { direction: 'note', author: 'staff', staffUserId: req.user.id, text });
  res.json({ success: true });
}));

router.post('/conversations/:id/status', manage, wrap(async (req, res) => {
  const id = idParam(req, res); if (!id) return;
  const status = String((req.body && req.body.status) || '');
  if (!['open', 'resolved', 'closed'].includes(status)) return res.status(400).json({ success: false, message: 'Unknown status.' });
  const c = await conversations.setStatus(id, status);
  if (!c) return res.status(404).json({ success: false, message: 'Not found.' });
  await audit(req, 'sasha.conversation_status', id, { status });
  res.json({ success: true, data: { status: c.status } });
}));

// ── Settings (switches: Super Admin only) ───────────────────────────────────────────────────────────────
router.get('/settings', wrap(async (req, res) => {
  settings.clear();
  const s = await settings.effective();
  const spent = await require('../services/sasha/engine').spentTodayUsd();
  const inbound = (await db.query(`SELECT status, count(*)::int n FROM inbound_email_receipts WHERE programme = 'company_inbox'
    AND received_at > now() - interval '7 days' GROUP BY 1`)).rows;
  res.json({ success: true, data: { settings: s, spent_today_usd: Math.round(spent * 10000) / 10000, model: require('../services/sasha/engine').MODEL(),
    inbox_address: 'inbox@' + (process.env.INBOUND_REPLY_DOMAIN || 'reply.advantage.bid'), inbound_last_7_days: inbound,
    imap: await require('../services/sasha/imap/imapIngestService').status().catch(() => null) } });
}));

// Super Admin: clear the fail-closed IMAP login block after the password was corrected (the next poll tries once).
router.post('/imap/clear-auth-block', superAdminOnly, wrap(async (req, res) => {
  const r = await require('../services/sasha/imap/imapIngestService').clearAuthBlock();
  await auditService.logEvent(db, { eventType: 'sasha.imap_auth_block_cleared', entityType: 'platform_config', entityId: '00000000-0000-0000-0000-000000000000',
    actorId: req.user.id, metadata: { mailbox: r.mailbox } });
  res.json({ success: true, data: r });
}));

router.post('/settings', superAdminOnly, wrap(async (req, res) => {
  const { key, value } = req.body || {};
  const before = (await settings.load())[String(key || '').replace('sasha.', '')];
  const v = await settings.set(String(key || ''), value);
  await auditService.logEvent(db, { eventType: 'sasha.setting_changed', entityType: 'platform_config', entityId: '00000000-0000-0000-0000-000000000000',
    actorId: req.user.id, metadata: { key, before, after: v } });
  res.json({ success: true, data: await settings.effective() });
}));

// ── Knowledge (support guidance + what Sasha reads) ─────────────────────────────────────────────────────
router.get('/knowledge', wrap(async (req, res) => {
  const kb = (await db.query(`SELECT k.id, k.slug, k.title, k.body, k.audience, k.status, k.conflict_note, k.source, k.version, k.updated_at, u.full_name AS updated_by
    FROM cs_kb_articles k LEFT JOIN users u ON u.id = k.updated_by ORDER BY (k.status = 'conflict') DESC, k.title`)).rows;
  res.json({ success: true, data: { articles: kb, help_index: helpIndex.stats(), help_pages: helpIndex.HELP_PAGES, platform_rules: platformFacts.getFacts('all') } });
}));

const KB_STATUS = ['draft', 'approved', 'disabled', 'conflict'];
const KB_AUDIENCE = ['all', 'buyer', 'seller', 'professional', 'staff'];
router.post('/knowledge', manage, wrap(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 200); const body = String(b.body || '').trim().slice(0, 8000);
  if (!title || !body) return res.status(400).json({ success: false, message: 'Title and text are required.' });
  const slug = (String(b.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'guidance').slice(0, 80) + '-' + Date.now().toString(36);
  const status = KB_STATUS.includes(b.status) ? b.status : 'approved';
  const audience = KB_AUDIENCE.includes(b.audience) ? b.audience : 'all';
  const r = (await db.query(`INSERT INTO cs_kb_articles (slug, title, body, audience, status, conflict_note, source, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [slug, title, body, audience, status, b.conflict_note || null, 'admin', req.user.id])).rows[0];
  await auditService.logEvent(db, { eventType: 'sasha.kb_created', entityType: 'cs_kb_article', entityId: r.id, actorId: req.user.id, metadata: { title, status } });
  res.json({ success: true, data: { id: r.id } });
}));

router.patch('/knowledge/:id', manage, wrap(async (req, res) => {
  const id = idParam(req, res); if (!id) return;
  const b = req.body || {}; const sets = []; const p = [id];
  const add = (col, v) => { p.push(v); sets.push(`${col} = $${p.length}`); };
  if (typeof b.title === 'string' && b.title.trim()) add('title', b.title.trim().slice(0, 200));
  if (typeof b.body === 'string' && b.body.trim()) add('body', b.body.trim().slice(0, 8000));
  if (KB_STATUS.includes(b.status)) add('status', b.status);
  if (KB_AUDIENCE.includes(b.audience)) add('audience', b.audience);
  if (b.conflict_note !== undefined) add('conflict_note', b.conflict_note ? String(b.conflict_note).slice(0, 2000) : null);
  if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to change.' });
  add('updated_by', req.user.id);
  const r = await db.query(`UPDATE cs_kb_articles SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $1 RETURNING id, status`, p);
  if (!r.rowCount) return res.status(404).json({ success: false, message: 'Not found.' });
  await auditService.logEvent(db, { eventType: 'sasha.kb_updated', entityType: 'cs_kb_article', entityId: id, actorId: req.user.id,
    metadata: { fields: Object.keys(b), status: r.rows[0].status } });
  res.json({ success: true });
}));

// ── Activity (observability) ────────────────────────────────────────────────────────────────────────────
router.get('/activity', wrap(async (req, res) => {
  const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
  const byDay = (await db.query(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, outcome, count(*)::int n,
      sum(cost_micro_usd)::bigint cost, round(avg(latency_ms))::int avg_ms
      FROM cs_ai_runs WHERE created_at > now() - ($1 || ' days')::interval GROUP BY 1, 2 ORDER BY 1 DESC, 2`, [String(days)])).rows;
  const recentErrors = (await db.query(`SELECT r.created_at, r.outcome_reason, r.error, c.ref FROM cs_ai_runs r LEFT JOIN cs_conversations c ON c.id = r.conversation_id
      WHERE r.outcome = 'error' ORDER BY r.created_at DESC LIMIT 10`)).rows;
  const inbound = (await db.query(`SELECT outcome->>'sasha' AS sasha, outcome->>'reason' AS reason, count(*)::int n FROM inbound_email_receipts
      WHERE programme = 'company_inbox' AND received_at > now() - ($1 || ' days')::interval GROUP BY 1, 2 ORDER BY 3 DESC`, [String(days)])).rows;
  res.json({ success: true, data: { runs_by_day: byDay.map((r) => ({ ...r, cost_usd: Number(r.cost) / 1e6 })), recent_errors: recentErrors, inbound_filtering: inbound } });
}));

module.exports = router;

'use strict';

/**
 * marketplaceModerationService — storefront milestone 2: listing moderation (admin takedown / restore) and buyer reports.
 *
 *   • Takedown: an administrator removes a listing from view with a written reason. The listing can never be live while
 *     taken down (database check, migration 198), and the seller cannot change its status. Refused while a buyer is mid-
 *     checkout, so a payment is never left without its item.
 *   • Restore: only a listing an administrator took down, back to the status it had before, with a written reason.
 *   • Report: a signed-in buyer reports a PUBLIC listing. The report is tied to the listing's real seller (read from the
 *     listing; composite key in the database), one open report per person per listing, at most 10 a day per person.
 *     Reporting establishes nothing about the seller: it creates an item for review.
 * Every administrator action is kept permanently in marketplace_item_moderation_events.
 */

const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');

const REPORT_CATEGORIES = ['prohibited_item', 'counterfeit', 'misleading', 'wrong_category', 'offensive', 'other'];
const REPORTS_PER_DAY = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const clip = (v, n) => (v == null ? '' : String(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]+/g, ' ').trim().slice(0, n));
function reasonOf(v) {
  const r = clip(v, 1000);
  if (r.length < 5) throw err(422, 'REASON_REQUIRED', 'Give a short reason (it is kept in the listing history).');
  return r;
}
function needAdmin(adminId) { if (!adminId) throw err(403, 'ADMIN_REQUIRED', 'Only an administrator can do this.'); }

async function logModeration(client, item, action, adminId, reason, extra = {}) {
  await client.query(
    `INSERT INTO marketplace_item_moderation_events (item_id, seller_id, action, actor_user_id, reason, prior_status, report_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [item.id, item.seller_id, action, adminId, reason, extra.priorStatus || null, extra.reportId || null]);
}

// ── Admin: inventory across every seller ─────────────────────────────────────────────────────────────
async function listItemsForAdmin({ status, moderation, reported, q, limit } = {}) {
  const where = []; const p = [];
  const add = (sql, v) => { p.push(v); where.push(sql.replace('$?', '$' + p.length)); };
  if (['draft', 'active', 'paused', 'pending_purchase', 'sold', 'removed'].includes(status)) add('mi.status = $?', status);
  if (moderation === 'taken_down') where.push(`mi.moderation_status = 'taken_down'`);
  if (reported === 'open') where.push(`EXISTS (SELECT 1 FROM marketplace_item_reports r WHERE r.item_id = mi.id AND r.status = 'open')`);
  if (q) add('(mi.title ILIKE $? OR COALESCE(sp.display_name, \'\') ILIKE $?)', '%' + clip(q, 80) + '%');
  p.push(Math.min(500, Math.max(1, parseInt(limit, 10) || 200)));
  const { rows } = await db.query(
    `SELECT mi.id, mi.title, mi.price_cents, mi.status, mi.moderation_status, mi.moderation_reason, mi.moderated_at, mi.thumbnail_url,
            mi.city, mi.state, mi.created_at, mi.updated_at, mi.is_demo, mi.seller_id,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name, sp.seller_type,
            (SELECT count(*)::int FROM marketplace_item_reports r WHERE r.item_id = mi.id AND r.status = 'open') AS open_reports,
            (SELECT count(*)::int FROM marketplace_orders o WHERE o.marketplace_item_id = mi.id AND o.payment_status IN ('pending','processing','paid')) AS live_orders
       FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY open_reports DESC, mi.updated_at DESC LIMIT $${p.length}`, p);
  return rows;
}

async function itemHistory(itemId) {
  if (!UUID_RE.test(String(itemId || ''))) return null;
  const { rows } = await db.query(
    `SELECT action, actor_user_id, reason, prior_status, report_id, created_at FROM marketplace_item_moderation_events
      WHERE item_id = $1 ORDER BY created_at ASC, id ASC`, [itemId]);
  return rows;
}

async function takedown(itemId, adminId, { reason, reportId } = {}, runner = null) {
  needAdmin(adminId);
  if (!UUID_RE.test(String(itemId || ''))) throw err(404, 'ITEM_NOT_FOUND', 'Listing not found.');
  const why = reasonOf(reason);
  const run = async (client) => {
    const it = (await client.query('SELECT * FROM marketplace_items WHERE id = $1 FOR UPDATE', [itemId])).rows[0];
    if (!it) throw err(404, 'ITEM_NOT_FOUND', 'Listing not found.');
    if (it.moderation_status === 'taken_down') return it;   // idempotent
    const live = (await client.query(
      `SELECT count(*)::int AS n FROM marketplace_orders WHERE marketplace_item_id = $1 AND payment_status IN ('pending','processing')`, [it.id])).rows[0];
    if (it.status === 'pending_purchase' || live.n > 0) {
      throw err(409, 'ITEM_RESERVED', 'A buyer is checking out this listing. Try again in a few minutes, or place the order on hold.');
    }
    const upd = (await client.query(
      `UPDATE marketplace_items SET status = 'removed', moderation_status = 'taken_down', moderation_reason = $2, moderated_by = $3,
              moderated_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [it.id, why, adminId])).rows[0];
    await logModeration(client, it, 'takedown', adminId, why, { priorStatus: it.status, reportId });
    return upd;
  };
  return runner ? run(runner) : withTransaction(run);
}

async function restore(itemId, adminId, { reason } = {}) {
  needAdmin(adminId);
  if (!UUID_RE.test(String(itemId || ''))) throw err(404, 'ITEM_NOT_FOUND', 'Listing not found.');
  const why = reasonOf(reason);
  return withTransaction(async (client) => {
    const it = (await client.query('SELECT * FROM marketplace_items WHERE id = $1 FOR UPDATE', [itemId])).rows[0];
    if (!it) throw err(404, 'ITEM_NOT_FOUND', 'Listing not found.');
    if (it.moderation_status !== 'taken_down') throw err(409, 'NOT_TAKEN_DOWN', 'Only a listing an administrator took down can be restored.');
    const last = (await client.query(
      `SELECT prior_status FROM marketplace_item_moderation_events WHERE item_id = $1 AND action = 'takedown' ORDER BY created_at DESC LIMIT 1`, [it.id])).rows[0];
    let back = last && ['draft', 'active', 'paused', 'sold', 'removed'].includes(last.prior_status) ? last.prior_status : 'draft';
    // A listing that has been sold is never offered again.
    const paid = (await client.query(`SELECT count(*)::int AS n FROM marketplace_orders WHERE marketplace_item_id = $1 AND payment_status = 'paid'`, [it.id])).rows[0];
    if (paid.n > 0 && (back === 'active' || back === 'paused')) back = 'sold';
    const upd = (await client.query(
      `UPDATE marketplace_items SET moderation_status = 'none', status = $2, moderation_reason = NULL, moderated_by = $3, moderated_at = now(),
              updated_at = now() WHERE id = $1 RETURNING *`, [it.id, back, adminId])).rows[0];
    await logModeration(client, it, 'restore', adminId, why, { priorStatus: it.status });
    return upd;
  });
}

// ── Buyer: report a public listing ──────────────────────────────────────────────────────────────────
async function reportItem(itemId, reporterUserId, body = {}) {
  if (!UUID_RE.test(String(itemId || ''))) throw err(404, 'ITEM_NOT_FOUND', 'Listing not found.');
  const category = REPORT_CATEGORIES.includes(body.category) ? body.category : null;
  if (!category) throw err(422, 'CATEGORY_REQUIRED', 'Choose what is wrong with this listing.');
  const message = clip(body.message, 2000);
  if (message.length < 5) throw err(422, 'MESSAGE_REQUIRED', 'Tell us briefly what is wrong.');
  // The listing must be one the public can see; its seller comes from the listing itself.
  const it = (await db.query(
    `SELECT mi.id, mi.seller_id, mi.title, sp.user_id AS seller_user_id FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE mi.id = $1 AND mi.status IN ('active','pending_purchase','sold') AND sp.seller_type = ANY($2::text[])`,
    [itemId, PROFESSIONAL_SELLER_TYPES])).rows[0];
  if (!it) throw err(404, 'ITEM_NOT_FOUND', 'Listing not found.');
  if (it.seller_user_id === reporterUserId) throw err(409, 'OWN_LISTING', 'You cannot report your own listing.');
  const today = (await db.query(
    `SELECT count(*)::int AS n FROM marketplace_item_reports WHERE reporter_user_id = $1 AND created_at > now() - interval '1 day'`, [reporterUserId])).rows[0];
  if (today.n >= REPORTS_PER_DAY) throw err(429, 'TOO_MANY_REPORTS', 'You have sent several reports today. Our team will review them.');
  const existing = (await db.query(
    `SELECT id FROM marketplace_item_reports WHERE item_id = $1 AND reporter_user_id = $2 AND status = 'open'`, [it.id, reporterUserId])).rows[0];
  if (existing) return { id: existing.id, already_reported: true };
  const row = (await db.query(
    `INSERT INTO marketplace_item_reports (item_id, seller_id, reporter_user_id, category, message) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (item_id, reporter_user_id) WHERE status = 'open' DO NOTHING RETURNING id`,
    [it.id, it.seller_id, reporterUserId, category, message])).rows[0];
  if (!row) return { already_reported: true };
  try {
    const oa = require('./ownerAlertService');
    await oa.notifyAdminActionRequired({ actionType: oa.ALERT_TYPES.STOREFRONT_ITEM_REPORT, entityType: 'marketplace_item', entityId: it.id,
      headline: 'Storefront listing reported', context: category.replace(/_/g, ' '), adminPath: '/admin/storefront-moderation.html',
      adminId: it.id, adminParam: 'item', actionLabel: 'Review' });
  } catch (e) { console.error('[moderation] report alert failed:', e.message); }
  return { id: row.id, already_reported: false };
}

async function listReports({ status } = {}) {
  const st = ['open', 'dismissed', 'actioned'].includes(status) ? status : 'open';
  const { rows } = await db.query(
    `SELECT r.id, r.item_id, r.seller_id, r.category, r.message, r.status, r.review_note, r.reviewed_at, r.created_at,
            mi.title AS item_title, mi.status AS item_status, mi.moderation_status,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name
       FROM marketplace_item_reports r JOIN marketplace_items mi ON mi.id = r.item_id JOIN seller_profiles sp ON sp.id = r.seller_id
      WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT 500`, [st]);
  return rows;   // the reporter's identity is not listed (kept for the record, shown only if needed)
}

// Admin reviews a report: dismiss it, or act on it (takes the listing down). Both need a written note.
async function reviewReport(reportId, adminId, { action, note } = {}) {
  needAdmin(adminId);
  if (!UUID_RE.test(String(reportId || ''))) throw err(404, 'REPORT_NOT_FOUND', 'Report not found.');
  const why = reasonOf(note);
  if (!['dismiss', 'takedown'].includes(action)) throw err(422, 'ACTION_REQUIRED', 'Choose dismiss or take down.');
  return withTransaction(async (client) => {
    const r = (await client.query('SELECT * FROM marketplace_item_reports WHERE id = $1 FOR UPDATE', [reportId])).rows[0];
    if (!r) throw err(404, 'REPORT_NOT_FOUND', 'Report not found.');
    if (r.status !== 'open') throw err(409, 'ALREADY_REVIEWED', 'This report was already reviewed.');
    const item = { id: r.item_id, seller_id: r.seller_id };
    if (action === 'takedown') await takedown(r.item_id, adminId, { reason: why, reportId: r.id }, client);
    await client.query(`UPDATE marketplace_item_reports SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`,
      [r.id, action === 'takedown' ? 'actioned' : 'dismissed', why, adminId]);
    await logModeration(client, item, action === 'takedown' ? 'report_actioned' : 'report_dismissed', adminId, why, { reportId: r.id });
    return { id: r.id, status: action === 'takedown' ? 'actioned' : 'dismissed' };
  });
}

module.exports = { REPORT_CATEGORIES, listItemsForAdmin, itemHistory, takedown, restore, reportItem, listReports, reviewReport };

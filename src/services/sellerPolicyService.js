'use strict';

/**
 * Professional Seller Store Terms & Conditions and Shipping & Pickup Policy (migration 203; roadmap §7.2–7.4).
 *
 *   Owner (company.storefront.manage):  forOwner · saveDraft · publish     (each kind edited/published independently)
 *   Public:                              publishedFor(sellerId) · publicBySlug(slug)
 *   Checkout:                            snapshotFor(sellerId) — what an order records at purchase
 *
 * Rules: policies belong to the seller organisation from the session (never a seller id from the request); a published
 * version is never rewritten (new version instead; database-enforced); one seller's policies are never shown as another's.
 * These are the seller's own terms: Advantage.Bid does not write them, does not treat them as legally reviewed, and its
 * platform Buyer Terms stay separate and prevail. Plain text only (no HTML from sellers).
 */
const crypto = require('crypto');
const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const { writeAuditLog } = require('../lib/auditLog');

const KINDS = { store_terms: 'Store Terms & Conditions', shipping_pickup: 'Shipping & Pickup Policy' };
const PATHS = { store_terms: 'terms', shipping_pickup: 'shipping-pickup' };
const MAX = 20000; const MIN_PUBLISH = 20;

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const hash = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
function clean(body) {
  return String(body == null ? '' : body).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}
function kindOrThrow(kind) { if (!KINDS[kind]) throw err(404, 'POLICY_KIND_UNKNOWN', 'Unknown policy.'); return kind; }
function ownerOnly(ctx) { if (!ctx || !ctx.sellerId || ctx.role !== 'owner') throw err(403, 'OWNER_ONLY', 'Only the company owner can change store policies.'); }

const view = (r) => (r ? { id: r.id, kind: r.kind, version: r.version, status: r.status, body: r.body, content_hash: r.content_hash,
  updated_at: r.updated_at, published_at: r.published_at, superseded_at: r.superseded_at } : null);

async function forOwner(ctx) {
  ownerOnly(ctx);
  const rows = (await db.query(`SELECT * FROM seller_policy_versions WHERE seller_id = $1 ORDER BY kind, version DESC`, [ctx.sellerId])).rows;
  const out = {};
  for (const k of Object.keys(KINDS)) {
    const mine = rows.filter((r) => r.kind === k);
    out[k] = { label: KINDS[k], draft: view(mine.find((r) => r.status === 'draft')), published: view(mine.find((r) => r.status === 'published')),
      history: mine.filter((r) => r.status !== 'draft').map((r) => ({ version: r.version, status: r.status, published_at: r.published_at, superseded_at: r.superseded_at,
        withdrawn_at: r.withdrawn_at || null, withdrawn_reason: r.withdrawn_reason || null })) };
  }
  return out;
}

async function saveDraft(ctx, kind, body) {
  ownerOnly(ctx); kindOrThrow(kind);
  const text = clean(body);
  if (text.length > MAX) throw err(422, 'POLICY_TOO_LONG', `Please keep this policy under ${MAX.toLocaleString()} characters.`);
  return withTransaction(async (client) => {
    await client.query('SELECT id FROM seller_profiles WHERE id = $1 FOR UPDATE', [ctx.sellerId]);   // one writer per company
    const draft = (await client.query(`SELECT * FROM seller_policy_versions WHERE seller_id = $1 AND kind = $2 AND status = 'draft'`, [ctx.sellerId, kind])).rows[0];
    let row;
    if (draft) {
      row = (await client.query(`UPDATE seller_policy_versions SET body = $2, content_hash = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [draft.id, text, hash(text)])).rows[0];
    } else {
      const next = Number((await client.query(`SELECT COALESCE(max(version), 0) + 1 AS v FROM seller_policy_versions WHERE seller_id = $1 AND kind = $2`, [ctx.sellerId, kind])).rows[0].v);
      row = (await client.query(
        `INSERT INTO seller_policy_versions (seller_id, kind, version, body, content_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.sellerId, kind, next, text, hash(text), ctx.userId])).rows[0];
    }
    return view(row);
  });
}

async function publish(ctx, kind) {
  ownerOnly(ctx); kindOrThrow(kind);
  const published = await withTransaction(async (client) => {
    await client.query('SELECT id FROM seller_profiles WHERE id = $1 FOR UPDATE', [ctx.sellerId]);
    const draft = (await client.query(`SELECT * FROM seller_policy_versions WHERE seller_id = $1 AND kind = $2 AND status = 'draft'`, [ctx.sellerId, kind])).rows[0];
    if (!draft) throw err(409, 'NO_DRAFT', 'There are no unpublished changes to publish.');
    if (draft.body.length < MIN_PUBLISH) throw err(422, 'POLICY_TOO_SHORT', 'Write your policy before publishing it.');
    const current = (await client.query(`SELECT id, content_hash FROM seller_policy_versions WHERE seller_id = $1 AND kind = $2 AND status = 'published'`, [ctx.sellerId, kind])).rows[0];
    if (current && current.content_hash === draft.content_hash) throw err(409, 'NO_CHANGES', 'This is the same as your published policy.');
    if (current) await client.query(`UPDATE seller_policy_versions SET status = 'superseded', superseded_at = now() WHERE id = $1`, [current.id]);
    const row = (await client.query(`UPDATE seller_policy_versions SET status = 'published', published_at = now(), published_by = $2 WHERE id = $1 RETURNING *`,
      [draft.id, ctx.userId])).rows[0];
    return view(row);
  });
  // Audit after the commit (a logging failure can never undo or block the publication).
  await writeAuditLog({ event_type: 'seller_policy_published', entity_type: 'seller_profile', entity_id: ctx.sellerId, actor_id: ctx.userId,
    metadata: { kind, version: published.version, content_hash: published.content_hash } }).catch(() => {});
  return published;
}

async function publishedFor(sellerId, runner = db) {
  const rows = (await runner.query(`SELECT * FROM seller_policy_versions WHERE seller_id = $1 AND status = 'published'`, [sellerId])).rows;
  const out = {};
  for (const k of Object.keys(KINDS)) {
    const r = rows.find((x) => x.kind === k);
    out[k] = r ? { label: KINDS[k], version: r.version, body: r.body, published_at: r.published_at, path: PATHS[k] } : null;
  }
  return out;
}

// What an order records at purchase: the seller's published versions (or null) and the current platform Buyer Terms
// version (read only — never modified here). `shown: false` = the seller's branding is hidden, so its policies could not be
// shown to the buyer: they are neither required nor recorded (only the platform Buyer Terms apply).
async function snapshotFor(sellerId, runner = db, { shown = true } = {}) {
  const rows = shown ? (await runner.query(`SELECT id, kind, version, content_hash, published_at FROM seller_policy_versions WHERE seller_id = $1 AND status = 'published'`, [sellerId])).rows : [];
  const pick = (k) => { const r = rows.find((x) => x.kind === k); return r ? { version_id: r.id, version: r.version, content_hash: r.content_hash, published_at: r.published_at } : null; };
  // Runs inside the checkout transaction, so it must never raise: check the table exists before reading it.
  let platform = null;
  const has = (await runner.query(`SELECT to_regclass('public.terms_versions') IS NOT NULL AS ok`)).rows[0];
  if (has && has.ok) {
    const t = (await runner.query(`SELECT id, version_int FROM terms_versions WHERE kind = 'buyer_terms' AND is_current = true LIMIT 1`)).rows[0];
    if (t) platform = { version_id: t.id, version: t.version_int };
  }
  return { store_terms: pick('store_terms'), shipping_pickup: pick('shipping_pickup'), platform_terms: platform, seller_policies_shown: !!shown };
}

// Advantage.Bid override (marketplace.moderate): withdraw a published policy from public view with a written reason. The
// text stays on record; the seller may publish a corrected version.
async function withdraw(versionId, adminId, { reason } = {}) {
  if (!adminId) throw err(403, 'ADMIN_REQUIRED', 'Only an administrator can withdraw a seller policy.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(versionId || ''))) throw err(404, 'POLICY_NOT_FOUND', 'Policy not found.');
  const note = String(reason || '').trim().slice(0, 1000);
  if (note.length < 5) throw err(422, 'REASON_REQUIRED', 'Give a short reason.');
  const row = (await db.query(`UPDATE seller_policy_versions SET status = 'withdrawn', withdrawn_by = $2, withdrawn_at = now(), withdrawn_reason = $3
    WHERE id = $1 AND status = 'published' RETURNING *`, [versionId, adminId, note])).rows[0];
  if (!row) throw err(409, 'NOT_PUBLISHED', 'Only a published policy can be withdrawn.');
  await writeAuditLog({ event_type: 'seller_policy_withdrawn', entity_type: 'seller_profile', entity_id: row.seller_id, actor_id: adminId,
    metadata: { kind: row.kind, version: row.version, reason: note } }).catch(() => {});
  return view(row);
}

// Administrators: every company's currently published policies (for review / withdrawal).
async function listPublishedForAdmin({ limit = 200 } = {}) {
  const { rows } = await db.query(
    `SELECT v.id, v.seller_id, v.kind, v.version, v.body, v.published_at, COALESCE(sp.display_name, sp.metadata->>'business_name') AS seller_name, sp.storefront_slug
       FROM seller_policy_versions v JOIN seller_profiles sp ON sp.id = v.seller_id WHERE v.status = 'published' ORDER BY v.published_at DESC LIMIT $1`,
    [Math.min(500, Math.max(1, parseInt(limit, 10) || 200))]);
  return rows;
}

module.exports = { KINDS, PATHS, forOwner, saveDraft, publish, publishedFor, snapshotFor, withdraw, listPublishedForAdmin, _hash: hash, _clean: clean };

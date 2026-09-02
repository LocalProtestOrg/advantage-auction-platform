'use strict';

/**
 * complianceService — DECISION-SUPPORT auction compliance screening (NOT an automated legal decision-maker).
 * Evaluates lot title/description/category against active compliance_rules and records FLAGS
 * ("POSSIBLE COMPLIANCE CONCERN — REVIEW SUGGESTED") for fast Admin review. Conservative by design:
 *   • keyword matches create a review FLAG, never a legal conclusion or an auto-block;
 *   • scanning is BEST-EFFORT and NON-BLOCKING — it must never fail/delay auction publication;
 *   • rescans are idempotent (UNIQUE(lot_id, rule_id)); review history is preserved; open flags whose match
 *     disappears are auto-cleared, reviewed flags are left untouched;
 *   • jurisdiction rules apply only where the auction's location matches; illustrative rules are nationwide
 *     "possible concern" and store the auction's state only as review CONTEXT (never a fabricated verdict).
 * Reuses the shared audit log + the existing lot/auction state model for moderation actions.
 */

const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');
const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');

const SEV_RANK = { high: 3, medium: 2, low: 1 };
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Compile a rule → a matcher over free text. Returns the first matched term, or null. Word-boundary based
// to limit obvious false positives; supports an explicit match_regex for advanced future rules.
function compileMatcher(rule) {
  const terms = Array.isArray(rule.match_terms) ? rule.match_terms.filter((t) => t && String(t).trim()) : [];
  let re = null;
  try {
    if (rule.match_regex) re = new RegExp(rule.match_regex, 'i');
    else if (terms.length) re = new RegExp('\\b(' + terms.map((t) => escapeRegex(String(t).trim())).join('|') + ')\\b', 'i');
  } catch (e) { re = null; }
  return (text) => { if (!re || !text) return null; const m = re.exec(text); return m ? (m[1] || m[0]) : null; };
}

async function loadActiveRules(runner = db) {
  const { rows } = await runner.query(
    `SELECT id, code, name, category, severity, jurisdiction, match_terms, match_regex, reason, review_behavior
       FROM compliance_rules WHERE active = TRUE`);
  return rows.map((r) => ({ ...r, _match: compileMatcher(r) }));
}

// Evaluate one lot against the compiled rules for a given auction jurisdiction (address_state, may be null).
function evaluateLot(lot, rules, auctionState) {
  const text = [lot.title, lot.description, lot.category].filter(Boolean).join('  ');
  const hits = [];
  for (const r of rules) {
    // Jurisdiction rules apply ONLY where the auction location matches; nationwide rules (null) always apply.
    if (r.jurisdiction && String(r.jurisdiction).toUpperCase() !== String(auctionState || '').toUpperCase()) continue;
    const term = r._match(text);
    if (term) hits.push({ rule: r, matchedTerm: term });
  }
  return hits;
}

// ── Scan an auction (best-effort, non-blocking) ─────────────────────────────────
async function scanAuction(auctionId) {
  try {
    const auction = (await db.query('SELECT id, address_state FROM auctions WHERE id = $1', [auctionId])).rows[0];
    if (!auction) return { ok: false, reason: 'not_found' };
    const rules = await loadActiveRules();
    const lots = (await db.query(
      `SELECT id, title, description, category FROM lots WHERE auction_id = $1 AND state <> 'withdrawn'`, [auctionId])).rows;
    let flagged = 0, created = 0;
    const bySeverity = { high: 0, medium: 0, low: 0 };
    for (const lot of lots) {
      const hits = evaluateLot(lot, rules, auction.address_state);
      const matchedRuleIds = hits.map((h) => h.rule.id);
      for (const h of hits) {
        const juris = h.rule.jurisdiction || auction.address_state || null;
        const ins = await db.query(
          `INSERT INTO compliance_flags
             (auction_id, lot_id, rule_id, rule_code, category, severity, jurisdiction, reason, matched_term, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open')
           ON CONFLICT (lot_id, rule_id) DO NOTHING RETURNING id`,
          [auctionId, lot.id, h.rule.id, h.rule.code, h.rule.category, h.rule.severity, juris, h.rule.reason, h.matchedTerm]);
        if (ins.rowCount) created += 1;
      }
      // Auto-clear OPEN flags that no longer match (preserve reviewed ones + full history).
      if (matchedRuleIds.length) {
        await db.query(
          `UPDATE compliance_flags SET status='auto_cleared', updated_at=now()
            WHERE lot_id=$1 AND status='open' AND rule_id <> ALL($2::uuid[])`, [lot.id, matchedRuleIds]);
      } else {
        await db.query(`UPDATE compliance_flags SET status='auto_cleared', updated_at=now() WHERE lot_id=$1 AND status='open'`, [lot.id]);
      }
      if (hits.length) { flagged += 1; hits.forEach((h) => { bySeverity[h.rule.severity] = (bySeverity[h.rule.severity] || 0) + 1; }); }
    }
    return { ok: true, scanned: lots.length, flagged, created, bySeverity };
  } catch (err) {
    console.error('[compliance] scanAuction failed for', auctionId, '-', err.message);
    return { ok: false, reason: 'error', error: err.message };
  }
}

// Fire-and-forget scan for the publication path — NEVER throws, NEVER blocks/delays publication.
function scanAuctionSafe(auctionId) { scanAuction(auctionId).catch((e) => console.error('[compliance] scan error:', e.message)); }

// ── Admin reads ─────────────────────────────────────────────────────────────────
// Recent Professional-seller auctions with a compliance summary (zero-flag ones INCLUDED — the owner wants
// to see everything recently published, and immediately spot what needs attention).
async function recentProfessionalAuctions({ filter = 'all', limit = 50 } = {}) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const { rows } = await db.query(
    `SELECT a.id, a.title, a.state, a.address_state, a.published_at, a.created_at,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS company,
            u.email AS seller_email,
            (SELECT count(*)::int FROM lots l WHERE l.auction_id=a.id AND l.state<>'withdrawn') AS lot_count,
            (SELECT count(*)::int FROM compliance_flags f WHERE f.auction_id=a.id AND f.status='open') AS open_flags,
            (SELECT count(*)::int FROM compliance_flags f WHERE f.auction_id=a.id) AS total_flags,
            (SELECT max(CASE f.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END)
               FROM compliance_flags f WHERE f.auction_id=a.id AND f.status='open') AS max_sev
       FROM auctions a
       JOIN seller_profiles sp ON sp.id = a.seller_id
       LEFT JOIN users u ON u.id = sp.user_id
      WHERE sp.seller_type = ANY($1) AND a.state IN ('published','active','closed')
      ORDER BY COALESCE(a.published_at, a.created_at) DESC
      LIMIT $2`, [PROFESSIONAL_SELLER_TYPES, cap]);
  const sevLabel = (n) => (n === 3 ? 'high' : n === 2 ? 'medium' : n === 1 ? 'low' : null);
  let list = rows.map((r) => ({
    id: r.id, title: r.title, state: r.state, auction_state: r.address_state || null,
    company: r.company || null, seller_email: r.seller_email || null,
    published_at: r.published_at, created_at: r.created_at,
    lot_count: r.lot_count, open_flags: r.open_flags, total_flags: r.total_flags,
    max_severity: sevLabel(r.max_sev),
    review_status: r.total_flags === 0 ? 'none' : (r.open_flags === 0 ? 'reviewed' : 'needs_review'),
  }));
  if (filter === 'needs_review') list = list.filter((a) => a.open_flags > 0);
  else if (filter === 'flagged') list = list.filter((a) => a.total_flags > 0);
  else if (filter === 'reviewed') list = list.filter((a) => a.total_flags > 0 && a.open_flags === 0);
  return list;
}

async function getAuctionFlags(auctionId) {
  const auction = (await db.query(
    `SELECT a.id, a.title, a.state, a.address_state,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS company,
            u.email AS seller_email
       FROM auctions a JOIN seller_profiles sp ON sp.id=a.seller_id LEFT JOIN users u ON u.id=sp.user_id
      WHERE a.id=$1`, [auctionId])).rows[0];
  if (!auction) return null;
  const { rows: flags } = await db.query(
    `SELECT f.id, f.lot_id, f.rule_code, f.category, f.severity, f.jurisdiction, f.reason, f.matched_term,
            f.status, f.action, f.detected_at, f.reviewed_at, f.admin_notes,
            l.title AS lot_title, l.lot_number, l.state AS lot_state
       FROM compliance_flags f JOIN lots l ON l.id=f.lot_id
      WHERE f.auction_id=$1
      ORDER BY CASE f.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, f.detected_at DESC`, [auctionId]);
  return {
    auction: { id: auction.id, title: auction.title, state: auction.state, auction_state: auction.address_state || null,
      company: auction.company || null, seller_email: auction.seller_email || null },
    flags,
  };
}

// ── Admin review + moderation (audited) ─────────────────────────────────────────
async function reviewFlag(adminId, flagId, { status, notes } = {}) {
  const allowed = ['reviewed_allowed', 'cleared', 'action_taken', 'open'];
  if (!allowed.includes(status)) { const e = new Error('Invalid review status.'); e.status = 400; throw e; }
  const { rows } = await db.query(
    `UPDATE compliance_flags SET status=$2, admin_notes=COALESCE($3, admin_notes),
            reviewed_by=$4, reviewed_at=now(), updated_at=now() WHERE id=$1
      RETURNING id, auction_id, lot_id, rule_code, status`, [flagId, status, notes || null, adminId]);
  if (!rows[0]) { const e = new Error('Flag not found.'); e.status = 404; throw e; }
  await writeAuditLog({ event_type: 'compliance.flag_reviewed', entity_type: 'compliance_flag', entity_id: flagId,
    actor_id: adminId, metadata: { status, rule_code: rows[0].rule_code, auction_id: rows[0].auction_id, lot_id: rows[0].lot_id } });
  return rows[0];
}

// Moderation reuses the EXISTING lot/auction state model (lots.state='withdrawn' removes a single lot;
// auctions.state='draft' unpublishes the whole auction). Both audited. Admin-authorized at the route.
async function withdrawLot(adminId, lotId, { flagId, notes } = {}) {
  const { rows } = await db.query(`UPDATE lots SET state='withdrawn' WHERE id=$1 RETURNING id, auction_id`, [lotId]);
  if (!rows[0]) { const e = new Error('Lot not found.'); e.status = 404; throw e; }
  await writeAuditLog({ event_type: 'compliance.lot_withdrawn', entity_type: 'lot', entity_id: lotId,
    actor_id: adminId, auction_id: rows[0].auction_id, lot_id: lotId, metadata: { via: 'compliance_review', notes: notes || null } });
  if (flagId) await db.query(
    `UPDATE compliance_flags SET status='action_taken', action='lot_withdrawn', admin_notes=COALESCE($2,admin_notes),
            reviewed_by=$3, reviewed_at=now(), updated_at=now() WHERE id=$1`, [flagId, notes || null, adminId]);
  return rows[0];
}

async function unpublishAuction(adminId, auctionId, { notes } = {}) {
  const { rows } = await db.query(`UPDATE auctions SET state='draft', updated_at=now() WHERE id=$1 AND state IN ('published','active') RETURNING id, state`, [auctionId]);
  if (!rows[0]) { const e = new Error('Auction not found or not in a published state.'); e.status = 409; throw e; }
  await writeAuditLog({ event_type: 'compliance.auction_unpublished', entity_type: 'auction', entity_id: auctionId,
    actor_id: adminId, auction_id: auctionId, metadata: { via: 'compliance_review', notes: notes || null } });
  return rows[0];
}

module.exports = {
  escapeRegex, compileMatcher, loadActiveRules, evaluateLot,
  scanAuction, scanAuctionSafe,
  recentProfessionalAuctions, getAuctionFlags,
  reviewFlag, withdrawLot, unpublishAuction,
};

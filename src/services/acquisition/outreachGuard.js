'use strict';

/**
 * outreachGuard — the shared "may a person contact this company right now?" check for 1:1 rep email.
 *
 * Every programme shares one answer (handoff section 7):
 *   - suppression across the global, Claimed Listing and Event Partner lists (a STOP anywhere stops all);
 *   - no manual email while the company is in an ACTIVE automated Claimed Listing sequence;
 *   - the company contact lock: the sending rep must hold it. A free lock is taken for the rep as part of
 *     the send; a lock held by another person or by an automated sequence refuses the send.
 * Fail closed: any lookup error refuses (the rep can retry; an unwanted email cannot be unsent).
 */

const db = require('../../db');
const suppression = require('../claimedListings/suppressionService');
const identity = require('./companyIdentityService');
const locks = require('./contactLockService');

function refuse(code, message) { const e = new Error(message); e.status = 409; e.code = code; e.expose = true; return e; }

async function checkProspectContact({ prospect, repUserId }, runner = db) {
  const s = await suppression.check({ email: prospect.business_email }, runner);
  if (s.suppressed) {
    throw s.error ? refuse('SUPPRESSION_CHECK_FAILED', 'Could not confirm this address may be contacted. Try again shortly.')
      : refuse('SUPPRESSED', 'This address has opted out of Advantage.Bid business outreach (' + (s.source || 'suppressed') + ').');
  }
  let cluster = null;
  try {
    const snap = await identity.snapshot(runner);
    cluster = snap.clusterFor('sales_prospect', String(prospect.id));
  } catch (e) { throw refuse('COMPANY_CHECK_FAILED', 'Could not confirm who else is working this company. Try again shortly.'); }

  if (cluster && cluster.journey === 'CLAIMED_LISTING') {
    const orgIds = cluster.members.filter((m) => m.entity_type === 'organization').map((m) => m.entity_id);
    const live = orgIds.length ? (await runner.query(
      `SELECT 1 FROM listing_outreach_sequences WHERE organization_id = ANY($1::uuid[]) AND state IN ('queued','active') LIMIT 1`, [orgIds])
      .catch(() => ({ rows: [{ unknown: true }] }))).rows[0] : null;
    if (live) throw refuse('LISTING_SEQUENCE_ACTIVE', 'This company is in an active Claimed Listing sequence. Take the company lock (which pauses it) before emailing.');
  }

  const multi = cluster && cluster.members.length > 1;
  let companyId = cluster ? cluster.companyId : null;
  if (!companyId && multi) companyId = await identity.ensureCompany('sales_prospect', String(prospect.id), { actorId: repUserId, runner }).catch(() => null);
  if (companyId) {
    const c = await locks.check(companyId, { type: 'user', userId: repUserId }, runner);
    if (!c.ok) {
      throw refuse(c.code || 'CONTACT_LOCKED', c.code === 'LOCK_CHECK_FAILED' ? 'Could not check the company contact lock. Try again shortly.'
        : ((c.holder && c.holder.name) || (c.holder && c.holder.type === 'system' ? 'An automated sequence' : 'Another team member')) + ' is working this company.');
    }
    if (!c.lock) await locks.acquire(companyId, { userId: repUserId, reason: '1:1 email' }).catch(() => {});
    else await locks.touch(companyId, repUserId, runner).catch(() => {});
  }
  return { ok: true, companyId };
}

module.exports = { checkProspectContact };

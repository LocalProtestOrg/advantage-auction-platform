'use strict';

/**
 * R-1 Seller Activation (migration 187). Finds sellers who stalled on a step THEY own and lets Sasha check in, at
 * most twice per stage and three times per seller, from the shared inbox, so replies land in the normal inbox.
 *
 * Nothing here is a second source of truth. Each pass computes, from platform facts:
 *   stage       onboarding_incomplete | ready_no_auction | draft_started | submitted_waiting | activated
 *   blocker     what is stopping progress (agreement_unsigned, verification_documents_needed, ...)
 *   next_owner  seller | advantage | relationship_owner   (Sasha only ever nudges when it is 'seller')
 *   last_progress_at, time stalled, and a decision with the guard that produced it.
 *
 * Mode: platform_config seller_activation.mode. Anything other than exactly 'live' is SHADOW: decisions are
 * recorded in seller_activation_touches and nothing is sent. Every guard fails closed: a lookup that errors blocks
 * the contact. Immediately before a live send the seller is re-evaluated from fresh facts.
 *
 * Auction Partners: any seller linked to a founding_partners record (directly, through its organization or company,
 * or by matching the prospect's business email or corporate domain) belongs to the relationship owner (Ty) until Ty
 * releases it to Sasha (founding_partners.sasha_assist_released_at). This does not depend on contact-lock expiry.
 */

const db = require('../db');
const { normalizeEmail } = require('../lib/emailNormalize');

const ADDENDUM_TEMPLATE_ID = 'a9000000-0000-4000-8000-0000000000a1';
const MIN_LOTS = 30;   // auctionService.MIN_LOTS_FOR_SUBMISSION (kept literal: this module must not load auctionService)
const PROFESSIONAL_TYPES = ['auction_house', 'estate_sale_company', 'professional_liquidator'];
const BASE_URL = () => (process.env.PUBLIC_APP_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const HOUR = 3600 * 1000; const DAY = 24 * HOUR;

const DEFAULTS = { enabled: false, mode: 'shadow', first_touch_hours: 72, second_touch_days: 7, max_per_stage: 2, max_per_seller: 3,
  daily_cap: 6, recent_human_days: 14 };

// ── exclusions ─────────────────────────────────────────────────────────────────────────────────────────
const INTERNAL_DOMAIN = /@(?:[a-z0-9-]+\.)*(advantage\.bid|advantageauction\.bid)$/i;
const TEST_EMAIL = /(example\.(com|org|net)$|@example\.|test|validation|\bqa\b|seed|demo|\+e2e|@mailinator\.|@invalid$|simulator\.amazonses\.com$|^oat-)/i;
const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'me.com', 'msn.com', 'live.com',
  'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net', 'bellsouth.net', 'protonmail.com', 'proton.me', 'ymail.com', 'mail.com',
  'gmx.com', 'charter.net', 'cox.net', 'earthlink.net', 'frontier.com', 'windstream.net', 'rocketmail.com', 'live.net']);

function exclusion(f) {
  if (f.user_is_demo || f.sp_is_demo) return 'DEMO_ACCOUNT';
  if (f.role === 'admin' || f.staff_role || f.marketing_internal || INTERNAL_DOMAIN.test(f.email || '')) return 'INTERNAL_ACCOUNT';
  if (TEST_EMAIL.test(f.email || '')) return 'TEST_ACCOUNT';
  if (f.user_active === false) return 'INACTIVE_ACCOUNT';
  return null;
}

// ── stage (pure) ───────────────────────────────────────────────────────────────────────────────────────
const t = (v) => (v ? new Date(v).getTime() : 0);

/**
 * Compute the activation stage from facts. Order matters: published ends outreach; anything waiting on Advantage
 * is staff attention; then the earliest seller-owned step.
 */
function computeStage(f) {
  const lastProgressMs = Math.max(t(f.created_at), t(f.agreement_signed_at), t(f.verification_updated_at), t(f.last_auction_at), t(f.last_lot_at));
  const out = (stage, blocker, nextOwner, category) => ({ stage, blocker, next_owner: nextOwner, message_category: category || null,
    last_progress_at: lastProgressMs ? new Date(lastProgressMs).toISOString() : null });

  if (Number(f.published_auctions) > 0) return out('activated', null, null);
  if (Number(f.submitted_auctions) > 0) return out('submitted_waiting', 'auction_awaiting_review', 'advantage');

  const agreementOk = !!f.agreement_waived_at || !!f.agreement_signed_at || Number(f.submitted_ever) > 0;
  if (!agreementOk) return out('onboarding_incomplete', 'agreement_unsigned', 'seller', 'onboarding_incomplete');

  const verificationRequired = PROFESSIONAL_TYPES.includes(f.seller_type) || !!f.verification_flag;
  if (verificationRequired && !f.verification_approved) {
    if (f.verification_status === 'submitted') return out('onboarding_incomplete', 'verification_review_pending', 'advantage');
    return out('onboarding_incomplete', f.verification_status === 'more_info' ? 'verification_more_info_requested' : 'verification_documents_needed',
      'seller', 'onboarding_incomplete');
  }

  if (Number(f.rejected_auctions) > 0 && f.draft_state === 'rejected') return out('draft_started', 'auction_returned_for_changes', 'seller', 'draft_stalled');
  if (Number(f.draft_auctions) > 0 || f.draft_id) return out('draft_started', 'draft_incomplete', 'seller', 'draft_stalled');
  return out('ready_no_auction', 'no_auction_created', 'seller', 'ready_no_auction');
}

// ── send window (pure) ─────────────────────────────────────────────────────────────────────────────────
// States that lie entirely in one time zone. A multi-zone state (TX, FL, MI, ...) is NOT reliable: fallback.
const STATE_TZ = {};
for (const s of 'CT DE DC GA ME MD MA NH NJ NY NC OH PA RI SC VT VA WV'.split(' ')) STATE_TZ[s] = 'America/New_York';
for (const s of 'AL AR IL IA LA MN MS MO OK WI'.split(' ')) STATE_TZ[s] = 'America/Chicago';
for (const s of 'CO MT NM UT WY'.split(' ')) STATE_TZ[s] = 'America/Denver';
STATE_TZ.AZ = 'America/Phoenix'; STATE_TZ.CA = 'America/Los_Angeles'; STATE_TZ.WA = 'America/Los_Angeles'; STATE_TZ.HI = 'Pacific/Honolulu';
const SELLER_WINDOW = { start: 10, end: 16 };                                   // 10:00-16:00 local, Mon-Fri
const FALLBACK = { tz: 'America/New_York', start: 11, end: 16 };                 // 11-4 ET = 10-3 CT = 9-2 MT = 8-1 PT

function validTz(tz) { try { if (!tz) return false; new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; } }

function timezoneFor(f) {
  if (f.draft_timezone && validTz(f.draft_timezone)) return { tz: f.draft_timezone, source: 'auction_timezone', ...SELLER_WINDOW };
  const st = String(f.default_pickup_state || '').trim().toUpperCase();
  if (STATE_TZ[st]) return { tz: STATE_TZ[st], source: 'pickup_state', ...SELLER_WINDOW };
  return { ...FALLBACK, source: 'fallback_eastern' };
}

function localParts(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, hour: Number(p.hour) };
}
function inWindow(date, w) { const p = localParts(date, w.tz); return !['Sat', 'Sun'].includes(p.weekday) && p.hour >= w.start && p.hour < w.end; }
function nextWindowStart(from, w) {
  if (inWindow(from, w)) return from;
  const d = new Date(Math.ceil(from.getTime() / (15 * 60 * 1000)) * 15 * 60 * 1000);
  for (let i = 0; i < 4 * 24 * 9; i++, d.setTime(d.getTime() + 15 * 60 * 1000)) if (inWindow(d, w)) return new Date(d.getTime());
  return null;
}

// ── decision (pure) ────────────────────────────────────────────────────────────────────────────────────
/**
 * Decide what to do with one seller now. `h` is the history/guard fact bundle; `cfg` the switches.
 * Returns { decision, guard, reason, needs_staff_attention, attempt, stage_attempt, due_at, send_at, window }.
 * decision: excluded | complete | staff_attention | suppressed | waiting | would_contact
 */
function decide(f, s, h, cfg, now = new Date()) {
  const r = (decision, guard, reason, extra = {}) => ({ decision, guard: guard || null, reason, needs_staff_attention: false, ...extra });
  const ex = exclusion(f);
  if (ex) return r('excluded', ex, 'Not a real seller account for outreach (' + ex.toLowerCase().replace(/_/g, ' ') + ').');
  if (h.lookup_error) return r('suppressed', 'LOOKUP_FAILED', 'A safety lookup failed, so no contact (fail closed): ' + h.lookup_error);
  if (s.stage === 'activated') return r('complete', 'ACTIVATED', 'First auction published. Activation outreach has ended.');

  if (h.auction_partner && !h.auction_partner.released) {
    return r('staff_attention', 'AUCTION_PARTNER_RELATIONSHIP_OWNER', 'Auction Partner (' + h.auction_partner.name + '). The relationship owner handles this seller; Sasha does not contact it until released.',
      { needs_staff_attention: true });
  }
  if (s.next_owner === 'advantage') {
    return r('staff_attention', 'ADVANTAGE_OWNS_NEXT_ACTION', s.blocker === 'verification_review_pending'
      ? 'Business verification documents are waiting on Advantage.Bid review.' : 'An auction is submitted and waiting on Advantage.Bid review.',
    { needs_staff_attention: true });
  }
  if (s.next_owner !== 'seller' || !s.message_category) return r('suppressed', 'NO_SELLER_OWNED_STEP', 'No seller-owned step to help with.');
  // A real seller whose account email cannot receive mail: a person must fix the address (or call); never guess one.
  if (!normalizeEmail(f.email)) return r('staff_attention', 'INVALID_ACCOUNT_EMAIL', 'The account email on file is not a valid address, so Sasha cannot write. A person should correct it or call the seller.',
    { needs_staff_attention: true });

  if (h.opted_out) return r('suppressed', 'ACTIVATION_OPT_OUT', 'Seller opted out of activation check-ins.');
  if (h.suppressed) return r('suppressed', 'SUPPRESSION_LIST', 'Address or company is on a suppression list (' + h.suppressed + ').');
  if (h.bounced) return r('suppressed', 'KNOWN_BOUNCE', 'Address has a recorded hard bounce, complaint or invalid result.');
  if (h.send_failed) return r('staff_attention', 'PREVIOUS_SEND_FAILED', 'An earlier check-in failed to send; a person should review before any retry.', { needs_staff_attention: true });
  if (h.replied) return r('suppressed', 'SELLER_REPLIED', 'Seller replied to a check-in. The conversation continues in the Shared Inbox; no more automated check-ins.');
  if (h.takeover) return r('suppressed', 'HUMAN_TAKEOVER', 'Staff took over or flagged the check-in conversation.');
  if (h.open_conversation) return r('suppressed', 'OPEN_CONVERSATION', 'Seller has an open, recent or staff-owned support conversation (' + h.open_conversation + ').');
  if (h.recent_human) return r('suppressed', 'RECENT_HUMAN_CONTACT', 'Recent human communication (' + h.recent_human + ').');
  if (h.staff_owner) return r('suppressed', 'STAFF_RELATIONSHIP_OWNER', 'A staff member owns this relationship (' + h.staff_owner + ').');
  if (h.other_programme) return r('suppressed', 'OTHER_PROGRAMME_CONTACT', 'Another outreach programme currently holds this company (' + h.other_programme + ').');

  const total = h.touches_total || 0;
  const inStage = (h.touches_by_stage || {})[s.stage] || 0;
  const attempt = total + 1; const stageAttempt = inStage + 1;
  if (total >= cfg.max_per_seller) return r('suppressed', 'SELLER_CAP', 'Reached ' + cfg.max_per_seller + ' check-ins for this seller.');
  if (inStage >= cfg.max_per_stage) return r('suppressed', 'STAGE_CAP', 'Reached ' + cfg.max_per_stage + ' check-ins for this stage.');

  const progressMs = t(s.last_progress_at);
  let due = progressMs + cfg.first_touch_hours * HOUR; let guard = 'NOT_DUE';
  const lastStageTouch = h.last_stage_touch_at || (h.last_touch_by_stage || {})[s.stage];
  if (inStage > 0 && t(lastStageTouch) + cfg.second_touch_days * DAY > due) { due = t(lastStageTouch) + cfg.second_touch_days * DAY; guard = 'COOLDOWN'; }
  if (h.last_touch_at && t(h.last_touch_at) + cfg.first_touch_hours * HOUR > due) { due = t(h.last_touch_at) + cfg.first_touch_hours * HOUR; guard = 'COOLDOWN'; }
  const dueAt = new Date(due).toISOString();
  const base = { attempt, stage_attempt: stageAttempt, due_at: dueAt };
  if (now.getTime() < due) {
    return r('waiting', guard, guard === 'NOT_DUE' ? 'Seller progress is recent; the first check-in waits ' + cfg.first_touch_hours + ' hours.'
      : 'Waiting for the follow-up interval after the last check-in.', base);
  }
  const w = timezoneFor(f);
  const sendAt = nextWindowStart(now, w);
  const window = { tz: w.tz, source: w.source, hours: w.start + ':00-' + w.end + ':00 Mon-Fri' };
  if (!sendAt) return r('suppressed', 'OUTSIDE_SEND_WINDOW', 'No send window found.', { ...base, window });
  if (cfg.mode === 'live' && h.sent_today >= cfg.daily_cap) {
    return r('waiting', 'DAILY_CAP', 'Daily check-in cap (' + cfg.daily_cap + ') reached.', { ...base, window });
  }
  if (cfg.mode === 'live' && sendAt.getTime() > now.getTime()) {
    return r('waiting', 'OUTSIDE_SEND_WINDOW', 'Outside weekday business hours for the seller.', { ...base, window, send_at: sendAt.toISOString() });
  }
  return r('would_contact', null, 'Stalled ' + Math.floor((now.getTime() - progressMs) / HOUR) + 'h on a seller-owned step (' + s.blocker + ').',
    { ...base, window, send_at: sendAt.toISOString() });
}

// ── message (pure, deterministic, Sasha's voice) ───────────────────────────────────────────────────────
const clean = (v, n = 80) => String(v || '').replace(/[\r\n\t]+/g, ' ').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim().slice(0, n);
function firstName(full) {
  const w = clean(full, 60).split(' ')[0] || '';
  return /^[A-Za-z][A-Za-z'.-]{1,30}$/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : '';
}

/** Compose a check-in from verified facts only. Returns { subject, text } or null if there is nothing to say. */
function composeMessage(f, s, d) {
  const hi = firstName(f.full_name) ? 'Hi ' + firstName(f.full_name) + ',' : 'Hi there,';
  const follow = d.stage_attempt > 1 ? 'I wanted to follow up on my note from last week. ' : '';
  const url = BASE_URL();
  const close = 'If something got in the way or you have a question, just reply to this email and I will help, or get you to the right person on our team.\n\n'
    + 'If you would rather I not check in again, reply and let me know.';
  let subject; let body;
  if (s.message_category === 'onboarding_incomplete' && s.blocker === 'agreement_unsigned') {
    subject = 'Finishing your Advantage.Bid seller setup';
    body = follow + 'This is Sasha from Advantage.Bid. Your seller account is set up, and the one step left before you can start your first auction is signing your Seller Agreement.\n\n'
      + 'You can review and sign it here: ' + url + '/my-agreements.html';
  } else if (s.message_category === 'onboarding_incomplete') {
    subject = 'Finishing your Advantage.Bid business verification';
    body = follow + 'This is Sasha from Advantage.Bid. Your seller account is set up, and the step left before your first auction can go live is business verification'
      + (s.blocker === 'verification_more_info_requested' ? '. Our team asked for a little more information.' : '.') + '\n\n'
      + 'You can finish it from your seller dashboard: ' + url + '/seller-dashboard.html';
  } else if (s.message_category === 'ready_no_auction') {
    subject = 'Starting your first auction on Advantage.Bid';
    body = follow + 'This is Sasha from Advantage.Bid. Your seller account is ready, and you have not started an auction yet. When you are ready, you can start one here: '
      + url + '/seller-create.html\n\n'
      + 'You can save a draft and come back to it at any time. Clear photos of each item help, and an auction needs at least ' + MIN_LOTS + ' lots before it can be submitted.';
  } else if (s.message_category === 'draft_stalled') {
    const title = clean(f.draft_title, 80);
    const lots = Number(f.draft_lots) || 0;
    subject = 'Your draft auction on Advantage.Bid';
    if (s.blocker === 'auction_returned_for_changes') {
      body = follow + 'This is Sasha from Advantage.Bid. Your auction' + (title ? ' "' + title + '"' : '') + ' came back from our review with a few changes requested. Once those are made, you can submit it again.\n\n'
        + 'You can see the details from your seller dashboard: ' + url + '/seller-dashboard.html';
    } else {
      body = follow + 'This is Sasha from Advantage.Bid. I saw you started a draft auction' + (title ? ', "' + title + '",' : '') + ' and it has ' + lots + (lots === 1 ? ' lot' : ' lots') + ' so far.'
        + (lots < MIN_LOTS ? ' An auction needs at least ' + MIN_LOTS + ' lots before it can be submitted, so you have ' + (MIN_LOTS - lots) + ' to go.' : ' That is enough lots to submit it for review.')
        + '\n\nYou can pick up where you left off from your seller dashboard: ' + url + '/seller-dashboard.html';
    }
  } else return null;
  const text = (hi + '\n\n' + body + '\n\n' + close).replace(/[—–]/g, '-');
  return { subject, text };
}

// ── config ─────────────────────────────────────────────────────────────────────────────────────────────
async function config(runner = db) {
  try {
    const rows = (await runner.query(`SELECT key, value FROM platform_config WHERE key LIKE 'seller_activation.%'`)).rows;
    const c = { ...DEFAULTS };
    for (const { key, value } of rows) {
      const k = key.slice('seller_activation.'.length);
      if (k === 'enabled') c.enabled = value === true || value === 'true';
      else if (k === 'mode') c.mode = value === 'live' ? 'live' : 'shadow';     // anything else is shadow
      else if (k in DEFAULTS && Number.isFinite(Number(value)) && Number(value) >= 0) c[k] = Number(value);
    }
    return c;
  } catch (e) { return { ...DEFAULTS, enabled: false, mode: 'shadow', error: e.message }; }   // fail closed
}

// ── facts (read-only) ──────────────────────────────────────────────────────────────────────────────────
async function loadFacts(runner = db, { sellerProfileIds = null } = {}) {
  const base = (await runner.query(
    `SELECT sp.id AS seller_profile_id, sp.user_id, sp.seller_type, sp.display_name, sp.created_at, sp.is_demo AS sp_is_demo,
            sp.agreement_waived_at, sp.verification_required_before_publication AS verification_flag, sp.default_pickup_state, sp.organization_id,
            u.email, u.full_name, u.role, u.staff_role, u.is_demo AS user_is_demo, COALESCE(u.is_active, true) AS user_active,
            EXISTS (SELECT 1 FROM marketing_contacts mc WHERE mc.is_internal = true AND mc.normalized_email = lower(u.email)) AS marketing_internal,
            sig.signed_at AS agreement_signed_at,
            vr.status AS verification_status, vr.updated_at AS verification_updated_at,
            EXISTS (SELECT 1 FROM verification_requests x WHERE x.seller_profile_id = sp.id AND x.status = 'approved') AS verification_approved,
            au.published_auctions, au.submitted_auctions, au.draft_auctions, au.rejected_auctions, au.total_auctions, au.submitted_ever, au.last_auction_at,
            au.first_published_at, lt.last_lot_at,
            dr.id AS draft_id, dr.title AS draft_title, dr.timezone AS draft_timezone, dr.state AS draft_state, dr.lots AS draft_lots
       FROM seller_profiles sp JOIN users u ON u.id = sp.user_id
       LEFT JOIN LATERAL (SELECT max(a.signed_at) AS signed_at FROM agreements a JOIN agreement_template_versions v ON v.id = a.template_version_id
                           WHERE a.seller_profile_id = sp.id AND a.status IN ('signed','countersigned') AND v.template_id <> $1) sig ON true
       LEFT JOIN LATERAL (SELECT status, updated_at FROM verification_requests WHERE seller_profile_id = sp.id AND status <> 'cancelled'
                           ORDER BY created_at DESC LIMIT 1) vr ON true
       LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE x.published_at IS NOT NULL OR x.state IN ('published','active','closed'))::int AS published_auctions,
                                 count(*) FILTER (WHERE x.state IN ('submitted','under_review'))::int AS submitted_auctions,
                                 count(*) FILTER (WHERE x.state = 'draft' AND NOT COALESCE(x.is_archived, false))::int AS draft_auctions,
                                 count(*) FILTER (WHERE x.state = 'rejected' AND NOT COALESCE(x.is_archived, false))::int AS rejected_auctions,
                                 count(*)::int AS total_auctions,
                                 count(*) FILTER (WHERE x.submitted_at IS NOT NULL OR x.state <> 'draft')::int AS submitted_ever,
                                 max(GREATEST(x.created_at, x.updated_at, x.submitted_at)) AS last_auction_at,
                                 min(x.published_at) AS first_published_at
                            FROM auctions x WHERE x.seller_id = sp.id AND NOT COALESCE(x.is_demo, false)) au ON true
       LEFT JOIN LATERAL (SELECT max(GREATEST(l.created_at, l.updated_at)) AS last_lot_at FROM lots l JOIN auctions x ON x.id = l.auction_id
                           WHERE x.seller_id = sp.id AND NOT COALESCE(x.is_demo, false)) lt ON true
       LEFT JOIN LATERAL (SELECT x.id, x.title, x.timezone, x.state,
                                 (SELECT count(*)::int FROM lots l WHERE l.auction_id = x.id AND l.state <> 'withdrawn') AS lots
                            FROM auctions x WHERE x.seller_id = sp.id AND x.state IN ('draft','rejected') AND NOT COALESCE(x.is_archived, false)
                             AND NOT COALESCE(x.is_demo, false)
                           ORDER BY x.updated_at DESC NULLS LAST LIMIT 1) dr ON true
      WHERE ($2::uuid[] IS NULL OR sp.id = ANY($2::uuid[]))
      ORDER BY sp.created_at`, [ADDENDUM_TEMPLATE_ID, sellerProfileIds])).rows;
  return base;
}

/** History + guard facts for a set of sellers. Any failed lookup marks every seller lookup_error (fail closed). */
async function loadHistory(facts, cfg, runner = db, now = new Date()) {
  const out = new Map(facts.map((f) => [f.seller_profile_id, { touches_total: 0, touches_by_stage: {}, sent_today: 0 }]));
  if (!facts.length) return out;
  const spIds = facts.map((f) => f.seller_profile_id);
  const userIds = facts.map((f) => f.user_id).filter(Boolean);
  const emails = [...new Set(facts.map((f) => normalizeEmail(f.email)).filter(Boolean))];
  const orgIds = facts.map((f) => f.organization_id).filter(Boolean);
  const recentMs = now.getTime() - cfg.recent_human_days * DAY;
  try {
    // Touch ledger: live sends only count toward caps.
    const touches = (await runner.query(
      `SELECT seller_profile_id, stage, decision, conversation_id, created_at FROM seller_activation_touches
        WHERE seller_profile_id = ANY($1::uuid[]) AND mode = 'live' AND decision IN ('contacted','send_failed') ORDER BY created_at`, [spIds])).rows;
    const sentToday = Number((await runner.query(
      `SELECT count(*)::int n FROM seller_activation_touches WHERE mode = 'live' AND decision = 'contacted' AND created_at > now() - interval '24 hours'`)).rows[0].n);
    const state = (await runner.query(`SELECT seller_profile_id, opted_out_at FROM seller_activation_state WHERE seller_profile_id = ANY($1::uuid[])`, [spIds])).rows;
    const convs = (await runner.query(
      `SELECT c.id, c.ref, c.status, c.owner, c.handoff_state, c.customer_email, c.user_id, c.contact_match_user_id, c.last_message_at,
              (SELECT max(m.created_at) FROM cs_messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound' AND m.author_type = 'customer') AS last_inbound_at,
              (SELECT max(m.created_at) FROM cs_messages m WHERE m.conversation_id = c.id AND m.author_type = 'staff' AND m.direction = 'outbound') AS last_staff_at
         FROM cs_conversations c
        WHERE c.customer_email = ANY($1::text[]) OR c.user_id = ANY($2::uuid[]) OR c.contact_match_user_id = ANY($2::uuid[])`, [emails, userIds])).rows;
    const outreach = (await runner.query(
      `SELECT lower(recipient_email) AS e, max(created_at) AS at FROM sales_outreach_emails WHERE lower(recipient_email) = ANY($1::text[]) GROUP BY 1`, [emails])).rows;
    const prospects = (await runner.query(
      `SELECT p.id, p.assigned_rep_user_id, p.converted_seller_profile_id, lower(p.business_email) AS e,
              (SELECT max(n.created_at) FROM sales_prospect_notes n WHERE n.prospect_id = p.id) AS last_note_at
         FROM sales_prospects p WHERE p.converted_seller_profile_id = ANY($1::uuid[]) OR lower(p.business_email) = ANY($2::text[])`, [spIds, emails])).rows;
    const links = (await runner.query(
      `SELECT entity_type, entity_id, company_id FROM company_identity_links
        WHERE (entity_type = 'seller_profile' AND entity_id = ANY($1::text[])) OR (entity_type = 'organization' AND entity_id = ANY($2::text[]))
           OR (entity_type = 'sales_prospect' AND entity_id = ANY($3::text[]))`, [spIds.map(String), orgIds.map(String), prospects.map((p) => String(p.id))])).rows;
    const domains = [...new Set(emails.map((e) => e.split('@')[1]).filter((d) => d && !FREE_MAIL.has(d)))];
    const domainCos = domains.length ? (await runner.query(
      `SELECT id, lower(corporate_email_domain) AS d FROM company_identities WHERE lower(corporate_email_domain) = ANY($1::text[])`, [domains])).rows : [];
    const companyIds = [...new Set([...links.map((l) => l.company_id), ...domainCos.map((c) => c.id)])];
    const fps = (await runner.query(
      `SELECT id, company_id, seller_profile_id, organization_id, status, display_name, relationship_owner_user_id, sasha_assist_released_at
         FROM founding_partners WHERE seller_profile_id = ANY($1::uuid[]) OR company_id = ANY($2::uuid[]) OR organization_id = ANY($3::uuid[])`,
    [spIds, companyIds, orgIds])).rows;
    const locks = companyIds.length ? (await runner.query(
      `SELECT company_id, holder_type, holder_user_id, reason, expires_at FROM company_contact_locks WHERE company_id = ANY($1::uuid[]) AND expires_at > now()`,
      [companyIds])).rows : [];
    const deliv = (await runner.query(
      `SELECT normalized_email, hard_bounced, complaint, invalid FROM email_deliverability WHERE normalized_email = ANY($1::text[])`, [emails])).rows;
    const suppress = require('./claimedListings/suppressionService');

    for (const f of facts) {
      const h = out.get(f.seller_profile_id);
      const email = normalizeEmail(f.email);
      h.sent_today = sentToday;
      const mine = touches.filter((x) => x.seller_profile_id === f.seller_profile_id);
      const sent = mine.filter((x) => x.decision === 'contacted');
      h.touches_total = sent.length;
      h.last_touch_by_stage = {};
      for (const x of sent) { h.touches_by_stage[x.stage] = (h.touches_by_stage[x.stage] || 0) + 1; h.last_touch_by_stage[x.stage] = x.created_at; }
      h.last_touch_at = sent.length ? sent[sent.length - 1].created_at : null;
      h.send_failed = mine.some((x) => x.decision === 'send_failed');
      h.first_touch_at = sent.length ? sent[0].created_at : null;
      const st = state.find((x) => x.seller_profile_id === f.seller_profile_id);
      h.opted_out = !!(st && st.opted_out_at);

      const activationConvIds = new Set(mine.map((x) => x.conversation_id).filter(Boolean));
      const myConvs = convs.filter((c) => (email && c.customer_email === email) || (f.user_id && (c.user_id === f.user_id || c.contact_match_user_id === f.user_id)));
      const actConvs = myConvs.filter((c) => activationConvIds.has(c.id));
      const otherConvs = myConvs.filter((c) => !activationConvIds.has(c.id));
      h.activation_conversations = actConvs.map((c) => ({ id: c.id, ref: c.ref, status: c.status, owner: c.owner, handoff_state: c.handoff_state }));
      h.replied = actConvs.some((c) => c.last_inbound_at)
        || (h.first_touch_at && myConvs.some((c) => t(c.last_inbound_at) > t(h.first_touch_at)));
      h.takeover = actConvs.some((c) => c.owner === 'staff' || ['needed', 'taken'].includes(c.handoff_state));
      const openConv = otherConvs.find((c) => c.owner === 'staff' && !['resolved', 'closed', 'ignored'].includes(c.status))
        || otherConvs.find((c) => c.status === 'open' || c.handoff_state === 'needed')
        || otherConvs.find((c) => c.status === 'waiting_customer' && t(c.last_message_at) > recentMs);
      h.open_conversation = openConv ? 'Ref ' + openConv.ref + ', ' + openConv.status + (openConv.owner === 'staff' ? ', staff-owned' : '') : null;
      h.sasha_history = myConvs.map((c) => ({ ref: c.ref, status: c.status, owner: c.owner, last_message_at: c.last_message_at }));

      const human = [];
      const staffAt = Math.max(0, ...myConvs.map((c) => t(c.last_staff_at)));
      if (staffAt > recentMs) human.push('staff email ' + new Date(staffAt).toISOString().slice(0, 10));
      const o = outreach.find((x) => x.e === email);
      if (o && t(o.at) > recentMs) human.push('rep email ' + new Date(o.at).toISOString().slice(0, 10));
      const myProspects = prospects.filter((p) => p.converted_seller_profile_id === f.seller_profile_id || (email && p.e === email));
      const noteAt = Math.max(0, ...myProspects.map((p) => t(p.last_note_at)));
      if (noteAt > recentMs) human.push('rep note ' + new Date(noteAt).toISOString().slice(0, 10));
      h.recent_human = human.length ? human.join(', ') : null;
      h.last_human_contact_at = Math.max(staffAt, o ? t(o.at) : 0, noteAt) || null;

      const myCompanies = new Set([
        ...links.filter((l) => (l.entity_type === 'seller_profile' && l.entity_id === String(f.seller_profile_id))
          || (l.entity_type === 'organization' && f.organization_id && l.entity_id === String(f.organization_id))
          || (l.entity_type === 'sales_prospect' && myProspects.some((p) => String(p.id) === l.entity_id))).map((l) => l.company_id),
        ...domainCos.filter((c) => email && c.d === email.split('@')[1]).map((c) => c.id)]);
      const fp = fps.find((x) => x.seller_profile_id === f.seller_profile_id)
        || fps.find((x) => myCompanies.has(x.company_id))
        || fps.find((x) => f.organization_id && x.organization_id === f.organization_id);
      h.auction_partner = fp ? { id: fp.id, name: fp.display_name, status: fp.status, owner_user_id: fp.relationship_owner_user_id,
        released: !!fp.sasha_assist_released_at, bound: fp.seller_profile_id === f.seller_profile_id } : null;

      const rep = myProspects.find((p) => p.assigned_rep_user_id);
      const userLock = locks.find((l) => myCompanies.has(l.company_id) && l.holder_type === 'user');
      h.staff_owner = userLock ? 'contact lock until ' + new Date(userLock.expires_at).toISOString().slice(0, 10) : rep ? 'assigned sales rep' : null;
      const sysLock = locks.find((l) => myCompanies.has(l.company_id) && l.holder_type === 'system');
      h.other_programme = sysLock ? (sysLock.reason || 'system contact lock') : null;

      const dv = deliv.find((x) => x.normalized_email === email);
      h.bounced = !!(dv && (dv.hard_bounced || dv.complaint || dv.invalid));
      let sup = await suppress.check({ email, organizationId: f.organization_id || null }, runner);
      for (const co of myCompanies) { if (sup.suppressed) break; sup = await suppress.check({ email: null, companyId: co }, runner); }
      h.suppressed = sup.suppressed ? (sup.error ? 'lookup failed' : sup.source + (sup.reason ? ': ' + sup.reason : '')) : null;
      if (sup.error) h.lookup_error = 'suppression lookup: ' + sup.error;
    }
  } catch (e) {
    for (const h of out.values()) h.lookup_error = e.message;
  }
  return out;
}

// ── ledger ─────────────────────────────────────────────────────────────────────────────────────────────
const LEDGER_DECISION = { SELLER_REPLIED: 'replied', HUMAN_TAKEOVER: 'human_takeover', ACTIVATION_OPT_OUT: 'opted_out' };

function snapshotFor(f, s, h, d) {
  return {   // operational facts only: no message text, no address, no documents
    seller_type: f.seller_type || null, agreement_signed: !!f.agreement_signed_at || !!f.agreement_waived_at,
    auctions_total: Number(f.total_auctions) || 0, submitted_ever: Number(f.submitted_ever) > 0, published: Number(f.published_auctions) > 0,
    draft_id: f.draft_id || null, draft_lots: f.draft_lots == null ? null : Number(f.draft_lots), verification_status: f.verification_status || null,
    touches_total: h.touches_total || 0, touches_in_stage: (h.touches_by_stage || {})[s.stage] || 0,
    last_touch_at: h.last_touch_at || null, last_human_contact_at: h.last_human_contact_at ? new Date(h.last_human_contact_at).toISOString() : null,
    auction_partner: h.auction_partner ? { id: h.auction_partner.id, name: h.auction_partner.name, status: h.auction_partner.status, released: h.auction_partner.released } : null,
    sasha_history: (h.sasha_history || []).slice(0, 5), due_at: d.due_at || null, send_at: d.send_at || null, window: d.window || null,
    first_published_at: f.first_published_at || null,
  };
}

async function recordEvaluation(f, s, h, d, cfg, runner = db) {
  const prev = (await runner.query(`SELECT stage, blocker, decision, guard, last_progress_at FROM seller_activation_state WHERE seller_profile_id = $1`,
    [f.seller_profile_id])).rows[0];
  const stage = d.decision === 'excluded' ? 'excluded' : s.stage;
  const snap = snapshotFor(f, s, h, d);
  const ledgerRows = [];
  if (prev && prev.decision === 'would_contact' && (prev.stage !== stage || t(s.last_progress_at) > t(prev.last_progress_at))) {
    ledgerRows.push({ decision: 'cancelled', guard: 'PROGRESSED', reason: 'Seller progressed (' + prev.stage + ' -> ' + stage + '); the planned check-in was cancelled.' });
  }
  if (!prev || prev.stage !== stage || prev.blocker !== s.blocker || prev.decision !== d.decision || (prev.guard || null) !== (d.guard || null)) {
    ledgerRows.push({ decision: LEDGER_DECISION[d.guard] || d.decision, guard: d.guard, reason: d.reason });
  }
  for (const row of ledgerRows) {
    await runner.query(
      `INSERT INTO seller_activation_touches (seller_profile_id, user_id, mode, decision, stage, blocker, next_owner, guard, reason, message_category,
         attempt, stage_attempt, last_progress_at, snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
      [f.seller_profile_id, f.user_id, cfg.mode, row.decision, stage, s.blocker, s.next_owner, row.guard, String(row.reason || '').slice(0, 500),
        row.decision === 'would_contact' ? s.message_category : null, d.attempt || null, d.stage_attempt || null, s.last_progress_at, JSON.stringify(snap)]);
  }
  await runner.query(
    `INSERT INTO seller_activation_state (seller_profile_id, user_id, stage, blocker, next_owner, last_progress_at, decision, guard, reason,
       needs_staff_attention, next_touch_at, snapshot, evaluated_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb, now(), now())
     ON CONFLICT (seller_profile_id) DO UPDATE SET user_id = EXCLUDED.user_id, stage = EXCLUDED.stage, blocker = EXCLUDED.blocker,
       next_owner = EXCLUDED.next_owner, last_progress_at = EXCLUDED.last_progress_at, decision = EXCLUDED.decision, guard = EXCLUDED.guard,
       reason = EXCLUDED.reason, needs_staff_attention = EXCLUDED.needs_staff_attention, next_touch_at = EXCLUDED.next_touch_at,
       snapshot = EXCLUDED.snapshot, evaluated_at = now(), updated_at = now()`,
    [f.seller_profile_id, f.user_id, stage, s.blocker, s.next_owner, s.last_progress_at, d.decision, d.guard, String(d.reason || '').slice(0, 500),
      !!d.needs_staff_attention, d.send_at || d.due_at || null, JSON.stringify(snap)]);
  return { ledger: ledgerRows.length };
}

/** Auction Partner seller: one staff task for the relationship owner (idempotent). Internal only; contacts no one. */
async function openApTask(f, h) {
  try {
    await require('./claimedListings/taskService').open({ type: 'activation_stalled', priority: 'high', assignedUserId: h.auction_partner.owner_user_id || null,
      organizationId: f.organization_id || null, summary: 'Auction Partner seller account: ' + (f.display_name || h.auction_partner.name) + '. Relationship owner follows up; Sasha will not contact.',
      payload: { seller_profile_id: f.seller_profile_id, founding_partner_id: h.auction_partner.id, source: 'seller_activation' },
      dedupeKey: 'seller_activation:ap:' + f.seller_profile_id });
  } catch (e) { console.error('[sellerActivation] AP task failed:', e.message); }
}

// ── live send (only in mode 'live') ────────────────────────────────────────────────────────────────────
/**
 * Re-evaluate one seller from fresh facts and, only if still due and every guard passes, send one check-in.
 * Idempotent: the (seller, stage, stage attempt, attempt) key is claimed in the ledger before the send.
 */
async function sendCheckIn(sellerProfileId, selected, deps = {}) {
  const cfg = deps.cfg || await config();
  if (!cfg.enabled || cfg.mode !== 'live') return { sent: false, reason: 'not_live' };
  const now = deps.now || new Date();
  const [f] = await loadFacts(db, { sellerProfileIds: [sellerProfileId] });
  if (!f) return { sent: false, reason: 'seller_missing' };
  const h = (await loadHistory([f], cfg, db, now)).get(sellerProfileId);
  const s = computeStage(f);
  const d = decide(f, s, h, cfg, now);
  const ledger = async (decision, guard, reason, extra = {}) => db.query(
    `INSERT INTO seller_activation_touches (seller_profile_id, user_id, mode, decision, stage, blocker, next_owner, guard, reason, message_category,
       attempt, stage_attempt, last_progress_at, conversation_id, conversation_ref, idempotency_key, snapshot)
     VALUES ($1,$2,'live',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
    [f.seller_profile_id, f.user_id, decision, s.stage, s.blocker, s.next_owner, guard || null, String(reason || '').slice(0, 500), s.message_category,
      d.attempt || null, d.stage_attempt || null, s.last_progress_at, extra.conversationId || null, extra.ref || null, extra.key || null, JSON.stringify(snapshotFor(f, s, h, d))]);

  const progressed = selected && (selected.stage !== s.stage || t(s.last_progress_at) > t(selected.last_progress_at));
  if (d.decision !== 'would_contact' || progressed) {
    await ledger('cancelled', progressed ? 'PROGRESSED' : d.guard, progressed ? 'Seller progressed between selection and send.' : 'Re-check before send: ' + d.reason);
    return { sent: false, reason: progressed ? 'PROGRESSED' : d.guard };
  }
  const msg = composeMessage(f, s, d);
  if (!msg || /[—–]/.test(msg.text + msg.subject)) { await ledger('cancelled', 'COMPOSE_FAILED', 'No safe message for this stage.'); return { sent: false, reason: 'COMPOSE_FAILED' }; }
  const sasha = await require('./sasha/settings').effective().catch(() => ({}));
  if (!sasha.enabled || !sasha.email_inbound) { await ledger('cancelled', 'SASHA_UNAVAILABLE', 'Sasha or the Shared Inbox is switched off, so replies could not be received.'); return { sent: false, reason: 'SASHA_UNAVAILABLE' }; }

  const key = ['sa', f.seller_profile_id, s.stage, d.stage_attempt, d.attempt].join(':');
  const conversations = require('./sasha/conversationService');
  const channel = require('./sasha/emailChannel');
  // Second check-in in the same stage continues the same thread.
  const prior = (await db.query(`SELECT conversation_id FROM seller_activation_touches WHERE seller_profile_id = $1 AND stage = $2 AND decision = 'contacted'
    AND conversation_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [f.seller_profile_id, s.stage])).rows[0];
  const conv = prior ? await conversations.get(prior.conversation_id)
    : await conversations.createConversation({ channel: 'email', subject: msg.subject, customerEmail: f.email, customerName: f.full_name || null, contactMatchUserId: f.user_id });
  const claim = (await ledger('contacted', null, d.reason, { conversationId: conv.id, ref: conv.ref, key })).rows[0];
  if (!claim) return { sent: false, reason: 'DUPLICATE' };

  const out = await conversations.addSashaReply(conv.id, { text: msg.text, autoSent: true, deliveryStatus: 'pending' });
  if (out.blocked) {
    await db.query(`UPDATE seller_activation_touches SET decision = 'cancelled', guard = 'HUMAN_TAKEOVER', reason = $2 WHERE id = $1`, [claim.id, 'Conversation is ' + out.blocked]);
    return { sent: false, reason: 'HUMAN_TAKEOVER' };
  }
  try {
    const sent = await channel.sendActivationEmail(conv, msg.subject, msg.text, deps);
    await db.query(`UPDATE cs_messages SET delivery_status = $2, email_message_id = $3, ses_message_id = $4 WHERE id = $1`,
      [out.id, sent && sent.skipped ? 'not_sent' : 'sent', sent && sent.messageId ? `<${String(sent.messageId).replace(/^<|>$/g, '')}>` : null, (sent && sent.sesMessageId) || null]);
    if (sent && sent.skipped) throw new Error('email not configured');
    return { sent: true, conversation_id: conv.id, ref: conv.ref };
  } catch (e) {
    await db.query(`UPDATE cs_messages SET delivery_status = 'failed', delivery_error = $2 WHERE id = $1`, [out.id, String(e.message).slice(0, 300)]);
    await db.query(`UPDATE seller_activation_touches SET decision = 'send_failed', reason = $2 WHERE id = $1`, [claim.id, 'Send failed: ' + String(e.message).slice(0, 300)]);
    return { sent: false, reason: 'SEND_FAILED' };
  }
}

// ── the pass ───────────────────────────────────────────────────────────────────────────────────────────
const LOCK_KEY = 187001;

/**
 * Evaluate every seller, record the decision, and (live mode, allowSend) send due check-ins under the daily cap.
 * Single-flight across processes via an advisory lock.
 */
async function runPass({ allowSend = true, now = new Date(), deps = {} } = {}) {
  const cfg = await config();
  if (!cfg.enabled) return { skipped: 'disabled', mode: cfg.mode };
  const lockClient = await db.connect();
  try {
    const got = (await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY])).rows[0].ok;
    if (!got) return { skipped: 'locked' };
    try {
      const facts = await loadFacts();
      const hist = await loadHistory(facts, cfg, db, now);
      const counts = {}; const due = [];
      for (const f of facts) {
        const s = computeStage(f); const h = hist.get(f.seller_profile_id); const d = decide(f, s, h, cfg, now);
        counts[d.decision] = (counts[d.decision] || 0) + 1;
        await recordEvaluation(f, s, h, d, cfg);
        if (d.guard === 'AUCTION_PARTNER_RELATIONSHIP_OWNER') await openApTask(f, h);
        if (d.decision === 'would_contact') due.push({ id: f.seller_profile_id, stage: s.stage, last_progress_at: s.last_progress_at });
      }
      const sends = [];
      if (cfg.mode === 'live' && allowSend) {
        due.sort((a, b) => t(a.last_progress_at) - t(b.last_progress_at));
        for (const x of due) {
          const r = await sendCheckIn(x.id, x, { ...deps, cfg, now });
          sends.push({ seller_profile_id: x.id, ...r });
          if (r.reason === 'DAILY_CAP') break;
        }
      }
      return { mode: cfg.mode, evaluated: facts.length, counts, sends };
    } finally { await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {}); }
  } finally { lockClient.release(); }
}

/** Evaluate without writing anything (Director preview / reports). */
async function preview({ now = new Date(), runner = db } = {}) {
  const cfg = await config(runner);
  const facts = await loadFacts(runner);
  const hist = await loadHistory(facts, cfg, runner, now);
  return facts.map((f) => { const s = computeStage(f); const h = hist.get(f.seller_profile_id); const d = decide(f, s, h, cfg, now);
    return { f, s, h, d, message: d.decision === 'would_contact' ? composeMessage(f, s, d) : null }; });
}

async function optOut(sellerProfileId, { actorId, reason }) {
  const r = await db.query(
    `INSERT INTO seller_activation_state (seller_profile_id, stage, opted_out_at, opted_out_by, opted_out_reason)
     VALUES ($1, 'onboarding_incomplete', now(), $2, $3)
     ON CONFLICT (seller_profile_id) DO UPDATE SET opted_out_at = COALESCE(seller_activation_state.opted_out_at, now()),
       opted_out_by = COALESCE(seller_activation_state.opted_out_by, $2), opted_out_reason = COALESCE(seller_activation_state.opted_out_reason, $3), updated_at = now()
     RETURNING seller_profile_id, opted_out_at`, [sellerProfileId, actorId || null, reason ? String(reason).slice(0, 300) : 'staff recorded opt-out']);
  return r.rows[0];
}

// ── Director view ──────────────────────────────────────────────────────────────────────────────────────
async function directorView() {
  const cfg = await config();
  const rows = (await db.query(
    `SELECT s.seller_profile_id, s.stage, s.blocker, s.next_owner, s.last_progress_at, s.decision, s.guard, s.reason, s.needs_staff_attention,
            s.next_touch_at, s.opted_out_at, s.evaluated_at, s.snapshot, sp.display_name, sp.seller_type, u.full_name, u.email,
            (SELECT max(created_at) FROM seller_activation_touches t WHERE t.seller_profile_id = s.seller_profile_id AND t.decision = 'contacted') AS last_touch_at,
            (SELECT count(*)::int FROM seller_activation_touches t WHERE t.seller_profile_id = s.seller_profile_id AND t.decision = 'contacted') AS touches
       FROM seller_activation_state s JOIN seller_profiles sp ON sp.id = s.seller_profile_id JOIN users u ON u.id = sp.user_id
      WHERE s.stage <> 'excluded'
      ORDER BY s.needs_staff_attention DESC, (s.stage = 'activated') ASC, s.last_progress_at ASC NULLS FIRST`)).rows;
  const now = Date.now();
  const sellers = rows.map((r) => {
    const snap = r.snapshot || {};
    return {
      seller_profile_id: r.seller_profile_id, seller: r.display_name || r.full_name || '(no name)', email: r.email, seller_type: r.seller_type || 'individual',
      stage: r.stage, blocker: r.blocker, next_owner: r.next_owner, last_progress_at: r.last_progress_at,
      stalled_hours: r.stage === 'activated' || !r.last_progress_at ? null : Math.floor((now - t(r.last_progress_at)) / HOUR),
      last_sasha_touch_at: r.last_touch_at, touches: r.touches,
      reply_status: r.guard === 'SELLER_REPLIED' ? 'replied' : r.touches ? 'no reply' : '-',
      ownership: r.guard === 'HUMAN_TAKEOVER' ? 'staff took over' : r.guard === 'STAFF_RELATIONSHIP_OWNER' ? 'staff owner'
        : r.guard === 'AUCTION_PARTNER_RELATIONSHIP_OWNER' ? 'relationship owner' : 'Sasha',
      needs_staff_attention: r.needs_staff_attention, auction_partner: snap.auction_partner || null,
      activation_status: r.decision, guard: r.guard, reason: r.reason, next_touch_at: r.next_touch_at, opted_out: !!r.opted_out_at, evaluated_at: r.evaluated_at,
    };
  });
  const real = rows.map((r) => r.snapshot || {});
  const funnel = {
    signup: rows.length,
    onboarding_complete: rows.filter((r) => (r.snapshot || {}).agreement_signed).length,
    draft_started: real.filter((s) => s.auctions_total > 0).length,
    submitted: real.filter((s) => s.submitted_ever).length,
    first_auction_published: real.filter((s) => s.published).length,
  };
  return { config: { enabled: cfg.enabled, mode: cfg.mode, first_touch_hours: cfg.first_touch_hours, second_touch_days: cfg.second_touch_days,
    max_per_stage: cfg.max_per_stage, max_per_seller: cfg.max_per_seller, daily_cap: cfg.daily_cap }, funnel, sellers };
}

module.exports = { computeStage, decide, composeMessage, exclusion, timezoneFor, inWindow, nextWindowStart, config, loadFacts, loadHistory,
  recordEvaluation, sendCheckIn, runPass, preview, optOut, directorView, DEFAULTS, MIN_LOTS };

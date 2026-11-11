'use strict';

/**
 * ownerReviewDigestService: one daily summary, at 9:00 AM America/New_York, of every task waiting for a human at
 * Advantage.Bid (owner 2026-11-10).
 *
 *   email  each address in platform_config owner.notify_emails (the same owner notice list as ownerNotifyService)
 *   text   the platform owner's VERIFIED phone only: an owner alert number (OWNER_ALERT_PHONE_E164S / _E164) that equals
 *          users.phone_verified_e164 (phone_verified_at set) of a platform owner account. A configured number that is not
 *          verified is never texted; it is reported, masked, in the digest and in the run record.
 *
 * Guarantees:
 *   - one digest per New York calendar day: owner_digest_runs.run_date is the primary key (migration 228), and a short
 *     lease lets exactly one process work the day, across instances and restarts;
 *   - every delivery is recorded per recipient (owner_digest_deliveries) and retried, at most MAX_ATTEMPTS times, a few
 *     minutes apart; a recipient already sent is never sent again;
 *   - nothing pending, nothing sent (the day is recorded as nothing_pending);
 *   - the stored message is what every retry sends, so a retry never sends different content;
 *   - no customer data: categories, counts, ages, urgency, a short internal reference and fixed admin links only. No
 *     names, email addresses, phone numbers, documents, taxpayer or bank details, buyer details or tokens. One exception
 *     (owner 2026-11-11): a seller awaiting business verification is listed in the EMAIL with its Professional Seller
 *     business name (already public on its storefront), registration date, verification status and what is missing; the
 *     text message stays counts only;
 *   - links go only to Advantage.Bid admin pages, which require an administrator sign-in (htmlAuthGate);
 *   - read-only toward every workflow: it never changes a task, and existing immediate notifications are untouched.
 * Never throws out of runDigestTick.
 */

const crypto = require('crypto');
const db = require('../db');

const TZ = 'America/New_York';
const SEND_HOUR = 9;                 // 9:00 AM New York time, standard or daylight time
const LAST_HOUR = 21;                // a run missed at 9 (deploy, restart) catches up the same day, never late at night
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 10 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const MAX_LINES_PER_CATEGORY = 10;
const DAY_MS = 86400000;

const BASE = () => (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ── time (DST-aware through Intl) ─────────────────────────────────────────────
function nyDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function nyHour(d = new Date()) {
  return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d), 10) % 24;
}
/** Due from 9:00 AM to 9:00 PM New York time; the first step in that window sends, once per day. */
function isDue(now = new Date()) { const h = nyHour(now); return h >= SEND_HOUR && h < LAST_HOUR; }

function enabled(env = process.env) {
  if (String(env.OWNER_DIGEST_DISABLED || '').toLowerCase() === 'true') return false;
  return env.NODE_ENV === 'production' || String(env.OWNER_DIGEST_ENABLED || '').toLowerCase() === 'true';
}

// ── seller business verification (read-only) ─────────────────────────────────
// One line per seller whose business verification is required (seller_profiles.verification_required_before_publication)
// and not approved (no 'approved' verification_requests row: verificationService.hasApprovedVerification). Demo accounts
// and closed accounts (owner is_active false) are left out; approved sellers never appear. The state comes from the
// seller's most recent unapproved request:
//   none / open / more_info  -> Awaiting Seller Action   (the seller must start, upload or answer)
//   submitted                -> Awaiting Admin Review    (documents are in; an administrator decides)
//   rejected / cancelled     -> Verification Blocked     (no path to approval without an investigation)
// The business name is shown only for a Professional Seller (a public business identity, already on its storefront); any
// other seller is described by type only. No personal contact details, documents or taxpayer data are read.
const VERIFICATION_STATES = {
  seller_action: { label: 'Awaiting Seller Action', urgency: 'normal' },
  admin_review: { label: 'Awaiting Admin Review', urgency: 'high' },
  blocked: { label: 'Verification Blocked', urgency: 'high' },
};
function verificationState(reqStatus, docs) {
  const n = Number(docs) || 0;
  switch (reqStatus || null) {
    case null: return { state: 'seller_action', missing: 'Verification not started: no request and no documents yet' };
    case 'open': return { state: 'seller_action', missing: n ? `Documents requested; ${n} uploaded so far, not yet submitted` : 'Documents requested; none uploaded yet' };
    case 'more_info': return { state: 'seller_action', missing: 'Additional information requested from the seller' };
    case 'submitted': return { state: 'admin_review', missing: `Documents submitted (${n}); an administrator decision is needed` };
    case 'rejected': return { state: 'blocked', missing: 'Verification was rejected; the seller cannot sell until this is resolved' };
    case 'cancelled': return { state: 'blocked', missing: 'The verification request was cancelled without approval' };
    default: return { state: 'blocked', missing: `Unrecognized verification status "${String(reqStatus).slice(0, 30)}"; please check` };
  }
}
async function collectSellerVerification(runner) {
  const { isProfessional } = require('./sellerTypeRules');
  const rows = (await runner.query(
    `SELECT sp.id::text AS id, sp.seller_type, sp.display_name, sp.created_at AS registered_at,
            vr.status AS req_status, vr.at AS req_at,
            (SELECT count(*)::int FROM verification_documents d WHERE d.request_id = vr.id) AS docs
       FROM seller_profiles sp
       LEFT JOIN users u ON u.id = sp.user_id
       LEFT JOIN LATERAL (SELECT v.id, v.status, COALESCE(v.updated_at, v.created_at) AS at FROM verification_requests v
                           WHERE v.seller_profile_id = sp.id ORDER BY COALESCE(v.updated_at, v.created_at) DESC LIMIT 1) vr ON true
      WHERE sp.verification_required_before_publication IS TRUE
        AND sp.is_demo IS NOT TRUE
        AND u.is_active IS NOT FALSE
        AND NOT EXISTS (SELECT 1 FROM verification_requests a WHERE a.seller_profile_id = sp.id AND a.status = 'approved')
      ORDER BY sp.created_at ASC LIMIT 500`)).rows;
  return rows.map((r) => {
    const v = verificationState(r.req_status, r.docs);
    const pro = isProfessional(r.seller_type);
    const typeLabel = String(r.seller_type || 'seller').replace(/_/g, ' ');
    return {
      id: r.id,
      // Waiting since: the seller's registration while it is the seller's move; the request's last change otherwise.
      since: v.state === 'seller_action' && !r.req_status ? r.registered_at : (r.req_at || r.registered_at),
      base_urgency: VERIFICATION_STATES[v.state].urgency,
      detail: {
        name: pro && r.display_name ? String(r.display_name).slice(0, 120) : (pro ? 'Professional Seller (no business name yet)' : `Seller (${typeLabel})`),
        type: typeLabel,
        registered: r.registered_at ? new Date(r.registered_at).toISOString().slice(0, 10) : null,
        status: VERIFICATION_STATES[v.state].label,
        missing: v.missing,
      },
      path: '/admin/verification.html?seller=' + encodeURIComponent(r.id),
    };
  });
}

// ── the review workflows (read-only) ──────────────────────────────────────────
// Each: the queue, where it is worked, its base urgency, and the SQL returning (id, waiting_since) for open tasks only.
// Urgency rises with age: normal -> high after 3 days waiting, high -> urgent after 2 days.
const CATEGORIES = [
  { key: 'payment_disputes', label: 'Card disputes', urgency: 'urgent', path: '/admin/marketplace-orders.html',
    sql: `SELECT id::text, COALESCE(opened_at, created_at) AS since FROM payment_disputes WHERE closed_at IS NULL` },
  { key: 'support_handoffs', label: 'Customers waiting for a person (Sasha handoffs)', urgency: 'high', path: '/admin/sasha-inbox.html',
    sql: `SELECT id::text, COALESCE(updated_at, created_at) AS since FROM cs_conversations WHERE handoff_state = 'needed'` },
  { key: 'order_issues', label: 'Storefront order issues', urgency: 'high', path: '/admin/storefront-moderation.html',
    sql: `SELECT id::text, created_at AS since FROM marketplace_order_issues WHERE status IN ('open','seller_responded')` },
  { key: 'orders_review', label: 'Storefront orders held for review', urgency: 'high', path: '/admin/marketplace-orders.html',
    sql: `SELECT id::text, created_at AS since FROM marketplace_orders WHERE review_required IS TRUE` },
  { key: 'storefront_payouts', label: 'Storefront payouts to review or on hold', urgency: 'high', path: '/admin/storefront-payouts.html',
    sql: `SELECT id::text, created_at AS since FROM storefront_payouts WHERE settlement_status IN ('pending_review','on_hold')` },
  { key: 'auction_settlements', label: 'Auction seller settlements to complete', urgency: 'high', path: '/admin/settlement-review.html',
    sql: `SELECT id::text, created_at AS since FROM seller_payouts WHERE settlement_status IN ('pending_review','approved','ready_for_payment','on_hold')` },
  // Every seller who must pass business verification before selling and has not (owner 2026-11-11: a Professional Seller
  // with NO request was invisible here, because only submitted requests were counted). Built from the same flag and the
  // same "approved request" test as verificationService.publicationGate, so the report and the sale gate cannot disagree.
  { key: 'seller_verification', label: 'Sellers awaiting business verification', urgency: 'high', path: '/admin/verification.html',
    collect: collectSellerVerification },
  // A submitted request from a seller the rule above does not cover (an administrator-opened review): kept, never lost.
  { key: 'business_verification', label: 'Business verifications submitted', urgency: 'high', path: '/admin/verification.html',
    sql: `SELECT vr.id::text, COALESCE(vr.updated_at, vr.created_at) AS since FROM verification_requests vr
            LEFT JOIN seller_profiles sp ON sp.id = vr.seller_profile_id
           WHERE vr.status = 'submitted' AND (sp.id IS NULL OR sp.verification_required_before_publication IS NOT TRUE)` },
  { key: 'auction_review', label: 'Auctions submitted for review', urgency: 'high', path: '/admin/moderation.html',
    sql: `SELECT id::text, COALESCE(submitted_at, created_at) AS since FROM auctions WHERE state IN ('submitted','under_review')` },
  { key: 'webhook_quarantine', label: 'Payment callbacks held for verification', urgency: 'high', path: '/admin/compliance.html',
    sql: `SELECT id::text, created_at AS since FROM webhook_callback_quarantine WHERE status = 'pending_verification'` },
  { key: 'event_review', label: 'Estate sales and events submitted for review', urgency: 'normal', path: '/admin/events.html',
    sql: `SELECT id::text, COALESCE(submitted_at, created_at) AS since FROM events WHERE status = 'submitted'` },
  { key: 'walkthrough_videos', label: 'Auction walkthrough videos to review', urgency: 'normal', path: '/admin/moderation.html',
    sql: `SELECT id::text, created_at AS since FROM auction_walkthrough_videos WHERE review_status = 'pending_review'` },
  { key: 'item_reports', label: 'Reported storefront listings', urgency: 'normal', path: '/admin/storefront-moderation.html',
    sql: `SELECT id::text, created_at AS since FROM marketplace_item_reports WHERE status = 'open'` },
  { key: 'held_messages', label: 'Storefront messages held for review', urgency: 'normal', path: '/admin/storefront-moderation.html',
    sql: `SELECT id::text, created_at AS since FROM storefront_messages WHERE status = 'held'` },
  { key: 'tax_exemptions', label: 'Buyer tax exemption certificates to review', urgency: 'normal', path: '/admin/buyers.html',
    sql: `SELECT id::text, created_at AS since FROM buyer_tax_exemptions WHERE status = 'under_review'` },
  { key: 'failed_notifications', label: 'Storefront order notices that failed to send', urgency: 'normal', path: '/admin/marketplace-orders.html',
    sql: `SELECT id::text, created_at AS since FROM storefront_notifications WHERE status = 'failed'` },
  { key: 'watchdog', label: 'Open site watchdog findings', urgency: 'normal', path: '/admin/site-watchdog.html',
    sql: `SELECT id::text, first_seen_at AS since FROM watchdog_findings WHERE status = 'open'` },
  { key: 'event_partner_escalations', label: 'Event partner escalations', urgency: 'normal', path: '/admin/event-partners.html',
    sql: `SELECT id::text, created_at AS since FROM event_partner_escalations WHERE status IN ('open','in_review')` },
  { key: 'event_partner_requests', label: 'Event partner requests needing an administrator', urgency: 'normal', path: '/admin/event-partners.html',
    sql: `SELECT id::text, created_at AS since FROM event_partner_requests WHERE status = 'needs_admin'` },
  { key: 'listing_changes', label: 'Business listing changes to approve', urgency: 'normal', path: '/admin/business-listings.html',
    sql: `SELECT id::text, created_at AS since FROM organization_profile_change_requests WHERE status = 'pending'` },
  { key: 'company_identity', label: 'Possible duplicate companies to review', urgency: 'normal', path: '/admin/business-listings.html',
    sql: `SELECT id::text, created_at AS since FROM company_identity_reviews WHERE status = 'open'` },
  { key: 'listing_tasks', label: 'Claimed listing tasks', urgency: 'normal', path: '/admin/business-listings.html',
    sql: `SELECT id::text, created_at AS since FROM listing_tasks WHERE status IN ('open','in_progress')` },
  { key: 'event_channels', label: 'Event collection channels awaiting confirmation', urgency: 'normal', path: '/admin/event-discovery.html',
    sql: `SELECT id::text, created_at AS since FROM event_collection_channels WHERE status = 'previewed'` },
];
const URGENCY_RANK = { urgent: 0, high: 1, normal: 2 };

function urgencyFor(base, ageDays) {
  if (base === 'normal' && ageDays >= 3) return 'high';
  if (base === 'high' && ageDays >= 2) return 'urgent';
  return base;
}
function ageDays(since, now) {
  const t = since ? new Date(since).getTime() : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : 0;
}
function ageText(days) { return days === 0 ? 'less than 1 day' : days === 1 ? '1 day' : `${days} days`; }
function adminLink(p) { return BASE() + (String(p || '/admin/').startsWith('/admin/') ? p : '/admin/'); }

/** Read every queue. A queue that cannot be read is reported as not checked, never silently skipped. */
async function collectTasks({ runner = db, now = new Date() } = {}) {
  const categories = []; const unchecked = [];
  for (const cat of CATEGORIES) {
    let rows;
    try {
      // savepoint-free and read-only: each query stands alone
      rows = cat.collect ? await cat.collect(runner, now) : (await runner.query(cat.sql + ' ORDER BY 2 ASC NULLS LAST LIMIT 500')).rows;
    } catch (e) {
      unchecked.push({ key: cat.key, label: cat.label });
      console.warn(`[owner-digest] queue ${cat.key} could not be read: ${e.message}`);
      continue;
    }
    if (!rows.length) continue;
    const tasks = rows.map((r) => {
      const days = ageDays(r.since, now);
      const t = { ref: String(r.id).replace(/-/g, '').slice(0, 8).toUpperCase(), age_days: days, urgency: urgencyFor(r.base_urgency || cat.urgency, days) };
      if (r.detail) t.detail = r.detail;
      if (r.path) t.link = adminLink(r.path);
      return t;
    });
    const top = tasks.reduce((a, t) => (URGENCY_RANK[t.urgency] < URGENCY_RANK[a] ? t.urgency : a), 'normal');
    categories.push({ key: cat.key, label: cat.label, link: adminLink(cat.path), count: tasks.length,
      oldest_days: Math.max(...tasks.map((t) => t.age_days)), urgency: top, tasks });
  }
  categories.sort((a, b) => (URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]) || (b.oldest_days - a.oldest_days));
  const total = categories.reduce((n, c) => n + c.count, 0);
  const urgent = categories.reduce((n, c) => n + c.tasks.filter((t) => t.urgency === 'urgent').length, 0);
  return { categories, unchecked, total, urgent };
}

// ── destinations ──────────────────────────────────────────────────────────────
function hash(v) { return crypto.createHash('sha256').update(String(v || '').trim().toLowerCase()).digest('hex').slice(0, 24); }
function maskEmail(e) { const [u, d] = String(e).split('@'); return (u ? u.slice(0, 2) : '') + '***@' + (d || ''); }
function maskPhone(n) { const s = String(n || ''); return s.length >= 4 ? 'phone ending ' + s.slice(-4) : 'phone'; }

async function resolveDestinations({ runner = db, env = process.env } = {}) {
  const alerts = require('./ownerAlertService');
  const report = { email: [], email_problem: null, sms: [], sms_not_verified: [], sms_problem: null };
  // email: the owner notice list (platform owner editable)
  try {
    const row = (await runner.query(`SELECT value FROM platform_config WHERE key = 'owner.notify_emails'`)).rows[0];
    const list = row && Array.isArray(row.value) ? row.value : [];
    const valid = [...new Set(list.map((e) => String(e || '').trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];
    report.email = valid.map((e) => ({ to: e, hash: hash(e), hint: maskEmail(e) }));
    if (!valid.length) report.email_problem = 'No owner notice email address is configured (owner.notify_emails).';
  } catch (e) { report.email_problem = 'The owner notice email list could not be read.'; }
  // text: configured owner alert numbers that are the platform owner's verified phone
  const configured = alerts.parseRecipients(env.OWNER_ALERT_PHONE_E164S || '').length
    ? alerts.parseRecipients(env.OWNER_ALERT_PHONE_E164S) : alerts.parseRecipients(env.OWNER_ALERT_PHONE_E164 || '');
  let verified = [];
  try {
    verified = (await runner.query(`SELECT phone_verified_e164 AS p FROM users
       WHERE is_platform_owner IS TRUE AND is_active IS NOT FALSE AND phone_verified_at IS NOT NULL AND phone_verified_e164 IS NOT NULL`)).rows.map((r) => String(r.p).trim());
  } catch (e) { report.sms_problem = 'The verified owner phone could not be read.'; }
  for (const n of configured) {
    if (verified.includes(n)) report.sms.push({ to: n, hash: hash(n), hint: maskPhone(n) });
    else report.sms_not_verified.push(maskPhone(n));
  }
  if (!report.sms_problem && !report.sms.length) {
    report.sms_problem = !configured.length ? 'No owner alert phone number is configured.'
      : 'No configured owner alert number matches the platform owner\'s verified phone, so no text is sent.';
  }
  return report;
}
// What may be stored or logged about the destinations (masked only).
function publicDestinations(d) {
  return { email: d.email.map((x) => x.hint), email_problem: d.email_problem, sms: d.sms.map((x) => x.hint),
    sms_not_verified: d.sms_not_verified, sms_problem: d.sms_problem };
}

// ── composition (no customer data; no long dashes) ────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const URG_LABEL = { urgent: 'Urgent', high: 'High', normal: 'Normal' };

function compose(result, dest, runDate) {
  const { categories, unchecked, total, urgent } = result;
  const subject = `Advantage.Bid daily review: ${total} ${total === 1 ? 'task' : 'tasks'} waiting${urgent ? ` (${urgent} urgent)` : ''}`;
  const lines = [`Daily review for ${runDate} (9:00 AM New York time).`, `${total} ${total === 1 ? 'task is' : 'tasks are'} waiting for a person${urgent ? `, ${urgent} urgent` : ''}.`, ''];
  for (const c of categories) {
    lines.push(`${c.label}: ${c.count} (${URG_LABEL[c.urgency]}, oldest waiting ${ageText(c.oldest_days)})`);
    for (const t of c.tasks.slice(0, MAX_LINES_PER_CATEGORY)) {
      if (t.detail) {
        lines.push(`  - ${t.detail.name}: ${t.detail.status} (${URG_LABEL[t.urgency]}). Registered ${t.detail.registered || 'unknown'}; waiting ${ageText(t.age_days)}.`);
        lines.push(`    Needed: ${t.detail.missing}.`);
        if (t.link) lines.push(`    Open: ${t.link}`);
      } else lines.push(`  - Ref ${t.ref}: waiting ${ageText(t.age_days)}, ${URG_LABEL[t.urgency]}`);
    }
    if (c.tasks.length > MAX_LINES_PER_CATEGORY) lines.push(`  - and ${c.tasks.length - MAX_LINES_PER_CATEGORY} more`);
    lines.push(`  Open: ${c.link}`, '');
  }
  if (unchecked.length) lines.push(`Not checked today (could not be read): ${unchecked.map((u) => u.label).join('; ')}.`, '');
  const pd = publicDestinations(dest);
  lines.push(pd.sms.length ? `Text summary: goes to the verified owner ${pd.sms.join(', ')}.` : `Text summary: not sent. ${pd.sms_problem}`);
  if (pd.sms_not_verified.length) lines.push(`Not texted (not a verified owner phone): ${pd.sms_not_verified.join(', ')}.`);
  lines.push('', 'Links open the Advantage.Bid admin and require an administrator sign-in. This summary is information only; it changes nothing.', '', 'Advantage.Bid');
  const text = lines.join('\n');

  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#111;max-width:640px;margin:0 auto;padding:16px">
<h2 style="font-size:18px;margin:0 0 6px">${esc(subject)}</h2>
<p style="margin:0 0 16px;font-size:14px;color:#475569">Daily review for ${esc(runDate)} (9:00 AM New York time).</p>
${categories.map((c) => `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin:0 0 12px">
<div style="font-weight:700;font-size:15px">${esc(c.label)}: ${c.count}</div>
<div style="font-size:13px;color:#475569;margin:2px 0 8px">${esc(URG_LABEL[c.urgency])} &middot; oldest waiting ${esc(ageText(c.oldest_days))}</div>
<ul style="margin:0 0 8px;padding-left:18px;font-size:13px">${c.tasks.slice(0, MAX_LINES_PER_CATEGORY).map((t) => (t.detail
    ? `<li style="margin-bottom:6px"><b>${esc(t.detail.name)}</b>: ${esc(t.detail.status)} (${esc(URG_LABEL[t.urgency])})<br>Registered ${esc(t.detail.registered || 'unknown')}; waiting ${esc(ageText(t.age_days))}<br>Needed: ${esc(t.detail.missing)}${t.link ? `<br><a href="${esc(t.link)}">Open this seller in Admin</a>` : ''}</li>`
    : `<li>Ref ${esc(t.ref)}: waiting ${esc(ageText(t.age_days))}, ${esc(URG_LABEL[t.urgency])}</li>`)).join('')}${c.tasks.length > MAX_LINES_PER_CATEGORY ? `<li>and ${c.tasks.length - MAX_LINES_PER_CATEGORY} more</li>` : ''}</ul>
<a href="${esc(c.link)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;padding:8px 14px;border-radius:8px;font-size:13px">Open in Admin</a>
</div>`).join('\n')}
${unchecked.length ? `<p style="font-size:13px;color:#b45309">Not checked today (could not be read): ${esc(unchecked.map((u) => u.label).join('; '))}.</p>` : ''}
<p style="font-size:12px;color:#64748b">${esc(lines.filter((l) => /^Text summary|^Not texted/.test(l)).join(' '))}</p>
<p style="font-size:12px;color:#64748b">Links open the Advantage.Bid admin and require an administrator sign-in. This summary is information only; it changes nothing.</p>
</body></html>`;

  const parts = categories.slice(0, 4).map((c) => `${c.label.split(' (')[0]} ${c.count}`);
  const more = categories.length > 4 ? `, +${categories.length - 4} more` : '';
  const sms = `Advantage.Bid daily review: ${total} waiting${urgent ? `, ${urgent} urgent` : ''}. ${parts.join(', ')}${more}.\n\nReview:\n${BASE()}/admin/`;
  return { subject, text, html, sms };
}

// ── the run ───────────────────────────────────────────────────────────────────
// Claim today's run for this process (insert, or take an expired lease on an unfinished run). Returns the row or null.
async function claimRun(runner, runDate, now) {
  await runner.query(`INSERT INTO owner_digest_runs (run_date) VALUES ($1) ON CONFLICT (run_date) DO NOTHING`, [runDate]);
  const r = await runner.query(
    `UPDATE owner_digest_runs SET lease_until = $2, updated_at = now()
      WHERE run_date = $1 AND status IN ('composing','sending') AND (lease_until IS NULL OR lease_until < $3)
      RETURNING *`, [runDate, new Date(now.getTime() + LEASE_MS), now]);
  return r.rows[0] || null;
}

async function sendOne(channel, d, run, deps) {
  if (channel === 'email') {
    const r = await deps.mail.sendEmail({ to: d.to, subject: run.email_subject, text: run.email_text, html: run.email_html });
    if (r && r.skipped) throw new Error('email is not configured on this server');
  } else {
    await deps.sms.sendSMS({ to: d.to, message: run.sms_text });
  }
}

/**
 * One scheduler step. Safe to call every minute from any number of processes.
 * deps: { runner, now, env, mail, sms } (tests inject stand-ins). Returns a small report; never throws.
 */
async function runDigestTick(deps = {}) {
  const runner = deps.runner || db;
  const now = deps.now || new Date();
  const env = deps.env || process.env;
  const mail = deps.mail || require('./emailService');
  const sms = deps.sms || require('./smsService');
  try {
    if (!deps.force && !enabled(env)) return { ran: false, reason: 'disabled' };
    if (!isDue(now)) return { ran: false, reason: 'not_due' };
    const runDate = nyDate(now);
    let run = await claimRun(runner, runDate, now);
    if (!run) return { ran: false, reason: 'already_handled_or_in_progress', run_date: runDate };

    const dest = await resolveDestinations({ runner, env });
    if (run.status === 'composing') {
      const result = await collectTasks({ runner, now });
      const summary = { total: result.total, urgent: result.urgent, unchecked: result.unchecked.map((u) => u.key),
        categories: result.categories.map((c) => ({ key: c.key, count: c.count, oldest_days: c.oldest_days, urgency: c.urgency })) };
      if (!result.total) {
        await runner.query(`UPDATE owner_digest_runs SET status = 'nothing_pending', task_count = 0, summary = $2, destinations = $3,
            finished_at = now(), lease_until = NULL, updated_at = now() WHERE run_date = $1`, [runDate, JSON.stringify(summary), JSON.stringify(publicDestinations(dest))]);
        console.log(`[owner-digest] ${runDate}: nothing pending, nothing sent${result.unchecked.length ? ` (${result.unchecked.length} queue(s) not checked)` : ''}`);
        return { ran: true, run_date: runDate, status: 'nothing_pending', total: 0 };
      }
      const msg = compose(result, dest, runDate);
      run = (await runner.query(`UPDATE owner_digest_runs SET status = 'sending', task_count = $2, summary = $3, destinations = $4,
          email_subject = $5, email_text = $6, email_html = $7, sms_text = $8, updated_at = now() WHERE run_date = $1 RETURNING *`,
        [runDate, result.total, JSON.stringify(summary), JSON.stringify(publicDestinations(dest)), msg.subject, msg.text, msg.html, msg.sms])).rows[0];
      for (const [channel, list] of [['email', dest.email], ['sms', dest.sms]]) {
        for (const d of list) {
          await runner.query(`INSERT INTO owner_digest_deliveries (run_date, channel, recipient_hash, recipient_hint) VALUES ($1,$2,$3,$4)
              ON CONFLICT (run_date, channel, recipient_hash) DO NOTHING`, [runDate, channel, d.hash, d.hint]);
        }
      }
    }

    // deliver: pending ones, and failed ones whose retry time has come (never one already sent)
    const byHash = new Map([...dest.email.map((d) => ['email:' + d.hash, d]), ...dest.sms.map((d) => ['sms:' + d.hash, d])]);
    const deliveries = (await runner.query(`SELECT * FROM owner_digest_deliveries WHERE run_date = $1 ORDER BY channel, created_at`, [runDate])).rows;
    for (const dv of deliveries) {
      if (dv.status === 'sent' || dv.attempts >= MAX_ATTEMPTS) continue;
      if (dv.status === 'failed' && dv.last_attempt_at && now.getTime() - new Date(dv.last_attempt_at).getTime() < RETRY_AFTER_MS) continue;
      const d = byHash.get(dv.channel + ':' + dv.recipient_hash);
      if (!d) {   // removed from the configuration, or no longer verified, since the digest was composed: never sent
        await runner.query(`UPDATE owner_digest_deliveries SET status = 'failed', attempts = $2, last_error = $3, last_attempt_at = $4 WHERE id = $1`,
          [dv.id, MAX_ATTEMPTS, 'destination no longer configured or verified', now]);
        continue;
      }
      try {
        await sendOne(dv.channel, d, run, { mail, sms });
        await runner.query(`UPDATE owner_digest_deliveries SET status = 'sent', attempts = attempts + 1, sent_at = $2, last_attempt_at = $2, last_error = NULL WHERE id = $1`, [dv.id, now]);
        console.log(`[owner-digest] ${runDate}: ${dv.channel} sent to ${dv.recipient_hint}`);
      } catch (e) {
        const msg = String((e && e.message) || 'send failed').slice(0, 300);
        await runner.query(`UPDATE owner_digest_deliveries SET status = 'failed', attempts = attempts + 1, last_error = $2, last_attempt_at = $3 WHERE id = $1`, [dv.id, msg, now]);
        console.error(`[owner-digest] ${runDate}: ${dv.channel} to ${dv.recipient_hint} failed: ${msg}`);
      }
    }

    // finish the day when nothing is left to try
    const after = (await runner.query(`SELECT status, attempts FROM owner_digest_deliveries WHERE run_date = $1`, [runDate])).rows;
    const sent = after.filter((r) => r.status === 'sent').length;
    const open = after.filter((r) => r.status !== 'sent' && r.attempts < MAX_ATTEMPTS).length;
    let status = 'sending';
    if (!open) status = !after.length ? 'failed' : sent === after.length ? 'complete' : sent ? 'partial' : 'failed';
    await runner.query(`UPDATE owner_digest_runs SET status = $2, lease_until = NULL, finished_at = CASE WHEN $2 = 'sending' THEN NULL ELSE now() END,
        updated_at = now() WHERE run_date = $1`, [runDate, status]);
    if (status === 'failed') console.error(`[owner-digest] ${runDate}: DIGEST NOT DELIVERED on any channel`);
    return { ran: true, run_date: runDate, status, sent, open, total: run.task_count };
  } catch (e) {
    console.error('[owner-digest] tick error:', e.message);
    return { ran: false, reason: 'error', error: e.message };
  }
}

module.exports = { runDigestTick, collectTasks, resolveDestinations, publicDestinations, compose, nyDate, nyHour, isDue, enabled,
  urgencyFor, CATEGORIES, MAX_ATTEMPTS, RETRY_AFTER_MS, verificationState, collectSellerVerification, VERIFICATION_STATES };

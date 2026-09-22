#!/usr/bin/env node
/* event-partner-first-cohort.js — the first bounded live Event Partner cohort.

   Phases, so nothing leaves the building unexamined:
     --screen    run relationship segmentation across every prospect with a public business email
     --select    apply contact-provenance quality rules and show the proposed cohort
     --prepare   create the approved template version and the approved cohort (no sending)
     --dry-run   render the exact message and authorization link for each recipient, send nothing
     --send      send, hard-stopped at the cohort ceiling

   Beyond relationship segmentation, a recipient must also pass CONTACT PROVENANCE:
   the company must actually be an auction or estate-sale business, and the public email must sit on
   the company's OWN domain. An address on a directory or unrelated domain is not a published
   business contact for this purpose, and a retailer that merely has "liquidation" in its name is
   not an event company. */

const db = require('../src/db');
const configService = require('../src/services/configService');
const cohortService = require('../src/services/eventPartners/cohortService');
const segmentation = require('../src/services/eventPartners/relationshipSegmentationService');
const sender = require('../src/services/eventPartners/outreachSendService');

const has = (f) => process.argv.includes('--' + f);
const log = (...a) => console.log(...a);

const COHORT_NAME = 'First live Event Partner cohort — 2026-09';
const TEMPLATE_KEY = 'event_partner_invitation';

/** Company types this programme is for. A flooring retailer is not an event company. */
const EVENT_BUSINESS_TYPES = ['auction_house', 'estate_sale_company'];

/** Names that describe retail/liquidation storefronts rather than event businesses. */
const NOT_EVENT_BUSINESS = /lumber|flooring|office furniture|thrift store/i;

/**
 * Mailbox local-parts that are transactional endpoints rather than business contacts. A bidding
 * inbox exists to take bids; sending it a partnership proposal is the wrong message to the wrong
 * desk, even though the address is genuinely published.
 */
const TRANSACTIONAL_MAILBOX = /^(bid|bids|bidding|noreply|no-reply|donotreply|support|help|webmaster|postmaster|abuse)$/i;

async function candidates(runner = db) {
  const { rows } = await runner.query(`
    SELECT d.prospect_id, d.company_name, d.business_email, d.website_domain, d.decision,
           p.business_type, p.city, p.state, p.contact_source, p.website, p.business_phone
      FROM event_partner_eligibility_decisions d
      JOIN sales_prospects p ON p.id = d.prospect_id
     WHERE d.decision = 'ELIGIBLE_UNAFFILIATED'
     ORDER BY d.company_name`);
  return rows.map((r) => {
    const emailDom = segmentation.emailDomain(r.business_email);
    const siteDom = segmentation.rootDomain(r.website || r.website_domain);
    const reasons = [];
    if (EVENT_BUSINESS_TYPES.indexOf(r.business_type) === -1) reasons.push('not an auction/estate-sale business (' + r.business_type + ')');
    if (NOT_EVENT_BUSINESS.test(r.company_name)) reasons.push('name indicates a retail/liquidation storefront, not an event company');
    const localPart = String(r.business_email || '').split('@')[0];
    if (TRANSACTIONAL_MAILBOX.test(localPart)) reasons.push('"' + localPart + '@" is a transactional inbox, not a business contact');
    if (!siteDom) reasons.push('no company website to attribute events to');
    else if (emailDom !== siteDom) reasons.push('email domain (' + emailDom + ') is not the company website domain (' + siteDom + ')');
    return Object.assign({}, r, { email_domain: emailDom, site_domain: siteDom,
      provenance_ok: reasons.length === 0, provenance_reasons: reasons });
  });
}

async function screen() {
  const r = await segmentation.screen({ limit: 2000 });
  log('SCREENED ' + r.screened + ' prospects with a public business email\n');
  Object.entries(r.counts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => log('  ' + k.padEnd(28) + v));
  return true;
}

async function select() {
  const all = await candidates();
  const ok = all.filter((c) => c.provenance_ok);
  const rejected = all.filter((c) => !c.provenance_ok);
  const max = Number(await configService.get(null, 'event_partners.first_cohort_max')) || 10;

  log('RELATIONSHIP-ELIGIBLE: ' + all.length);
  log('PASSED CONTACT PROVENANCE: ' + ok.length + '\n');
  ok.slice(0, max).forEach((c, i) => log('  ' + String(i + 1).padStart(2) + '. ' + c.company_name.slice(0, 34).padEnd(36)
    + c.business_email.padEnd(38) + c.business_type + '  ' + (c.city || '') + ', ' + (c.state || '')));
  if (ok.length > max) log('  … ' + (ok.length - max) + ' more eligible, NOT contacted (cohort ceiling ' + max + ')');

  log('\nHELD BACK ON CONTACT PROVENANCE (' + rejected.length + '):');
  rejected.forEach((c) => log('  ' + c.company_name.slice(0, 34).padEnd(36) + c.provenance_reasons.join('; ').slice(0, 96)));
  return { selected: ok.slice(0, max), rejected, max };
}

async function prepare(actorId) {
  const subject = 'Free event promotion for {{company}} on Advantage.Bid';
  const text = [
    'Hello,',
    '',
    'Advantage.Bid is an online marketplace where people look for upcoming auctions and estate sales.',
    '',
    'We would like to include {{company}}\'s upcoming public events in our listings, at no cost to you.',
    '',
    'How it works:',
    '  - Your events are listed with {{company}} named as the host',
    '  - Visitors are linked back to your own listing or website',
    '  - There is no cost, and no Advantage.Bid account is required',
    '',
    'If you would like us to promote your upcoming events, you can authorize it here:',
    '{{authorize_url}}',
    '',
    'If you would rather we did not, simply reply to this message and we will not contact you again.',
    '',
    'Advantage.Bid',
    'https://bid.advantage.bid',
  ].join('\n');
  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;max-width:560px">',
    '<p>Hello,</p>',
    '<p>Advantage.Bid is an online marketplace where people look for upcoming auctions and estate sales.</p>',
    '<p>We would like to include <strong>{{company}}</strong>\'s upcoming public events in our listings, at no cost to you.</p>',
    '<p style="margin:0 0 6px"><strong>How it works</strong></p>',
    '<ul style="margin:0 0 16px;padding-left:20px">',
    '<li>Your events are listed with {{company}} named as the host</li>',
    '<li>Visitors are linked back to your own listing or website</li>',
    '<li>There is no cost, and no Advantage.Bid account is required</li>',
    '</ul>',
    '<p style="margin:22px 0"><a href="{{authorize_url}}" style="background:#1d4ed8;color:#fff;padding:12px 22px;border-radius:7px;text-decoration:none;font-weight:700;display:inline-block">Authorize Event Promotion</a></p>',
    '<p style="color:#475569;font-size:13px">If you would rather we did not, simply reply to this message and we will not contact you again.</p>',
    '<p style="color:#475569;font-size:13px">Advantage.Bid &middot; <a href="https://bid.advantage.bid" style="color:#1d4ed8">bid.advantage.bid</a></p>',
    '</div>',
  ].join('');

  const tpl = await cohortService.createTemplateVersion({
    templateKey: TEMPLATE_KEY, purpose: 'initial_outreach', subject, bodyText: text, bodyHtml: html,
    notes: 'First live cohort. Concise, no performance claims, no implied relationship.', actorId });
  await cohortService.approveTemplate(tpl.id, { actorId });
  log('template ' + TEMPLATE_KEY + ' v' + tpl.version + ' created and approved');

  const max = Number(await configService.get(null, 'event_partners.first_cohort_max')) || 10;
  // Order matters: membership is fixed once a cohort is approved, and approval is what binds the
  // template version. So the cohort is created, filled, and only then approved.
  const cohort = await cohortService.createCohort({
    name: COHORT_NAME, description: 'First bounded live Event Partner outreach cohort.',
    maxSends: max, dailySendCap: max,
    expiresAt: new Date(Date.now() + 30 * 864e5).toISOString(), actorId });
  log('cohort created (draft): ' + cohort.id + '  max_sends=' + max);

  const { selected } = await select();
  for (const c of selected) {
    await cohortService.addMember(cohort.id, { recipientEmail: c.business_email, actorId });
  }
  log('cohort members added: ' + selected.length);

  await cohortService.approveCohort(cohort.id, { actorId, templateId: tpl.id });
  log('cohort approved and bound to ' + TEMPLATE_KEY + ' v' + tpl.version);
  return cohort.id;
}

async function currentCohort() {
  const { rows } = await db.query(
    `SELECT id, name, status, max_sends, sends_used, template_id FROM event_partner_cohorts
      WHERE name = $1 ORDER BY created_at DESC LIMIT 1`, [COHORT_NAME]);
  return rows[0] || null;
}

(async () => {
  const actor = (await db.query(
    "SELECT id FROM users WHERE email = 'tylerwitt2015@gmail.com' OR role='admin' ORDER BY created_at LIMIT 1")).rows[0];
  const actorId = actor ? actor.id : null;

  if (has('screen')) return (await screen()) ? 0 : 1;
  if (has('select')) { await select(); return 0; }
  if (has('prepare')) { await prepare(actorId); return 0; }

  const cohort = await currentCohort();
  if (!cohort) { console.error('No cohort. Run --prepare first.'); return 2; }
  log('Cohort ' + cohort.id + '  status=' + cohort.status + '  used ' + cohort.sends_used + '/' + cohort.max_sends + '\n');

  const { selected } = await select();
  const prospects = selected.map((c) => ({ id: c.prospect_id, company_name: c.company_name,
    business_email: c.business_email, business_phone: c.business_phone,
    website: c.website, website_domain: c.website_domain }));

  if (has('dry-run')) {
    const r = await sender.sendCohort({ cohortId: cohort.id, prospects, max: cohort.max_sends, actorId, dryRun: true });
    log('\n--- DRY RUN (nothing sent) ---');
    r.results.forEach((x) => log('  ' + String(x.company).slice(0, 32).padEnd(34)
      + (x.dry_run ? 'READY   ' : 'SKIP    ') + (x.skipped || '')
      + (x.gate && !x.gate.allowed ? ' [' + (x.gate.blocked_by || []).join(', ') + ']' : '')
      + (x.subject ? '\n      subject: ' + x.subject : '')
      + (x.authorize_url ? '\n      link:    ' + x.authorize_url.slice(0, 96) : '')
      + (x.error ? '\n      error:   ' + x.error : '')));
    return 0;
  }

  if (has('send')) {
    const outreachOn = await configService.get(null, 'event_partners.outreach_enabled');
    if (outreachOn !== true) { console.error('REFUSE: event_partners.outreach_enabled is OFF'); return 2; }
    const r = await sender.sendCohort({ cohortId: cohort.id, prospects, max: cohort.max_sends, actorId, dryRun: false });
    log('\n--- SEND ---');
    r.results.forEach((x) => log('  ' + String(x.company).slice(0, 32).padEnd(34)
      + (x.sent ? 'SENT    ' : 'NOT SENT ') + (x.skipped || x.error || '')
      + (x.provider_message_id ? '  id=' + String(x.provider_message_id).slice(0, 40) : '')));
    log('\nSENT ' + r.sent + ' / ceiling ' + r.ceiling);
    return 0;
  }

  console.error('Specify --screen --select --prepare --dry-run or --send');
  return 2;
})().then((c) => process.exit(c || 0)).catch((e) => { console.error(e); process.exit(1); });

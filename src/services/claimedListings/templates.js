'use strict';

/**
 * Claimed Listing email templates: the blueprint copy (Desktop Marketing, 24 Sep 2026), rendered.
 *
 * The catalogue below is the SOURCE for draft versions. What is sent is always an APPROVED row in
 * listing_outreach_templates (immutable once approved, enforced by a database trigger); the catalogue is
 * loaded as drafts by `seedDrafts` and approved by the Owner. Nothing in this file can send.
 *
 * Rules the render enforces (and the tests assert):
 *   - no em dashes anywhere in rendered copy (brand voice);
 *   - no tracking pixel, no images, no attachments, no forms;
 *   - every link is on an Advantage.Bid domain;
 *   - listing outreach always carries the footer: why you got this, the options link, the unsubscribe
 *     link and the postal address. An empty postal address makes rendering fail (fail closed).
 */

const db = require('../../db');

const LISTING_FOOTER = [
  '--',
  'You are receiving this because {{company}} is listed in the Advantage.Bid business directory with this email address. Wrong contact, or has the business closed? Tell us: {{listing_options_link}}',
  'Don\'t email me about this listing: {{unsubscribe_link}}',
  'Advantage.Bid, {{postal_address}}',
].join('\n');

const CATALOGUE = {
  E1: {
    stream: 'claimed_listing', subject: 'Your Advantage.Bid listing for {{company}}',
    preheader: 'It\'s free to claim and update. Here is what that means.',
    text: [
      '{{greeting}},',
      '',
      'Advantage.Bid is an online marketplace where people in {{area}} look for estate sales and auctions. Our business directory includes a listing for {{company}}:',
      '{{listing_url}}',
      '',
      'It shows your company name, your {{city}} location and phone number, taken from public business information. You can claim the listing and manage it yourself. Claiming is free, with no monthly fee and no credit card.',
      '',
      'Once it\'s yours, you can:',
      '- correct anything that is out of date',
      '- add your logo and a description in your own words',
      '- {{third_bullet}}',
      '',
      'Claim the {{company}} listing:',
      '{{claim_link}}',
      '',
      'This link was sent to {{recipient_email}} and works for 14 days.',
      '',
      'Claiming is optional. If you would rather not hear from us about this listing, use the link at the bottom of this email and we won\'t write again.',
      '',
      '{{rep_full_name}}',
      'Advantage.Bid',
      '(551) 655-7050',
      '{{footer}}',
    ].join('\n'),
  },
  E2_NOCLICK: {
    stream: 'claimed_listing', subject: 'What people see when they find {{company}}',
    preheader: 'A quick look at your listing, and how to change it.',
    text: [
      '{{greeting}},',
      '',
      'Following up about the {{company}} listing on Advantage.Bid. Here is what it shows today:',
      '',
      'Name: {{company}}',
      'Location: {{city}}, {{state}}',
      'Phone: {{phone}}',
      'Website: {{website_or_none_listed}}',
      'Description: written by Advantage.Bid from public information',
      '',
      'If any of that is wrong or missing, claiming the listing lets you fix it in a few minutes.',
      '{{#no_website}}',
      'If {{company}} doesn\'t have its own website, the listing can serve as a simple company page you can share with clients, with your details, your logo and your upcoming sales in one place.',
      '{{/no_website}}',
      '',
      'Claim the listing:',
      '{{claim_link}}',
      '',
      'This is a new link for {{recipient_email}}. The one in my earlier email no longer works.',
      '',
      '{{rep_first_name}}',
      'Advantage.Bid · (551) 655-7050',
      '{{footer}}',
    ].join('\n'),
  },
  E2_CLICKED: {
    stream: 'claimed_listing', subject: 'Finishing your {{company}} listing',
    preheader: 'Two short steps left. Here is a fresh link.',
    text: [
      '{{greeting}},',
      '',
      'You opened the claim page for {{company}} but didn\'t finish. It takes about two minutes: confirm it is your company, then choose a password.',
      '',
      'Here is a fresh link:',
      '{{claim_link}}',
      '',
      'If something got in the way, or you have a question, reply to this email. A person on our team reads every reply.',
      '',
      '{{rep_first_name}}',
      'Advantage.Bid · (551) 655-7050',
      '{{footer}}',
    ].join('\n'),
  },
  E3: {
    stream: 'claimed_listing', subject: 'Last note about the {{company}} listing',
    preheader: 'After this we won\'t email you about it again.',
    text: [
      '{{greeting}},',
      '',
      'This is the last email I\'ll send about claiming the {{company}} listing on Advantage.Bid.',
      '',
      'The listing stays in our directory as it is today. You can claim it any time from the listing page with the "Claim this listing" button, or with this link for the next 14 days:',
      '{{claim_link}}',
      '',
      'If the information is wrong, the business has closed, or you would like the listing removed, you can tell us here and we will take care of it:',
      '{{listing_options_link}}',
      '',
      'Thank you,',
      '{{rep_first_name}}',
      'Advantage.Bid · (551) 655-7050',
      '{{footer}}',
    ].join('\n'),
  },
  E4_REFRESH: {
    stream: 'claimed_listing', subject: 'Is the {{company}} listing still right?', preheader: null,
    text: [
      '{{greeting}},',
      '',
      'A few months ago we wrote about the {{company}} listing on Advantage.Bid. It is still unclaimed, and we would rather it be accurate than out of date.',
      '',
      'Take a look: {{listing_url}}',
      'Claim it (free): {{claim_link}}',
      'Correct or remove it: {{listing_options_link}}',
      '',
      'We won\'t email about this again.',
      '',
      '{{rep_first_name}}',
      'Advantage.Bid',
      '{{footer}}',
    ].join('\n'),
  },
  CL_SELF_REQUEST: {
    stream: 'claimed_listing', subject: 'Your claim link for {{company}}', preheader: null,
    text: [
      'Hello,',
      '',
      'Someone asked to claim the {{company}} listing on Advantage.Bid, and this is the email address on that listing.',
      '',
      'If it was you, use this link within 14 days:',
      '{{claim_link}}',
      '',
      'If it wasn\'t you, you can ignore this email. Nothing changes unless the link is used from this inbox.',
      '',
      'Advantage.Bid · (551) 655-7050 · info@advantage.bid',
    ].join('\n'),
  },
  A1: {
    stream: 'transactional', subject: '{{company}} is yours to manage', preheader: null,
    text: [
      'Hi {{first_name}},',
      '',
      'You\'ve claimed {{company}} on Advantage.Bid. It\'s free, with no monthly fee.',
      '',
      'Your listing checklist takes about ten minutes:',
      '1. Confirm your business details',
      '2. Add your logo',
      '3. Replace our description with your own',
      '4. Choose your service area and specialties',
      '5. Post your next estate sale or auction',
      '',
      'Open your checklist: {{checklist_link}}',
      '',
      'Questions? Reply here or call (551) 655-7050.',
      '',
      '{{rep_first_name}}',
      'Advantage.Bid',
    ].join('\n'),
  },
  A2: {
    stream: 'transactional', subject: 'Two quick things for your {{company}} page', preheader: null,
    text: [
      'Hi {{first_name}},',
      '',
      'Your {{company}} page is claimed. {{next_step_1}} and {{next_step_2}} are the two things that make the biggest difference to how it looks to buyers.',
      '',
      'Finish them here: {{checklist_link}}',
      '',
      '{{rep_first_name}}',
      'Advantage.Bid',
      '',
      'Email preferences: {{preferences_link}}',
    ].join('\n'),
  },
  A3: {
    stream: 'transactional', subject: 'Have a sale coming up?', preheader: null,
    text: [
      'Hi {{first_name}},',
      '',
      'When you post an upcoming estate sale or auction, it shows on your {{company}} page and on the Advantage.Bid pages buyers in {{area}} use to find sales. Posting is free, and you can have up to three active at a time.',
      '',
      'Post a sale: {{new_event_link}}',
      '',
      'No sale scheduled right now? You can mark that on your checklist and we\'ll stop reminding you.',
      '',
      '{{rep_first_name}}',
      'Advantage.Bid',
      '',
      'Email preferences: {{preferences_link}}',
    ].join('\n'),
  },
  A4: {
    stream: 'transactional', subject: 'Want a hand setting up your page?', preheader: null,
    text: [
      'Hi {{first_name}},',
      '',
      'If it would help, I can set up the {{company}} page with you over the phone. It usually takes 15 minutes. Reply with a good time, or call me at (551) 655-7050.',
      '',
      '{{rep_first_name}}',
      'Advantage.Bid',
      '',
      'Email preferences: {{preferences_link}}',
    ].join('\n'),
  },
};

// Which sequence step uses which template (handoff section 5).
const STEP_TEMPLATE = { 1: 'E1', 2: null /* E2_NOCLICK or E2_CLICKED */, 3: 'E3', 4: 'E4_REFRESH' };
const LISTING_TEMPLATES = ['E1', 'E2_NOCLICK', 'E2_CLICKED', 'E3', 'E4_REFRESH', 'CL_SELF_REQUEST'];

const ALLOWED_LINK_HOST = /^https:\/\/(bid\.advantage\.bid|www\.advantage\.bid|advantage\.bid)(\/|$)/i;
const EM_DASH = /\u2014/;

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** {{var}} substitution and {{#flag}}...{{/flag}} sections. Unknown variables are an error (fail closed). */
function fill(tpl, vars) {
  const withSections = String(tpl || '').replace(/\{\{#(\w+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g, (m, k, body) => (vars[k] ? body : ''));
  const missing = [];
  const outText = withSections.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
    if (!Object.prototype.hasOwnProperty.call(vars, k) || vars[k] == null || vars[k] === '') { missing.push(k); return m; }
    return String(vars[k]);
  });
  return { text: outText, missing };
}

/** Plain, accessible HTML from the text body: paragraphs, advantage.bid links only, no images. */
function htmlFromText(text, preheader) {
  const paras = String(text).split(/\n{2,}/).map((p) => {
    const lines = p.split('\n').map((line) => {
      const safe = escHtml(line);
      return safe.replace(/(https:\/\/[^\s<]+)/g, (u) => {
        const raw = u.replace(/&amp;/g, '&');
        return ALLOWED_LINK_HOST.test(raw) ? '<a href="' + u + '" style="color:#1d4ed8">' + u + '</a>' : u;
      });
    });
    const isFooter = p.startsWith('--');
    return '<p style="margin:0 0 14px;font-size:' + (isFooter ? '12px;color:#64748b' : '15px;color:#111') + ';line-height:1.55">' + lines.join('<br>') + '</p>';
  }).join('');
  const pre = preheader ? '<div style="display:none;max-height:0;overflow:hidden">' + escHtml(preheader) + '</div>' : '';
  return '<!doctype html><html><body style="margin:0;background:#ffffff;font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,Arial,sans-serif">'
    + pre + '<div style="max-width:560px;margin:0 auto;padding:24px 16px">' + paras + '</div></body></html>';
}

/**
 * Render a template row ({ subject, preheader, body_text, stream }) with variables. Throws when a
 * variable is missing, a link leaves Advantage.Bid, an em dash appears, or a listing message would go
 * out without its postal address and unsubscribe link.
 */
function render(template, vars) {
  const v = Object.assign({}, vars);
  if (template.stream === 'claimed_listing' && /\{\{footer\}\}/.test(template.body_text || '')) {
    const f = fill(LISTING_FOOTER, v);
    if (f.missing.length) throw Object.assign(new Error('footer incomplete: ' + f.missing.join(', ')), { code: 'FOOTER_INCOMPLETE' });
    v.footer = f.text;
  }
  const subject = fill(template.subject, v);
  const body = fill(template.body_text, v);
  const pre = template.preheader ? fill(template.preheader, v) : { text: null, missing: [] };
  const missing = [...new Set([...subject.missing, ...body.missing, ...pre.missing])];
  if (missing.length) throw Object.assign(new Error('missing template variables: ' + missing.join(', ')), { code: 'TEMPLATE_VARIABLES' });
  const text = body.text.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  for (const s of [subject.text, text, pre.text || '']) {
    if (EM_DASH.test(s)) throw Object.assign(new Error('em dash in rendered copy'), { code: 'EM_DASH' });
  }
  const links = text.match(/https?:\/\/[^\s)]+/g) || [];
  const foreign = links.filter((u) => !ALLOWED_LINK_HOST.test(u));
  if (foreign.length) throw Object.assign(new Error('link outside Advantage.Bid: ' + foreign[0]), { code: 'FOREIGN_LINK' });
  return { subject: subject.text, preheader: pre.text, text, html: htmlFromText(text, pre.text) };
}

/** Load the catalogue as DRAFT v1 rows (idempotent; never touches an existing version). */
async function seedDrafts({ actorId = null, runner = db } = {}) {
  let created = 0;
  for (const [key, t] of Object.entries(CATALOGUE)) {
    const r = await runner.query(
      `INSERT INTO listing_outreach_templates (template_key, version, stream, subject, preheader, body_text, body_html, status, created_by, notes)
       SELECT $1, 1, $2, $3, $4, $5, $6, 'draft', $7, 'Blueprint copy, Desktop Marketing 2026-09-24'
        WHERE NOT EXISTS (SELECT 1 FROM listing_outreach_templates WHERE template_key = $1)`,
      [key, t.stream, t.subject, t.preheader, t.text, htmlFromText(t.text, t.preheader), actorId]);
    created += r.rowCount;
  }
  return { created };
}

/** Approve one draft version (Super Admin). The trigger makes it immutable from here on. */
async function approve(templateId, { actorId }, runner = db) {
  if (!actorId) throw new Error('an approving administrator is required');
  const r = await runner.query(
    `UPDATE listing_outreach_templates SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'draft' RETURNING *`, [templateId, actorId]);
  return r.rows[0] || null;
}

async function approvedVersion(templateId, runner = db) {
  return (await runner.query(`SELECT * FROM listing_outreach_templates WHERE id = $1 AND status = 'approved'`, [templateId])).rows[0] || null;
}

module.exports = { CATALOGUE, LISTING_TEMPLATES, STEP_TEMPLATE, LISTING_FOOTER, render, fill, htmlFromText, seedDrafts, approve, approvedVersion, ALLOWED_LINK_HOST };

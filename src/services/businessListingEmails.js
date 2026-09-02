'use strict';

/**
 * businessListingEmails — welcome email for a FREE Business Listing (created or claimed).
 * Pure builder; the caller sends via emailService.sendEmail (best-effort, deduped by the
 * one-time create/claim transition). Neutral, accurate copy — no "AI"/vendor terms, no overselling.
 * Mentions Professional Seller as an OPTIONAL upgrade (never as a required paid membership).
 */

const company = require('../lib/companyContact');

const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** @param {{companyName?:string, claimed?:boolean}} opts */
function buildWelcomeEmail({ companyName, claimed = false } = {}) {
  const co = esc(companyName || 'your business');
  const profileUrl = `${APP_BASE}/org/profile.html`;
  const eventsUrl = `${APP_BASE}/org/events.html`;
  const proUrl = `${APP_BASE}/professional-sellers.html`;
  const verb = claimed ? 'claimed' : 'created';
  const subject = `Your Advantage.Bid business listing — ${companyName || 'welcome'}`;
  const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#222;max-width:560px">
    <h2 style="margin:0 0 4px">Your business listing is ready</h2>
    <p style="color:#555;margin:0 0 16px">${co} is now ${esc(verb)} on Advantage.Bid — it's yours to manage.</p>
    <p style="margin:0 0 8px"><b>What you can do now (free — no monthly fee):</b></p>
    <ul style="margin:0 0 16px;padding-left:20px;color:#333;line-height:1.6">
      <li>Complete your company profile — logo, description, contact info, website, and social links.</li>
      <li>Publish your qualifying upcoming auctions and events (up to 3 active at a time).</li>
      <li>Publish your profile so buyers can find your company page.</li>
    </ul>
    <p style="margin:0 0 16px">
      <a href="${profileUrl}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">Manage my business profile</a>
      &nbsp; <a href="${eventsUrl}" style="color:#2563eb">Add an event →</a>
    </p>
    <p style="color:#475569;font-size:13px;margin:16px 0 0">Want to run online auctions or sell directly through Advantage.Bid? That's <a href="${proUrl}" style="color:#2563eb">Professional Seller</a> — an optional upgrade you can add anytime. It is never required for your free listing.</p>
    <p style="color:#475569;font-size:13px;margin-top:16px">Questions? <a href="mailto:info@advantage.bid" style="color:#2563eb">info@advantage.bid</a> · <a href="${company.TEL_HREF}" style="color:#2563eb">${company.PHONE_DISPLAY}</a></p>
  </div>`;
  const text = `Your Advantage.Bid business listing is ready.\n\n`
    + `${companyName || 'Your business'} is now ${verb} — it's yours to manage (free, no monthly fee).\n\n`
    + `You can now:\n`
    + `  - Complete your company profile (logo, description, contact, website, social links)\n`
    + `  - Publish qualifying upcoming auctions and events (up to 3 active at a time)\n`
    + `  - Publish your profile so buyers can find your company page\n\n`
    + `Manage your profile: ${profileUrl}\nAdd an event: ${eventsUrl}\n\n`
    + `Optional upgrade: to run online auctions or sell directly through Advantage.Bid, become a Professional Seller (never required for your free listing): ${proUrl}\n\n`
    + `Questions? info@advantage.bid · ${company.PHONE_DISPLAY}`;
  return { subject, html, text };
}

// ── Review-lifecycle emails (submit → approve / changes / reject) ────────────────
function shell(heading, lead, bodyHtml, ctaHref, ctaLabel) {
  return `<div style="font-family:system-ui,Arial,sans-serif;color:#222;max-width:560px">
    <h2 style="margin:0 0 4px">${heading}</h2>
    <p style="color:#555;margin:0 0 16px">${lead}</p>
    ${bodyHtml || ''}
    ${ctaHref ? `<p style="margin:16px 0"><a href="${ctaHref}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">${ctaLabel}</a></p>` : ''}
    <p style="color:#475569;font-size:13px;margin-top:16px">Questions? <a href="mailto:info@advantage.bid" style="color:#2563eb">info@advantage.bid</a> · <a href="${company.TEL_HREF}" style="color:#2563eb">${company.PHONE_DISPLAY}</a></p>
  </div>`;
}

function buildSubmittedEmail({ companyName } = {}) {
  const co = esc(companyName || 'your business');
  return {
    subject: `We received your business listing — ${companyName || 'Advantage.Bid'}`,
    html: shell('Your business listing was submitted for review',
      `Thanks — we've received the listing for <b>${co}</b>.`,
      `<p style="margin:0 0 12px">Our team will review it shortly. Once approved, your company profile can appear in Advantage.Bid search and you can begin promoting your eligible upcoming events. We'll email you when the review is complete.</p>`,
      `${APP_BASE}/org/submit-listing.html`, 'View listing status'),
    text: `We received the business listing for ${companyName || 'your business'}. Our team will review it shortly; once approved, your company profile can appear in Advantage.Bid search and you can promote eligible upcoming events. Status: ${APP_BASE}/org/submit-listing.html`,
  };
}

function buildApprovedEmail({ companyName, slug } = {}) {
  const co = esc(companyName || 'your business');
  const profileUrl = slug ? `${APP_BASE}/pro.html?slug=${encodeURIComponent(slug)}` : `${APP_BASE}/org/profile.html`;
  return {
    subject: `You're live on Advantage.Bid — ${companyName || 'your business'}`,
    html: shell('Your business listing is approved and live',
      `<b>${co}</b> is now published on Advantage.Bid.`,
      `<p style="margin:0 0 12px">Your company profile can now appear in Advantage.Bid search, and you can promote your upcoming estate sales and auctions (up to 3 active at a time) — free.</p>
       <p style="margin:0 0 12px"><a href="${profileUrl}" style="color:#2563eb">View your public profile</a> · <a href="${APP_BASE}/org/event-new.html" style="color:#2563eb">Add an upcoming event</a></p>`,
      `${APP_BASE}/org/profile.html`, 'Manage my business'),
    text: `${companyName || 'Your business'} is approved and live on Advantage.Bid. Your profile can appear in search and you can promote upcoming estate sales and auctions (up to 3 active). Public profile: ${profileUrl} · Manage: ${APP_BASE}/org/profile.html`,
  };
}

function buildChangesRequestedEmail({ companyName, reason } = {}) {
  const co = esc(companyName || 'your business');
  return {
    subject: `A quick change needed on your business listing — ${companyName || 'Advantage.Bid'}`,
    html: shell('We need a small change before publishing',
      `Thanks for submitting <b>${co}</b>. Before we can publish it, please take a look at the note below.`,
      `<blockquote style="border-left:3px solid #c8a86b;padding-left:12px;color:#333;margin:0 0 12px">${esc(reason || 'Please review and complete your listing details.')}</blockquote>
       <p style="margin:0 0 12px">Update your listing and resubmit — no need to start over.</p>`,
      `${APP_BASE}/org/submit-listing.html`, 'Update &amp; resubmit'),
    text: `Before we publish ${companyName || 'your business'}, please address: ${reason || 'review and complete your listing details.'} Update and resubmit: ${APP_BASE}/org/submit-listing.html`,
  };
}

function buildRejectedEmail({ companyName, reason } = {}) {
  const co = esc(companyName || 'your business');
  return {
    subject: `About your Advantage.Bid business listing — ${companyName || ''}`.trim(),
    html: shell('Your business listing was not approved',
      `We reviewed the listing for <b>${co}</b> and are unable to publish it at this time.`,
      `<blockquote style="border-left:3px solid #dc2626;padding-left:12px;color:#333;margin:0 0 12px">${esc(reason || 'It did not meet our listing requirements.')}</blockquote>
       <p style="margin:0 0 12px">If you believe this was in error, reply to this email and we'll take another look.</p>`,
      null, null),
    text: `We reviewed ${companyName || 'your business'} and are unable to publish it at this time. Reason: ${reason || 'It did not meet our listing requirements.'} Reply to this email if you believe this was in error.`,
  };
}

module.exports = {
  buildWelcomeEmail, buildSubmittedEmail, buildApprovedEmail, buildChangesRequestedEmail, buildRejectedEmail,
};

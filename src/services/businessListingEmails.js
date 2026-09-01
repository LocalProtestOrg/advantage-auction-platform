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

module.exports = { buildWelcomeEmail };

'use strict';

/**
 * professionalSellerEmails — builder(s) for the Professional Seller application/welcome email.
 * Pure builders (subject/html/text); the caller sends via emailService.sendEmail (best-effort).
 * No "AI"/vendor terminology; neutral, accurate copy that matches the actual onboarding gates
 * (agreement → business verification → Stripe Connect payouts). Mirrors the appraiser/estate-sale
 * email module conventions.
 */

const company = require('../lib/companyContact');

const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Application/welcome email sent at the authoritative professional-enrollment transition.
 * Confirms enrollment + current status + the exact remaining steps, with a safe link back into onboarding.
 */
function buildApplicationEmail({ companyName, sellerTypeLabel } = {}) {
  const co = esc(companyName || 'your business');
  const type = esc(sellerTypeLabel || 'Professional Seller');
  const dash = `${APP_BASE}/app.html`;
  const subject = `Your Advantage.Bid Professional Seller enrollment — ${companyName || 'welcome'}`;
  const steps = [
    'Accept your Professional Seller agreement (if you have not already).',
    'Advantage.Bid verifies your business before your first sale can go live — your work is saved while we review.',
    'Set up direct-deposit payouts (Stripe Connect) so proceeds can be released to you.',
  ];
  const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#222;max-width:560px">
    <h2 style="margin:0 0 4px">Welcome to Advantage.Bid, ${co}</h2>
    <p style="color:#555;margin:0 0 16px">Professional Seller enrollment received — <b>${type}</b>.</p>
    <p style="margin:0 0 10px">Your seller workspace is enabled. Here is what remains before your first sale can go live:</p>
    <ol style="margin:0 0 16px;padding-left:20px;color:#333;line-height:1.6">
      ${steps.map((s) => `<li>${esc(s)}</li>`).join('')}
    </ol>
    <p style="margin:0 0 16px">You can begin building your catalog now — publishing unlocks automatically once your business is verified.</p>
    <p><a href="${dash}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">Open my seller dashboard</a></p>
    <p style="color:#475569;font-size:13px;margin-top:20px">Questions? <a href="mailto:info@advantage.bid" style="color:#2563eb">info@advantage.bid</a> · <a href="${company.TEL_HREF}" style="color:#2563eb">${company.PHONE_DISPLAY}</a></p>
  </div>`;
  const text = `Welcome to Advantage.Bid, ${companyName || 'your business'}.\n\n`
    + `Professional Seller enrollment received (${sellerTypeLabel || 'Professional Seller'}). Your seller workspace is enabled.\n\n`
    + `Remaining steps before your first sale goes live:\n`
    + steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
    + `\n\nYou can build your catalog now; publishing unlocks once your business is verified.\n\n`
    + `Open your dashboard: ${dash}\nQuestions? info@advantage.bid · ${company.PHONE_DISPLAY}`;
  return { subject, html, text };
}

module.exports = { buildApplicationEmail };

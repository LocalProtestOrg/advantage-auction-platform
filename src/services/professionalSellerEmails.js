'use strict';

/**
 * professionalSellerEmails: the Professional Seller welcome email (owner request 2026-11-05). Pure builder
 * (subject/html/text); delivered once per seller by sellerWelcomeEmailService (outbox, migration 221).
 *
 * Copy rules: short and benefit-led; no "AI" or vendor names; no long dashes; Title Case button; never says purchasing,
 * checkout, payments or payouts are active, and never implies registration approves the seller to sell or be paid
 * (business verification and the seller agreement come first). Sellers always reach buyers on Advantage.Bid as well as
 * their own website (no website-only option). Contains only the company name the seller typed: no account details.
 */

const company = require('../lib/companyContact');

const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The verified authenticated dashboard (the member area; /seller-dashboard.html redirects here, and registration lands here).
const LINKS = Object.freeze({
  dashboard: `${APP_BASE}/app.html`,
  demo: `${APP_BASE}/seller-demo`,
  howTo: `${APP_BASE}/seller-how-to`,
  logo: `${APP_BASE}/img/brand/advantage-bid-logo-white.png`,
});

function buildWelcomeEmail({ companyName } = {}) {
  const name = String(companyName || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const subject = name ? `Welcome to Advantage.Bid, ${name}` : 'Welcome to Advantage.Bid';
  const hi = name ? `Welcome to Advantage.Bid, ${esc(name)}` : 'Welcome to Advantage.Bid';
  const resource = (href, title, line) => `<tr><td style="padding:12px 0;border-top:1px solid #e6eaef">
      <a href="${href}" style="color:#1a56db;font-weight:700;font-size:16px;text-decoration:none">${title} &rsaquo;</a>
      <div style="color:#475569;font-size:14px;line-height:1.5;margin-top:3px">${line}</div></td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#f4f6f9;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<div style="display:none;max-height:0;overflow:hidden">Your seller tools are ready. Here is where to start.</div>
<div style="max-width:600px;margin:0 auto;padding:24px 14px">
  <div style="background:#071629;border-radius:12px 12px 0 0;padding:18px 22px"><img src="${LINKS.logo}" alt="Advantage.Bid" width="190" style="display:block;width:190px;max-width:60%;height:auto;border:0"></div>
  <div style="background:#ffffff;border:1px solid #e6eaef;border-top:0;border-radius:0 0 12px 12px;padding:24px 22px">
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#0f172a">${hi}</h1>
    <p style="margin:0 0 12px;font-size:16px;line-height:1.6">Thank you for joining. Your Professional Seller account is ready, with tools to help you organize inventory, reach more buyers and grow your business.</p>
    <p style="margin:0 0 20px;font-size:16px;line-height:1.6">Show your merchandise on your own branded storefront and your own website, while the same listings reach buyers across the Advantage.Bid marketplace.</p>
    <p style="margin:0 0 22px"><a href="${LINKS.dashboard}" style="display:inline-block;background:#d62828;color:#ffffff;font-weight:700;font-size:16px;text-decoration:none;padding:13px 22px;border-radius:10px">Go To Your Seller Dashboard</a></p>
    <p style="margin:0 0 2px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#64748b">Start here</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      ${resource(LINKS.demo, 'Seller Demo', 'A quick look at your branded storefront, your inventory, and selling on your own website and the Advantage.Bid marketplace.')}
      ${resource(LINKS.howTo, 'Seller How To Center', 'Practical guides for auctions, photography, lots and pickup instructions, plus printable lot labels and checklists.')}
    </table>
    <div style="margin:18px 0 0;padding:14px 16px;background:#f8fafc;border:1px solid #e6eaef;border-radius:10px;font-size:14px;line-height:1.55;color:#334155">
      <b style="color:#0f172a">Before your first sale goes live</b><br>
      Review and sign your Professional Seller agreement, if you have not already. Advantage.Bid then verifies your business. While we review, you can set up your storefront, add inventory with Smart Catalog Tools and build your auctions.
    </div>
    <p style="margin:22px 0 0;font-size:16px;line-height:1.6">Get The Advantage.<br><span style="color:#475569">The Advantage.Bid Team</span></p>
  </div>
  <p style="text-align:center;color:#64748b;font-size:12.5px;line-height:1.6;margin:14px 0 0">Questions? <a href="mailto:${company.SUPPORT_EMAIL}" style="color:#1a56db">${company.SUPPORT_EMAIL}</a> &middot; <a href="${company.TEL_HREF}" style="color:#1a56db">${company.PHONE_DISPLAY}</a><br>${company.OFFICE_HOURS}</p>
  <p style="text-align:center;color:#94a3b8;font-size:11.5px;line-height:1.6;margin:8px 0 0">You received this email because you registered a Professional Seller account on Advantage.Bid.</p>
</div></body></html>`;
  const text = [
    name ? `Welcome to Advantage.Bid, ${name}.` : 'Welcome to Advantage.Bid.',
    '',
    'Thank you for joining. Your Professional Seller account is ready, with tools to help you organize inventory, reach more buyers and grow your business.',
    'Show your merchandise on your own branded storefront and your own website, while the same listings reach buyers across the Advantage.Bid marketplace.',
    '',
    `Go To Your Seller Dashboard: ${LINKS.dashboard}`,
    '',
    'Start here:',
    `Seller Demo: ${LINKS.demo}`,
    `Seller How To Center: ${LINKS.howTo}`,
    '',
    'Before your first sale goes live: review and sign your Professional Seller agreement, if you have not already. Advantage.Bid then verifies your business. While we review, you can set up your storefront, add inventory with Smart Catalog Tools and build your auctions.',
    '',
    'Get The Advantage.',
    'The Advantage.Bid Team',
    '',
    `Questions? ${company.SUPPORT_EMAIL} | ${company.PHONE_DISPLAY} | ${company.OFFICE_HOURS}`,
  ].join('\n');
  return { subject, html, text };
}

module.exports = { buildWelcomeEmail, LINKS };

'use strict';

/**
 * Estate Sale Promotion transactional emails (Phase 2B). Inline-HTML builders in the platform
 * convention (Advantage.Bid header, system-ui). Customer language only — never "credit/entitlement/
 * organization". Returns { subject, html, text } for emailService.sendEmail. No invented legal copy.
 */
const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const SUPPORT = 'info@advantage.bid';

function shell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#111">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#0f172a;border-radius:12px 12px 0 0;padding:18px 22px"><span style="color:#fff;font-weight:800;font-size:18px">Advantage<span style="color:#5b8cff">.Bid</span></span></div>
    <div style="background:#fff;border:1px solid #e6eaef;border-top:0;border-radius:0 0 12px 12px;padding:22px">
      <h1 style="margin:0 0 12px;font-size:19px;color:#0f172a">${title}</h1>
      ${bodyHtml}
      <p style="margin:22px 0 0;font-size:12.5px;color:#8a97a6">Questions? Contact us at <a href="mailto:${SUPPORT}" style="color:#2563eb">${SUPPORT}</a>.</p>
    </div>
    <p style="text-align:center;color:#9aa6b3;font-size:11.5px;margin:14px 0 0">Advantage Auction Company</p>
  </div></body></html>`;
}
function btn(href, label) { return `<p style="margin:16px 0"><a href="${href}" style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:11px 18px;border-radius:10px">${label}</a></p>`; }

/** Payment confirmation for the $39 one-time Estate Sale Promotion. */
function buildReceiptEmail() {
  const url = `${APP_BASE}/my-estate-sales.html`;
  const subject = 'Your Estate Sale Promotion receipt';
  const html = shell('Thank you for your purchase', `
    <p style="margin:0 0 10px;font-size:14.5px;line-height:1.5">We received your payment of <b>$39.00</b> for one Estate Sale Promotion on Advantage.Bid.</p>
    <p style="margin:0 0 4px;font-size:14.5px;line-height:1.5">You're all set to create your estate sale listing.</p>
    ${btn(url, 'Create Your Estate Sale')}`);
  const text = `Thank you. We received your $39.00 payment for one Estate Sale Promotion.\n\nCreate your estate sale: ${url}\n\nAdvantage Auction Company`;
  return { subject, html, text };
}
/** Submitted for review. */
function buildReceivedEmail() {
  const url = `${APP_BASE}/my-estate-sales.html`;
  const subject = "We've received your estate sale";
  const html = shell('Your estate sale is in review', `
    <p style="margin:0 0 10px;font-size:14.5px;line-height:1.5">Thanks for submitting your estate sale. Our team reviews every listing before it goes live, usually within one business day.</p>
    <p style="margin:0 0 4px;font-size:14.5px;line-height:1.5">We'll email you as soon as it's published.</p>
    ${btn(url, 'View My Estate Sale')}`);
  const text = `Thanks for submitting your estate sale. We review every listing before it goes live, usually within one business day. We'll email you when it's published.\n\n${url}\n\nAdvantage Auction Company`;
  return { subject, html, text };
}
/** Approved & published. */
function buildPublishedEmail(extra) {
  const slug = (extra && extra.slug) || '';
  const url = slug ? `${APP_BASE}/event.html?slug=${encodeURIComponent(slug)}` : `${APP_BASE}/my-estate-sales.html`;
  const subject = 'Your estate sale is live on Advantage.Bid';
  const html = shell('Your estate sale is live', `
    <p style="margin:0 0 10px;font-size:14.5px;line-height:1.5">Great news. Your estate sale is now published on Advantage.Bid and visible to shoppers on the map and in search.</p>
    ${btn(url, 'View My Live Listing')}`);
  const text = `Your estate sale is now live on Advantage.Bid, visible to shoppers on the map and in search.\n\n${url}\n\nAdvantage Auction Company`;
  return { subject, html, text };
}
/** Needs changes (rejected with a reason). */
function buildNeedsChangesEmail(extra) {
  const url = `${APP_BASE}/my-estate-sales.html`;
  const reason = (extra && extra.reason) ? String(extra.reason) : '';
  const subject = 'A quick change is needed for your estate sale';
  const html = shell('Your estate sale needs a small change', `
    <p style="margin:0 0 10px;font-size:14.5px;line-height:1.5">Our reviewers asked for a small update before your estate sale can be published.</p>
    ${reason ? `<p style="margin:0 0 10px;font-size:14px;line-height:1.5;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:10px 12px;color:#9a3412"><b>What to update:</b> ${reason.replace(/[<>&]/g, '')}</p>` : ''}
    <p style="margin:0 0 4px;font-size:14.5px;line-height:1.5">Make the update and resubmit. There is no additional charge to resubmit the same listing.</p>
    ${btn(url, 'Edit My Estate Sale')}`);
  const text = `Our reviewers asked for a small update before your estate sale can be published.${reason ? `\n\nWhat to update: ${reason}` : ''}\n\nMake the update and resubmit (no additional charge to resubmit the same listing): ${url}\n\nAdvantage Auction Company`;
  return { subject, html, text };
}

module.exports = { buildReceiptEmail, buildReceivedEmail, buildPublishedEmail, buildNeedsChangesEmail };

'use strict';

/**
 * followerEmails — the Advantage.Bid-controlled branded template for a Professional Seller's
 * "Notify Your Followers" announcement (FOLLOWER_EVENT). The seller supplies only a short custom
 * message; Advantage.Bid owns the entire template, event data, CTA, branding, and the unsubscribe
 * footer. Every seller/event-supplied string is HTML-escaped. The CTA always points back to the
 * Advantage.Bid event detail page (never bypasses the platform).
 *
 * buildFollowerEventEmail(payload, { toAddress, unsubscribeUrl }) → { to, subject, html, text, headers }
 */

const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const SUPPORT = 'info@advantage.bid';

function escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shell(title, bodyHtml, unsubscribeUrl) {
  const unsub = unsubscribeUrl
    ? `<p style="text-align:center;color:#9aa6b3;font-size:11.5px;margin:12px 0 0;line-height:1.5">
         You're receiving this because you follow this company on Advantage.Bid.<br>
         <a href="${escHtml(unsubscribeUrl)}" style="color:#9aa6b3;text-decoration:underline">Unsubscribe from this company's updates</a>
         &nbsp;·&nbsp;
         <a href="${escHtml(unsubscribeUrl)}&amp;scope=all" style="color:#9aa6b3;text-decoration:underline">Stop all follower emails</a>
       </p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#111">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#0f172a;border-radius:12px 12px 0 0;padding:18px 22px"><span style="color:#fff;font-weight:800;font-size:18px">Advantage<span style="color:#5b8cff">.Bid</span></span></div>
    <div style="background:#fff;border:1px solid #e6eaef;border-top:0;border-radius:0 0 12px 12px;padding:22px">
      <h1 style="margin:0 0 12px;font-size:19px;color:#0f172a">${title}</h1>
      ${bodyHtml}
      <p style="margin:22px 0 0;font-size:12.5px;color:#8a97a6">Questions? Contact us at <a href="mailto:${SUPPORT}" style="color:#2563eb">${SUPPORT}</a>.</p>
    </div>
    <p style="text-align:center;color:#9aa6b3;font-size:11.5px;margin:14px 0 0">Advantage.Bid</p>
    ${unsub}
  </div></body></html>`;
}
function btn(href, label) {
  return `<p style="margin:16px 0"><a href="${escHtml(href)}" style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:11px 18px;border-radius:10px">${escHtml(label)}</a></p>`;
}

// Friendly noun for the CTA/subject by sale type.
function typeNoun(saleType) {
  if (saleType === 'estate_sale') return 'estate sale';
  if (saleType === 'auction') return 'auction';
  return 'event';
}

/**
 * payload (snapshot stored on the queue row):
 *   { campaign_id, seller_id, event_id, company_name, event_title, event_url,
 *     image_url, date_line, location_line, sale_type, custom_message }
 */
function buildFollowerEventEmail(payload, opts = {}) {
  payload = payload || {};
  const toAddress = opts.toAddress;
  const unsubscribeUrl = opts.unsubscribeUrl || null;
  const company = payload.company_name || 'A company you follow';
  const title = payload.event_title || 'A new event';
  const noun = typeNoun(payload.sale_type);
  const eventUrl = payload.event_url || `${APP_BASE}/upcoming-auctions.html`;

  const img = payload.image_url && /^https?:\/\//i.test(payload.image_url)
    ? `<p style="margin:0 0 14px"><img src="${escHtml(payload.image_url)}" alt="${escHtml(title)}" style="width:100%;max-width:512px;border-radius:10px;display:block"></p>`
    : '';
  const facts = [];
  if (payload.date_line) facts.push(`<li style="margin:2px 0"><strong>When:</strong> ${escHtml(payload.date_line)}</li>`);
  if (payload.location_line) facts.push(`<li style="margin:2px 0"><strong>Where:</strong> ${escHtml(payload.location_line)}</li>`);
  const factsHtml = facts.length ? `<ul style="margin:0 0 12px;padding-left:18px;font-size:14px;color:#374151;line-height:1.5">${facts.join('')}</ul>` : '';
  const custom = payload.custom_message
    ? `<div style="margin:0 0 14px;padding:12px 14px;background:#f8fafc;border:1px solid #e6eaef;border-radius:10px;font-size:14.5px;line-height:1.55;color:#111">${escHtml(payload.custom_message)}</div>`
    : '';

  const subject = `${company}: ${title}`;
  const html = shell(
    `${escHtml(company)} has a new ${escHtml(noun)}`,
    `${img}
     <p style="margin:0 0 10px;font-size:14.5px;line-height:1.5"><strong>${escHtml(company)}</strong> just published a new ${escHtml(noun)} on Advantage.Bid: <strong>${escHtml(title)}</strong>.</p>
     ${factsHtml}
     ${custom}
     ${btn(eventUrl, 'View Event')}`,
    unsubscribeUrl
  );
  const textLines = [
    `${company} just published a new ${noun} on Advantage.Bid: ${title}.`,
    payload.date_line ? `When: ${payload.date_line}` : '',
    payload.location_line ? `Where: ${payload.location_line}` : '',
    payload.custom_message ? `\n${payload.custom_message}` : '',
    `\nView Event: ${eventUrl}`,
    unsubscribeUrl ? `\nUnsubscribe from this company's updates: ${unsubscribeUrl}` : '',
    `\nAdvantage.Bid`,
  ].filter(Boolean);

  const headers = unsubscribeUrl
    ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : undefined;

  return { to: toAddress, subject, html, text: textLines.join('\n'), ...(headers ? { headers } : {}) };
}

module.exports = { buildFollowerEventEmail, escHtml };

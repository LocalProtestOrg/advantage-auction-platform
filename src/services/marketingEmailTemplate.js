'use strict';

/**
 * marketingEmailTemplate — the shared Advantage.Bid MARKETING email shell + the Local Event Alert
 * renderer (single event + digest). Pure (no I/O). Advantage.Bid owns 100% of the template; only
 * FACTUAL, already-public event data is inserted (title, location, date, image, canonical URL). It never
 * invents distance, availability, values, scarcity, or popularity.
 *
 * Every marketing email carries: branding, mobile-responsive layout, a factual CTA, a clean canonical
 * Advantage.Bid URL, a Full-Circle seller-acquisition CTA (secondary), an unsubscribe link + a
 * preference-management link, and required sender/footer info. No AI/vendor terminology.
 */
const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const SUPPORT = 'info@advantage.bid';
const COMPANY_FOOTER = 'Advantage.Bid';

function escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Friendly noun + CTA verb per event kind (vocabulary appropriate to the event type).
function kindNoun(kind) {
  if (kind === 'estate_sale') return 'estate sale';
  if (kind === 'partner_event' || kind === 'auction') return 'auction';
  return 'event';
}
function kindCta(kind) {
  if (kind === 'estate_sale') return 'View Estate Sale';
  if (kind === 'partner_event' || kind === 'auction') return 'View Auction';
  return 'See Event';
}

function shell(title, bodyHtml, { unsubscribeUrl, preferencesUrl } = {}) {
  const links = [];
  if (preferencesUrl) links.push(`<a href="${escHtml(preferencesUrl)}" style="color:#9aa6b3;text-decoration:underline">Manage preferences</a>`);
  if (unsubscribeUrl) links.push(`<a href="${escHtml(unsubscribeUrl)}" style="color:#9aa6b3;text-decoration:underline">Unsubscribe</a>`);
  const footer = `<p style="text-align:center;color:#9aa6b3;font-size:11.5px;margin:12px 0 0;line-height:1.6">
      You're receiving this because you asked Advantage.Bid to keep you posted about auctions and estate sales near you.<br>
      ${links.join('&nbsp;·&nbsp;')}
    </p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;background:#f4f6f9;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#111">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px">
    <div style="background:#0f172a;border-radius:12px 12px 0 0;padding:18px 22px"><span style="color:#fff;font-weight:800;font-size:18px">Advantage<span style="color:#5b8cff">.Bid</span></span></div>
    <div style="background:#fff;border:1px solid #e6eaef;border-top:0;border-radius:0 0 12px 12px;padding:22px">
      <h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;line-height:1.3">${title}</h1>
      ${bodyHtml}
      <p style="margin:22px 0 0;font-size:12.5px;color:#8a97a6">Questions? Contact us at <a href="mailto:${SUPPORT}" style="color:#2563eb">${SUPPORT}</a>.</p>
    </div>
    <p style="text-align:center;color:#9aa6b3;font-size:11.5px;margin:14px 0 2px">${escHtml(COMPANY_FOOTER)}</p>
    ${footer}
  </div></body></html>`;
}

function btn(href, label, primary = true) {
  const bg = primary ? '#2563eb' : 'transparent';
  const color = primary ? '#fff' : '#2563eb';
  const border = primary ? 'none' : '1px solid #2563eb';
  return `<a href="${escHtml(href)}" style="display:inline-block;background:${bg};color:${color};border:${border};font-weight:700;font-size:14px;text-decoration:none;padding:11px 18px;border-radius:10px">${escHtml(label)}</a>`;
}

// The Full-Circle seller-acquisition CTA (secondary; never overwhelms the event).
function fullCircleBlock() {
  const url = `${APP_BASE}/start-selling.html`;
  return `<div style="margin:22px 0 0;padding:14px 16px;background:#f8fafc;border:1px solid #e6eaef;border-radius:10px">
      <p style="margin:0 0 8px;font-size:14px;color:#374151">Have an estate or collection to sell?</p>
      ${btn(url, 'Sell with Advantage.Bid', false)}
    </div>`;
}

// Render one event card (image + facts + CTA). `ev` is a FACTUAL, already-public event object:
// { kind, title, city, state, date_line, image_url, url }.
function eventCard(ev) {
  const noun = kindNoun(ev.kind);
  const img = ev.image_url && /^https?:\/\//i.test(ev.image_url)
    ? `<p style="margin:0 0 12px"><img src="${escHtml(ev.image_url)}" alt="${escHtml(ev.title || noun)}" style="width:100%;max-width:552px;border-radius:10px;display:block"></p>` : '';
  const loc = [ev.city, ev.state].filter(Boolean).join(', ');
  const facts = [];
  if (loc) facts.push(`<li style="margin:2px 0"><strong>Where:</strong> ${escHtml(loc)}</li>`);
  if (ev.date_line) facts.push(`<li style="margin:2px 0"><strong>When:</strong> ${escHtml(ev.date_line)}</li>`);
  const factsHtml = facts.length ? `<ul style="margin:0 0 12px;padding-left:18px;font-size:14px;color:#374151;line-height:1.5">${facts.join('')}</ul>` : '';
  return `<div style="margin:0 0 18px;padding-bottom:16px;border-bottom:1px solid #eef1f5">
      ${img}
      <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#0f172a">${escHtml(ev.title || 'Upcoming ' + noun)}</p>
      ${factsHtml}
      <p style="margin:12px 0 0">${btn(ev.url, kindCta(ev.kind))}</p>
    </div>`;
}

/**
 * Single Local Event Alert.
 * @param {object} event factual public event: { kind, title, city, state, date_line, image_url, url }
 * @param {object} opts  { locationLabel, unsubscribeUrl, preferencesUrl, fullCircle=true }
 */
function buildLocalEventAlert(event, opts = {}) {
  const noun = kindNoun(event.kind);
  const where = opts.locationLabel || [event.city, event.state].filter(Boolean).join(', ') || 'you';
  const heading = `Upcoming ${noun} near ${where}`;
  const subject = event.title ? `Upcoming ${noun} near ${where}: ${event.title}` : `Upcoming ${noun} near ${where}`;
  const body = `${eventCard(event)}${opts.fullCircle === false ? '' : fullCircleBlock()}`;
  const html = shell(escHtml(heading), body, opts);
  const text = [
    heading,
    event.title || '',
    [event.city, event.state].filter(Boolean).join(', '),
    event.date_line || '',
    `View: ${event.url}`,
    opts.fullCircle === false ? '' : `\nHave an estate to sell? ${APP_BASE}/start-selling.html`,
    opts.unsubscribeUrl ? `\nUnsubscribe: ${opts.unsubscribeUrl}` : '',
    `\n${COMPANY_FOOTER}`,
  ].filter(Boolean).join('\n');
  return { subject, html, text, headers: unsubHeaders(opts) };
}

/**
 * Local Event DIGEST — several nearby events in one email.
 * @param {Array} events factual public events
 * @param {object} opts { locationLabel, unsubscribeUrl, preferencesUrl, fullCircle=true }
 */
function buildLocalEventDigest(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const where = opts.locationLabel || 'you';
  const heading = `${list.length} auctions and estate sales near ${where}`;
  const subject = heading;
  const cards = list.map(eventCard).join('');
  const body = `<p style="margin:0 0 16px;font-size:14.5px;color:#374151;line-height:1.5">Here's what's coming up near ${escHtml(where)}:</p>${cards}${opts.fullCircle === false ? '' : fullCircleBlock()}`;
  const html = shell(escHtml(heading), body, opts);
  const text = [
    heading, '',
    ...list.map((e) => `- ${e.title || kindNoun(e.kind)} (${[e.city, e.state].filter(Boolean).join(', ')}) ${e.url}`),
    opts.unsubscribeUrl ? `\nUnsubscribe: ${opts.unsubscribeUrl}` : '',
    `\n${COMPANY_FOOTER}`,
  ].filter(Boolean).join('\n');
  return { subject, html, text, headers: unsubHeaders(opts) };
}

function unsubHeaders(opts) {
  return opts.unsubscribeUrl
    ? { 'List-Unsubscribe': `<${opts.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : undefined;
}

module.exports = { buildLocalEventAlert, buildLocalEventDigest, shell, escHtml, kindNoun, kindCta, fullCircleBlock, APP_BASE };

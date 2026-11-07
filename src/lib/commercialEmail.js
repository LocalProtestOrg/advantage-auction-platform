'use strict';

/**
 * commercialEmail — the business postal address every commercial email must carry (CAN-SPAM), from the one stored
 * value, platform_config company.postal_address (edited on the Claimed Listings program screen).
 *
 * FAIL CLOSED: when the address is empty, commercial email is refused, exactly like the Claimed Listings send gate.
 * Transactional email (receipts, invoices, account notices) is not affected.
 */

const db = require('../db');

const MISSING_MESSAGE = 'The business postal address (company.postal_address) is not set, so commercial email cannot be sent.';

async function postalAddress(runner = db) {
  try {
    const row = (await runner.query(`SELECT value FROM platform_config WHERE key = 'company.postal_address'`)).rows[0];
    const v = row ? row.value : null;
    return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  } catch (e) {
    console.error('[commercial-email] postal address unreadable:', e.message);
    return '';
  }
}

/** The address, or throws (code POSTAL_ADDRESS_MISSING). */
async function requirePostalAddress(runner = db) {
  const a = await postalAddress(runner);
  if (!a) { const e = new Error(MISSING_MESSAGE); e.code = 'POSTAL_ADDRESS_MISSING'; e.status = 409; e.expose = true; throw e; }
  return a;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The footer line as HTML (escaped). */
function footerHtml(address) {
  return `<p style="text-align:center;color:#9aa6b3;font-size:11.5px;margin:10px 0 0;line-height:1.5">Advantage.Bid, ${esc(address)}</p>`;
}

/**
 * Ensure a rendered message { html, text } carries the address. Leaves it unchanged when the address is already there,
 * otherwise inserts it before the LAST </body> of the HTML and appends it to the text. Pure.
 */
function withPostalAddress(rendered, address) {
  if (!rendered || !address) return rendered;
  const out = Object.assign({}, rendered);
  if (typeof out.html === 'string' && !out.html.includes(esc(address))) {
    const i = out.html.toLowerCase().lastIndexOf('</body>');
    out.html = i === -1 ? out.html + footerHtml(address) : out.html.slice(0, i) + footerHtml(address) + out.html.slice(i);
  }
  if (typeof out.text === 'string' && !out.text.includes(address)) out.text = out.text.replace(/\s+$/, '') + '\n\nAdvantage.Bid, ' + address;
  return out;
}

module.exports = { postalAddress, requirePostalAddress, withPostalAddress, footerHtml, MISSING_MESSAGE };

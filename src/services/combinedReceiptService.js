'use strict';

/**
 * combinedReceiptService — Design C combined per-buyer buyer emails.
 *
 * Mirrors receiptService (direct Amazon SES send via emailService + combined PDF
 * attachment + email_audit logging). Two email families:
 *   - Success package  → sent after the single combined charge settles (PAID).
 *   - Payment required  → sent when the charge failed / no card (Reminder #1),
 *                         and again on the +12h / +24h reminders (#2, Final).
 *
 * FLAG-INERT (Phase 1): deliverQueuedReminder is IMPLEMENTED for the notification
 * worker but NOT registered in it — Phase 2 wires it. Everything is dormant until
 * COMBINED_INVOICING_ENABLED is set.
 *
 * Best-effort: any failure is logged + swallowed so a delivery problem can never
 * roll back or block the settled combined payment.
 */

const db = require('../db');
const { sendEmail } = require('./emailService');
const invoicePdfService = require('./invoicePdfService');
const doc = require('./documentService');
const auditService = require('./auditService');
const pt = require('../lib/pickupTiers');

let SITE_URL = '';
try { SITE_URL = require('../lib/publicUrls').publicBaseUrl(); } catch (_e) { SITE_URL = ''; }

const SUPPORT_EMAIL = 'support@advantage.bid';

// Email visibility: record every combined invoice/receipt send in audit_log. Best-effort.
async function logEmail(eventType, { combinedInvoiceId, to, result, reason, messageId }) {
  try {
    await auditService.logEvent(db, {
      eventType, entityType: 'invoice', entityId: combinedInvoiceId || null,
      metadata: { to: to || null, result, reason: reason || null, messageId: messageId || null, combined: true },
    });
  } catch (_e) { /* visibility logging is best-effort */ }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDateTime(d, tz) {
  if (!d) return null;
  try {
    return new Date(d).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: tz || pt.DEFAULT_TZ,
    });
  } catch (_e) {
    try {
      return new Date(d).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        timeZone: pt.DEFAULT_TZ,
      });
    } catch (__e) { return null; }
  }
}

function windowLabel(start, end, tz) {
  const s = fmtDateTime(start, tz);
  if (!s) return null;
  const e = end ? fmtDateTime(end, tz) : null;
  return e ? (s + ' – ' + e) : s;
}

// Assemble the email payload from the combined header (getCombinedInvoiceData) plus
// pickup lookups (buyer's recommended arrival window/tier + the published window +
// pickup address). Address is read from the auction's plain columns (the same source
// pickupPacketService uses); no encrypted-address decrypt is required on this path.
async function assembleEmailData(combinedInvoiceId, pdfData) {
  const data = pdfData || await invoicePdfService.getCombinedInvoiceData(combinedInvoiceId);
  if (!data) return null;

  const a = (await db.query(
    `SELECT title, timezone, street_address, city, address_state, zip, pickup_window_start, pickup_window_end
       FROM auctions WHERE id = $1`,
    [data.auctionId]
  )).rows[0] || {};

  const pa = (await db.query(
    `SELECT pa.slot_start, pa.slot_end, pa.assigned_tier
       FROM pickup_assignments pa
       JOIN pickup_schedules ps ON ps.id = pa.pickup_schedule_id
      WHERE ps.auction_id = $1 AND pa.buyer_user_id = $2
      ORDER BY pa.slot_start ASC
      LIMIT 1`,
    [data.auctionId, data.buyerUserId]
  )).rows[0] || {};

  const address = [
    a.street_address,
    [a.city, a.address_state].filter(Boolean).join(', '),
    a.zip,
  ].filter(Boolean).join(', ') || null;

  return {
    ...data,
    pickup: {
      address,
      tier: pa.assigned_tier || null,
      recommended: windowLabel(pa.slot_start, pa.slot_end, a.timezone),
      published: windowLabel(a.pickup_window_start, a.pickup_window_end, a.timezone),
    },
  };
}

function summaryRowsHtml(summary) {
  const sumRow = (label, valCents, opts = {}) => {
    const isCredit = !!opts.credit;
    const val = valCents ? ((isCredit ? '-' : '') + doc.money(valCents)) : (opts.bold ? doc.money(0) : '—');
    const color = (!valCents && !opts.bold) ? '#94a3b8' : '#0f172a';
    return '<tr>' +
      '<td style="padding:3px 0;color:' + (opts.bold ? '#0f172a' : '#64748b') + ';font-weight:' + (opts.bold ? '700' : '400') + '">' + esc(label) + '</td>' +
      '<td style="padding:3px 0;text-align:right;color:' + color + ';font-weight:' + (opts.bold ? '700' : '600') + '">' + val + '</td>' +
    '</tr>';
  };
  return sumRow('Hammer Total', summary.hammerCents) +
    sumRow('Buyer Premium', summary.buyerPremiumCents) +
    sumRow('Sales Tax', summary.salesTaxCents) +
    sumRow('Shipping', summary.shippingCents) +
    sumRow('Credits / Refunds', summary.creditsCents, { credit: true }) +
    '<tr><td colspan="2" style="border-top:1px solid #e2e8f0;padding-top:6px"></td></tr>' +
    sumRow('Grand Total', summary.totalCents, { bold: true });
}

function summaryLinesText(summary) {
  return [
    'Hammer Total: ' + doc.money(summary.hammerCents),
    'Buyer Premium: ' + (summary.buyerPremiumCents ? doc.money(summary.buyerPremiumCents) : '—'),
    'Sales Tax: ' + (summary.salesTaxCents ? doc.money(summary.salesTaxCents) : '—'),
    'Shipping: ' + (summary.shippingCents ? doc.money(summary.shippingCents) : '—'),
    'Credits / Refunds: ' + (summary.creditsCents ? ('-' + doc.money(summary.creditsCents)) : '—'),
    'Grand Total: ' + doc.money(summary.totalCents),
  ];
}

function lotLinesHtml(lines) {
  return lines.map((ln) => (
    '<tr>' +
      '<td style="padding:8px 0;border-bottom:1px solid #f1f5f9">' +
        (ln.lotNumber != null ? ('<span style="color:#64748b">#' + esc(ln.lotNumber) + '</span> ') : '') +
        esc(ln.title || 'Lot') +
      '</td>' +
      '<td style="padding:8px 0;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600">' + doc.money(ln.hammerCents) + '</td>' +
    '</tr>'
  )).join('');
}

function button(href, label, color) {
  return '<a href="' + href + '" style="display:inline-block;background:' + (color || '#2563eb') + ';color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:8px;margin:4px 8px 4px 0">' + esc(label) + '</a>';
}

// ── Success package (PAID) ───────────────────────────────────────────────────
function buildSuccessPackageEmail(data) {
  const invoicesUrl = SITE_URL ? (SITE_URL + '/invoices.html') : null;
  const p = data.pickup || {};

  const pickupHtml =
    '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 14px;margin:14px 0;font-size:13px;color:#14532d">' +
      '<div style="font-weight:700;margin-bottom:4px">Pickup</div>' +
      (p.address ? ('<div><strong>Location:</strong> ' + esc(p.address) + '</div>') : '') +
      (p.recommended ? ('<div><strong>Recommended arrival:</strong> ' + esc(p.recommended) + '</div>') : '') +
      (p.published ? ('<div><strong>Pickup window:</strong> ' + esc(p.published) + '</div>') : '') +
    '</div>';

  const html =
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">' +
      '<div style="font-weight:800;font-size:18px;color:#0f172a;padding:8px 0 2px">Advantage Auction</div>' +
      '<div style="font-size:13px;color:#16a34a;font-weight:700;margin-bottom:14px">Payment received — thank you!</div>' +
      (data.auctionTitle ? ('<div style="font-size:13px;color:#64748b">' + esc(data.auctionTitle) + '</div>') : '') +
      '<div style="font-size:15px;font-weight:700;margin:2px 0 4px">Invoice ' + esc(data.invoiceNumber) + '</div>' +
      '<div style="display:inline-block;font-size:12px;font-weight:700;color:#166534;background:#dcfce7;border-radius:5px;padding:2px 8px;margin-bottom:12px">PAID</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:6px">' +
        '<thead><tr>' +
          '<th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;padding-bottom:4px">Lot</th>' +
          '<th style="text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;padding-bottom:4px">Hammer</th>' +
        '</tr></thead><tbody>' + lotLinesHtml(data.lines) + '</tbody>' +
      '</table>' +
      '<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">' + summaryRowsHtml(data.summary) + '</table>' +
      pickupHtml +
      (invoicesUrl ? ('<p style="margin:16px 0 4px">' + button(invoicesUrl, 'View My Purchases', '#2563eb') + button('mailto:' + SUPPORT_EMAIL, 'Need Help?', '#475569') + '</p>') : '') +
      '<p style="font-size:12px;color:#94a3b8;margin-top:14px">Your itemized invoice is attached as a PDF. Advantage Auction never stores your full card details.</p>' +
    '</div>';

  const textLines = [
    'Advantage Auction — Payment received, thank you!',
    '',
    data.auctionTitle ? ('Auction: ' + data.auctionTitle) : null,
    'Invoice: ' + data.invoiceNumber + ' (PAID)',
    '',
    ...data.lines.map((ln) => (ln.lotNumber != null ? ('#' + ln.lotNumber + ' ') : '') + (ln.title || 'Lot') + ' — ' + doc.money(ln.hammerCents)),
    '',
    ...summaryLinesText(data.summary),
    '',
    'Pickup:',
    p.address ? ('  Location: ' + p.address) : null,
    p.recommended ? ('  Recommended arrival: ' + p.recommended) : null,
    p.published ? ('  Pickup window: ' + p.published) : null,
    '',
    invoicesUrl ? ('View My Purchases: ' + invoicesUrl) : null,
    'Need help? ' + SUPPORT_EMAIL,
  ].filter((l) => l !== null);

  return {
    subject: 'Payment receipt — Invoice ' + data.invoiceNumber,
    html,
    text: textLines.join('\n'),
  };
}

// ── Payment required / reminders ─────────────────────────────────────────────
function reminderSubject(invoiceNumber, reminderNo) {
  if (reminderNo >= 3) return 'Final notice — payment required (Invoice ' + invoiceNumber + ')';
  if (reminderNo === 2) return 'Payment reminder — Invoice ' + invoiceNumber;
  return 'Payment required — Invoice ' + invoiceNumber;
}

function buildPaymentRequiredEmail(data, { reminderNo } = {}) {
  const n = reminderNo || 1;
  const invoicesUrl = SITE_URL ? (SITE_URL + '/invoices.html') : null;
  const heading = n >= 3 ? 'Final notice — payment required' : (n === 2 ? 'Payment reminder' : 'Payment required');
  const p = data.pickup || {};

  const pickupHtml = (p.address || p.published)
    ? ('<div style="font-size:12px;color:#64748b;margin:12px 0">' +
        (p.address ? ('Pickup location: ' + esc(p.address) + '<br>') : '') +
        (p.published ? ('Pickup window: ' + esc(p.published)) : '') +
      '</div>')
    : '';

  const html =
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">' +
      '<div style="font-weight:800;font-size:18px;color:#0f172a;padding:8px 0 2px">Advantage Auction</div>' +
      '<div style="font-size:13px;color:#b91c1c;font-weight:800;margin-bottom:12px">' + esc(heading) + '</div>' +
      (data.auctionTitle ? ('<div style="font-size:13px;color:#64748b">' + esc(data.auctionTitle) + '</div>') : '') +
      '<div style="font-size:15px;font-weight:700;margin:2px 0 10px">Invoice ' + esc(data.invoiceNumber) + '</div>' +
      '<div style="background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #b91c1c;border-radius:6px;padding:10px 12px;margin:0 0 14px;font-size:13px;color:#7f1d1d;font-weight:600">' +
        'Payment must be confirmed before items can be picked up or released.' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
        '<thead><tr>' +
          '<th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;padding-bottom:4px">Lot</th>' +
          '<th style="text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;padding-bottom:4px">Hammer</th>' +
        '</tr></thead><tbody>' + lotLinesHtml(data.lines) + '</tbody>' +
      '</table>' +
      '<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">' + summaryRowsHtml(data.summary) + '</table>' +
      pickupHtml +
      (invoicesUrl ? ('<p style="margin:16px 0 4px">' + button(invoicesUrl, 'Complete Payment Now', '#b91c1c') + '</p>') : '') +
      '<p style="font-size:12px;color:#94a3b8;margin-top:14px">Your invoice is attached as a PDF. Advantage Auction never stores your full card details.</p>' +
    '</div>';

  const textLines = [
    'Advantage Auction — ' + heading,
    '',
    data.auctionTitle ? ('Auction: ' + data.auctionTitle) : null,
    'Invoice: ' + data.invoiceNumber,
    '',
    'Payment must be confirmed before items can be picked up or released.',
    '',
    ...data.lines.map((ln) => (ln.lotNumber != null ? ('#' + ln.lotNumber + ' ') : '') + (ln.title || 'Lot') + ' — ' + doc.money(ln.hammerCents)),
    '',
    ...summaryLinesText(data.summary),
    '',
    invoicesUrl ? ('Complete payment now: ' + invoicesUrl) : null,
  ].filter((l) => l !== null);

  return { subject: reminderSubject(data.invoiceNumber, n), html, text: textLines.join('\n') };
}

// ── Send paths (direct SES + attached combined PDF + email_audit) ────────────
async function sendSuccessPackage(combinedInvoiceId) {
  try {
    const pdfData = await invoicePdfService.getCombinedInvoiceData(combinedInvoiceId);
    if (!pdfData) return { sent: false, skipped: true, reason: 'not_found' };
    const data = await assembleEmailData(combinedInvoiceId, pdfData);
    if (!data.buyerEmail) {
      await logEmail('combined_receipt.email_skipped', { combinedInvoiceId, result: 'skipped', reason: 'no_buyer_email' });
      return { sent: false, skipped: true, reason: 'no_buyer_email' };
    }
    const buffer = await invoicePdfService.buildInvoicePdf(pdfData);
    const fileName = 'invoice-' + pdfData.invoiceNumber + '.pdf';
    const { subject, html, text } = buildSuccessPackageEmail(data);
    const result = await sendEmail({
      to: data.buyerEmail, subject, html, text,
      attachments: [{ filename: fileName, content: buffer, contentType: 'application/pdf' }],
    });
    if (result && result.skipped) {
      await logEmail('combined_receipt.email_skipped', { combinedInvoiceId, to: data.buyerEmail, result: 'skipped', reason: 'smtp_unconfigured' });
      return { sent: false, skipped: true, reason: 'smtp_unconfigured' };
    }
    await logEmail('combined_receipt.email_sent', { combinedInvoiceId, to: data.buyerEmail, result: 'sent', messageId: result && result.messageId });
    return { sent: true, messageId: result && result.messageId };
  } catch (err) {
    console.error('[combined-receipt] sendSuccessPackage failed for', combinedInvoiceId, '-', err.message);
    await logEmail('combined_receipt.email_failed', { combinedInvoiceId, result: 'failed', reason: err.message });
    return { sent: false, reason: err.message };
  }
}

async function sendPaymentRequired(combinedInvoiceId, reminderNo) {
  const n = reminderNo || 1;
  try {
    const pdfData = await invoicePdfService.getCombinedInvoiceData(combinedInvoiceId);
    if (!pdfData) return { sent: false, skipped: true, reason: 'not_found' };
    const data = await assembleEmailData(combinedInvoiceId, pdfData);
    if (!data.buyerEmail) {
      await logEmail('combined_invoice.email_skipped', { combinedInvoiceId, result: 'skipped', reason: 'no_buyer_email' });
      return { sent: false, skipped: true, reason: 'no_buyer_email' };
    }
    const buffer = await invoicePdfService.buildInvoicePdf(pdfData);
    const fileName = 'invoice-' + pdfData.invoiceNumber + '.pdf';
    const { subject, html, text } = buildPaymentRequiredEmail(data, { reminderNo: n });
    const result = await sendEmail({
      to: data.buyerEmail, subject, html, text,
      attachments: [{ filename: fileName, content: buffer, contentType: 'application/pdf' }],
    });
    if (result && result.skipped) {
      await logEmail('combined_invoice.email_skipped', { combinedInvoiceId, to: data.buyerEmail, result: 'skipped', reason: 'smtp_unconfigured' });
      return { sent: false, skipped: true, reason: 'smtp_unconfigured' };
    }
    await logEmail('combined_invoice.email_sent', { combinedInvoiceId, to: data.buyerEmail, result: 'sent', reason: 'reminder_' + n, messageId: result && result.messageId });
    return { sent: true, messageId: result && result.messageId };
  } catch (err) {
    console.error('[combined-receipt] sendPaymentRequired failed for', combinedInvoiceId, '-', err.message);
    await logEmail('combined_invoice.email_failed', { combinedInvoiceId, result: 'failed', reason: err.message });
    return { sent: false, reason: err.message };
  }
}

// For the notification worker (Phase 2 will call this on PAYMENT_REMINDER rows).
// Loads the header from row.payload.combined_invoice_id; skips if already paid/void;
// else sends the reminder and bumps reminders_sent. NOT registered in the worker here.
async function deliverQueuedReminder(row) {
  let payload = row && row.payload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_e) { payload = {}; } }
  const combinedInvoiceId = payload && payload.combined_invoice_id;
  const n = (payload && payload.n) || 1;
  if (!combinedInvoiceId) return { skipped: 'no_combined_invoice_id' };

  const combinedSvc = require('./combinedInvoiceService');
  const unpaid = await combinedSvc.stillUnpaid(combinedInvoiceId);
  if (!unpaid) return { skipped: 'already_paid' };

  const result = await sendPaymentRequired(combinedInvoiceId, n);
  await db.query(
    `UPDATE buyer_auction_invoices SET reminders_sent = GREATEST(reminders_sent, $2), updated_at = now() WHERE id = $1`,
    [combinedInvoiceId, n]
  ).catch(() => {});
  return { sent: true, delivery: result };
}

module.exports = {
  buildSuccessPackageEmail,
  buildPaymentRequiredEmail,
  sendSuccessPackage,
  sendPaymentRequired,
  deliverQueuedReminder,
  assembleEmailData,
};

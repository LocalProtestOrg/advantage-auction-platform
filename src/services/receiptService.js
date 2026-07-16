'use strict';

/**
 * receiptService — buyer payment-receipt email.
 *
 * Sent fire-and-forget after a payment settles (recordPaymentSuccess, post-commit).
 * Renders the invoice PDF via invoicePdfService (which also archives it + records
 * history), then delivers an itemized receipt through the same Amazon SES transport
 * (emailService) used by every other buyer email, with the PDF attached.
 *
 * Best-effort: any failure is logged and swallowed so a delivery problem can never
 * roll back or block the settled payment. (A future hardening could move this into
 * the retrying notification queue; for Phase 2 a logged direct send is sufficient
 * and SES-verifiable.)
 */

const db = require('../db');
const { sendEmail } = require('./emailService');
const invoicePdfService = require('./invoicePdfService');
const doc = require('./documentService');
const auditService = require('./auditService');

let SITE_URL = '';
try { SITE_URL = require('../lib/publicUrls').publicBaseUrl(); } catch (_e) { SITE_URL = ''; }

// Phase 2D email visibility: record every invoice/receipt send attempt in audit_log
// so admins can see delivery outcomes via GET /api/admin/audit-log. Best-effort —
// logging must never affect the send result.
async function logEmail(eventType, { invoiceId, paymentId, to, result, reason, messageId }) {
  try {
    await auditService.logEvent(db, {
      eventType, entityType: 'invoice', entityId: invoiceId || null, paymentId: paymentId || null,
      metadata: { to: to || null, result, reason: reason || null, messageId: messageId || null },
    });
  } catch (_e) { /* visibility logging is best-effort */ }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildReceiptEmail(data) {
  const linesHtml = data.lines.map((ln) => (
    '<tr>' +
      '<td style="padding:8px 0;border-bottom:1px solid #f1f5f9">' +
        (ln.lotNumber != null ? ('<span style="color:#64748b">#' + esc(ln.lotNumber) + '</span> ') : '') +
        esc(ln.title || 'Lot') +
      '</td>' +
      '<td style="padding:8px 0;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600">' + doc.money(ln.hammerCents) + '</td>' +
    '</tr>'
  )).join('');

  const sumRow = (label, valCents, opts = {}) => {
    const val = valCents ? doc.money(valCents) : '—';
    const color = (!valCents && !opts.bold) ? '#94a3b8' : '#0f172a';
    return '<tr>' +
      '<td style="padding:3px 0;color:' + (opts.bold ? '#0f172a' : '#64748b') + ';font-weight:' + (opts.bold ? '700' : '400') + '">' + esc(label) + '</td>' +
      '<td style="padding:3px 0;text-align:right;color:' + color + ';font-weight:' + (opts.bold ? '700' : '600') + '">' + val + '</td>' +
    '</tr>';
  };

  const invoicesUrl = SITE_URL ? (SITE_URL + '/invoices.html') : null;

  const html =
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">' +
      doc.emailBrandHeader() +
      '<div style="font-size:13px;color:#16a34a;font-weight:700;margin-bottom:14px">Payment received. Thank you!</div>' +
      (data.auctionTitle ? ('<div style="font-size:13px;color:#64748b">' + esc(data.auctionTitle) + '</div>') : '') +
      '<div style="font-size:15px;font-weight:700;margin:2px 0 14px">Invoice ' + esc(data.invoiceNumber) + '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
        '<thead><tr>' +
          '<th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;padding-bottom:4px">Lot</th>' +
          '<th style="text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;padding-bottom:4px">Hammer</th>' +
        '</tr></thead><tbody>' + linesHtml + '</tbody>' +
      '</table>' +
      '<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">' +
        sumRow('Hammer subtotal', data.summary.hammerCents) +
        sumRow('Buyer premium', data.summary.buyerPremiumCents) +
        sumRow('Sales tax', data.summary.salesTaxCents) +
        sumRow('Shipping', data.summary.shippingCents) +
        '<tr><td colspan="2" style="border-top:1px solid #e2e8f0;padding-top:6px"></td></tr>' +
        sumRow('Total paid', data.summary.totalCents, { bold: true }) +
      '</table>' +
      '<p style="font-size:13px;line-height:1.5;color:#475569;margin:16px 0 4px">Your itemized invoice is attached as a PDF.' +
        (invoicesUrl ? (' You can also view all invoices any time at <a href="' + invoicesUrl + '" style="color:#2563eb">your account</a>.') : '') +
      '</p>' +
      '<p style="font-size:12px;color:#94a3b8;margin-top:14px">Buyer premium, sales tax, and shipping appear as “—” until those features are activated. Advantage.Bid never stores your full card details.</p>' +
    '</div>';

  const textLines = [
    'Advantage.Bid - Payment received, thank you!',
    '',
    data.auctionTitle ? ('Auction: ' + data.auctionTitle) : null,
    'Invoice: ' + data.invoiceNumber,
    '',
    ...data.lines.map((ln) => (ln.lotNumber != null ? ('#' + ln.lotNumber + ' ') : '') + (ln.title || 'Lot') + ' - ' + doc.money(ln.hammerCents)),
    '',
    'Hammer subtotal: ' + doc.money(data.summary.hammerCents),
    'Buyer premium: ' + (data.summary.buyerPremiumCents ? doc.money(data.summary.buyerPremiumCents) : '—'),
    'Sales tax: ' + (data.summary.salesTaxCents ? doc.money(data.summary.salesTaxCents) : '—'),
    'Shipping: ' + (data.summary.shippingCents ? doc.money(data.summary.shippingCents) : '—'),
    'Total paid: ' + doc.money(data.summary.totalCents),
    '',
    'Your itemized invoice PDF is attached.',
    SITE_URL ? ('View all invoices: ' + SITE_URL + '/invoices.html') : null,
  ].filter((l) => l !== null);

  return {
    subject: 'Payment receipt - Invoice ' + data.invoiceNumber,
    html,
    text: textLines.join('\n'),
  };
}

/**
 * Send the payment receipt for a settled payment.
 * @returns {Promise<{sent:boolean, skipped?:boolean, reason?:string, messageId?:string}>}
 */
async function sendPaymentReceipt(paymentId) {
  try {
    const invRes = await db.query('SELECT id FROM invoices WHERE payment_id = $1 LIMIT 1', [paymentId]);
    if (!invRes.rows[0]) {
      console.warn('[receipt] no invoice for payment', paymentId, '— skipping receipt');
      return { sent: false, skipped: true, reason: 'invoice_not_found' };
    }
    const invoiceId = invRes.rows[0].id;

    const { buffer, fileName, data } = await invoicePdfService.generateAndStoreInvoicePdf(invoiceId);
    if (!data.buyerEmail) {
      console.warn('[receipt] buyer has no email for invoice', invoiceId, '— skipping receipt');
      return { sent: false, skipped: true, reason: 'no_buyer_email' };
    }

    const { subject, html, text } = buildReceiptEmail(data);
    const result = await sendEmail({
      to: data.buyerEmail,
      subject,
      html,
      text,
      attachments: [{ filename: fileName, content: buffer, contentType: 'application/pdf' }],
    });

    if (result && result.skipped) {
      console.warn('[receipt] SES not configured — receipt for invoice', invoiceId, 'not delivered');
      await logEmail('receipt.email_skipped', { invoiceId, paymentId, to: data.buyerEmail, result: 'skipped', reason: 'smtp_unconfigured' });
      return { sent: false, skipped: true, reason: 'smtp_unconfigured' };
    }
    console.log('[receipt] sent receipt for invoice', invoiceId, 'to', data.buyerEmail);
    await logEmail('receipt.email_sent', { invoiceId, paymentId, to: data.buyerEmail, result: 'sent', messageId: result && result.messageId });
    return { sent: true, messageId: result && result.messageId };
  } catch (err) {
    console.error('[receipt] sendPaymentReceipt failed for payment', paymentId, '-', err.message);
    await logEmail('receipt.email_failed', { paymentId, result: 'failed', reason: err.message });
    return { sent: false, reason: err.message };
  }
}

// ── Unpaid / issued invoice email (Phase 2C) ─────────────────────────────────
// Sent when an auction closes (one per winning lot) and on admin resend. Clearly
// states payment is required before pickup/release. The paid receipt is separate.
function buildUnpaidInvoiceEmail(data) {
  const linesHtml = data.lines.map((ln) => (
    '<tr>' +
      '<td style="padding:8px 0;border-bottom:1px solid #f1f5f9">' +
        (ln.lotNumber != null ? ('<span style="color:#64748b">#' + esc(ln.lotNumber) + '</span> ') : '') +
        esc(ln.title || 'Lot') +
      '</td>' +
      '<td style="padding:8px 0;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600">' + doc.money(ln.hammerCents) + '</td>' +
    '</tr>'
  )).join('');

  const invoicesUrl = SITE_URL ? (SITE_URL + '/invoices.html') : null;

  const html =
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">' +
      doc.emailBrandHeader() +
      '<div style="font-size:13px;color:#b91c1c;font-weight:800;margin-bottom:12px">Payment required</div>' +
      (data.auctionTitle ? ('<div style="font-size:13px;color:#64748b">' + esc(data.auctionTitle) + '</div>') : '') +
      '<div style="font-size:15px;font-weight:700;margin:2px 0 10px">Invoice ' + esc(data.invoiceNumber) + '</div>' +
      '<p style="line-height:1.5;margin:0 0 12px">Congratulations on your winning bid! The following ' +
        (data.lines.length === 1 ? 'lot is' : 'lots are') + ' awaiting payment.</p>' +
      '<div style="background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #b91c1c;border-radius:6px;padding:10px 12px;margin:0 0 14px;font-size:13px;color:#7f1d1d;font-weight:600">' +
        'Payment must be confirmed before items can be picked up or released.' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
        '<thead><tr>' +
          '<th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;padding-bottom:4px">Lot</th>' +
          '<th style="text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;padding-bottom:4px">Hammer</th>' +
        '</tr></thead><tbody>' + linesHtml + '</tbody>' +
      '</table>' +
      '<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">' +
        '<tr><td style="color:#0f172a;font-weight:700;padding-top:4px">Amount due</td>' +
        '<td style="text-align:right;color:#0f172a;font-weight:800;padding-top:4px">' + doc.money(data.summary.totalCents) + '</td></tr>' +
      '</table>' +
      (invoicesUrl ? ('<p style="margin:16px 0 4px"><a href="' + invoicesUrl + '" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:8px">Pay now →</a></p>') : '') +
      '<p style="font-size:12px;color:#94a3b8;margin-top:14px">Your invoice is attached as a PDF. Buyer premium, sales tax, and shipping appear as “—” until those features are activated. Advantage.Bid never stores your full card details.</p>' +
    '</div>';

  const textLines = [
    'Advantage.Bid - Payment required',
    '',
    data.auctionTitle ? ('Auction: ' + data.auctionTitle) : null,
    'Invoice: ' + data.invoiceNumber,
    '',
    'Payment must be confirmed before items can be picked up or released.',
    '',
    ...data.lines.map((ln) => (ln.lotNumber != null ? ('#' + ln.lotNumber + ' ') : '') + (ln.title || 'Lot') + ' - ' + doc.money(ln.hammerCents)),
    '',
    'Amount due: ' + doc.money(data.summary.totalCents),
    SITE_URL ? ('Pay now: ' + SITE_URL + '/invoices.html') : null,
  ].filter((l) => l !== null);

  return { subject: 'Invoice ' + data.invoiceNumber + ' - payment required', html, text: textLines.join('\n') };
}

/**
 * Send the unpaid/issued invoice email for an invoice (close-time + admin resend).
 * @returns {Promise<{sent:boolean, skipped?:boolean, reason?:string, messageId?:string}>}
 */
async function sendUnpaidInvoiceEmail(invoiceId) {
  try {
    const { buffer, fileName, data } = await invoicePdfService.generateAndStoreInvoicePdf(invoiceId);
    if (!data.buyerEmail) {
      console.warn('[invoice-email] buyer has no email for invoice', invoiceId, '— skipping');
      return { sent: false, skipped: true, reason: 'no_buyer_email' };
    }
    const { subject, html, text } = buildUnpaidInvoiceEmail(data);
    const result = await sendEmail({
      to: data.buyerEmail, subject, html, text,
      attachments: [{ filename: fileName, content: buffer, contentType: 'application/pdf' }],
    });
    if (result && result.skipped) {
      console.warn('[invoice-email] SES not configured — invoice', invoiceId, 'not delivered');
      await logEmail('invoice.email_skipped', { invoiceId, to: data.buyerEmail, result: 'skipped', reason: 'smtp_unconfigured' });
      return { sent: false, skipped: true, reason: 'smtp_unconfigured' };
    }
    console.log('[invoice-email] sent unpaid invoice', invoiceId, 'to', data.buyerEmail);
    await logEmail('invoice.email_sent', { invoiceId, to: data.buyerEmail, result: 'sent', messageId: result && result.messageId });
    return { sent: true, messageId: result && result.messageId };
  } catch (err) {
    console.error('[invoice-email] sendUnpaidInvoiceEmail failed for invoice', invoiceId, '-', err.message);
    await logEmail('invoice.email_failed', { invoiceId, result: 'failed', reason: err.message });
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendPaymentReceipt, buildReceiptEmail, sendUnpaidInvoiceEmail, buildUnpaidInvoiceEmail };

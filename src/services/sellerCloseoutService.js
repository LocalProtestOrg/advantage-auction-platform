'use strict';

/**
 * sellerCloseoutService — Design C single HELD seller closeout package.
 *
 * Under combined invoicing the immediate operational close email is NOT sent at
 * auction close. Instead ONE consolidated closeout package is assembled + emailed
 * to the seller once every buyer has paid OR 24h have elapsed post-close (see the
 * notificationWorker's runSellerCloseoutScan). This service builds + sends that
 * package; the caller stamps auctions.seller_closeout_sent_at for idempotency.
 *
 * Sends the same way receiptService / combinedReceiptService do (direct SES via
 * emailService.sendEmail) with the bundled all-buyer-invoice PDF attached, and logs
 * the send in the email audit. Best-effort per section — a lookup failure degrades
 * the section rather than the whole package.
 *
 * Settlement gating (L1): NET-settlement + platform-fee (payout) lines are SUPPRESSED
 * unless SELLER_SETTLEMENTS_ENABLED='true'. Gross sales, buyer roster, per-buyer
 * invoices, payment-status, pickup report and no-show report ship regardless.
 *
 * Launch-scoped: NO marketing/analytics (that is future + documented).
 */

const db = require('../db');
const { sendEmail } = require('./emailService');
const doc = require('./documentService');
const auditService = require('./auditService');
const reportingService = require('./reportingService');
const pickupPacketService = require('./pickupPacketService');
const { sellerSettlementsEnabled } = require('../lib/launchGuards');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function logEmail(eventType, { auctionId, to, result, reason, messageId }) {
  try {
    await auditService.logEvent(db, {
      eventType, entityType: 'auction', entityId: auctionId || null,
      auctionId: auctionId || null,
      metadata: { to: to || null, result, reason: reason || null, messageId: messageId || null, seller_closeout: true },
    });
  } catch (_e) { /* visibility logging is best-effort */ }
}

// Seller email + auction title (mirrors operationalCloseEmailService's join).
async function loadSellerAndAuction(auctionId) {
  const { rows } = await db.query(
    `SELECT a.id, a.title, u.email AS seller_email
       FROM auctions a
       JOIN seller_profiles sp ON sp.id = a.seller_id
       JOIN users u            ON u.id = sp.user_id
      WHERE a.id = $1`,
    [auctionId]
  );
  return rows[0] || null;
}

// Per-buyer combined invoice + payment-status roster for the auction.
async function loadBuyerInvoices(auctionId) {
  const { rows } = await db.query(
    `SELECT bai.id, bai.invoice_number, bai.total_cents, bai.hammer_cents, bai.status,
            bai.paid_at, bai.reminders_sent,
            u.email AS buyer_email, u.full_name AS buyer_name
       FROM buyer_auction_invoices bai
       JOIN users u ON u.id = bai.buyer_user_id
      WHERE bai.auction_id = $1
      ORDER BY bai.total_cents DESC`,
    [auctionId]
  ).catch(() => ({ rows: [] }));
  return rows;
}

// Unsold lots (closed with no winner).
async function loadUnsoldLots(auctionId) {
  const { rows } = await db.query(
    `SELECT lot_number, title
       FROM lots
      WHERE auction_id = $1 AND state = 'closed' AND winning_buyer_user_id IS NULL
      ORDER BY lot_number ASC`,
    [auctionId]
  ).catch(() => ({ rows: [] }));
  return rows;
}

// Per-buyer pickup report (consolidated appointment/tier/status).
async function loadPickupReport(auctionId) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (pa.buyer_user_id)
            pa.buyer_user_id, pa.assigned_tier, pa.slot_start, pa.slot_end, pa.pickup_status,
            u.email AS buyer_email, u.full_name AS buyer_name
       FROM pickup_assignments pa
       JOIN pickup_schedules ps ON ps.id = pa.pickup_schedule_id
       JOIN users u ON u.id = pa.buyer_user_id
      WHERE ps.auction_id = $1
      ORDER BY pa.buyer_user_id, pa.slot_start ASC`,
    [auctionId]
  ).catch(() => ({ rows: [] }));
  return rows;
}

// No-show report (active missed pickups for the auction's lots).
async function loadNoShows(auctionId) {
  const { rows } = await db.query(
    `SELECT mp.lot_id, mp.status, mp.scheduled_slot_start, mp.scheduled_slot_end,
            l.lot_number, l.title AS lot_title,
            u.email AS buyer_email, u.full_name AS buyer_name
       FROM missed_pickups mp
       JOIN lots l ON l.id = mp.lot_id
       LEFT JOIN users u ON u.id = mp.buyer_user_id
      WHERE l.auction_id = $1 AND mp.status IN ('missed','rescheduled')
      ORDER BY l.lot_number ASC`,
    [auctionId]
  ).catch(() => ({ rows: [] }));
  return rows;
}

function statusLabel(status) {
  if (status === 'paid') return 'PAID';
  if (status === 'payment_required') return 'PAYMENT REQUIRED';
  if (status === 'void') return 'VOID';
  return 'ISSUED';
}

// Assemble the plain-text + HTML seller closeout body from the gathered sections.
function buildEmail({ auctionTitle, auctionId, report, invoices, unsold, pickups, noShows, settlementsOn }) {
  const summary = (report && report.summary) || {};
  const grossCents = summary.gross_revenue_cents || 0;
  const paidCount = invoices.filter((i) => i.status === 'paid').length;
  const unpaidCount = invoices.filter((i) => i.status === 'payment_required').length;

  // ── Plain text ──
  const t = [];
  t.push(`Auction Closeout: ${auctionTitle}`);
  t.push(`Auction ID: ${auctionId}`);
  t.push('');
  t.push('SETTLEMENT SUMMARY');
  t.push(`  Total lots: ${summary.total_lots ?? '—'}   Sold: ${summary.sold_lots ?? '—'}   Unsold: ${summary.unsold_lots ?? '—'}`);
  t.push(`  Unique buyers: ${summary.unique_buyers_count ?? '—'}`);
  t.push(`  Gross Sales: ${doc.money(grossCents)}`);
  if (settlementsOn) {
    t.push(`  Platform Fee: ${doc.money(summary.platform_fee_cents || 0)}`);
    t.push(`  Net Seller Payout: ${doc.money(summary.seller_payout_cents || 0)}`);
  }
  t.push('');
  t.push(`PAYMENT STATUS  (paid ${paidCount} / payment-required ${unpaidCount} / ${invoices.length} buyer invoice(s))`);
  for (const inv of invoices) {
    t.push(`  ${inv.invoice_number || '—'}  ${inv.buyer_email || inv.buyer_name || 'buyer'}  ${doc.money(inv.total_cents)}  [${statusLabel(inv.status)}]`);
  }
  if (!invoices.length) t.push('  (no combined buyer invoices)');
  t.push('');
  t.push('BUYER ROSTER');
  if (invoices.length) {
    for (const inv of invoices) t.push(`  ${inv.buyer_name || inv.buyer_email || 'buyer'} — ${doc.money(inv.total_cents)}`);
  } else {
    t.push('  (no winning buyers)');
  }
  t.push('');
  t.push('UNSOLD LOTS');
  if (unsold.length) {
    for (const l of unsold) t.push(`  #${l.lot_number} ${l.title || ''}`.trimEnd());
  } else {
    t.push('  (none — all lots sold)');
  }
  t.push('');
  t.push('PICKUP REPORT');
  if (pickups.length) {
    for (const p of pickups) {
      t.push(`  ${p.buyer_email || p.buyer_name || 'buyer'} — tier ${p.assigned_tier || '—'} — ${p.pickup_status || 'scheduled'}`);
    }
  } else {
    t.push('  (no pickup assignments)');
  }
  t.push('');
  t.push('NO-SHOW REPORT');
  if (noShows.length) {
    for (const n of noShows) t.push(`  #${n.lot_number} ${n.lot_title || ''} — ${n.buyer_email || 'buyer'} — ${n.status}`.trimEnd());
  } else {
    t.push('  (no missed pickups)');
  }
  t.push('');
  t.push('The bundled buyer-invoice PDF is attached.');
  t.push('- Advantage Auction');

  // ── HTML ──
  const row = (label, val) => `<tr><td style="padding:2px 12px 2px 0;color:#64748b">${esc(label)}</td><td style="padding:2px 0;text-align:right;font-weight:600">${esc(val)}</td></tr>`;
  const settlementRows = row('Gross Sales', doc.money(grossCents)) +
    (settlementsOn
      ? row('Platform Fee', doc.money(summary.platform_fee_cents || 0)) + row('Net Seller Payout', doc.money(summary.seller_payout_cents || 0))
      : '');
  const invRows = invoices.map((inv) => (
    `<tr><td style="padding:4px 12px 4px 0">${esc(inv.invoice_number || '—')}</td>` +
    `<td style="padding:4px 12px 4px 0">${esc(inv.buyer_email || inv.buyer_name || 'buyer')}</td>` +
    `<td style="padding:4px 12px 4px 0;text-align:right">${doc.money(inv.total_cents)}</td>` +
    `<td style="padding:4px 0">${esc(statusLabel(inv.status))}</td></tr>`
  )).join('') || '<tr><td colspan="4" style="color:#94a3b8;padding:4px 0">(no combined buyer invoices)</td></tr>';

  const html =
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#1f2937">' +
      '<div style="font-weight:800;font-size:18px;color:#0f172a;padding:8px 0 2px">Advantage Auction — Seller Closeout</div>' +
      `<div style="font-size:14px;color:#64748b;margin-bottom:14px">${esc(auctionTitle)}</div>` +
      '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#0f172a">Settlement Summary</h3>' +
      `<table style="border-collapse:collapse;font-size:14px">${settlementRows}</table>` +
      `<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#0f172a">Payment Status — ${paidCount} paid / ${unpaidCount} payment-required</h3>` +
      `<table style="width:100%;border-collapse:collapse;font-size:13px">${invRows}</table>` +
      '<p style="font-size:12px;color:#94a3b8;margin-top:16px">Buyer roster, unsold lots, pickup and no-show details are in the attached bundled buyer-invoice PDF and the plain-text copy of this message.</p>' +
    '</div>';

  return { subject: `[Auction Closeout] ${auctionTitle}`, html, text: t.join('\n') };
}

// Assemble ONE seller closeout package and email it to the seller. Best-effort;
// idempotency (double-send guard) is the CALLER's responsibility via
// auctions.seller_closeout_sent_at. Returns { sent } | { skipped, reason }.
async function generateAndSend(auctionId) {
  const meta = await loadSellerAndAuction(auctionId);
  if (!meta) {
    await logEmail('seller_closeout.email_skipped', { auctionId, result: 'skipped', reason: 'auction_not_found' });
    return { sent: false, skipped: true, reason: 'auction_not_found' };
  }
  if (!meta.seller_email) {
    await logEmail('seller_closeout.email_skipped', { auctionId, result: 'skipped', reason: 'no_seller_email' });
    return { sent: false, skipped: true, reason: 'no_seller_email' };
  }

  const settlementsOn = sellerSettlementsEnabled(process.env);

  // Gather sections in parallel; each is individually fault-tolerant.
  const [report, invoices, unsold, pickups, noShows] = await Promise.all([
    reportingService.generateAuctionReport(auctionId).catch((err) => {
      console.error('[seller-closeout] report failed for', auctionId, '-', err.message);
      return { summary: {} };
    }),
    loadBuyerInvoices(auctionId),
    loadUnsoldLots(auctionId),
    loadPickupReport(auctionId),
    loadNoShows(auctionId),
  ]);

  const { subject, html, text } = buildEmail({
    auctionTitle: meta.title, auctionId, report, invoices, unsold, pickups, noShows, settlementsOn,
  });

  // Bundled all-buyer-invoice PDF (best-effort attachment).
  const attachments = [];
  try {
    const packet = await pickupPacketService.getPacketData(auctionId);
    if (packet) {
      const buffer = await pickupPacketService.buildPacketPdf(packet);
      if (buffer) attachments.push({ filename: 'auction-buyer-invoices-' + auctionId + '.pdf', content: buffer, contentType: 'application/pdf' });
    }
  } catch (err) {
    console.error('[seller-closeout] packet PDF failed for', auctionId, '-', err.message);
  }

  try {
    const result = await sendEmail({ to: meta.seller_email, subject, html, text, attachments });
    if (result && result.skipped) {
      await logEmail('seller_closeout.email_skipped', { auctionId, to: meta.seller_email, result: 'skipped', reason: 'smtp_unconfigured' });
      return { sent: false, skipped: true, reason: 'smtp_unconfigured' };
    }
    await logEmail('seller_closeout.email_sent', { auctionId, to: meta.seller_email, result: 'sent', messageId: result && result.messageId });
    console.log(`[seller-closeout] sent for auction_id=${auctionId}`);
    return { sent: true, messageId: result && result.messageId };
  } catch (err) {
    console.error('[seller-closeout] generateAndSend failed for', auctionId, '-', err.message);
    await logEmail('seller_closeout.email_failed', { auctionId, to: meta.seller_email, result: 'failed', reason: err.message });
    return { sent: false, reason: err.message };
  }
}

module.exports = { generateAndSend, buildEmail };

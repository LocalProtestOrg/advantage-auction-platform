'use strict';

/**
 * pickupPacketService — Phase 2B pickup-day bulk invoice packet.
 *
 * Produces ONE combined PDF of every buyer invoice for an auction, ordered for
 * pickup-day use: unpaid invoices first (so staff can withhold release), then
 * paid; within each group by buyer last name, first name, then invoice number.
 *
 * Each invoice is rendered as a pickup-day sheet: an unmistakable UNPAID warning
 * banner (red + heavy black border + huge bold text, so it survives a B&W
 * printer) or a small PAID badge; a contact/pickup header; the lot + hammer; and
 * an item-release / signature block.
 *
 * Read-only over existing data. Does NOT change charging, payouts, tax, or
 * settlement. Buyer premium / tax / shipping render from existing columns (0 today).
 */

const db = require('../db');
const doc = require('./documentService');

// Split a single full_name into { first, last }. Heuristic: last whitespace token
// is the last name, the remainder is the first name. Falls back to the email local
// part so every row still sorts deterministically.
function parseName(fullName, email) {
  const n = (fullName || '').trim().replace(/\s+/g, ' ');
  if (n) {
    const parts = n.split(' ');
    if (parts.length === 1) return { first: '', last: parts[0], display: parts[0] };
    const last = parts[parts.length - 1];
    const first = parts.slice(0, -1).join(' ');
    return { first, last, display: `${last}, ${first}` };
  }
  const local = (email || '').split('@')[0] || 'Unknown';
  return { first: '', last: local, display: local };
}

function fmtDateTime(d) {
  if (!d) return null;
  try {
    return new Date(d).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch (_e) { return null; }
}

function pickupWindowLabel(start, end) {
  const s = fmtDateTime(start);
  if (!s) return null;
  const e = end ? fmtDateTime(end) : null;
  return e ? `${s} – ${e}` : s;
}

async function getPacketData(auctionId) {
  const auctionRes = await db.query(
    `SELECT id, title, street_address, city, address_state, zip, pickup_window_start, pickup_window_end
       FROM auctions WHERE id = $1`,
    [auctionId]
  );
  if (!auctionRes.rows[0]) return null;
  const a = auctionRes.rows[0];

  const { rows } = await db.query(
    `SELECT i.id,
            i.invoice_number,
            i.invoice_date,
            i.status            AS invoice_status,
            i.amount_cents,
            i.hammer_cents,
            i.buyer_premium_cents,
            i.sales_tax_cents,
            i.shipping_cents,
            i.total_cents,
            i.buyer_user_id,
            i.lot_id,
            u.email             AS buyer_email,
            u.full_name         AS buyer_name,
            u.phone             AS buyer_phone,
            p.status            AS payment_status,
            p.charged_at        AS payment_date,
            l.lot_number,
            l.title             AS lot_title,
            pa.slot_start,
            pa.slot_end,
            (SELECT image_url FROM lot_images WHERE lot_id = l.id ORDER BY sort_order ASC LIMIT 1) AS lot_image_url
       FROM invoices i
       LEFT JOIN users    u  ON u.id = i.buyer_user_id
       LEFT JOIN payments p  ON p.id = i.payment_id
       LEFT JOIN lots     l  ON l.id = i.lot_id
       LEFT JOIN pickup_assignments pa ON pa.lot_id = i.lot_id AND pa.buyer_user_id = i.buyer_user_id
      WHERE i.auction_id = $1`,
    [auctionId]
  );

  const location = [a.street_address, [a.city, a.address_state].filter(Boolean).join(', '), a.zip]
    .filter(Boolean).join(' · ') || null;

  const invoices = rows.map((r) => {
    const isPaid = r.invoice_status === 'paid' || r.payment_status === 'paid';
    const name = parseName(r.buyer_name, r.buyer_email);
    const hammer = r.hammer_cents != null ? r.hammer_cents : r.amount_cents;
    const total = r.total_cents != null ? r.total_cents : r.amount_cents;
    return {
      id: r.id,
      invoiceNumber: r.invoice_number || ('AAC-' + String(r.id).slice(0, 8)),
      isPaid,
      paymentStatusLabel: isPaid ? 'PAID' : 'UNPAID',
      paymentDate: r.payment_date,
      first: name.first, last: name.last, displayName: name.display,
      email: r.buyer_email || '—',
      phone: r.buyer_phone || null,
      lotNumber: r.lot_number,
      lotTitle: r.lot_title || 'Lot',
      imageUrl: r.lot_image_url || null,
      pickup: pickupWindowLabel(r.slot_start || a.pickup_window_start, r.slot_end || a.pickup_window_end),
      summary: {
        hammerCents: hammer,
        buyerPremiumCents: r.buyer_premium_cents || 0,
        salesTaxCents: r.sales_tax_cents || 0,
        shippingCents: r.shipping_cents || 0,
        totalCents: total,
      },
    };
  });

  // Sort: unpaid group first, then paid; within each, last name, first name, invoice number.
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  invoices.sort((x, y) => {
    if (x.isPaid !== y.isPaid) return x.isPaid ? 1 : -1;       // unpaid (false) first
    const byLast = collator.compare(x.last || '', y.last || '');
    if (byLast) return byLast;
    const byFirst = collator.compare(x.first || '', y.first || '');
    if (byFirst) return byFirst;
    return collator.compare(x.invoiceNumber || '', y.invoiceNumber || '');
  });

  return {
    auction: { id: a.id, title: a.title || 'Auction', location, pickup: pickupWindowLabel(a.pickup_window_start, a.pickup_window_end) },
    invoices,
    counts: {
      unpaid: invoices.filter((i) => !i.isPaid).length,
      paid: invoices.filter((i) => i.isPaid).length,
      total: invoices.length,
    },
  };
}

// ── Per-invoice pickup sheet (assumes a fresh page) ───────────────────────────
function drawPickupSheet(pdf, inv, auction, thumbBuf) {
  const left = pdf.page.margins.left;
  const right = pdf.page.width - pdf.page.margins.right;
  const W = right - left;
  let y = pdf.page.margins.top;

  // Brand line
  pdf.fillColor(doc.BRAND.navy).font('Helvetica-Bold').fontSize(13).text(doc.BRAND.name, left, y);
  pdf.font('Helvetica').fontSize(11).fillColor(doc.BRAND.slate)
     .text('PICKUP INVOICE', left, y, { width: W, align: 'right' });
  pdf.fillColor('#000000');
  y = pdf.y + 8;

  // ── Status indicator ───────────────────────────────────────────────────────
  if (!inv.isPaid) {
    const bh = 80;
    pdf.save();
    pdf.fillColor('#c0262d').rect(left, y, W, bh).fill();            // red (prints dark-gray in B&W)
    pdf.lineWidth(3.5).strokeColor('#000000').rect(left, y, W, bh).stroke(); // heavy black border
    pdf.lineWidth(1).strokeColor('#ffffff').rect(left + 5, y + 5, W - 10, bh - 10).stroke(); // inner contrast border
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(38).text('UNPAID', left, y + 8, { width: W, align: 'center' });
    pdf.font('Helvetica-Bold').fontSize(12).text('DO NOT RELEASE ITEMS UNTIL PAYMENT IS CONFIRMED', left, y + 56, { width: W, align: 'center' });
    pdf.restore();
    y += bh + 14;
  } else {
    const bw = 96, bh = 26, bx = right - bw;
    pdf.save();
    pdf.fillColor('#15803d').roundedRect(bx, y, bw, bh, 4).fill();
    pdf.lineWidth(1).strokeColor('#000000').roundedRect(bx, y, bw, bh, 4).stroke();
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(14).text('PAID', bx, y + 6, { width: bw, align: 'center' });
    pdf.restore();
    if (inv.paymentDate) {
      pdf.font('Helvetica').fontSize(9).fillColor(doc.BRAND.slate)
         .text('Paid ' + (fmtDateTime(inv.paymentDate) || ''), bx - 160, y + 8, { width: 156, align: 'right' });
      pdf.fillColor('#000000');
    }
    y += bh + 14;
  }

  // ── Contact / pickup header (two columns) ───────────────────────────────────
  pdf.y = y;
  const colR = left + W / 2;
  const topY = y;

  pdf.font('Helvetica-Bold').fontSize(16).fillColor('#000000').text(inv.displayName, left, topY, { width: W / 2 - 10 });
  pdf.font('Helvetica').fontSize(10).fillColor(doc.BRAND.slate);
  pdf.text(inv.email, left, pdf.y, { width: W / 2 - 10 });
  if (inv.phone) pdf.text('Phone: ' + inv.phone, left, pdf.y, { width: W / 2 - 10 });
  const leftEnd = pdf.y;

  const fact = (label, val) => {
    if (!val) return;
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(doc.BRAND.slate).text(label, colR, pdf.y, { width: W / 2, continued: true });
    pdf.font('Helvetica').fontSize(9).fillColor('#000000').text('  ' + val, { width: W / 2 });
  };
  pdf.y = topY;
  fact('Invoice', inv.invoiceNumber);
  fact('Auction', auction.title);
  fact('Payment', inv.paymentStatusLabel);
  fact('Pickup location', auction.location || '—');
  fact('Pickup date/time', inv.pickup || 'See auction details');
  const rightEnd = pdf.y;

  pdf.y = Math.max(leftEnd, rightEnd) + 10;
  pdf.strokeColor(doc.BRAND.hair).lineWidth(1).moveTo(left, pdf.y).lineTo(right, pdf.y).stroke();
  pdf.moveDown(0.5);

  // ── Lot row ─────────────────────────────────────────────────────────────────
  const THUMB = 46;
  const rowY = pdf.y;
  let drew = false;
  if (thumbBuf) {
    try { pdf.image(thumbBuf, left, rowY, { fit: [THUMB, THUMB] }); drew = true; } catch (_e) { drew = false; }
  }
  if (!drew) {
    pdf.save().fillColor('#f1f5f9').rect(left, rowY, THUMB, THUMB).fill().restore();
    pdf.save().fillColor('#94a3b8').font('Helvetica').fontSize(7).text('No image', left, rowY + THUMB / 2 - 4, { width: THUMB, align: 'center' }).restore();
  }
  pdf.font('Helvetica-Bold').fontSize(9).fillColor(doc.BRAND.slate);
  pdf.text('LOT', left + 60, rowY); pdf.text('DESCRIPTION', left + 110, rowY);
  pdf.text('HAMMER', right - 90, rowY, { width: 90, align: 'right' });
  pdf.font('Helvetica').fontSize(11).fillColor('#000000');
  pdf.text(inv.lotNumber != null ? ('#' + inv.lotNumber) : '—', left + 60, rowY + 12, { width: 50 });
  pdf.text(inv.lotTitle, left + 110, rowY + 12, { width: right - 90 - (left + 110) - 6 });
  pdf.font('Helvetica-Bold').text(doc.money(inv.summary.hammerCents), right - 90, rowY + 12, { width: 90, align: 'right' });
  pdf.y = rowY + THUMB + 8;

  // ── Summary ─────────────────────────────────────────────────────────────────
  const sx = right - 230, sw = 230;
  const sline = (label, cents, opts = {}) => {
    const val = cents ? doc.money(cents) : '—';
    const yy = pdf.y;
    pdf.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.bold ? 12 : 10)
       .fillColor(opts.bold ? '#000000' : (cents ? '#000000' : '#94a3b8'));
    pdf.text(label, sx, yy, { width: sw - 90 });
    pdf.text(val, sx + sw - 90, yy, { width: 90, align: 'right' });
    pdf.moveDown(opts.bold ? 0.2 : 0.3);
  };
  sline('Hammer subtotal', inv.summary.hammerCents);
  sline('Buyer premium', inv.summary.buyerPremiumCents);
  sline('Sales tax', inv.summary.salesTaxCents);
  sline('Shipping', inv.summary.shippingCents);
  pdf.strokeColor(doc.BRAND.hair).lineWidth(1).moveTo(sx, pdf.y).lineTo(right, pdf.y).stroke();
  pdf.moveDown(0.25);
  sline('Total', inv.summary.totalCents, { bold: true });

  // ── Item release / signature section ────────────────────────────────────────
  let ry = Math.max(pdf.y, 580) + 6;
  pdf.strokeColor('#000000').lineWidth(1).moveTo(left, ry).lineTo(right, ry).stroke();
  ry += 8;
  pdf.font('Helvetica-Bold').fontSize(12).fillColor('#000000').text('ITEM RELEASE', left, ry);
  ry = pdf.y + 4;

  if (!inv.isPaid) {
    pdf.font('Helvetica-Bold').fontSize(11).fillColor('#c0262d')
       .text('Payment must be confirmed before items are released.', left, ry, { width: W });
    // Black underline keeps it obvious in B&W as well.
    pdf.strokeColor('#000000').lineWidth(1.2).moveTo(left, pdf.y + 1).lineTo(left + 330, pdf.y + 1).stroke();
    pdf.fillColor('#000000');
    ry = pdf.y + 12;
  }

  const lineY = (label, x, w, yy) => {
    pdf.strokeColor('#000000').lineWidth(0.8).moveTo(x, yy + 16).lineTo(x + w, yy + 16).stroke();
    pdf.font('Helvetica').fontSize(8).fillColor(doc.BRAND.slate).text(label, x, yy + 19, { width: w });
    pdf.fillColor('#000000');
  };
  lineY('Buyer signature', left, 230, ry);
  lineY('Staff initials', left + 250, 90, ry);
  lineY('Pickup date', left + 360, W - 360, ry);
  ry += 44;
  lineY('Notes', left, W, ry);
}

async function buildPacketPdf(packet) {
  // Prefetch thumbnails (raster http(s) only; SVG/data-URI/webp → placeholder).
  const thumbs = await Promise.all(packet.invoices.map(async (inv) => {
    const ok = inv.imageUrl && /^https?:\/\//i.test(inv.imageUrl) && !/\.(svg|webp|gif)(\?|$)/i.test(inv.imageUrl);
    return ok ? await doc.fetchImageBuffer(inv.imageUrl) : null;
  }));

  return doc.renderPdf((pdf) => {
    if (packet.invoices.length === 0) {
      pdf.font('Helvetica-Bold').fontSize(16).text('Pickup Invoice Packet', { align: 'center' });
      pdf.moveDown(0.5).font('Helvetica').fontSize(11)
         .text('No buyer invoices exist for this auction yet.', { align: 'center' });
      return;
    }
    packet.invoices.forEach((inv, i) => {
      if (i > 0) pdf.addPage();
      drawPickupSheet(pdf, inv, packet.auction, thumbs[i]);
    });
  });
}

module.exports = { getPacketData, buildPacketPdf, parseName };

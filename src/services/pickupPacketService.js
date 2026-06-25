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
const pt = require('../lib/pickupTiers');

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

// Item size tiers — labels are the AUTHORITATIVE ones defined in Lot Studio
// (public/lot-builder.html size_category selector). Not invented here. Lots with
// no size set show "Not specified" (no inference from description).
const SIZE_LABELS = {
  A: 'A — Small (carry by hand)',
  B: 'B — Medium (2 people)',
  C: 'C — Large (truck / dolly)',
};

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
            l.size_category,
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

  // Phase 3: split the auction pickup window into 3 equal A/B/C tiers (computed,
  // not hardcoded) and pre-group each buyer's lots so the packet can show the
  // buyer's assigned pickup time (largest item wins) + per-lot pickup times.
  const tierWin = pt.splitWindow(a.pickup_window_start, a.pickup_window_end);
  const tierWindowLabel = (t) => (tierWin && t && tierWin[t]) ? pt.windowLabel(tierWin[t]) : null;
  const byBuyer = new Map();
  for (const r of rows) {
    if (!byBuyer.has(r.buyer_user_id)) byBuyer.set(r.buyer_user_id, []);
    byBuyer.get(r.buyer_user_id).push({ lotNumber: r.lot_number, size: r.size_category });
  }

  const invoices = rows.map((r) => {
    const isPaid = r.invoice_status === 'paid' || r.payment_status === 'paid';
    const name = parseName(r.buyer_name, r.buyer_email);
    const hammer = r.hammer_cents != null ? r.hammer_cents : r.amount_cents;
    const total = r.total_cents != null ? r.total_cents : r.amount_cents;
    const buyerLotRows = byBuyer.get(r.buyer_user_id) || [];
    const aTier = pt.assignedTier(buyerLotRows.map((l) => l.size)); // largest item wins
    const lotTier = pt.normTier(r.size_category);
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
      sizeCategory: r.size_category || null,
      sizeTier: SIZE_LABELS[r.size_category] || 'Not specified',
      lotTier,
      lotTimeLabel: pt.timeLabel(lotTier),
      lotTimeWindow: tierWindowLabel(lotTier),
      assignedTier: aTier,
      assignedTimeLabel: pt.timeLabel(aTier),
      assignedTimeWindow: tierWindowLabel(aTier),
      buyerLots: buyerLotRows.map((l) => { const t = pt.normTier(l.size); return { lotNumber: l.lotNumber, tier: t, timeLabel: pt.timeLabel(t) }; }),
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
    auction: {
      id: a.id, title: a.title || 'Auction', location,
      pickup: pickupWindowLabel(a.pickup_window_start, a.pickup_window_end),
      tierWindows: tierWin ? { A: tierWindowLabel('A'), B: tierWindowLabel('B'), C: tierWindowLabel('C') } : null,
    },
    invoices,
    counts: {
      unpaid: invoices.filter((i) => !i.isPaid).length,
      paid: invoices.filter((i) => i.isPaid).length,
      total: invoices.length,
    },
  };
}

// ── Per-invoice PICKUP RELEASE sheet (assumes a fresh page) ───────────────────
// A pickup-day RELEASE / item-release document — NOT an invoice copy. Emphasizes
// the pickup workflow: large "PICKUP RELEASE" title, alphabetical buyer lookup,
// strong PAID/UNPAID handling, pickup instructions, an item checklist, the
// financial totals (retained), and a release/signature block. The buyer-facing
// accounting invoice (invoicePdfService) is unchanged.
function drawPickupSheet(pdf, inv, auction, thumbBuf) {
  const left = pdf.page.margins.left;
  const right = pdf.page.width - pdf.page.margins.right;
  const W = right - left;
  const unpaid = !inv.isPaid;
  const SLATE = doc.BRAND.slate, HAIR = doc.BRAND.hair, BLUE = doc.BRAND.blue, NAVY = doc.BRAND.navy;

  // ── Title band ────────────────────────────────────────────────────────────
  let y = pdf.page.margins.top;
  pdf.fillColor(NAVY).font('Helvetica-Bold').fontSize(26).text('PICKUP RELEASE', left, y);
  pdf.font('Helvetica').fontSize(9).fillColor(SLATE)
     .text('Advantage Auction' + (auction.title ? ('  ·  ' + auction.title) : ''), left, y + 31, { width: W });
  pdf.fillColor('#000000');
  y += 46;
  pdf.lineWidth(2).strokeColor(BLUE).moveTo(left, y).lineTo(right, y).stroke();
  y += 12;

  // ── Strong PAID / UNPAID status band (B&W-safe) ───────────────────────────
  if (unpaid) {
    const bh = 66;
    pdf.save();
    pdf.fillColor('#c0262d').rect(left, y, W, bh).fill();                       // red → dark band in B&W
    pdf.lineWidth(3.5).strokeColor('#000000').rect(left, y, W, bh).stroke();    // heavy black border
    pdf.lineWidth(1).strokeColor('#ffffff').rect(left + 5, y + 5, W - 10, bh - 10).stroke();
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(28).text('UNPAID — DO NOT RELEASE', left, y + 9, { width: W, align: 'center' });
    pdf.font('Helvetica-Bold').fontSize(11).text('Payment must be confirmed before any item is released.', left, y + 44, { width: W, align: 'center' });
    pdf.restore();
    y += bh + 12;
  } else {
    const bh = 46;
    pdf.save();
    pdf.fillColor('#dcfce7').rect(left, y, W, bh).fill();
    pdf.lineWidth(2.5).strokeColor('#166534').rect(left, y, W, bh).stroke();
    pdf.fillColor('#166534').font('Helvetica-Bold').fontSize(20).text('PAID — CLEARED FOR PICKUP', left, y + 7, { width: W, align: 'center' });
    pdf.font('Helvetica').fontSize(9).text(inv.paymentDate ? ('Payment received ' + (fmtDateTime(inv.paymentDate) || '')) : 'Payment received', left, y + 30, { width: W, align: 'center' });
    pdf.restore();
    y += bh + 12;
  }

  // ── Buyer lookup (large) + pickup facts (two columns) ─────────────────────
  const colW = W / 2 - 8;
  const rx = left + W / 2 + 8;
  pdf.fillColor('#000000').font('Helvetica-Bold').fontSize(22).text(inv.displayName, left, y, { width: colW });
  let lyEnd = pdf.y;
  pdf.font('Helvetica').fontSize(8).fillColor(SLATE).text('BUYER — last, first (alphabetical lookup)', left, lyEnd, { width: colW });
  pdf.font('Helvetica').fontSize(10).fillColor('#000000').text(inv.email || '—', left, pdf.y + 2, { width: colW });
  if (inv.phone) pdf.text('Phone: ' + inv.phone, left, pdf.y, { width: colW });
  const leftBottom = pdf.y;

  let ry = y;
  const fact = (label, val) => {
    pdf.font('Helvetica-Bold').fontSize(8).fillColor(SLATE).text(label, rx, ry, { width: colW });
    ry = pdf.y;
    pdf.font('Helvetica').fontSize(10).fillColor('#000000').text(val || '—', rx, ry, { width: colW });
    ry = pdf.y + 5;
  };
  fact('INVOICE #', inv.invoiceNumber);
  fact('PAYMENT STATUS', inv.paymentStatusLabel);
  fact('PICKUP LOCATION', auction.location || 'See auction details');
  fact('PICKUP DATE / TIME', inv.pickup || auction.pickup || 'See auction details');
  y = Math.max(leftBottom, ry) + 10;

  // ── Pickup instructions ────────────────────────────────────────────────────
  pdf.strokeColor(HAIR).lineWidth(1).moveTo(left, y).lineTo(right, y).stroke();
  y += 8;
  pdf.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text('Pickup instructions', left, y);
  pdf.font('Helvetica').fontSize(9).fillColor('#334155');
  [
    '1. Look up the buyer by last name; verify photo ID matches the buyer name above.',
    '2. Confirm the status band reads PAID before releasing any item. If UNPAID, do not release — direct the buyer to pay first.',
    '3. Check off each item below as it is handed to the buyer.',
    '4. Buyer signs; staff initials and dates the release block.',
  ].forEach((s) => pdf.text(s, left, pdf.y + 1, { width: W }));
  pdf.fillColor('#000000');
  y = pdf.y + 10;

  // ── Assigned pickup time (buyer-level; largest item purchased determines it) ─
  pdf.font('Helvetica-Bold').fontSize(9).fillColor(SLATE).text('ASSIGNED PICKUP TIME (largest item purchased)', left, y);
  y = pdf.y + 1;
  pdf.font('Helvetica-Bold').fontSize(16).fillColor(NAVY)
     .text((inv.assignedTimeLabel || 'Not specified') + (inv.assignedTimeWindow ? ('     ' + inv.assignedTimeWindow) : ''), left, y);
  pdf.fillColor('#000000');
  y = pdf.y + 8;

  // ── Item checklist (each lot's individual pickup time shown per row) ────────
  pdf.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text('Item checklist', left, y);
  y = pdf.y + 4;
  const timeX = right - 152;
  pdf.font('Helvetica-Bold').fontSize(8).fillColor(SLATE);
  pdf.text('RELEASED', left, y, { width: 56 });
  pdf.text('LOT', left + 96, y, { width: 32 });
  pdf.text('ITEM', left + 132, y, { width: timeX - (left + 132) - 4 });
  pdf.text('PICKUP TIME', timeX, y, { width: 60 });
  pdf.text('HAMMER', right - 92, y, { width: 92, align: 'right' });
  y = pdf.y + 2;
  pdf.strokeColor(HAIR).lineWidth(1).moveTo(left, y).lineTo(right, y).stroke();
  y += 6;
  const rowY = y;
  pdf.lineWidth(1.2).strokeColor('#000000').rect(left + 12, rowY, 16, 16).stroke();   // release checkbox
  const TH = 30;
  let drew = false;
  if (thumbBuf) { try { pdf.image(thumbBuf, left + 56, rowY - 4, { fit: [TH, TH] }); drew = true; } catch (_e) { drew = false; } }
  if (!drew) {
    pdf.save().fillColor('#f1f5f9').rect(left + 56, rowY - 4, TH, TH).fill().restore();
    pdf.save().fillColor('#94a3b8').font('Helvetica').fontSize(6).text('no img', left + 56, rowY + 7, { width: TH, align: 'center' }).restore();
  }
  pdf.font('Helvetica').fontSize(10).fillColor('#000000');
  pdf.text(inv.lotNumber != null ? ('#' + inv.lotNumber) : '—', left + 96, rowY + 2, { width: 32 });
  pdf.text(inv.lotTitle || 'Lot', left + 132, rowY + 2, { width: timeX - (left + 132) - 4 });
  pdf.font('Helvetica-Bold').fontSize(9).text(inv.lotTimeLabel || 'Not specified', timeX, rowY + 3, { width: 60 });
  pdf.font('Helvetica-Bold').fontSize(10).text(doc.money(inv.summary.hammerCents), right - 92, rowY + 2, { width: 92, align: 'right' });
  y = rowY + TH + 8;

  // Multi-lot buyer: list every lot this buyer is collecting + each lot's pickup time.
  if (inv.buyerLots && inv.buyerLots.length > 1) {
    pdf.font('Helvetica').fontSize(8).fillColor(SLATE).text(
      'This buyer has ' + inv.buyerLots.length + ' lots in this auction — '
        + inv.buyerLots.map((l) => '#' + (l.lotNumber != null ? l.lotNumber : '?') + ' ' + l.timeLabel).join('   ·   '),
      left, y, { width: W }
    );
    pdf.fillColor('#000000');
    y = pdf.y + 6;
  }

  // ── Financial totals (retained; compact, right-aligned) ───────────────────
  const sx = right - 230, sw = 230;
  pdf.y = y;
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
  pdf.strokeColor(HAIR).lineWidth(1).moveTo(sx, pdf.y).lineTo(right, pdf.y).stroke();
  pdf.moveDown(0.25);
  sline('Total due', inv.summary.totalCents, { bold: true });

  // ── Release authorization / signature block ───────────────────────────────
  let by = Math.max(pdf.y, 600) + 6;
  pdf.strokeColor('#000000').lineWidth(1).moveTo(left, by).lineTo(right, by).stroke();
  by += 8;
  pdf.font('Helvetica-Bold').fontSize(12).fillColor('#000000').text('RELEASE AUTHORIZATION', left, by);
  by = pdf.y + 4;
  if (unpaid) {
    pdf.font('Helvetica-Bold').fontSize(11).fillColor('#c0262d')
       .text('Payment must be confirmed before items are released.', left, by, { width: W });
    pdf.strokeColor('#000000').lineWidth(1.2).moveTo(left, pdf.y + 1).lineTo(left + 330, pdf.y + 1).stroke(); // B&W underline
    pdf.fillColor('#000000');
    by = pdf.y + 12;
  } else {
    pdf.font('Helvetica').fontSize(9).fillColor(SLATE)
       .text('Payment confirmed — release the checked item(s) to the buyer below.', left, by, { width: W });
    pdf.fillColor('#000000');
    by = pdf.y + 8;
  }
  const lineY = (label, x, w, yy) => {
    pdf.strokeColor('#000000').lineWidth(0.8).moveTo(x, yy + 16).lineTo(x + w, yy + 16).stroke();
    pdf.font('Helvetica').fontSize(8).fillColor(SLATE).text(label, x, yy + 19, { width: w });
    pdf.fillColor('#000000');
  };
  lineY('Buyer signature', left, 230, by);
  lineY('Staff initials', left + 250, 90, by);
  lineY('Pickup date / time', left + 360, W - 360, by);
  by += 44;
  lineY('Notes', left, W, by);
}

async function buildPacketPdf(packet) {
  // Prefetch thumbnails (raster http(s) only; SVG/data-URI/webp → placeholder).
  const thumbs = await Promise.all(packet.invoices.map(async (inv) => {
    const ok = inv.imageUrl && /^https?:\/\//i.test(inv.imageUrl) && !/\.(svg|webp|gif)(\?|$)/i.test(inv.imageUrl);
    return ok ? await doc.fetchImageBuffer(inv.imageUrl) : null;
  }));

  return doc.renderPdf((pdf) => {
    if (packet.invoices.length === 0) {
      pdf.font('Helvetica-Bold').fontSize(16).text('Pickup Release Packet', { align: 'center' });
      pdf.moveDown(0.5).font('Helvetica').fontSize(11)
         .text('No buyer invoices exist for this auction yet — no pickup release sheets to print.', { align: 'center' });
      return;
    }
    packet.invoices.forEach((inv, i) => {
      if (i > 0) pdf.addPage();
      drawPickupSheet(pdf, inv, packet.auction, thumbs[i]);
    });
  });
}

module.exports = { getPacketData, buildPacketPdf, parseName };

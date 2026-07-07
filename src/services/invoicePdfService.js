'use strict';

/**
 * invoicePdfService — buyer invoice data assembly + professional PDF rendering.
 *
 * Built on the reusable documentService (branding, render, private storage,
 * signed URL, history). Renders a printable, mobile-readable invoice with:
 *   Header  — invoice #, date, auction, buyer name/email, payment status/date
 *   Lots    — thumbnail, lot #, title, hammer price (table supports N rows)
 *   Summary — hammer subtotal, buyer premium, sales tax, shipping, total
 *
 * Buyer premium / sales tax / shipping are future-ready: they render from the
 * invoice columns (0 today) and are clearly labeled, so activating them later is
 * a data change, not a template change.
 */

const db = require('../db');
const doc = require('./documentService');

// One invoice == one lot in the current per-lot payment model. The lot table is
// written to iterate an array so consolidated multi-lot invoices later need no
// template change.
async function getInvoiceData(invoiceId) {
  const { rows } = await db.query(
    `SELECT i.id,
            i.invoice_number,
            i.invoice_date,
            i.created_at,
            i.status,
            i.amount_cents,
            i.hammer_cents,
            i.buyer_premium_cents,
            i.sales_tax_cents,
            i.shipping_cents,
            i.total_cents,
            i.buyer_user_id,
            i.lot_id,
            i.auction_id,
            i.pdf_public_id,
            l.lot_number,
            l.title           AS lot_title,
            a.title           AS auction_title,
            u.email           AS buyer_email,
            u.full_name       AS buyer_name,
            p.status          AS payment_status,
            p.charged_at      AS payment_date,
            (SELECT image_url FROM lot_images WHERE lot_id = l.id ORDER BY sort_order ASC LIMIT 1) AS lot_image_url
       FROM invoices i
       LEFT JOIN lots     l ON l.id = i.lot_id
       LEFT JOIN auctions a ON a.id = i.auction_id
       LEFT JOIN users    u ON u.id = i.buyer_user_id
       LEFT JOIN payments p ON p.id = i.payment_id
      WHERE i.id = $1`,
    [invoiceId]
  );
  if (!rows[0]) return null;
  const r = rows[0];

  const hammer = r.hammer_cents != null ? r.hammer_cents : r.amount_cents;
  const total = r.total_cents != null ? r.total_cents : r.amount_cents;

  return {
    id: r.id,
    invoiceNumber: r.invoice_number || ('AAC-' + String(r.id).slice(0, 8)),
    invoiceDate: r.invoice_date || r.created_at,
    status: r.status,
    paymentStatus: r.payment_status || r.status,
    paymentDate: r.payment_date,
    buyerUserId: r.buyer_user_id,
    buyerName: r.buyer_name || null,
    buyerEmail: r.buyer_email || null,
    auctionTitle: r.auction_title || null,
    lines: [{
      lotId: r.lot_id,
      lotNumber: r.lot_number,
      title: r.lot_title || 'Lot',
      imageUrl: r.lot_image_url || null,
      hammerCents: hammer,
    }],
    summary: {
      hammerCents: hammer,
      buyerPremiumCents: r.buyer_premium_cents || 0,
      salesTaxCents: r.sales_tax_cents || 0,
      shippingCents: r.shipping_cents || 0,
      totalCents: total,
    },
    pdfPublicId: r.pdf_public_id || null,
  };
}

function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch (_e) { return '—'; }
}

// PDFKit supports JPEG/PNG only. SVG/data-URI/webp/gif and any fetch/parse
// failure fall back to a placeholder so the PDF never breaks on a bad image.
async function buildInvoicePdf(data) {
  const lineThumbs = await Promise.all(
    data.lines.map(async (ln) => {
      const fetchable = ln.imageUrl && /^https?:\/\//i.test(ln.imageUrl) && !/\.(svg|webp|gif)(\?|$)/i.test(ln.imageUrl);
      return fetchable ? await doc.fetchImageBuffer(ln.imageUrl) : null;
    })
  );

  return doc.renderPdf((pdf) => {
    const left = pdf.page.margins.left;
    const right = pdf.page.width - pdf.page.margins.right;
    const W = right - left;

    doc.drawBrandHeader(pdf, { docTitle: 'INVOICE', docSubtitle: data.invoiceNumber });

    // ── Meta grid: left = bill-to, right = invoice facts ──────────────────────
    const metaTop = pdf.y;
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(doc.BRAND.slate).text('BILLED TO', left, metaTop);
    pdf.font('Helvetica').fontSize(11).fillColor('#000000');
    if (data.buyerName) pdf.text(data.buyerName, left, pdf.y);
    pdf.fillColor(doc.BRAND.slate).fontSize(10).text(data.buyerEmail || '—');
    pdf.fillColor('#000000');

    const factsX = left + W / 2;
    let fy = metaTop;
    const fact = (label, val) => {
      pdf.font('Helvetica-Bold').fontSize(9).fillColor(doc.BRAND.slate).text(label, factsX, fy, { width: W / 2, align: 'right' });
      fy = pdf.y;
      pdf.font('Helvetica').fontSize(11).fillColor('#000000').text(val, factsX, fy, { width: W / 2, align: 'right' });
      fy = pdf.y + 4;
    };
    fact('Invoice date', fmtDate(data.invoiceDate));
    fact('Auction', data.auctionTitle || '—');
    fact('Payment status', String(data.paymentStatus || '—').toUpperCase());
    fact('Payment date', data.paymentDate ? fmtDate(data.paymentDate) : '—');

    pdf.y = Math.max(pdf.y, fy) + 10;
    pdf.moveDown(0.5);

    // ── Lot table ─────────────────────────────────────────────────────────────
    const col = {
      thumb: { x: left,        w: 54 },
      num:   { x: left + 64,   w: 50 },
      title: { x: left + 118,  w: W - 118 - 90 },
      price: { x: right - 90,  w: 90 },
    };

    pdf.font('Helvetica-Bold').fontSize(9).fillColor(doc.BRAND.slate);
    const headY = pdf.y;
    pdf.text('ITEM', col.thumb.x, headY);
    pdf.text('LOT #', col.num.x, headY);
    pdf.text('DESCRIPTION', col.title.x, headY);
    pdf.text('HAMMER', col.price.x, headY, { width: col.price.w, align: 'right' });
    pdf.moveDown(0.3);
    pdf.strokeColor(doc.BRAND.hair).lineWidth(1).moveTo(left, pdf.y).lineTo(right, pdf.y).stroke();
    pdf.moveDown(0.4);
    pdf.fillColor('#000000');

    const THUMB = 46;
    for (let i = 0; i < data.lines.length; i++) {
      const ln = data.lines[i];
      if (pdf.y > 660) pdf.addPage();
      const rowY = pdf.y;

      // Thumbnail or placeholder
      let drew = false;
      const buf = lineThumbs[i];
      if (buf) {
        try { pdf.image(buf, col.thumb.x, rowY, { fit: [THUMB, THUMB] }); drew = true; } catch (_e) { drew = false; }
      }
      if (!drew) {
        pdf.save().fillColor('#f1f5f9').rect(col.thumb.x, rowY, THUMB, THUMB).fill().restore();
        pdf.save().fillColor('#94a3b8').font('Helvetica').fontSize(7)
           .text('No image', col.thumb.x, rowY + THUMB / 2 - 4, { width: THUMB, align: 'center' }).restore();
      }

      pdf.font('Helvetica').fontSize(11).fillColor('#000000');
      pdf.text(ln.lotNumber != null ? ('#' + ln.lotNumber) : '—', col.num.x, rowY + 4, { width: col.num.w });
      pdf.text(ln.title || 'Lot', col.title.x, rowY + 4, { width: col.title.w });
      pdf.font('Helvetica-Bold').text(doc.money(ln.hammerCents), col.price.x, rowY + 4, { width: col.price.w, align: 'right' });

      pdf.y = rowY + THUMB + 8;
      pdf.strokeColor('#f1f5f9').lineWidth(1).moveTo(left, pdf.y).lineTo(right, pdf.y).stroke();
      pdf.moveDown(0.4);
    }

    // ── Summary box (right-aligned) ───────────────────────────────────────────
    pdf.moveDown(0.6);
    const sx = right - 230;
    const sw = 230;
    const sumRow = (label, val, opts = {}) => {
      const y = pdf.y;
      pdf.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.bold ? 12 : 10)
         .fillColor(opts.muted ? doc.BRAND.slate : '#000000');
      pdf.text(label, sx, y, { width: sw - 90, align: 'left', continued: false });
      pdf.text(val, sx + sw - 90, y, { width: 90, align: 'right' });
      pdf.moveDown(opts.bold ? 0.2 : 0.35);
    };

    // #10: always show every line item ($0.00 until the feature is enabled), with a
    // Credits / Refunds line, ending in a bold Grand Total.
    const creditsCents = Number(data.summary.creditsCents || data.summary.refundedCents || 0);
    sumRow('Hammer Total', doc.money(data.summary.hammerCents));
    sumRow('Buyer Premium', doc.money(data.summary.buyerPremiumCents || 0), { muted: !data.summary.buyerPremiumCents });
    sumRow('Sales Tax', doc.money(data.summary.salesTaxCents || 0), { muted: !data.summary.salesTaxCents });
    sumRow('Shipping', doc.money(data.summary.shippingCents || 0), { muted: !data.summary.shippingCents });
    sumRow('Credits / Refunds', creditsCents ? ('-' + doc.money(creditsCents)) : doc.money(0), { muted: !creditsCents });
    pdf.moveDown(0.1);
    pdf.strokeColor(doc.BRAND.hair).lineWidth(1).moveTo(sx, pdf.y).lineTo(right, pdf.y).stroke();
    pdf.moveDown(0.3);
    sumRow('Grand Total', doc.money(data.summary.totalCents), { bold: true });

    // ── Footer ──────────────────────────────────────────────────────────────
    pdf.font('Helvetica').fontSize(8).fillColor(doc.BRAND.slate);
    pdf.text(
      'Buyer premium, sales tax, and shipping appear as "—" until those features are activated. ' +
      'Advantage Auction never stores your full card details. Questions? Reply to your receipt email.',
      left, 720, { width: W, align: 'center' }
    );
    pdf.fillColor('#000000');
  });
}

/**
 * getCombinedInvoiceData — Design C combined header assembled into the SAME
 * { header..., lines:[...], summary:{...} } shape buildInvoicePdf consumes, but
 * across ALL of the buyer's winning lots in the auction. Reuses buildInvoicePdf
 * unchanged. getInvoiceData (per-lot) is deliberately left untouched.
 *
 * FLAG-INERT: only reachable via the combined invoicing path, which is dormant
 * until COMBINED_INVOICING_ENABLED is set.
 */
async function getCombinedInvoiceData(combinedInvoiceId) {
  const { rows } = await db.query(
    `SELECT b.id,
            b.invoice_number,
            b.created_at,
            b.closed_at,
            b.status,
            b.hammer_cents,
            b.buyer_premium_cents,
            b.sales_tax_cents,
            b.shipping_cents,
            b.credits_cents,
            b.total_cents,
            b.buyer_user_id,
            b.auction_id,
            b.paid_at,
            b.payment_id,
            a.title      AS auction_title,
            u.email      AS buyer_email,
            u.full_name  AS buyer_name,
            p.status     AS payment_status,
            p.charged_at AS payment_date
       FROM buyer_auction_invoices b
       LEFT JOIN auctions a ON a.id = b.auction_id
       LEFT JOIN users    u ON u.id = b.buyer_user_id
       LEFT JOIN payments p ON p.id = b.payment_id
      WHERE b.id = $1`,
    [combinedInvoiceId]
  );
  if (!rows[0]) return null;
  const r = rows[0];

  const { rows: lots } = await db.query(
    `SELECT l.id AS lot_id,
            l.lot_number,
            l.title AS lot_title,
            l.winning_amount_cents,
            (SELECT image_url FROM lot_images WHERE lot_id = l.id ORDER BY sort_order ASC LIMIT 1) AS lot_image_url
       FROM lots l
      WHERE l.auction_id = $1
        AND l.winning_buyer_user_id = $2
        AND l.state = 'closed'
      ORDER BY l.lot_number ASC NULLS LAST`,
    [r.auction_id, r.buyer_user_id]
  );

  const lines = lots.map((l) => ({
    lotId: l.lot_id,
    lotNumber: l.lot_number,
    title: l.lot_title || 'Lot',
    imageUrl: l.lot_image_url || null,
    hammerCents: l.winning_amount_cents || 0,
  }));

  return {
    id: r.id,
    combinedInvoiceId: r.id,
    auctionId: r.auction_id,
    invoiceNumber: r.invoice_number || ('AAC-C-' + String(r.id).slice(0, 8)),
    invoiceDate: r.closed_at || r.created_at,
    status: r.status,
    paymentStatus: r.payment_status || (r.status === 'paid' ? 'paid' : r.status),
    paymentDate: r.payment_date || r.paid_at,
    buyerUserId: r.buyer_user_id,
    buyerName: r.buyer_name || null,
    buyerEmail: r.buyer_email || null,
    auctionTitle: r.auction_title || null,
    lines,
    summary: {
      hammerCents: r.hammer_cents || 0,
      buyerPremiumCents: r.buyer_premium_cents || 0,
      salesTaxCents: r.sales_tax_cents || 0,
      shippingCents: r.shipping_cents || 0,
      creditsCents: r.credits_cents || 0,
      totalCents: r.total_cents || 0,
    },
  };
}

/**
 * Build the invoice PDF, best-effort archive it to private storage, record a
 * generated_documents history row, and stamp the invoice's pdf_* columns.
 * @returns {Promise<{buffer: Buffer, fileName: string, public_id: string|null, sha256: string}>}
 */
async function generateAndStoreInvoicePdf(invoiceId) {
  const data = await getInvoiceData(invoiceId);
  if (!data) throw new Error('Invoice not found: ' + invoiceId);

  const buffer = await buildInvoicePdf(data);
  const fileName = `invoice-${data.invoiceNumber}.pdf`;

  const stored = await doc.storePrivatePdf({
    folder: 'invoices',
    publicId: `invoice-${data.id}`,
    buffer,
  });

  await doc.recordDocument(null, {
    docType: 'buyer_invoice',
    entityType: 'invoice',
    entityId: data.id,
    relatedUserId: data.buyerUserId,
    fileName,
    publicId: stored.public_id,
    sha256: stored.sha256,
    byteSize: buffer.length,
  });

  try {
    await db.query(
      `UPDATE invoices SET pdf_public_id = $1, pdf_sha256 = $2, pdf_generated_at = now() WHERE id = $3`,
      [stored.public_id, stored.sha256, data.id]
    );
  } catch (err) {
    console.warn('[invoicePdfService] failed to stamp invoice pdf columns (non-fatal):', err.message);
  }

  return { buffer, fileName, public_id: stored.public_id, sha256: stored.sha256, data };
}

module.exports = { getInvoiceData, getCombinedInvoiceData, buildInvoicePdf, generateAndStoreInvoicePdf };

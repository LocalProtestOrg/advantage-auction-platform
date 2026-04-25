'use strict';

const fs             = require('fs');
const path           = require('path');
const PDFDocument    = require('pdfkit');
const nodemailer     = require('nodemailer');
const db             = require('../db');
const { generateAuctionReport } = require('./reportingService');

const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports');

function fmt(cents) {
  if (cents == null) return 'N/A';
  return '$' + (cents / 100).toFixed(2);
}

// ── buildReportPdf ─────────────────────────────────────────────────────────────
// Returns { buffer: Buffer, path: string }.
// Writes the PDF to disk and resolves the full buffer so callers can stream
// it directly without a second fs.readFile.
async function buildReportPdf(auctionId) {
  const report = await generateAuctionReport(auctionId);

  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
  const pdfPath = path.join(REPORTS_DIR, `auction-report-${auctionId}.pdf`);

  const buffer = await new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50, size: 'LETTER' });
    const chunks = [];
    const stream = fs.createWriteStream(pdfPath);

    doc.on('data', chunk => chunks.push(chunk));
    doc.pipe(stream);

    stream.on('error', reject);
    stream.on('finish', () => resolve(Buffer.concat(chunks)));

    // ── Header ──────────────────────────────────────────────────────────────
    doc.fontSize(20).font('Helvetica-Bold')
       .text('Auction Report', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica')
       .text(report.auction_title ?? '', { align: 'center' });
    if (report.auction_ends_at) {
      const dateStr = new Date(report.auction_ends_at).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
      });
      doc.fontSize(9).fillColor('#666666').text(dateStr, { align: 'center' });
      doc.fillColor('#000000');
    }
    doc.fontSize(8).fillColor('#999999')
       .text(`Generated: ${new Date(report.generated_at).toLocaleString('en-US')}`, { align: 'center' });
    doc.fillColor('#000000');
    doc.moveDown(1.5);

    // ── Summary ──────────────────────────────────────────────────────────────
    const sectionTitle = label => {
      doc.fontSize(12).font('Helvetica-Bold').text(label);
      doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
      doc.moveDown(0.4);
    };

    sectionTitle('Summary');
    doc.fontSize(10).font('Helvetica');
    const s = report.summary;
    const col2 = 230;
    const startY = doc.y;

    // Left column
    doc.text(`Total lots:     ${s.total_lots}`,    50, startY);
    doc.text(`Sold:           ${s.sold_lots}`);
    doc.text(`Unsold:         ${s.unsold_lots}`);
    doc.text(`Unique buyers:  ${s.unique_buyers_count}`);

    // Right column
    doc.text(`Gross revenue:  ${fmt(s.gross_revenue_cents)}`,  col2, startY);
    doc.text(`Platform fee:   ${fmt(s.platform_fee_cents)}`,   col2);
    doc.text(`Seller payout:  ${fmt(s.seller_payout_cents)}`,  col2);
    doc.text(`Highest sale:   ${fmt(s.highest_sale_cents)}`,   col2);

    doc.moveDown(1.5);

    // ── Lots table ───────────────────────────────────────────────────────────
    sectionTitle('Lots');

    // Column layout: x positions and widths
    const cols = {
      num:      { x: 50,  w: 35,  label: '#'           },
      title:    { x: 90,  w: 155, label: 'Title'        },
      price:    { x: 250, w: 70,  label: 'Final Price'  },
      bids:     { x: 325, w: 40,  label: 'Bids'         },
      extended: { x: 370, w: 50,  label: 'Extended'     },
      intensity:{ x: 425, w: 55,  label: 'Intensity'    },
      winner:   { x: 485, w: 77,  label: 'Winner'       },
    };

    // Header row
    doc.fontSize(9).font('Helvetica-Bold');
    Object.values(cols).forEach(c => doc.text(c.label, c.x, doc.y, { width: c.w }));
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(562, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(0.3);

    doc.fontSize(9).font('Helvetica');

    if (report.lots.length === 0) {
      doc.text('No lots found for this auction.');
    }

    for (const lot of report.lots) {
      if (doc.y > 680) doc.addPage();

      const rowY = doc.y;
      const winner = lot.winner_email ?? (lot.winner_user_id ? lot.winner_user_id : '—');

      doc.text(lot.lot_number ?? '—',            cols.num.x,       rowY, { width: cols.num.w });
      doc.text(lot.title ?? 'Untitled',          cols.title.x,     rowY, { width: cols.title.w });
      doc.text(fmt(lot.winning_amount_cents),    cols.price.x,     rowY, { width: cols.price.w });
      doc.text(String(lot.bid_count),            cols.bids.x,      rowY, { width: cols.bids.w });
      doc.text(lot.was_extended ? 'Yes' : 'No', cols.extended.x,  rowY, { width: cols.extended.w });
      doc.text(lot.intensity,                    cols.intensity.x, rowY, { width: cols.intensity.w });
      doc.text(winner,                           cols.winner.x,    rowY, { width: cols.winner.w });

      doc.moveDown(0.8);
    }

    doc.end();
  });

  return { buffer, path: pdfPath };
}

// ── sendFinalSellerReport ─────────────────────────────────────────────────────
// MANUAL ONLY — invoked exclusively via POST /api/admin/auctions/:id/send-final-report.
async function sendFinalSellerReport(auctionId) {
  const [pdfResult, sellerRes] = await Promise.all([
    buildReportPdf(auctionId),
    db.query(
      `SELECT u.email
       FROM auctions a
       JOIN users u ON u.id = a.created_by_user_id
       WHERE a.id = $1`,
      [auctionId]
    )
  ]);

  if (!sellerRes.rows[0]) throw new Error('Auction not found');
  const sellerEmail = sellerRes.rows[0].email;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('Email config missing: set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env');
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from:    process.env.EMAIL_FROM || 'noreply@advantageauction.bid',
    to:      sellerEmail,
    subject: 'Your Final Auction Report',
    text: [
      'Hello,',
      '',
      'Your auction has closed and your final report is ready.',
      'Please find the full auction summary and payout breakdown attached.',
      '',
      'Thank you,',
      'Advantage Auction',
    ].join('\n'),
    attachments: [{
      filename: `auction-report-${auctionId}.pdf`,
      path:     pdfResult.path,
    }],
  });

  return { auction_id: auctionId, seller_email: sellerEmail, pdf_path: pdfResult.path, emailed: true };
}

module.exports = { buildReportPdf, sendFinalSellerReport };

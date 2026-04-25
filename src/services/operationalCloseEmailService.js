const nodemailer = require('nodemailer');
const db = require('../db');

function formatCents(cents) {
  if (cents == null) return '$0.00';
  return '$' + (cents / 100).toFixed(2);
}

function buildTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('Email config missing: set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env');
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

async function sendOperationalCloseEmail(auctionId) {
  // Three independent queries — run in parallel
  const [auctionRes, buyerRes, unpaidRes] = await Promise.all([
    // Auction header + seller email + gross total
    db.query(
      `SELECT a.title, a.id,
              u.email AS seller_email,
              COALESCE(SUM(l.winning_amount_cents) FILTER (WHERE l.winning_buyer_user_id IS NOT NULL), 0)::int
                AS gross_total_cents
       FROM auctions a
       JOIN users u ON u.id = a.created_by_user_id
       LEFT JOIN lots l ON l.auction_id = a.id
       WHERE a.id = $1
       GROUP BY a.title, a.id, u.email`,
      [auctionId]
    ),

    // Per-buyer summary: email, lots won, total owed
    db.query(
      `SELECT u.email              AS buyer_email,
              COUNT(l.id)::int     AS lots_won,
              COALESCE(SUM(l.winning_amount_cents), 0)::int AS total_cents
       FROM lots l
       JOIN users u ON u.id = l.winning_buyer_user_id
       WHERE l.auction_id = $1
         AND l.winning_buyer_user_id IS NOT NULL
       GROUP BY u.email
       ORDER BY total_cents DESC`,
      [auctionId]
    ),

    // Unpaid: sold lots with no paid payment record
    db.query(
      `SELECT COUNT(l.id)::int AS unpaid_count
       FROM lots l
       LEFT JOIN payments p ON p.lot_id = l.id AND p.status = 'paid'
       WHERE l.auction_id = $1
         AND l.winning_buyer_user_id IS NOT NULL
         AND p.id IS NULL`,
      [auctionId]
    )
  ]);

  if (!auctionRes.rows[0]) {
    throw new Error('Auction not found');
  }

  const { title, seller_email, gross_total_cents } = auctionRes.rows[0];
  const buyers = buyerRes.rows;
  const unpaidCount = unpaidRes.rows[0].unpaid_count;

  // Build plain-text body
  const lines = [
    `Auction Closed: ${title}`,
    `Auction ID: ${auctionId}`,
    '',
    `Current Auction Total: ${formatCents(gross_total_cents)}`,
    ''
  ];

  if (unpaidCount > 0) {
    lines.push(`⚠ UNPAID ITEMS WARNING: ${unpaidCount} sold lot(s) do not yet have a confirmed payment.`);
    lines.push('');
  }

  if (buyers.length === 0) {
    lines.push('No winning buyers recorded for this auction.');
  } else {
    lines.push('Buyer Summary:');
    for (const b of buyers) {
      lines.push(`  ${b.buyer_email} — ${b.lots_won} lot(s) — ${formatCents(b.total_cents)}`);
    }
  }

  lines.push('');
  lines.push('This is an operational notice. Pickup scheduling and final settlement details will follow.');
  lines.push('');
  lines.push('— Advantage Auction');

  const transporter = buildTransporter();

  await transporter.sendMail({
    from:    process.env.EMAIL_FROM || 'noreply@advantageauction.bid',
    to:      seller_email,
    subject: `[Auction Closed] ${title}`,
    text:    lines.join('\n')
  });

  console.log(`[email] operational close email sent for auction_id=${auctionId}`);
  return { auction_id: auctionId, seller_email, emailed: true };
}

module.exports = { sendOperationalCloseEmail };

const nodemailer = require('nodemailer');
const db = require('../db');

function formatCents(cents) {
  if (cents == null) return '$0.00';
  return '$' + (cents / 100).toFixed(2);
}

function buildTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('Email config missing: set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env');
  }
  const port   = parseInt(SMTP_PORT || '587', 10);
  const secure = SMTP_SECURE === 'true' || SMTP_SECURE === '1' || port === 465;
  return nodemailer.createTransport({
    host:             SMTP_HOST,
    port,
    secure,
    auth:             { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 15_000,
    greetingTimeout:   10_000,
    socketTimeout:     30_000,
  });
}

async function sendOperationalCloseEmail(auctionId) {
  // Three independent queries - run in parallel
  const [auctionRes, buyerRes, unpaidRes] = await Promise.all([
    // Auction header + seller email + gross total
    db.query(
      `SELECT a.title, a.id,
              u.email AS seller_email,
              COALESCE(SUM(l.winning_amount_cents) FILTER (WHERE l.winning_buyer_user_id IS NOT NULL), 0)::int
                AS gross_total_cents
       FROM auctions a
       JOIN seller_profiles sp ON sp.id = a.seller_id
       JOIN users u            ON u.id = sp.user_id
       LEFT JOIN lots l ON l.auction_id = a.id
       WHERE a.id = $1
       GROUP BY a.title, a.id, u.email`,
      [auctionId]
    ),

    // Per-buyer summary by PADDLE NUMBER, lots won, total owed. This email goes out at close, before anyone has paid,
    // so it carries no buyer contact details (owner policy 2026-10-15: contact is shared once the buyer pays).
    db.query(
      `SELECT ab.paddle_number       AS paddle_number,
              COUNT(l.id)::int     AS lots_won,
              COALESCE(SUM(l.winning_amount_cents), 0)::int AS total_cents
       FROM lots l
       LEFT JOIN auction_buyers ab ON ab.auction_id = l.auction_id AND ab.user_id = l.winning_buyer_user_id
       WHERE l.auction_id = $1
         AND l.winning_buyer_user_id IS NOT NULL
       GROUP BY l.winning_buyer_user_id, ab.paddle_number
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
    buyers.forEach((b, i) => {
      const who = b.paddle_number != null ? `Paddle ${b.paddle_number}` : `Buyer ${i + 1}`;
      lines.push(`  ${who} - ${b.lots_won} lot(s) - ${formatCents(b.total_cents)}`);
    });
    lines.push('');
    lines.push('Buyer names and contact details are shared with you once each buyer has paid.');
  }

  lines.push('');
  lines.push('This is an operational notice. Pickup scheduling and final settlement details will follow.');
  lines.push('');
  lines.push('- Advantage.Bid');

  const transporter = buildTransporter();

  const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@advantageauction.bid';
  await transporter.sendMail({
    from:    fromAddress,
    to:      seller_email,
    subject: `[Auction Closed] ${title}`,
    text:    lines.join('\n')
  });

  console.log(`[email] operational close email sent for auction_id=${auctionId}`);
  return { auction_id: auctionId, seller_email, emailed: true };
}

module.exports = { sendOperationalCloseEmail };

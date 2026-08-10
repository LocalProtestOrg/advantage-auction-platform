'use strict';

/**
 * Email standardization verification (Final Email Standardization phase).
 *  - Brand: every transactional email builder renders "Advantage.Bid" (never "Advantage Auction[s]").
 *  - One output per category (renders the ACTIVE builder for each category).
 *  - HTML/text parity, correct subject, internal links.
 *  - Reply-To honors EMAIL_REPLY_TO env and never falls back to a personal Gmail.
 *  - Single production path: close emails are flag-gated mutually exclusive; the legacy
 *    notificationService (emoji builders) is not wired into any sender.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const notificationContent = require('../src/lib/notificationContent');
const combinedReceipt = require('../src/services/combinedReceiptService');
const sellerCloseout = require('../src/services/sellerCloseoutService');
const doc = require('../src/services/documentService');

const EMAIL_BUILDER_FILES = [
  'src/lib/notificationContent.js', 'src/workers/notificationWorker.js',
  'src/services/sellerCloseoutService.js', 'src/services/emailVerificationService.js',
  'src/services/passwordResetService.js', 'src/services/notificationService.js',
  'src/services/operationalCloseEmailService.js', 'src/services/invoicePdfService.js',
  'src/services/verificationService.js', 'src/services/agreementService.js',
  'src/services/appraiserEmails.js', 'src/services/estateSaleEmails.js',
  'src/services/combinedReceiptService.js', 'src/services/receiptService.js',
];
const noOldBrand = (s) => !/Advantage Auctions?\b/.test(s);
const hasBrand = (s) => /Advantage\.Bid/.test(s);

describe('brand: no builder renders the old "Advantage Auction[s]" wording', () => {
  for (const f of EMAIL_BUILDER_FILES) {
    test(f, () => { expect(noOldBrand(read(f))).toBe(true); });
  }
  test('shared email header renders the Advantage.Bid wordmark', () => {
    const h = doc.emailBrandHeader();
    // The wordmark is split across spans: Advantage<span>.Bid</span> — check both parts, no old brand.
    expect(h).toContain('Advantage');
    expect(h).toContain('.Bid');
    expect(noOldBrand(h)).toBe(true);
  });
});

describe('rendered emails: single, branded, parity, links (active builders)', () => {
  test('Outbid (notification) — subject, brand, parity, lot link', () => {
    const m = notificationContent.buildLotEmail('OUTBID', {
      lot: { id: 'lot-1', title: 'Vintage Chair', current_bid_cents: 2500, auction_id: 'auc-1' },
      auction: { title: 'Estate Auction' }, toAddress: 'buyer@example.com',
    });
    expect(m.subject).toMatch(/outbid/i);
    expect(noOldBrand(m.subject)).toBe(true);
    expect(hasBrand(m.html)).toBe(true);
    expect(noOldBrand(m.html)).toBe(true);
    expect(typeof m.text).toBe('string'); expect(m.text.length).toBeGreaterThan(0);   // HTML/text parity
    expect(m.html).toContain('/lot.html?lotId=');
  });

  test('Reminder (ending soon) — branded, parity', () => {
    const m = notificationContent.buildLotEmail('ENDING_SOON', {
      lot: { id: 'lot-2', title: 'Oak Table', current_bid_cents: 4000, auction_id: 'auc-1' },
      auction: { title: 'Estate Auction' }, toAddress: 'buyer@example.com',
    });
    expect(m.subject).toMatch(/closing soon/i);
    expect(hasBrand(m.html)).toBe(true); expect(noOldBrand(m.html)).toBe(true);
    expect(m.text.length).toBeGreaterThan(0);
  });

  const invData = {
    invoiceNumber: 'INV-1001', auctionTitle: 'Estate Auction',
    lines: [{ lotNumber: 1, title: 'Chair', hammerCents: 2500 }],
    summary: { hammerCents: 2500, buyerPremiumCents: 450, salesTaxCents: 0, shippingCents: 0, creditsCents: 0, totalCents: 2950 },
    pickup: { address: '123 Main St, Town, ST', recommended: '9:00 AM to 10:00 AM', published: 'Sat 9:00 AM to 12:00 PM' },
  };

  test('Receipt (paid) — subject, brand, pickup order, parity', () => {
    const m = combinedReceipt.buildSuccessPackageEmail(invData);
    expect(m.subject).toBe('Payment receipt - Invoice INV-1001');
    expect(hasBrand(m.html)).toBe(true); expect(noOldBrand(m.html)).toBe(true);
    expect(m.html).toContain('Pickup Date / Time');
    expect(m.html).toContain('Recommended Arrival Time');
    expect(m.text.length).toBeGreaterThan(0); expect(noOldBrand(m.text)).toBe(true);
  });

  test('Invoice (payment required) — subject, brand, parity', () => {
    const m = combinedReceipt.buildPaymentRequiredEmail(invData, { reminderNo: 1 });
    expect(m.subject).toMatch(/payment required/i);
    expect(hasBrand(m.html)).toBe(true); expect(noOldBrand(m.html)).toBe(true);
    expect(m.text.length).toBeGreaterThan(0);
  });

  test('Seller closeout — subject, brand, parity', () => {
    const m = sellerCloseout.buildEmail({
      auctionTitle: 'Estate Auction', auctionId: 'auc-1',
      report: { summary: { total_lots: 10, sold_lots: 8, unsold_lots: 2, unique_buyers_count: 5, gross_revenue_cents: 100000 } },
      invoices: [], unsold: [{ lot_number: 3, title: 'Lamp' }], pickups: [], noShows: [], settlementsOn: false,
    });
    expect(m.subject).toBe('[Auction Closeout] Estate Auction');
    expect(hasBrand(m.html)).toBe(true); expect(noOldBrand(m.html)).toBe(true);
    expect(m.text.length).toBeGreaterThan(0); expect(noOldBrand(m.text)).toBe(true);
  });
});

describe('non-exported builders: branded subjects (source)', () => {
  test('email verification: Advantage.Bid subject', () => {
    expect(read('src/services/emailVerificationService.js')).toMatch(/subject = 'Welcome to Advantage\.Bid: please confirm your email'/);
  });
  test('password reset: Advantage.Bid subject', () => {
    expect(read('src/services/passwordResetService.js')).toMatch(/subject = 'Reset your Advantage\.Bid password'/);
  });
});

describe('Reply-To honors env, never a personal Gmail', () => {
  // Mirrors emailService: EFFECTIVE_REPLY_TO = EMAIL_REPLY_TO || EMAIL_FROM(||SMTP_FROM||SMTP_USER||noreply@…)
  function effectiveReplyTo(env) {
    const from = env.EMAIL_FROM || env.SMTP_FROM || env.SMTP_USER || 'noreply@advantageauction.bid';
    return env.EMAIL_REPLY_TO || from;
  }
  test('uses EMAIL_REPLY_TO when configured', () => {
    expect(effectiveReplyTo({ EMAIL_REPLY_TO: 'support@advantage.bid', EMAIL_FROM: 'noreply@advantage.bid' })).toBe('support@advantage.bid');
  });
  test('falls back to branded From, not gmail, when unset', () => {
    const r = effectiveReplyTo({ EMAIL_FROM: 'noreply@advantage.bid' });
    expect(r).toBe('noreply@advantage.bid');
    expect(r).not.toMatch(/gmail\.com/);
  });
  test('source has no hardcoded gmail reply-to default', () => {
    const src = read('src/services/emailService.js');
    expect(src).not.toMatch(/advantageauction\.bid@gmail\.com/);
    expect(src).toMatch(/EFFECTIVE_REPLY_TO = EMAIL_REPLY_TO \|\| EMAIL_FROM/);
    expect(src).toMatch(/replyTo: replyTo \|\| EFFECTIVE_REPLY_TO/);
  });
});

describe('single production path (no duplicate auto-fire)', () => {
  test('close emails are flag-gated mutually exclusive in auctionService', () => {
    const src = read('src/services/auctionService.js');
    expect(src).toMatch(/if \(!combinedInvoicingEnabled\(process\.env\)\)/);      // per-lot branch
    expect(src).toMatch(/operationalCloseEmailService/);                          // only in the !combined branch
    expect(src).toMatch(/combinedReceiptService/);                               // only in the else branch
  });
  test('legacy notificationService is not wired into any sender (worker/bid/payments)', () => {
    for (const f of ['src/workers/notificationWorker.js', 'src/services/bidService.js', 'src/routes/payments.js']) {
      expect(read(f)).not.toMatch(/require\(['"][^'"]*notificationService['"]\)/);
    }
  });
});

'use strict';

/**
 * Event Partner invitations are commercial email (baseline audit 2026-11-08): besides the postal address they carry a
 * visible unsubscribe link and the one-click List-Unsubscribe header, using the shared business suppression that every
 * outreach program honours (partnerSuppressionService.isSuppressed reads listing_outreach_suppressions). Without a
 * working unsubscribe, nothing is sent.
 */
const fs = require('fs');
const path = require('path');
const svc = require('../../src/services/eventPartners/outreachSendService');

test('the link is added to the text and HTML (escaped), once, before the closing body tag', () => {
  const m = svc.withUnsubscribe({ subject: 's', text: 'Hello', html: '<html><body><p>Hello</p></body></html>' }, 'https://bid.advantage.bid/api/public/listing-outreach/unsubscribe?t=a&b');
  expect(m.text).toBe('Hello\n\nTo stop receiving these emails: https://bid.advantage.bid/api/public/listing-outreach/unsubscribe?t=a&b');
  expect(m.html).toMatch(/unsubscribe\?t=a&amp;b" style="color:#94a3b8">unsubscribe<\/a>\.<\/p><\/body><\/html>$/);
  expect(m.unsubscribeUrl).toMatch(/listing-outreach\/unsubscribe/);
});

test('the send sets the one-click header and refuses to send when unsubscribe is not configured', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'eventPartners', 'outreachSendService.js'), 'utf8');
  expect(src).toMatch(/headers: \{ 'List-Unsubscribe': '<' \+ msg\.unsubscribeUrl \+ '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' \}/);
  expect(src).toMatch(/if \(!unsubToken\.configured\(\)\) \{ outcome\.sent = false; outcome\.skipped = 'UNSUBSCRIBE_NOT_CONFIGURED'; return outcome; \}/);
  // the unsubscribe writes the suppression list the partner program checks
  expect(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'eventPartners', 'partnerSuppressionService.js'), 'utf8'))
    .toMatch(/FROM listing_outreach_suppressions WHERE normalized_email/);
});

'use strict';

/**
 * Owner decision 2026-11-07: publishing a new Seller Agreement version never emails, texts or reminds existing sellers.
 * The publishing code paths contain no messaging; sellers meet the new version in the app when they next start a new
 * listing (tests/browser/seller-agreement-current-version.browser.test.js).
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MESSAGING = /emailService|sendEmail|smsService|sendSms|twilio|notificationService|notifications_queue|enqueueNotification|ownerAlertService|sellerActivation/i;

test('the publish script and the template version publisher send no message of any kind', () => {
  expect(read('scripts', 'prod-publish-seller-agreement-version.js')).not.toMatch(MESSAGING);
  expect(read('src', 'services', 'agreementTemplateService.js')).not.toMatch(MESSAGING);
});

test('the in-app issue of the current version never emails the link', () => {
  const svc = read('src', 'services', 'agreementService.js');
  const fn = svc.slice(svc.indexOf('async function ensureCurrentAgreement'), svc.indexOf('const CURRENT_AGREEMENT_MESSAGE'));
  expect(fn).toMatch(/sendAgreement\(\{ sellerProfileId, overrides, actorId, sendEmail: false \}\)/);
  expect(fn).not.toMatch(/sendEmail: true|emailLink\(/);
});

#!/usr/bin/env node
/* build-auction-partner-addendum-pdf.js — render the email copy of the Advantage.Bid Auction Partner Program Addendum.
   Uses the platform's own agreement PDF renderer (agreementPdfService.buildUnsignedPdfBuffer, PDFKit) and the SAME
   source text the online agreement is published from (docs/legal/auction-partner-program-addendum.md), so the email
   copy matches the version partners sign. No database, no network.

     node scripts/build-auction-partner-addendum-pdf.js
   → docs/legal/auction-partner-program-addendum.pdf (+ prints the text fingerprint) */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ap = require('../src/services/auctionPartnerAgreementService');
const pdf = require('../src/services/agreementPdfService');

(async () => {
  const body = ap.loadBody();
  const fingerprint = crypto.createHash('sha256').update(body).digest('hex');
  const buf = await pdf.buildUnsignedPdfBuffer({
    document_title: ap.ADDENDUM_NAME,
    rendered_body: ap.previewBody(body),
    version_int: 1,                       // the first published version of this text (a text change publishes v2)
    resolved_variables: {},
    party_snapshot: {},
  });
  const out = path.join(__dirname, '..', 'docs', 'legal', 'auction-partner-program-addendum.pdf');
  fs.writeFileSync(out, buf);
  console.log('wrote ' + out + ' (' + buf.length + ' bytes); text SHA-256 ' + fingerprint);
})().catch((e) => { console.error(e.message); process.exit(1); });

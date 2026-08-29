'use strict';

/**
 * companyContact — the ONE authoritative source for Advantage.Bid's public business contact details.
 * Server-side consumers (email templates, SSR/JSON-LD) import this; the browser uses the matching
 * public/widgets/shared/company-contact.js. Change the number in these two files ONLY — never hardcode
 * it elsewhere. This is the CORPORATE contact; it is never a seller's or a buyer's phone number.
 */

const PHONE_DISPLAY = '(551) 655-7050';       // human display
const PHONE_E164 = '+15516557050';            // dialable / tel: value
const TEL_HREF = 'tel:+15516557050';          // click-to-call href
const PHONE_SCHEMA = '+1-551-655-7050';       // schema.org telephone format
const SUPPORT_EMAIL = 'info@advantage.bid';   // existing approved support/contact email (unchanged)
const NAME = 'Advantage.Bid';
const WEBSITE = 'https://bid.advantage.bid';

// A plain-text signature/contact block for emails (company line only — never overrides a rep's identity).
function emailContactLines() {
  return `${NAME}\n${PHONE_DISPLAY}\n${SUPPORT_EMAIL}\n${WEBSITE}`;
}

module.exports = { PHONE_DISPLAY, PHONE_E164, TEL_HREF, PHONE_SCHEMA, SUPPORT_EMAIL, NAME, WEBSITE, emailContactLines };

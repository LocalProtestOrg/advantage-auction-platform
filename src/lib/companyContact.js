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
// Public office / support hours (owner decision 2026-10-12). Staff availability only: an automated assistant may answer
// at other times, which never implies staff are available then.
const OFFICE_HOURS = 'Monday through Friday, 10:00 AM to 5:00 PM Eastern Time';

// A plain-text signature/contact block for emails (company line only — never overrides a rep's identity).
function emailContactLines() {
  return `${NAME}\n${PHONE_DISPLAY}\n${SUPPORT_EMAIL}\n${WEBSITE}`;
}

module.exports = { PHONE_DISPLAY, PHONE_E164, TEL_HREF, PHONE_SCHEMA, SUPPORT_EMAIL, NAME, WEBSITE, OFFICE_HOURS, emailContactLines };

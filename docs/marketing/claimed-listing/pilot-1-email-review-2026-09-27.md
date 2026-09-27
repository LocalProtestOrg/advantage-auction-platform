# Claimed Listing Pilot 1: shared email infrastructure and revised emails (FOR OWNER REVIEW)

**Status:** review document.
- No template is edited or approved in the database.
- Nothing is sent. Pilot 1 (22 companies) stays DRAFT, and all four switches are OFF.

**Date:** 2026-09-27. Production code 9889086 (deployment 0fa57dd5).

## 1. What Claimed Listing reuses from the existing email system

| Piece | Status in production | Claimed Listing |
|---|---|---|
| Sending domain advantage.bid and SES SMTP transport | WORKING | Shared: same transport, From `listings@advantage.bid` on the verified domain |
| SNS feedback to `POST /api/ses/feedback` (signed, secret-guarded) | WORKING; proven by Event Partner: 10 deliveries and 1 bounce received 2026-09-22 | Shared. Events are assigned to a programme by **configuration-set name** |
| Global suppression `email_suppressions` (hard bounces, complaints, consumer unsubscribes) | WORKING (1 hard-bounce row, written by the Event Partner bounce) | Read before every listing send. SES hard bounces and complaints from listing mail are written here automatically |
| Event Partner suppression list | Present (0 rows) | Read before every listing send |
| Marketing configuration set `advantage-bid-marketing` | Configured, but no marketing campaign has sent yet, so its feedback is unproven on live mail | **Not used for listings** (see below) |
| Marketing unsubscribe (`MARKETING_EMAIL_SECRET`), consent, marketing kill switch | Consumer marketing only | Not shared, on purpose: listing mail is B2B directory outreach. Its unsubscribe is purpose-bound, so a listing link can never unsubscribe someone from consumer marketing or the reverse |
| Inbound replies: Postmark parsed-inbound webhook `/api/webhooks/email/inbound` (Event Partner) | Code live; **not configured** (see section 4) | Shared: the same webhook routes listing replies by their `listings+l...` key |

### Why Claimed Listing needs its own configuration set
- The shared feedback pipeline decides which programme an SES event belongs to from the configuration-set name. `advantage-bid-claimed-listing` maps to Claimed Listing (`src/lib/sesNotificationParser.js`).
- If listing mail went through `advantage-bid-marketing`, its bounces and complaints would be recorded as consumer marketing. Claimed Listing would then:
  - never mark its messages bounced or complained;
  - never retry soft bounces;
  - never stop a sequence;
  - and its automatic health pause (bounce 3% or more, complaint 0.1% or more) would read zero events and never trip.
- B2B cold-outreach reputation would also mix with buyer marketing.
- Event Partner already uses this one-set-per-programme pattern successfully.

**The only new SES object needed is one configuration set, not a new system:**
- create configuration set `advantage-bid-claimed-listing` (this exact name) in the same SES account and region;
- add an event destination that publishes Send, Delivery, Bounce, Complaint and Reject to the **existing** SNS feedback topic (the one `advantage-bid-marketing` and `advantage-bid-event-partner` already publish to);
- set Railway `SES_CLAIMED_LISTING_CONFIGURATION_SET=advantage-bid-claimed-listing`.

## 2. Fixed and deployed on 2026-09-27

| Commit | Fix | Verified in production |
|---|---|---|
| d76dff3 | Admin program settings and the stop switch returned 500 after saving (audit row had no entity id); screening silently lost its audit row | Real prod DB, Owner identity: all four switches saved OFF plus the address → 200 with an audit row; turning on without the phrase → 400; stop → 200 with an audit row; stop note cleared. Final: all OFF, no stop note |
| 9889086 | SES message id: listing messages stored the local Message-ID, which SES feedback never carries, so bounce and complaint events could not update the listing message. The SES id is now captured from the SMTP reply | Unit tests. Confirm on the first internal test send (the stored id must equal the feedback event id) |
| 9889086 | Event Partner outreach now honours Claimed Listing opt-outs (one B2B audience) | Prod: a signed one-click unsubscribe for a reserved test address was suppressed for Claimed Listing AND Event Partner. The test rows were then removed |
| 9889086 | An inbound reply matching no outbound message could fail its audit insert and roll back a STOP suppression | Unit test |
| (config) | `LISTING_OUTREACH_UNSUB_SECRET` generated (48 random bytes) and set in Railway. The value was never displayed or written to a file | Live site accepts links signed with it and rejects a tampered link; opening a link does not unsubscribe (the one-click POST does). No link had ever been sent before, so nothing was invalidated |
| (config) | `company.postal_address` = "2205 Ogden Hwy, Adrian, MI 49221" | Rendered in every footer |

Tests: 4,490 passed, 0 failed. Marketplace integrity gate PASS.

## 3. Deliberate separations that stay

- **The listing unsubscribe does not write the global consumer list.** A business opting out of listing emails has not withdrawn from buyer marketing, which needs its own affirmative consent anyway.
- Hard bounces and complaints DO reach the global list through SES feedback.
- Separate reporting per programme: `listing_outreach_messages`, `listing_claim_events` and the stream health are kept apart from the marketing tables.
- Separate kill switches per programme (`claimed_listings.sending_enabled` and the stop route).

## 4. Reply handling (shared with Event Partner; not configured for either)

| Requirement | State |
|---|---|
| Webhook code, STOP handling (suppress plus stop sequence), human replies go to a staff task with one-day SLA, legal replies escalate | LIVE code |
| MX record `reply.advantage.bid` → `inbound.postmarkapp.com` | MISSING: the domain does not exist in DNS (Owner; DNS is managed in BD) |
| Postmark inbound stream with `reply.advantage.bid` as the inbound domain, webhook `https://bid.advantage.bid/api/webhooks/email/inbound?token=<secret>` | NOT SET UP. The SPF record still includes Postmark from the old account, but that account was rejected, so a new inbound-only account is needed (Owner decision) |
| `EVENT_PARTNER_INBOUND_SECRET` (shared by both programmes) | UNSET. I can generate it once the Postmark side exists |
| `claimed_listings.inbound_enabled` | OFF (turn on only after the above is proven) |

- Until this exists, replies to listing emails, including STOP, bounce back to the sender.
- The unsubscribe link and the complaint path still work, but **replies must work before any prospect email**.
- The Marketing Agency has no inbound handling to reuse.

Also recommended (DNS, Owner): add SPF TXT `v=spf1 include:amazonses.com ~all` on `bounce.advantage.bid`. It is the SES MAIL FROM domain and has an MX but no SPF record. Mail passes on DKIM today; SPF adds a second pass, which is worthwhile for cold outreach.

## 5. Revised emails for review

- Validated with the platform's own checks (footer, claim link, variables, no em dash, links only on advantage.bid, no technology or vendor terms).
- Also checked against the outreach-safety test: no "Professional Seller", no percentages, no dollar amounts.
- Also checked that no disabled or planned feature is claimed (no checkout, Buy Now, import or bulk tools).
- Sample recipient data is shown. The footer shows the real address.
- The storefront is described as "buyers contact you directly", because checkout is off.
- E2_CLICKED, E3, E4_REFRESH, CL_SELF_REQUEST and A2 stay as they are (claim mechanics only).
- A1 now offers a phone call instead of "Reply here", because replies are not live yet.

### E1

**Subject:** Your Advantage.Bid listing for Sample Estate Sales

```text
Hello,

People in the Houston area use Advantage.Bid to find estate sales and auctions, and our business directory includes a listing for Sample Estate Sales:
https://www.advantage.bid/sample

It shows your company name, your Houston location and phone number, taken from public business information. You can claim the listing and manage it yourself. Claiming is free, with no monthly fee and no credit card.

Once it's yours, you can:
- correct anything that is out of date
- add your logo and a description in your own words
- post your upcoming estate sales and auctions so local buyers can find them

When you want them, Advantage.Bid can also help Sample Estate Sales sell more:
- Online auctions under your own company name. Each auction shows on your website and on the Advantage.Bid marketplace, so it reaches your customers and new buyers. No website? Your Advantage.Bid company page works as your home online.
- More from every estate: auction what is left after a sale, and offer items at a fixed price on your company storefront, where buyers contact you directly.
- An easier yes for clients: offer an estate sale, an online auction, or both.

None of that is needed to claim the listing.

Claim the Sample Estate Sales listing:
https://bid.advantage.bid/claim/SAMPLE

This link was sent to s•••••@example.com and works for 14 days.

Claiming is optional. If you would rather not hear from us about this listing, use the link at the bottom of this email and we won't write again.

Kym Witt
Advantage.Bid
(551) 655-7050
--
You are receiving this because Sample Estate Sales is listed in the Advantage.Bid business directory with this email address. Wrong contact, or has the business closed? Tell us: https://bid.advantage.bid/claim/SAMPLE#options
Don't email me about this listing: https://bid.advantage.bid/api/public/listing-outreach/unsubscribe?t=SAMPLE
Advantage.Bid, 2205 Ogden Hwy, Adrian, MI 49221
```

### E2_NOCLICK

**Subject:** What people see when they find Sample Estate Sales

```text
Hello,

Following up about the Sample Estate Sales listing on Advantage.Bid. Here is what it shows today:

Name: Sample Estate Sales
Location: Houston, TX
Phone: (713) 555-0100
Website: none listed
Description: none yet

If any of that is wrong or missing, claiming the listing lets you fix it in a few minutes.
If Sample Estate Sales doesn't have its own website, the listing can serve as a simple company page you can share with clients, with your details, your logo and your upcoming sales in one place.
Whether or not you have a website, your online auctions can carry your company name: shown on your own site if you have one, and always reaching buyers on the Advantage.Bid marketplace.

Claim the listing:
https://bid.advantage.bid/claim/SAMPLE

This is a new link for s•••••@example.com. The one in my earlier email no longer works.

Kym
Advantage.Bid · (551) 655-7050
--
You are receiving this because Sample Estate Sales is listed in the Advantage.Bid business directory with this email address. Wrong contact, or has the business closed? Tell us: https://bid.advantage.bid/claim/SAMPLE#options
Don't email me about this listing: https://bid.advantage.bid/api/public/listing-outreach/unsubscribe?t=SAMPLE
Advantage.Bid, 2205 Ogden Hwy, Adrian, MI 49221
```

### A1

**Subject:** Sample Estate Sales is yours to manage

```text
Hi Pat,

You've claimed Sample Estate Sales on Advantage.Bid. It's free, with no monthly fee.

Your listing checklist takes about ten minutes:
1. Confirm your business details
2. Add your logo
3. Replace our description with your own
4. Choose your service area and specialties
5. Post your next estate sale or auction

Open your checklist: https://bid.advantage.bid/org/profile.html

When you are ready, I can show you how online auctions and a company storefront could work for Sample Estate Sales.

Questions? Call (551) 655-7050.

Kym
Advantage.Bid
```

### A3

**Subject:** Have a sale coming up?

```text
Hi Pat,

When you post an upcoming estate sale or auction, it shows on your Sample Estate Sales page and on the Advantage.Bid pages buyers in the Houston area use to find sales. Posting is free, and you can have up to three active at a time.

Have contents left after the sale? You can auction them online under your company name, on your website and on Advantage.Bid, or offer them at a fixed price on your company storefront.

Post a sale: https://bid.advantage.bid/org/events.html

No sale scheduled right now? You can mark that on your checklist and we'll stop reminding you.

Kym
Advantage.Bid

Email preferences: https://bid.advantage.bid/account.html
```

### Claim page, "What is Advantage.Bid?" (`src/routes/claimListing.js`, `public/claim-listing.html`)

> Advantage.Bid helps estate sale companies and auction houses grow: post your sales, run online auctions under your own name on your website and our marketplace, and offer leftover items at a fixed price. Claiming your listing is free and is the first step.

### On approval (in this order)
1. Apply the text to the DRAFT rows through the Toolbox editor and to `src/services/claimedListings/templates.js`, so the tests keep matching. Run tests and deploy.
2. Approve the templates and bind them to the cohort (Super Admin).
3. Internal seed test to Advantage.Bid inboxes only (see the checklist in the report).

The live-page accuracy fixes (Buy Now wording) are listed in `outreach-revisions-2026-09-27.md` R6.

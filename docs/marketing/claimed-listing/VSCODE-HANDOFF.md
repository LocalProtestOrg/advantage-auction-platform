# Claimed Listing Activation & Conversion: VS Code Implementation Handoff

Owner mission: Claimed Listing Activation & Conversion (Desktop Marketing, 24 Sep 2026).
Companion document: the private artifact "Claimed Listing Blueprint" (strategy, copy, rationale).
Status: READY FOR IMPLEMENTATION. Nothing may SEND until the Owner approves a pilot cohort (see Gate L0).

This handoff lists what to build, in order, with acceptance criteria. It assumes the repo as audited
at `C:\Projects\advantage-auction-platform` (migration head 166). File references are to that tree.

---

## 0. Ground rules (non-negotiable)

1. **Two journeys, two data sets.** Claimed Listing outreach gets its OWN tables, templates, cohorts,
   suppression list, SES configuration set and mail stream. Do not add rows to any `event_partner_*`
   table and do not add a `program` column to them. Shared infrastructure is limited to: `organizations`,
   `organization_claim_tokens`, `organization_claim_attempts`, `email_suppressions` (global), `emailService`,
   `ses_feedback_events`, `attributionService`, `conversionService`, `auditService`, RBAC.
2. **Fail closed.** Any unknown, error, timeout, missing config, or ambiguous identity = no send.
3. **No autonomous replies to humans.** Deterministic handling is limited to unsubscribe, bounce,
   complaint, auto-reply detection. Every other inbound message pauses automation and creates a task.
4. **No em dashes in any rendered copy** (email, page, toast, subject, From display name). Existing
   violations to fix are listed in section 9.
5. **Public Language Standard** (CLAUDE.md) applies: no "AI", no vendor names in rendered text.
6. **Nothing sends** unless ALL locks in section 5 pass at send time.

---

## 1. Journey ownership lock (fixes the Event Partner collision)  [BUILD, blocker]

**Problem found.** `eventPartners/relationshipSegmentationService.claimedListings()` only screens
organizations that HAVE members. The ~336 BD-imported shells (`lifecycle_state IN ('inactive','directory_listing')`,
no owner) are invisible to it. `outreachSendService.ensureOrganizationForProspect()` then matches an existing
org by domain or exact name, so a directory-listed company can be pulled into cold Event Partner outreach
and become token-only claimable (`isEventPartnerOrganization`).

**Build.**

Migration `167_company_identity_and_journeys.sql` (additive, idempotent):

```sql
CREATE TABLE company_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  normalized_name text, root_domain text, corporate_email_domain text,
  normalized_phone text, google_place_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE company_identity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company_identities(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN
    ('organization','sales_prospect','authorized_event_source','seller_profile','bd_member')),
  entity_id text NOT NULL,
  match_method text NOT NULL CHECK (match_method IN
    ('bd_listing_id','google_place_id','root_domain','corporate_email_domain','phone','exact_name','admin')),
  confidence text NOT NULL CHECK (confidence IN ('strong','admin')),
  linked_at timestamptz NOT NULL DEFAULT now(), linked_by uuid REFERENCES users(id),
  UNIQUE (entity_type, entity_id)
);
CREATE TABLE acquisition_journey_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company_identities(id) ON DELETE CASCADE,
  journey text NOT NULL CHECK (journey IN ('CLAIMED_LISTING','EVENT_PARTNER','SALES_DIRECT')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  reason text NOT NULL, assigned_by uuid REFERENCES users(id), assigned_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz, released_by uuid REFERENCES users(id), release_reason text
);
CREATE UNIQUE INDEX uq_one_active_journey ON acquisition_journey_assignments(company_id) WHERE status = 'active';
```

Service `src/services/acquisition/companyIdentityService.js`:
- Reuse `relationshipSegmentationService` normalizers (`normalizeName`, `rootDomain`, `emailDomain`,
  `normalizePhone`, `isCorporateDomain`, `compareIdentity`). Do not fork them; import them.
- `resolveCompany(entity)` links an entity to an existing company only on a STRONG signal
  (bd_listing_id, google_place_id, corporate root domain, corporate email domain, phone, exact normalized name).
  Weak-only agreement returns `{ ambiguous: true }` and links nothing.
- `backfill()` links every organization, sales_prospect, authorized_event_source and professional
  seller_profile. Dry-run first (report counts), then apply.

Journey assignment rules (`journeyService.assign`):
- Company has an organization with `bd_listing_id IS NOT NULL` or `source = 'bd_import'` and no Event
  Partner authorization at status `invited` or beyond: journey = `CLAIMED_LISTING`.
- Company has an `authorized_event_sources` row at `invited` or beyond: journey = `EVENT_PARTNER`.
- Company is a professional seller: no acquisition journey (customer).
- Only `sales.manage_reps` (Super Admin) can release or move a journey. Release requires a reason and is audited.

Event Partner change (small, required): in `relationshipSegmentationService.resolve()`, before the
relationship sets, return a new decision `EXCLUDE_LISTING_JOURNEY` when the prospect resolves to a company whose
active journey is `CLAIMED_LISTING`. Add the value to `chk_epe_decision` in the same migration.
In `outreachSendService.ensureOrganizationForProspect()`, refuse (fail closed) when the matched org
belongs to a `CLAIMED_LISTING` company.

**Acceptance.**
- Backfill dry-run report lists counts by journey and every ambiguous pair; nothing is written in dry-run.
- A BD shell with website `x.com` plus a sales_prospect with email `info@x.com` resolve to one company.
- An EP screen of that prospect returns `EXCLUDE_LISTING_JOURNEY`. Test covers it.
- Two active assignments for one company are impossible (unique partial index test).

---

## 2. Claimed Listing eligibility screening  [BUILD]

Migration `168_claimed_listing_outreach.sql` creates (all additive):

- `listing_outreach_eligibility_decisions` (one row per organization; same shape as
  `event_partner_eligibility_decisions`, keyed by `organization_id`), decision CHECK:
  `ELIGIBLE_UNCLAIMED_LISTING, EXCLUDE_CLAIMED_LISTING, EXCLUDE_EVENT_PARTNER, EXCLUDE_PRO_SELLER,
  EXCLUDE_SUPPRESSED, EXCLUDE_RECENT_OUTREACH, EXCLUDE_NO_PUBLIC_CONTACT, EXCLUDE_OUT_OF_SCOPE,
  REVIEW_AMBIGUOUS_IDENTITY, REVIEW_OTHER_RELATIONSHIP, REVIEW_DATA_QUALITY`.

Service `src/services/claimedListings/eligibilityService.js`, order of checks (first hit wins):
1. `EXCLUDE_SUPPRESSED`: address in `email_suppressions` (global), `listing_outreach_suppressions`,
   or `event_partner_suppressions`. A STOP from any B2B programme stops this one.
2. `EXCLUDE_NO_PUBLIC_CONTACT`: no `contact_email`, or syntactically invalid, or role address that is
   a no-reply. Free mailboxes (gmail etc.) are ALLOWED here (unlike Event Partner) because the invitation goes
   to the address already published on the listing, and redemption proves mailbox control.
3. `EXCLUDE_RECENT_OUTREACH`: any Claimed Listing send in 90 days outside the company's current sequence,
   any Event Partner send in 90 days, or any `sales_outreach_emails` 1:1 send in 30 days, to the same
   company (not just the same address).
4. `EXCLUDE_CLAIMED_LISTING`: org has an active owner. (Moves to the activation track, section 6.)
5. `EXCLUDE_EVENT_PARTNER`: company journey is `EVENT_PARTNER`.
6. `EXCLUDE_PRO_SELLER`: company links to a professional seller_profile.
7. `EXCLUDE_OUT_OF_SCOPE`: `bd_sync_status = 'removed'`, non-US, Google business status not operational,
   or company on the config list `claimed_listings.excluded_company_ids` (national/international houses;
   seed list in section 10).
8. `REVIEW_AMBIGUOUS_IDENTITY`: weak-only identity resemblance to any other company with a relationship.
9. `REVIEW_OTHER_RELATIONSHIP`: linked sales_prospect with an assigned rep and `contact_status` past
   `new_lead`; an existing staff or test account on the address; a `company_contact_locks` row held by a person.
10. `REVIEW_DATA_QUALITY`: corporate email domain differs from website root domain (example seen:
    "Proxibid" listing with a Schultz Auctioneers address); two or more listings share one email address
    (example: two Black Rock Galleries listings), send only to the primary and mark the others;
    listing currently shows a paid-plan badge the company never bought (section 9.3).
11. Otherwise `ELIGIBLE_UNCLAIMED_LISTING`.

Every decision is persisted with reason, matched entity and signals (same pattern as migration 162).

**Acceptance.** Unit tests for each rule and for ordering; a screening run over staging data returns
counts per decision; a suppression lookup error returns an error (never ELIGIBLE).

---

## 3. Prospect scoring  [BUILD]

Store `listing_outreach_scores (organization_id PK, score smallint, tier char(1), factors jsonb, scored_at)`.
Deterministic, explainable, recomputed nightly. Weights are config (`claimed_listings.score_weights`).

| Factor | Points |
|---|---|
| Strategic market: Houston metro or NYC Tri-State (use `event_markets` / geo resolution) | +25 |
| Business type: estate sale company +15, regional auction house +10, liquidator +10, appraiser +5 | up to +15 |
| Evidence of current operation: Google business status operational and review in last 12 months | +15 |
| Local reputation: Google rating >= 4.5 with >= 25 reviews | +10 |
| Weak web presence: no website or social-only +10, basic/outdated site +8 | up to +10 |
| No online auction capability known (`online_auctions_offered = 'no'` on a linked prospect) | +8 |
| Corporate email domain with valid MX | +5 |
| Named individual at a firm with 50+ employees (proxy: in exclusion watchlist or national chain) | -10 |

Tier A >= 60, B 40 to 59, C < 40. Missing data scores 0 (never guessed).
Google Places lookups reuse `prospectResearch/googlePlaces.js` and `prospect_research_runs` for cost logging.
Owner approval is NOT needed for lookups inside the existing Places budget; do not raise spend.

---

## 4. Claim experience  [BUILD]

### 4.1 Token-first landing: `GET /claim/:token`
New route serving server-rendered HTML (no auth required to VIEW).
- Look up token by hash. NEVER consume on GET (mail security scanners pre-fetch links).
- Valid: render the listing preview (name, city/state, phone, website, current description with a
  label "Written by Advantage.Bid from public business information"), the masked recipient
  (`b•••••@gmail.com`), "Claiming is free. No monthly fee. We never ask for payment details to claim.",
  and the primary action "This is my company, continue".
- Secondary actions (each a POST with the token, each idempotent, each recorded):
  `not_my_company`, `business_closed`, `wrong_contact`, `remove_listing`. All four stop the sequence and
  add a suppression with the matching reason. `remove_listing` unpublishes the BD listing and hides the
  org (soft, reversible) within 2 business days via a staff task; confirmation shown on page, no email.
- Expired/used: page says so and offers "Send a new link to the email on this listing".
- Bot filtering: record `listing_claim_events.page_view` only on a client beacon after DOM ready plus a
  user interaction, or a POST. Server GETs are logged separately as `link_fetch` with UA class.
- `<meta name="robots" content="noindex,nofollow">`, no third-party scripts, no ad pixels on this page.

### 4.2 Token redemption doubles as email verification
`POST /claim/:token/complete` with `{ full_name, password }` (email is taken from the token binding, never
from input):
- If no user exists for the bound email: create the user with `email_verified = true`, reason
  `claim_token_link` (the single-use token was delivered only to that mailbox, equivalent to a
  verification link). Record in audit log.
- If a user exists: require sign-in (return 409 SIGN_IN_REQUIRED, the page switches to a sign-in form
  prefilled with the email), then proceed.
- Call `organizationLifecycleService.claim(userId, orgId, { claimToken })`. Token consumption stays in
  `verifyClaimProof` (atomic, same transaction). Do not weaken the existing ladder.
- Success redirects to the activation checklist (4.4).

### 4.3 Self-service claim request (replaces the dead-end www button)
- `POST /api/public/listings/:orgId/claim-link` (no auth): issues a fresh token bound to the org's
  `contact_email` and sends email template `CL_SELF_REQUEST`. Rate limits: 1 per org per 24h, 3 per org per
  7 days, 10 per IP per day. Response never reveals the full address (masked only).
- Refuse when org is claimed, suppressed (`remove_listing`), or `EXCLUDE_OUT_OF_SCOPE`.
- Tokens issued here: `issue_channel = 'self_request'`.
- "I use a different email": existing verified company-domain rung (`verifyClaimProof` rung 2).
- "I can't access that email": form (name, role, phone, message) creating a `listing_claim_help`
  escalation. Staff verify by calling the phone number ON THE LISTING (never the number supplied in the
  form), then use `claim(..., { adminOverride: true, actorId })`. Record the call in `organization_activity`.
- Page `/claim-listing.html` gets the new UI when `?org=` is present without a token.

### 4.4 BD button target
BD "Claim Listing" currently links `https://www.advantage.bid/join?claim=<hash>`, which lands on the
generic Join page and drops the listing context. Replace with
`https://bid.advantage.bid/claim-listing.html?org=<railway org id>&utm_source=directory&utm_medium=listing&utm_campaign=claim_button`.
Implement via BD widget or template edit through the BD adapter; Owner/Desktop can apply the BD-side
edit once VS Code exposes a stable `bd_listing_id -> org id` lookup endpoint
(`GET /api/public/listings/by-bd/:bdListingId` returning `{ orgId }` only, 404 when claimed/hidden).

**Acceptance.** Playwright: token link opened by a HEAD/GET-only client does not consume the token;
full claim in two screens; wrong-recipient signed-in user is denied (existing test extended);
rate limits enforced; remove_listing creates suppression + staff task.

---

## 5. Outreach send path  [BUILD]

Tables (migration 168):
- `listing_outreach_templates` (key, version, subject, preheader, html, text, status draft|approved|retired,
  approved_by, approved_at). Approved versions are immutable (same pattern as `event_partner_templates`).
- `listing_outreach_cohorts` (+ `_members`): draft|approved|active|paused|closed|expired, `max_sends`,
  `daily_cap`, `approved_by/at` (CHECK like EP), `autonomous_allowed boolean default false`.
- `listing_outreach_sequences`: one per (organization, cycle). Columns: company_id, cohort_id, step
  (0..3), state, next_send_at, stop_reason, assigned_rep_user_id, cycle_no, created_at.
- `listing_outreach_messages`: direction, template_key, template_version, token_id, ses_message_id,
  recipient_email_normalized, status (queued|sent|failed|bounced|complained), idempotency_key UNIQUE
  (`org_id:cycle:step`), reply_key, rendered subject/body snapshot, sent_at.
- `listing_outreach_suppressions` (normalized_email, company_id, reason CHECK
  stop_request|unsubscribe|hard_bounce|complaint|not_my_company|business_closed|wrong_contact|remove_listing|admin|compliance).
- `listing_claim_events` (see section 8).
- `company_contact_locks` (section 7).

Mail stream and sender:
- Add `'claimed_listing'` to the `mail_stream` CHECK on `ses_feedback_events`; config
  `email.configuration_sets.claimed_listing = "advantage-bid-claimed-listing"`; `emailService.configurationSetForStream`
  maps it. Owner/infra creates the SES configuration set with event destination (same as EP).
- From: `Advantage.Bid Listings <listings@advantage.bid>` (config `claimed_listings.from_address`,
  display name config `claimed_listings.from_name`). Must be a verified identity on the domain; if not, fail closed.
- Reply-To: `l-<reply_key>@reply.advantage.bid` using the existing inbound namespace. Route to a new
  `claimedListings/inboundService.js`; do NOT route into `event_partner_messages`.
- Headers: `List-Unsubscribe: <https://bid.advantage.bid/api/public/listing-outreach/unsubscribe?t=...>`,
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). Reuse the signing approach in
  `routes/publicMarketingEmail.js`. Unsubscribe writes `listing_outreach_suppressions` (not consumer marketing).
- Footer must include the physical postal address from config `company.postal_address`. If empty, fail closed.

Send gate (`claimedListings/sendGate.js`), checked at SEND time, all must pass:
1. Program switch `claimed_listings.sending_enabled = true` (default false).
2. Member of an APPROVED, unexpired cohort bound to approved template versions.
3. Eligibility re-screen now returns `ELIGIBLE_UNCLAIMED_LISTING` (or the member is mid-sequence and still
   has no stop condition).
4. Journey = `CLAIMED_LISTING` for this company.
5. Contact lock is free or held by `system` for this sequence.
6. Caps: cohort `max_sends`, `daily_cap`, global `claimed_listings.daily_cap` (default 10), one message per
   recipient root domain per 24h, minimum 90s spacing between sends.
7. Send window: Tue to Thu, 09:30 to 11:30 recipient local time (from org state; default America/Chicago).
8. Health: rolling 7-day stream bounce rate < 3% and complaint rate < 0.1% (min 50 delivered for the
   rate to apply; below 50, any complaint pauses). Breach auto-pauses the programme and alerts the Owner.
9. Config present: SES configuration set, From identity, postal address, unsubscribe secret.
Any failure: do not send, record reason on the member row.

Sequence scheduler (worker, every 10 min): step 1 at approval; step 2 at +6 days (variant `E2_NOCLICK`
or `E2_CLICKED` when a human page_view exists without claim); step 3 at +14 days. New token per step;
issuing a new token invalidates the previous one (already the behaviour of `issueClaimToken`). After step 3
the sequence state becomes `dormant`. One re-contact cycle is allowed after 180 days (cycle_no 2, single
email `E4_REFRESH`), then permanent stop unless the company contacts us.

Stop conditions (immediate, before any queued send): claim verified; any inbound reply that is not an
auto-reply; unsubscribe; hard bounce; complaint; any of the four landing-page actions; journey change;
company becomes EP or pro seller; staff pause.

---

## 6. Activation track  [BUILD, partly CURRENT]

CURRENT: `organizationLifecycleService.claim`, `businessListingEmails.buildWelcomeEmail`,
`/org/profile.html` editor, `businessListingReviewService` (submit, approve and publish), org events (free: up to 3 active).

Build:
- `listing_activation_progress (organization_id PK, details_confirmed_at, logo_added_at,
  description_owner_written_at, service_area_set_at, first_event_published_at, activated_at, engaged_at)`
  maintained by hooks on profile save and event publish.
- Activation definition: `activated_at` set when details confirmed + logo + owner-written description
  (>= 300 chars, differs from the imported text) + service area/specialties, AND first published event or
  auction within 45 days of claim. `engaged_at`: 2+ published events in 90 days, or 10+ followers, or 4+
  distinct login days in 30.
- Checklist UI at `/org/profile.html?claimed=1` shows the 5 steps with progress.
- Fast lane: a token-verified claim may publish profile edits without admin review EXCEPT company name,
  website root domain, or contact email changes, which queue for review. Keep admin moderation authority.
- Activation emails A1 to A4 (copy in the blueprint) on the `transactional` stream (account-holder
  relationship messages about a listing they now manage) with a preferences link; stop when activated.
- On claim: `organizations.crm_stage = 'claimed'`; on activation `'activated'`.

---

## 7. Marketing Toolbox: "Claimed Listings" queue  [BUILD]

Add a tab to `/admin/sales.html` (Sales & Marketing Toolbox), backed by `/api/admin/claimed-listings`.
Permissions (add to `src/lib/rbac.js`): `listings.view`, `listings.work` (lock, log, manual email, tasks),
`listings.approve_cohort` (Super Admin only), `listings.manage_journey` (Super Admin only). The `marketing`
staff role gets `listings.view` and `listings.work`. No package economics or financial fields are exposed.

Row fields: company, city/state, website, phone, email (masked until row opened), listing status
(unclaimed/claimed/activated/hidden), journey, eligibility decision + reason, tier/score, outreach status
(step, last send, next send), last contact (any programme, any channel), next action + due, engagement
(human page views, claim started), claim status + proof method, assigned rep, contact lock holder, Pro
Seller status, notes count.

`company_contact_locks (company_id PK, holder_type 'user'|'system', holder_user_id, reason, acquired_at,
expires_at)`: a rep must hold the lock to log outbound contact or send manual email for that company.
Locks auto-expire after 14 days without activity; Super Admin can reassign. The automated sequence holds
a `system` lock while active; a rep taking the lock pauses the sequence.

Company timeline: one view unioning `organization_activity`, `sales_prospect_notes`,
`sales_outreach_emails`, `listing_outreach_messages`, Event Partner messages (read-only summary line, no
bodies), claim attempts.

Task types generated: `reply_received`, `claim_help_request`, `remove_listing`, `wrong_contact_research`,
`tier_a_call` (Tier A with no website, 2 days after E1 delivered and no click), `activation_stalled`
(day 21), `pro_interest` (section 8 signals), `dispute`. SLA 1 business day for replies and help requests.

Also fix `salesOutreachService.send`: before sending, check global + listing + EP suppressions and the
company contact lock; add `List-Unsubscribe`; refuse when the company journey is `CLAIMED_LISTING` and a
sequence is active.

---

## 8. Measurement and attribution  [BUILD on CURRENT]

`listing_claim_events (id, organization_id, company_id, sequence_id, message_id, token_id, user_id,
visitor_id, event_key, is_internal boolean, is_automated boolean, occurred_at, meta jsonb)`.

Event keys and definitions:
- `sent`: SES accepted. `delivered`: SES Delivery on stream claimed_listing. `bounced`, `complained`: SES.
- `opened`: NOT measured. No tracking pixel in these emails (deliverability, privacy, Apple Mail Privacy Protection).
- `link_fetch`: server GET of `/claim/:token` (automated or unknown).
- `page_view` (= "clicked"): human beacon on the landing page.
- `claim_started`: POST "This is my company, continue".
- `claim_verified`: lifecycle claim granted (proof method in meta).
- `profile_completed`, `first_event_published`, `activated`, `engaged`.
- `pro_interest`: any of: viewed become-professional-seller page twice in 14 days from a logged-in
  claimed account, clicked demo booking, reply classified by a rep as interest, rep-logged interest.
- `pro_application`: seller_profile created with a professional seller_type by the claiming user or a
  member of the org.
- `pro_conversion`: that professional seller's first published auction or storefront listing.

Attribution:
- Every claim link carries `utm_source=advantage_bid&utm_medium=email&utm_campaign=claimed_listing_<cohort>&utm_content=<template_key>_v<version>`.
  `attributionService.recordTouch` captures it; `stitch` on account creation.
- Hard link (does not depend on cookies): token -> message -> sequence -> company. On claim write
  `organizations.acquisition = {journey, cohort_id, sequence_id, message_id, template_key, token_id,
  proof_method, claimed_at}` (new jsonb column, server-controlled).
- On professional seller creation by an org member, copy `organizations.acquisition` to
  `seller_profiles.acquisition` so the conversion inherits the journey.
- Register new keys in `src/lib/conversionDefinitions.js` with provider mapping `not_mapped`
  (first-party only; nothing goes to ad platforms).
- `is_internal` = staff_role set, role admin, demo flag, test domains, seeded users (reuse the exclusion
  already in `conversionService`). Dashboards exclude internal and automated rows by default.

Dashboard: `/admin/claimed-listings-funnel` (read-only), cohort-based by send week. Metrics and formulas
are in the blueprint section 21.

---

## 9. Fixes required before any send  [BUILD / DATA]

1. **BD claim button** (4.4).
2. **Journey lock** (1).
3. **Paid badges on imported, never-joined listings.** BD shows plan badges for imported records on
   Gold Retailers (7 records: user_id 21, 33, 34, 35, 36, 37, 39), Silver Retailers (24) and Appraiser
   Listing (22 and 318 to 349). Their pages show "Membership Plan - Gold Retailers" badges and no claim
   button. Owner decision O3 approves moving them to the Claim Listing plan (id 7). This is a BD data
   change: prepare the list and the change script; do not run without Owner approval.
4. **Imported "About" descriptions** state business terms we have not verified (example: Bayside
   Auction LLC page says "no upfront fees" and "fair commission rates"). For every Tier A/B pilot org,
   replace with a short factual template (name, type, city, service area if known, "This listing was
   created from public business information. The business can claim it to add details."). Owner decision O4.
5. **LocalBusiness JSON-LD image** uses a relative URL (`/logos/profile/limage-19.webp`); make absolute.
6. **Em dashes in rendered copy:** `salesOutreachService` From display suffix `' — Advantage.Bid'`
   (use `' | Advantage.Bid'` or `' at Advantage.Bid'`), `businessListingEmails` subjects and body
   (`— welcome`, `claimed on Advantage.Bid — it's yours`). Replace with commas or colons.
7. **Postal address** config `company.postal_address` (Owner decision O1).

---

## 10. Config seeds (all OFF)

```
claimed_listings.sending_enabled = false
claimed_listings.daily_cap = 10
claimed_listings.first_cohort_max = 50
claimed_listings.recent_outreach_days = 90
claimed_listings.token_ttl_days = 14
claimed_listings.from_address = "listings@advantage.bid"
claimed_listings.from_name = "Advantage.Bid Listings"
claimed_listings.send_window = {"days":[2,3,4],"start":"09:30","end":"11:30"}
claimed_listings.health = {"bounce_max":0.03,"complaint_max":0.001,"min_sample":50}
claimed_listings.excluded_company_ids = [ BD user_id 29 FORTUNA, 30 Bonhams, 31 Sotheby's New York,
  32 Swann Auction Galleries, 38 PHILLIPS, 43 Bidsquare, 36 Proxibid (data quality) -> resolve to org ids ]
email.configuration_sets.claimed_listing = "advantage-bid-claimed-listing"
company.postal_address = ""   (send gate fails closed while empty)
```

---

## 11. Build order and gates

| Gate | Contents | Exit criteria |
|---|---|---|
| L-A | Sections 1, 2, 3 + backfill dry-run | Dry-run report delivered to Desktop; no writes to EP data; tests green |
| L-B | Section 4 (claim landing, self-request, redemption) + 9.5, 9.6 | Playwright claim flow green; scanner GET does not consume token |
| L-C | Sections 5, 7, 8 in SHADOW (render + gate evaluation, no SES call) | Shadow report: cohort of 50 rendered, gate results per member, zero sends |
| L-D | Seed test to staff mailboxes (Gmail, Outlook, Yahoo) through the real stream | SPF/DKIM/DMARC aligned, one-click unsubscribe works, links resolve, footer present |
| L0 | Owner approves the pilot cohort and templates; flips `sending_enabled` | Owner action only |

`npm run gate` must stay green at every gate. Marketplace Integrity: company pages added to any public
list surface must go through `marketplaceVisibility` (no second retrieval path).

---

## 12. Items already supported (no build)

Secure claim tokens and attempt log (migration 153, `organizationClaimSecurityService`); lifecycle
machine; Free Business Listing review workflow; org events; profile editor; welcome email (copy fix only);
Partner CRM tables (`organization_activity`, `organization_reps`, `crm_stage`); Sales & Marketing Toolbox,
rep identities and 1:1 send; Google Places research with cost logging; RBAC `marketing` role; SES
feedback ingestion with mail streams; global suppression table; RFC 8058 unsubscribe pattern;
first-party attribution + conversion ledger with staff exclusion; Event Partner inbound namespace
`reply.advantage.bid`; sitemap generator; robots policy allowing AI crawlers on public content.

# Advantage.Bid — Buyer Lifecycle → Sales Near You, and Marketing Agency Go-Live Readiness

Internal project documentation. Audit date: 2026-09-22. Production database `neondb`
(`ep-proud-leaf-an8pzkib`), production host `https://bid.advantage.bid`.

No advertising was started. No money was spent. No email was sent. No provider gate was changed.

---

## Part A — Buyer registration establishes Sales Near You

### The gap this closes

Production held **95 users, 45 auction registrations and 392 bids against 1 marketing contact**.
Buyer registration, auction registration, bidding and purchase did nothing with the subscriber
system. Every buyer relationship was being discarded at the moment it was created.

### What was built

| Piece | File |
|---|---|
| Disclosure flag + buyer terms v3 + evidence table | `db/migrations/158_buyer_lifecycle_sales_near_you.sql` |
| Enrolment service (consent gate, geography reuse, one identity) | `src/services/buyerLifecycleEnrollmentService.js` |
| Wiring at terms acceptance | `src/services/termsService.js` |
| Wiring at auction registration | `src/services/auctionRegistrationService.js` |
| Guarded production applier + 21 verification checks | `scripts/prod-migrate-158.js` |
| Tests (33, all passing) | `tests/buyerLifecycleSalesNearYou.test.js` |

### The registration term, as the Owner specified it

> **11. Sales Near You.** Registration includes email notifications about qualifying upcoming
> auctions and estate sales near you, generally within 30 miles of your location.

Buyer terms v3 is v1 **verbatim** plus this one numbered clause, in the same voice. It is not a
warning, there is no separate marketing checkbox, and — per explicit Owner instruction — there is
**no unsubscribe sentence in the registration term**. Unsubscribe and suppression machinery lives in
the emails, which is where the legal requirement actually applies. `prod-migrate-158.js` asserts the
absence of that language rather than trusting it.

### How consent stays honest

`terms_versions.includes_sales_near_you` defaults to **false**, so every historical version is
non-disclosing. Enrolment asks *"did this person accept a version that actually told them about
this?"* — and refuses when the answer is no.

- No historical acceptance is fabricated. `no_acceptance_fabricated` is a hard check.
- No historical evidence is rewritten. Older versions stay marked non-disclosing.
- Existing buyers meet the new term **naturally**, at their next auction registration, because the
  existing `hasAcceptedCurrentTerms` gate already forces re-acceptance there. No re-consent
  campaign, no mass email.
- The migration itself enrols nobody: `enrollment_table_empty` and `no_contacts_created` are checks.

### One identity, one list

Enrolment routes through `subscriberService.signup`, which matches an existing platform user by
normalized email and upserts. The same person creating an account, registering for five auctions,
bidding, buying, and separately using the public Sales Near You form resolves to **one**
`marketing_contacts` row, with each event preserved as distinct provenance. There is no separate
"registered bidders" list.

`buyer_sales_near_you_enrollments` records the registration-specific fact the permission tables
cannot express: which event enrolled this person, under which disclosed terms version, accepted
when, with geography from where and at what precision. Unique on
`(contact_id, trigger, terms_version_id)`, so repeated activity cannot inflate the evidence trail.

### Geography without asking twice

`knownGeography()` reads `users.tax_city` / `users.tax_state` — city and state only, never the
street line. That is the same precision the public signup form collects and enough for a 30-mile
audience. A caller-supplied city/state wins; nothing is ever invented. A contact without geography
is simply not radius-eligible yet (audience matching fails closed) and can be improved later.

### Separation that must hold

- Marketing suppression is respected: `subscriberService` refuses to resurrect a complaint or hard
  bounce, and enrolment returns `status: 'received'` rather than forcing a subscribe.
- Transactional email is untouched. Nothing in this path can disable it, and transactional
  necessity cannot bypass marketing suppression.
- Enrolment is fire-and-forget and swallows its own errors. A marketing side effect must never be
  able to fail somebody's registration.
- Sending remains **OFF** (`marketing.email.sales_near_you_enabled = false`). This ships collection
  only.

### Deployment state

Committed as `2eed166` on `main`. **Not yet in production.** The code has a hard dependency on the
migration (`termsService.getCurrentTerms` selects `includes_sales_near_you`), so the order is not
optional:

```
node -r dotenv/config scripts/prod-migrate-158.js     # must print RESULT: PASS
git push origin main                                  # then Railway deploys
```

---

## Part B — Marketing Agency go-live readiness

### The decisive finding

**There is no paid execution layer.** The only non-GET calls to any advertising platform in the
entire codebase are:

- `src/services/measurement/metaCapiService.js` — conversions API (measurement)
- `src/services/metaGraphProvider.js` — **organic** publishing (page feed, Instagram media)

No code creates a campaign, an ad set or an ad. No code sets a provider budget. No code pauses a
provider campaign. Confirmed by searching for every write path to `graph.facebook.com` and
`googleads.googleapis.com`. Independently, the Meta token probe reports
**`ads_management_granted: false`** — the credential is read-only.

The Director is genuinely good, and it is genuinely only a Director. It proposes; nothing executes.
`marketing_paid_director_actions` is written with `executed: false` hard-coded in both persistence
paths — shadow mode is structural, not merely configured.

### The second finding: the runtime is headless

No front-end surface anywhere in `public/` references `paid-growth`, `creative-reviews` or
`measurement-readiness`. The admin API is rich — proposals, report, readiness, creative reviews,
needs-owner, cost import — and **nothing consumes it**. `public/admin/` has
`marketing-campaigns.html` and `marketing-packages.html`; neither touches these endpoints.

This explains the creative blocker below. There are **36 calibrations `HELD_FOR_OWNER_REVIEW` and 0
`OWNER_APPROVED`** — not because the Owner declined, but because there is no screen on which to
approve them.

### Measurement — genuinely strong

Evaluated in production: **14 VERIFIED, 4 PARTIAL. `minimum_for_any_paid_activation` is READY.**

VERIFIED: `meta_pixel`, `meta_click_id`, `google_click_ids`, `first_party_attribution`,
`utm_capture`, `behavioral_events`, `identity_stitching`, `anon_to_known`, `consent`,
`conversion_definitions`, `cost_ingestion`, `provider_reconciliation`,
`marketplace_outcome_attribution`, `director_facts`.

PARTIAL: `meta_capi` (server credential — **present in production**; the PARTIAL reading came from
a local evaluation and is an artifact, corrected), `google_ads_conversion` (Owner must connect the
account), `suppression` and `retargeting_audiences` (no provider audience upload exists; this is
intentional and Owner-gated).

Meta asset identity is verified and correctly scoped:

- Dataset `2041842543203121`, owner business **Advantage Auction Company** (`580647025419384`)
- Ad account `act_1722514625516256` — "Advantage.Bid Marketing", Owner-confirmed as the dedicated
  Advantage.Bid account
- `act_664514018846795` (Lewis & Maese) is in `meta_ad_account_excluded`, with
  `dataset_still_attached: false` and `excluded_accounts_still_connected: []`

Lewis & Maese assets are excluded by configuration and proven disconnected. No credential is
printed anywhere in this audit.

### Google Ads — not started

`google_ads_customer_id = null`, `google_conversions_enabled = false`,
`google_conversion_actions = {}`, and neither `GOOGLE_ADS_DEVELOPER_TOKEN` nor
`GOOGLE_ADS_REFRESH_TOKEN` is present in the production environment. Google is a clean, honest
"not connected yet", not a half-built integration.

### Budget controls

| Control | State |
|---|---|
| Monthly ceiling | `marketing.paid_growth.monthly_ceiling_usd = 1000`, read by `runShadow()` |
| Ceiling enforced at proposal | Yes — `validateProposal` and `enforceCaps`; over-ceiling totals are trimmed |
| Per-window cap | 40% of ceiling ($400), only a WINNER may exceed it |
| Experiment reserve | 10% of an active month — **was never produced; fixed this mission** |
| Ceiling is a maximum, not a target | Correct: with measurement unready every budget is $0, and buyer budgets are $0 without live inventory |
| Committed vs actual ledger | **Absent.** Caps run against *planned* numbers; `marketing_paid_cost_facts` is a reader with 0 rows |
| Race-condition overspend | Not possible today — nothing can spend |
| Pause / emergency kill | **Absent.** `marketing.emergency_stop`, `marketing.kill_switch` and `marketing.paused` do not exist. The only stop is turning a channel gate off |
| Owner visibility | API only; no screen |

**Defect found and fixed:** `propose()` never emitted an experiment line, so every portfolio the
Director generated failed its own `enforceCaps` experiment-reserve check. The reserve is now carved
**out of** the planned campaigns proportionally — satisfying a cap must never be able to grow a
month's spend. Five regression tests added.

### Creative runtime

The execution path does use the Owner calibration, not merely the files: `marketing_creative_jobs`
holds 7 jobs and `marketing_creative_calibrations` holds 44 rows tied to them (36
`HELD_FOR_OWNER_REVIEW`, 8 `NOT_FOR_PUBLICATION`). Publication is gated on `OWNER_APPROVED`, and
nothing has reached it.

The Python engine is real and provisioned: `nixpacks.toml` installs `python311`,
`python311Packages.pillow` and `python311Packages.numpy`, and `engineBridge` spawns
`creative-engine/calibrate.py` with a fixed script path, JSON on stdin, an explicit timeout and a
graceful `engine_unavailable` degrade. `PYTHON_BIN` is set by nixpacks (`python3.11`); the bridge
also falls back to `python3`, which exists in the image.

**One unresolved working-tree condition:** the Owner creative library contains an uncommitted,
half-finished category rename — 8 images and their sidecars deleted from
`approved-creative-examples/auction/` and present, untracked, in `approved-creative-examples/auction-event/`,
plus an untracked `index.phase3p2-preview.json`. This breaks `tests/phase3p-creative-reference.test.js`
(the suite passes cleanly when those two items are set aside) and means production does not have the
renamed category. This was left exactly as found rather than completed or reverted, because
finishing it requires regenerating the library index — an Owner-calibration decision.

### Meta organic

`metaGraphProvider` publishes to the page feed and to Instagram (`/media` → `/media_publish`).
Both destinations exist with provider account ids, both are `active = false`, and
`marketing.a9_publish_enabled = false`. Two social jobs have status `published`, so the path is
proven end-to-end and is currently switched off by Owner gate.

### Funnels and inventory

Marketplace Integrity: **PASS** (all 16 surface checks match canonical).

Canonical live inventory at audit time: **Advantage.Bid Auctions 0 · Auction Partner Events 16 ·
Estate Sales 0 · Marketplace items 0**. Professionals directory: 330.

Buyer acquisition would currently send paid traffic to a marketplace with no native auctions. The
Director already handles this correctly — `hasInventory` zeroes any buyer-acquisition budget in a
market with no live events — but it is a business precondition, not a software one.

Seller acquisition is the stronger funnel and the Director's default emphasis: both strategic
markets propose an individual-seller campaign, and assisted-service availability is used as
strategic intelligence only, with pricing never stated (enforced by
`assistedServiceService.pricingViolations` inside `validateProposal`).

Conversion coverage: 16 keys defined, 10 emitted server-side. Emitted in production so far:
`buyer_registered` (2), `seller_registered` (2), `email_signup` (1). `page_view`, `search` and
`lot_view` are carried by `analytics_events` rather than the conversion ledger, which is by design.

### Learning loop

`evaluateCampaigns()` is complete and correct: continuous checkpoints (never calendar-only),
two-proportion and Bayesian tests against a pooled baseline, anti-overreaction floors (no LOSER
before 100 sessions or $150 unless a safety flag; no WINNER without a meaningful signal held across
two consecutive checkpoints; CTR alone never decides), state transitions persisted, bounded actions
recorded. It has never run on real data because no campaign has ever existed:
`marketing_paid_campaign_states` 0, `marketing_paid_cost_facts` 0, `marketing_paid_director_actions` 0,
`marketing_experiments` 0, `marketing_learnings` 0.

The loop is built. It is unproven.

### The first campaign portfolio — prepared, not launched

Computed from production readiness at a $1,000 ceiling, October 2026:

| Budget | Channel | Campaign | Success signal |
|---:|---|---|---|
| $135.00 | meta_ads | Houston Metro — individual seller acquisition | `seller_registered` |
| $135.00 | meta_ads | NYC Tri-State — individual seller acquisition | `seller_registered` |
| $30.00 | meta_ads | creative and audience experiment reserve | `seller_registered` |
| $0.00 | meta_ads | Houston Metro — buyer growth | `buyer_registered` (no live inventory) |
| $0.00 | meta_ads | NYC Tri-State — buyer growth | `buyer_registered` (no live inventory) |

**Total $300.00 of the $1,000 ceiling** — 30%. `enforceCaps` passes with no issues. Every proposal
carries the full ten-field shape, names its first-party success signal and its measurement
dependencies, and validates clean.

`canActivate()` refuses, with three independent reasons: the Director is in shadow mode, `meta_ads`
is OFF, and the Meta measurement minimum is not fully verified. Three independent locks, all
holding.

### Classification

**READY**
- Measurement foundation (minimum set for paid activation VERIFIED)
- Meta asset identity and Lewis & Maese exclusion
- Meta CAPI credential present in production
- Conversion definitions and first-party ledger
- Attribution, identity stitching, anonymous-to-known policy
- Cost ingestion reader and provider reconciliation
- Director decision engine, signal states, anti-overreaction rules
- Proposal generation, ceiling and window caps, experiment reserve (as of this mission)
- Creative engine runtime and Python provisioning
- Meta organic publishing path (proven, gated off)
- Marketplace integrity and public surfaces
- Buyer lifecycle → Sales Near You collection (built and tested; awaiting deploy)

**BLOCKED — needs engineering**
1. **No paid execution layer.** Nothing can create, budget, or pause a campaign at any provider.
2. **No emergency kill switch.** No config key stops outbound marketing across paths; the only stop
   is a per-channel gate.
3. **No committed-vs-actual spend ledger.** Caps govern plans, not live provider spend.
4. **No Owner console.** The entire runtime is headless; proposals, readiness, spend and creative
   approval have no screen.
5. **Uncommitted creative-library category rename** breaking one test suite and absent from
   production.

**NEEDS OWNER**
1. Grant `ads_management` scope to the Advantage.Bid Meta system user (currently read-only).
2. Connect the Advantage.Bid Google Ads account: customer id, developer and refresh tokens,
   conversion action mapping.
3. Approve creative. 36 candidates are held; none is approved.
4. Accept Meta Custom Audience terms if retargeting is wanted
   (`custom_audience_tos_accepted: false`).
5. Turn on the channel gates and move the Director from `shadow` to `live` — only after 1–4.
6. Decide the creative-library category rename.

Nothing in this list is a manufactured approval. Items 1, 2 and 4 are credentials and provider
terms only the Owner can grant; item 3 is the Owner's own creative judgement, which the whole
calibration system exists to capture; item 5 is the activation decision itself.

### Honest summary

The measurement, decision and safety layers are real, careful and production-verified. The agency
can think. It cannot yet act, and the Owner cannot yet watch it. The gap between shadow and live is
not tuning — it is a missing execution layer, a missing kill switch, a missing spend ledger and a
missing console.

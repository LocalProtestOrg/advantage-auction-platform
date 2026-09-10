# 6 — Paid Growth Strategy + Measurement Readiness

**Phase 3P.2 addendum · 2026-09-11 · Configs: `paid-growth-policy.json`, `measurement-readiness-audit.json` · Nothing here activates a channel or spends; readiness stays Owner-controlled and OFF.**

## Authority

The Marketing Director holds meaningful autonomy over the existing **$1,000/month Growth Budget ceiling**. It is a ceiling, not a target:
the Director may recommend less, including nothing, when evidence does not justify spend. The Owner does not set allocations. Subscriber
health, attribution quality, platform safety and campaign economics outrank budget utilisation, in that order, with utilisation last.

Every recommendation takes one shape: MARKET → AUDIENCE → CAMPAIGN → OBJECTIVE → CHANNEL → BUDGET → MEASUREMENT WINDOW → SUCCESS SIGNAL
→ STOP CONDITION → SCALE CONDITION. The success signal is always a first-party outcome (registration, seller inquiry, auction draft,
auction published, lot watch, bid, purchase) with the platform proxy it will be judged against until the first-party signal matures. A
proposal whose measurement is MISSING or PARTIAL in the readiness audit cannot be activated (a bounded ≤ $100 experiment may proceed on a
PARTIAL item if the Director records exactly what it cannot measure).

Objectives the Director may propose across: seller acquisition, buyer acquisition, event promotion, retargeting, geographic growth,
creative/audience experiments, other justified opportunities. Per-window caps: ≤ 40% of the ceiling per campaign unless a WINNER state
justifies more; ≥ 10% of an active month reserved for experiments unless total spend is under $200.

## Strategic markets and the assisted-service capability

Houston Metro and NYC Tri-State / NYC Metro are the initial strategic growth markets — priorities, not permanent restrictions. In both,
Advantage.Bid has people who can provide a hands-on, full-service auction option: auction creation, catalog/auction setup, sale
management, pickup coordination. That creates two seller paths — **self-service** (the seller runs the auction on the software) and
**assisted/full-service** (Advantage.Bid's local people conduct substantially more of the sale).

Pricing for the assisted path is **not finalized**. The Director treats it as custom, determined after sale evaluation. No creative,
landing page, form, ad or report may state a commission percentage or a fixed price; the config lists the permitted availability phrasing
("Hands-on help available in Houston and the NYC area") and the forbidden forms.

How the capability changes seller acquisition in those two markets:

- **Two offers, one ad.** Individual-seller creative in Houston/NYC may carry one factual availability line beside the self-service
  message ("Prefer us to run the sale? Ask about assisted service."), and the destination form captures which path the seller wants.
  Everywhere else the ad stays self-service only.
- **A new success signal.** `assisted_service_inquiry` becomes a first-party conversion event with its own target cost; it is
  higher-intent and higher-value than a self-service draft, so the Director may justify a higher cost per outcome in those markets —
  but only after the outcome is measured, not on the assumption.
- **Audience shape.** Estate executors, downsizers and professional consignors in Houston/NYC are the natural assisted-path audience;
  self-service creative targets the broader "have items to sell" audience. The Director proposes both as separate campaigns with separate
  measurement so the paths never blur.
- **Geographic event promotion doubles as seller acquisition.** A promoted Houston estate sale creates local awareness that the
  assisted path exists; the Director may attach a small seller-facing follow-up in the same geography and measure inquiries.
- **Capacity is a stop condition.** The assisted path depends on people. The Director records local capacity as a stop condition on
  assisted-path campaigns so ads never generate inquiries the team cannot serve.

## Measurement before spend — the chain

AD IMPRESSION → CLICK → ADVANTAGE.BID SESSION → BEHAVIOR → REGISTRATION → BUYER/SELLER INTENT → MARKETPLACE ACTION → TRANSACTION / SELLER
OUTCOME → ATTRIBUTION → DIRECTOR LEARNING → STOP / MODIFY / SCALE.

First-party Advantage.Bid truth is the authority for outcomes; Meta and Google are acquisition and measurement destinations. To know
quickly what generates qualified traffic, which creative, audience, geography and channel perform, what visitors do after the click,
who returns, who registers, who becomes a buyer or a seller, who drafts and who publishes, who watches, bids and purchases, which
campaigns produce marketplace activity, who should be retargeted, who should be suppressed, and what a campaign cost relative to
downstream value — the Director needs every link of that chain instrumented and joined.

## The infrastructure audit VS Code must perform

`measurement-readiness-audit.json` lists eighteen items — Meta Pixel, Meta Conversions API with deduplication, fbclid capture, Google
Ads conversion measurement, gclid/gbraid/wbraid capture, first-party campaign/session attribution, UTM capture, behavioral event
instrumentation (including `auction_draft_created`, `auction_published`, `seller_inquiry`, `assisted_service_inquiry`, `watch_lot`,
`bid`, `purchase`, `email_signup`), identity stitching at registration, anonymous-to-known attribution policy, consent handling,
suppression, retargeting audience generation, shared conversion-event definitions, campaign cost ingestion, provider reconciliation,
marketplace outcome attribution (DELIVERED / MEASURED / INFLUENCED / ATTRIBUTION_UNAVAILABLE), and Director-accessible performance facts
with the Owner report. VS Code inspects production and reports **VERIFIED / PARTIAL / MISSING** for each with evidence. Nothing is
assumed present because behavioural intelligence exists. The minimum sets for any paid activation, for retargeting, for Meta and for
Google are stated in the config.

## Rapid learning without false certainty

Six states, each with a definition and a bounded action: NO_DATA (spend < $10 or < 500 impressions: wait), INSUFFICIENT_DATA (< 30
clicks/sessions and < 3 conversions: continue), EARLY_SIGNAL (≥ 30 sessions and a wide divergence from the pooled baseline but not
significant: note, shift ≤ 20%), MEANINGFUL_SIGNAL (≥ 100 sessions or ≥ 10 first-party conversions with p < 0.10 or Bayesian ≥ 80%:
shift ≤ 50%, test alternatives), WINNER (meaningful across two checkpoints at or under the target cost per outcome with no health or
safety flag: scale within caps), LOSER (≥ 100 sessions or ≥ $150 with cost > 2× target and no early signal of improvement, or any
safety/policy flag: pause, reallocate, record). Checkpoints fire on spend, impressions, clicks, conversions and 72 hours after any
state change — never on a calendar alone. CTR alone never decides; platform-reported conversions are provisional until reconciled to
first-party outcomes; no LOSER before 100 sessions or $150 unless a safety flag; no WINNER without two checkpoints.

Bounded actions: pause losers, shift budget, test alternatives, scale winners, stop — all within the ceiling and window caps; anything
outside the caps is a proposal to the Owner.

## Owner visibility

A concise weekly digest (and one on any state change; a monthly summary): MONTHLY AUTHORITY · RECOMMENDED SPEND · ACTUAL SPEND ·
REMAINING AUTHORITY; allocation by objective, geography, audience, channel and campaign; and for each material campaign — why we are
running it, what we have learned, what it cost, what happened after the click (sessions → engaged → registrations → intent →
marketplace actions → outcomes), and what the Director is doing next with the reason for increasing, decreasing, stopping, continuing or
reallocating. Numbers carry their signal state. Confidential Marketing Package economics, the internal policy split, seller-package
margins, channel media costs attributed to package fulfilment and Growth Pool mechanics are never shown.

## Readiness statement

No paid campaign is fully ready because Meta or Google can accept an advertisement. Readiness means the Director can measure the
campaign's downstream Advantage.Bid outcome and learn from it. Until the audit returns VERIFIED on the minimum set, the Director's
recommendations are proposals with "measurement not ready" stated on them, and the spend recommended is zero.

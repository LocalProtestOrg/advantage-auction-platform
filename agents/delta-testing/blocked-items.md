# Delta-Testing — Blocked Items

## Active Blockers

None at this time. Delta-Testing is in an IDLE monitoring posture.

---

## Standing Coverage Gaps (Not Yet Active Blockers)

These features have no E2E spec coverage. They become active blockers only when
a work cycle is in progress and the gap directly prevents checkpointing.

### Walkthrough Video Moderation
**Status:** Gap (no spec)
**Feature:** `POST /api/admin/walkthroughs/:id/moderate`, `GET /api/admin/walkthroughs`
**Owner of feature:** Alpha-Core (added in checkpoint-admin-moderation-v1)
**What's needed:** Playwright spec validating admin approve/reject + visibility rules
**Impact if unresolved:** Moderation flow is unvalidated by automated tests
**Workaround:** `_validate_pipeline.js` has a manual validation section for this endpoint

### Buyer Watchlist / Favorites
**Status:** Gap (no spec)
**Feature:** Buyer can save favorite lots and view them on a dedicated page
**Owner of feature:** Alpha-Core
**What's needed:** Playwright spec: add to watchlist, view favorites page, remove
**Impact if unresolved:** Business-rule-critical buyer feature has no regression guard

### Soft Close + Bid Extension
**Status:** Gap (no spec)
**Feature:** Bids at ≤2 min remaining extend lot by 2 min; lots stagger close 1 min apart
**Owner of feature:** Alpha-Core
**What's needed:** Playwright spec with time-manipulation or direct API validation
**Impact if unresolved:** Most critical auction business rule has no automated validation

### Invoice Generation + PDF Download
**Status:** Gap (no spec)
**Feature:** Invoice generated after auction close; buyer can download PDF
**Owner of feature:** Alpha-Core
**What's needed:** Playwright spec: close auction, verify invoice created, download PDF
**Impact if unresolved:** Payment/invoicing flow unvalidated end-to-end

### Seller Final Submission Lock
**Status:** Partial (seller-dashboard.spec.js touches submit, not full lock)
**Feature:** Seller final submission is single-use; locks all seller editing
**Owner of feature:** Alpha-Core
**What's needed:** Spec that verifies POST to submit returns 409 on second attempt
**Impact if unresolved:** Critical business rule (single-use) has no regression test

### BD Widget E2E Coverage
**Status:** Gap (no spec — Charlie-BD has not yet built widgets)
**Feature:** `public/widgets/featured-auctions.js` visual/functional validation
**Owner of feature:** Charlie-BD
**What's needed:** Playwright spec loading the widget demo page and asserting render
**Impact if unresolved:** Widget regression possible on API contract changes
**Note:** Delta will create `e2e/charlie-bd-featured-auctions.spec.js` once Charlie
completes their first work cycle and the widget is stable.

---

## Blocker Template

```
## BLOCKER: [Short title]

- **Opened:** YYYY-MM-DD
- **Blocking:** [What Delta work is waiting on this]
- **Owner:** [Alpha-Core / Bravo-Discovery / Charlie-BD / Infrastructure]
- **Resolution needed:** [What must be true before Delta can proceed]
- **Impact if unresolved:** [What spec or coverage gap persists]
- **Workaround:** [Any interim approach, or NONE]

### Context
[Why Delta cannot write the spec without this resolution]

### Resolution
[Filled in when resolved — what changed and which checkpoint]
```

---

## Resolved Blockers

_None yet. Delta has not started a standalone work cycle._

---

## Notes on Stripe / Payment Specs

Delta must not create real Stripe payment intents in test mode without an explicit
setup step. The following approach is approved when payment spec coverage is needed:

1. Use Stripe test mode keys (environment variable `STRIPE_SECRET_KEY` pointing to test)
2. Use Stripe test card numbers (4242424242424242) — never real cards
3. Scope payment specs to a separate describe block with a `test.skip` guard if
   Stripe test keys are not configured in the environment
4. Document the required environment setup in the spec file header comment

Until this setup is established, payment spec coverage remains a standing gap.

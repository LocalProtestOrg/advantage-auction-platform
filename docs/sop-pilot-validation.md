# SOP: Phase 1 Pilot Validation — Operator-as-Seller Pilot Prep

*Operational pilot-validation infrastructure for the Advantage Auction Platform. The operator acts as the real seller; 5 seeded buyer accounts act as distributed bidders. This document is the authoritative procedure for the controlled Phase 1 pilot auction.*

**Mode:** controlled operational validation. No new infrastructure, no RBAC implementation, no deployment.
**Operator role:** real seller + admin/operator.
**Buyer cohort:** 5 distributed pilot accounts (already seeded, see §1).
**Out of scope:** rebuilding any pilot tooling that already exists.

This SOP complements the synthetic `docs/sop-staging-validation-e.md` runbook. Both are required for Phase 1 production-readiness sign-off — §E catches what real users won't hit; this pilot catches what synthetic tests can't see.

**Prerequisite:** `docs/sop-staging-signoff.md` (governance regression gate) must pass on the current staging branch before pilot kickoff. The governance suite verifies moderation, audit, and suspension behavior end-to-end and is the fastest pre-pilot smoke test.

---

## 1. Buyer pilot accounts — 5 distributed accounts

**The 5 buyer accounts already exist as a seeded fixture.** `scripts/seed-pilot-accounts.js` is idempotent (`ON CONFLICT DO NOTHING`) and safe to re-run against any environment.

### Account roster (from the seed script)

| # | Email | Password | User ID | Notes |
|---|---|---|---|---|
| B1 | `pilot-buyer1@advantage.bid` | `PilotTest2026!` | `aa…0301` | Designate as "low-engagement bidder" (1–2 lots) |
| B2 | `pilot-buyer2@advantage.bid` | `PilotTest2026!` | `aa…0302` | Designate as "active bidder" — multiple lots, mid-auction bids |
| B3 | `pilot-buyer3@advantage.bid` | `PilotTest2026!` | `aa…0303` | Designate as "snipe bidder" — last-2-minute bidding |
| B4 | `pilot-buyer4@advantage.bid` | `PilotTest2026!` | `aa…0304` | Designate as "active bidder" — outbid victim scenarios |
| B5 | `pilot-buyer5@advantage.bid` | `PilotTest2026!` | `aa…0305` | Designate as "refund target" — wins a lot, gets refunded |

### Pre-pilot tasks for the buyer accounts

1. **Run the seeder once** (idempotent, safe to re-run):
   ```bash
   node scripts/seed-pilot-accounts.js
   ```
   Verify: `psql "$STAGING_DATABASE_URL" -c "SELECT email FROM users WHERE email LIKE 'pilot-buyer%' ORDER BY email;"` returns 5 rows.

2. **Set notification preferences per account** (one-time setup so notifications actually deliver during the pilot):
   ```sql
   -- Enable email for all 5 buyers (default is already TRUE, this is verification)
   INSERT INTO notification_preferences (user_id, email_enabled, sms_enabled)
        SELECT id, TRUE, FALSE
          FROM users WHERE email LIKE 'pilot-buyer%'
   ON CONFLICT (user_id) DO UPDATE SET email_enabled = TRUE;
   ```
   Leave `sms_enabled = FALSE` unless you specifically want to test SMS (see §5).

3. **Real email forwarding** (optional but recommended): the `pilot-buyer*@advantage.bid` addresses won't see real inboxes unless you've set up forwarding rules. For pilot, two options:
   - Replace one or two buyer emails with real inboxes you control (e.g., `+pilot1@gmail` alias), so you actually see the notifications.
   - Inspect `notifications_queue` table directly and verify Postmark delivery logs in the Postmark Dashboard instead.
   - **Recommended:** swap B2 and B5 to addresses you can monitor — these are the highest-signal buyers (active bidder + refund target).

4. **Distributed-user realism** (optional): if you have access to multiple devices/networks, having buyers active from different IPs and devices makes the validation closer to real conditions. Use:
   - Desktop browser (B2)
   - Mobile browser (B3)
   - Another desktop/incognito (B4)
   - Mobile (B5)
   - Whichever you have (B1)

   Not required, but having ≥2 distinct devices catches session/cookie issues that a single-device pilot misses.

### What's NOT in this prep
- ❌ No new accounts created
- ❌ No deletion of existing buyer accounts
- ❌ No password rotation (the seeded `PilotTest2026!` is the documented pilot password)

---

## 2. Seller/operator pilot checklist (operator, as the seller)

This is the step-by-step the operator follows to create the validation auction. Reference: existing seller UI flows + admin override capabilities.

### 2.1 Pre-create setup (one-time, before any auction work)

| Step | Action | Verify |
|---|---|---|
| 2.1.a | Log in as the seller account (or create a new one via the seller signup flow — operator's call) | Land on seller dashboard |
| 2.1.b | Confirm seller profile is complete (business info, contact, payout preference set) | Profile page shows no required fields missing |
| 2.1.c | If admin override capability is needed mid-pilot, ensure the account also has `users.role='admin'` OR a separate admin account is logged into a second browser/profile | Admin can hit `/api/admin/diagnostics/*` |
| 2.1.d | Open Postmark Dashboard in a tab — cross-check email delivery against it | Postmark stream shows recent activity |
| 2.1.e | Open the staging server logs in a terminal (T1 of the §E runbook style) | Tail filtered on `[bid]`, `[webhook]`, `[payment]`, `[notification]` |

### 2.2 Auction creation flow

The exact UI path is on the seller dashboard — usually "Create Auction" or similar. Validate each field as you go:

| Field | Recommended pilot value | What you're validating |
|---|---|---|
| Title | `Pilot Validation Auction — <date>` | Title displays correctly on all surfaces |
| Description | A few sentences — multi-paragraph, with one **bold** word and one list | Markdown/formatting handling |
| Auction type (public/private) | Public | Discovery surface displays it |
| Start time | T+25 min from now (rounded) | Future start; ends-soon rail doesn't pick it up prematurely |
| End time | T+60 min from now (gives 35-minute auction window) | Soft close window large enough for all 7 lots + 2 extensions to play out |
| Pickup window start | Non-professional sellers: at least 48 hours after end time; professional sellers exempt (own timing); never before close (seller-type rule, supersedes the old 36h) | The 48-hour non-professional rule is enforced server-side (`sellerTypeRules`); pre-check the form rejects shorter |
| Pickup window end | Pickup_start + 4–8 hours | Operator-realistic window |
| Address | Real or synthetic; whatever is encrypted at rest will only be revealed to buyers after payment confirmed | Per business rule: "Full address stays hidden until payment is verified" |
| Timezone | Operator's actual timezone | Countdown math must respect TZ |
| Default starting bid | `$1` (matches the platform default per CLAUDE.md) | Default applied correctly per lot unless overridden |
| Bid increment ladder | Use platform default (or specify; see §3) | Bid validations honor it |
| Auction terms | A non-trivial text block (1–2 paragraphs) | Display, editability |

After creation: auction is in `draft` state. **Do not publish yet** — add lots first.

### 2.3 Lot creation (×7, per §3 strategy)

For each of the 7 lots (numbered 1–7), in the seller UI's "Add Lot" flow:

| Field | Action | Notes |
|---|---|---|
| Lot number | 1–7 (sequential) | Unique per auction (DB enforces) |
| Title | Distinct per lot ("Pilot Lot 1 — Antique Vase", etc.) | Helps observers track |
| Description | At least one sentence per lot | Display test |
| Size category | A/B/C — mix of all three across the 7 lots | Per CLAUDE.md: size category is required (dimensions optional). Validates pickup-group assignment behaves |
| Dimensions | Skip on lots 1, 3, 5; fill on lots 2, 4, 6, 7 | Validates "dimensions are optional" |
| Images | Upload ≥1 image to every lot; upload ≥3 to lots 2 and 4 to exercise multi-image handling | Validates Cloudinary upload + image processor + thumbnail generation |
| Starting bid | $1 default for lots 1, 3, 5, 7; $25 override for lots 2, 4, 6 | Per CLAUDE.md: "Each lot starts at $1 by default unless admin overrides it" |
| Shipping | See §2.4 below | |
| Reserve | Leave unset on all 7 lots for v1 pilot simplicity | Reserve flow is admin-gated; deferred |
| Featured | Mark lots 1, 2, 3 as "featured" (per CLAUDE.md: seller picks 3 before submission) | Validates the 3-featured rule |

### 2.4 Shipping / pickup configuration (per-lot)

Per CLAUDE.md: pickup is the default; shipping is optional. Mix across the 7 lots:

| Lot | Pickup | Shippable | Shipping cost |
|---|---|---|---|
| 1 | Pickup-only | No | — |
| 2 | Pickup-only | No | — |
| 3 | Pickup-only | No | — |
| 4 | Shippable | Yes | $15 |
| 5 | Shippable | Yes | $25 |
| 6 | Pickup-only | No | — |
| 7 | Pickup-only | No | — |

This gives a 5:2 pickup-to-shipping ratio — enough to exercise both paths without overwhelming.

### 2.5 Staggered close configuration

Per CLAUDE.md: "Auctions must support per-lot soft close with 1-minute staggered closings." The auction `end_time` is the headline end; each lot's `closes_at` is staggered 1 minute apart.

Strategy: with 7 lots and a 35-minute auction window starting at T+25 min:

| Lot | Initial `closes_at` (relative to start) | Why |
|---|---|---|
| 1 | start + 25 min | First to close; "quiet" lot |
| 2 | start + 26 min | First active lot |
| 3 | start + 27 min | Active lot |
| 4 | start + 28 min | Snipe target #1 (shippable, complex flow) |
| 5 | start + 29 min | Snipe target #2 (shippable) |
| 6 | start + 30 min | Refund-target lot |
| 7 | start + 31 min | No-bid lot (unsold) |

If the lot service exposes per-lot `closes_at` in the create-lot form, set it explicitly. If it auto-staggers from the auction's `end_time`, verify the spacing matches above before publish.

### 2.6 Final pre-publish validation

| Check | How |
|---|---|
| All 7 lots created, lot_numbers 1–7 | `SELECT lot_number, title, starting_bid_cents, closes_at FROM lots WHERE auction_id='<id>' ORDER BY lot_number;` |
| Exactly 3 featured lots | `SELECT COUNT(*) FROM lots WHERE auction_id='<id>' AND is_featured = TRUE;` should be 3 |
| Auction is in `draft` state | `SELECT state FROM auctions WHERE id='<id>';` |
| Address is encrypted (BYTEA, not plaintext) | `SELECT octet_length(address_encrypted), address_encrypted FROM auctions WHERE id='<id>';` — should be a non-NULL bytea, not readable text |

### 2.7 Submit + publish

Per CLAUDE.md: "Seller final submission is single-use and locks seller editing" and "Advantage publishes auctions, not sellers."

1. **As the seller**: click "Submit for review" (final submission) — verify the UI now blocks edits.
2. **As the admin** (or the operator, with admin role): publish the auction via `/api/admin/auctions/:id/publish` or the admin UI equivalent.
3. **Verify**:
   - `SELECT state FROM auctions WHERE id='<id>';` → `'published'`
   - `SELECT state FROM lots WHERE auction_id='<id>';` → all `'open'`
   - Public discovery surface shows the auction
   - Countdown displays correctly on the auction detail page

### 2.8 Visibility verification (browser, multiple devices if available)

| Surface | Expected |
|---|---|
| `/marketplace` or homepage discovery | Auction appears in featured/recent rail |
| `/auctions/<id>` direct URL | Loads with all 7 lots, correct countdowns, correct images |
| `/lots/<id>` direct URL | Each lot loads with correct starting bid, increment ladder visible |
| Buyer paddle assignment | Each of the 5 buyers can register; receives unique paddle number for the auction |
| Address visibility before payment | Buyer view shows masked / partial address, NOT full street |

### 2.9 Countdown behavior verification

- Watch a lot's countdown for 60 seconds — it should decrement smoothly (1Hz tick at minimum).
- Cross-check: server `closes_at` minus client `now()` matches displayed countdown.
- If timezones drift more than 5 seconds between server and any client, stop and investigate before bidding starts.

---

## 3. Lot count + close-time strategy

### Goal-driven design

Optimized for:
- **Anti-snipe validation**: at least 2 lots must reach the final 2 minutes with active bidding
- **Concurrent bidding observation**: overlapping close times so multiple lots are in their "hot" phase simultaneously
- **Manageable monitoring**: one operator can watch 7 lots in real time; more than that risks blind spots
- **Payment/reconciliation review**: enough paid lots to exercise webhook, invoice, pickup, audit; one designated refund

### Recommended distribution (7 lots)

| Lot | Designated outcome | Bidders involved | Closes at | Why |
|---|---|---|---|---|
| **1** | **No-bid / unsold** | None | start + 25 min | Validates close behavior when no winning bid exists; tests `winning_buyer_user_id IS NULL` path |
| **2** | **Active bidding (quiet winner)** | B2 wins after 2–3 bids | start + 26 min | Validates normal happy path — single contested lot, no snipe |
| **3** | **Active bidding (proxy bidding)** | B2, B4 with proxy maxes | start + 27 min | Validates `is_proxy=TRUE` flow + proxy resolution |
| **4** | **Snipe target #1 (shippable)** | B3 snipes B2 at T-30s | start + 28 min | Validates anti-snipe extension on a shippable lot |
| **5** | **Snipe target #2 (multi-round)** | B3 and B4 alternate snipes, triggering 2–3 extensions | start + 29 min | Validates extension_count increments correctly across multiple extensions |
| **6** | **Refund target** | B5 wins with single bid | start + 30 min | Validates payment success then admin-issued refund flow |
| **7** | **One-bid-no-contest** | B1 wins with starting bid | start + 31 min | Validates minimum-bid path + low-engagement buyer |

### Total auction window

- Start time: operator chooses (recommend T+25 min from publish so buyers have time to find/log in)
- End time: start + 35 min (gives lot 7 close + 4 min buffer for any extensions)
- Actual end-of-activity: start + ~35–45 min depending on how many extensions fire

### Bid increment ladder

If the platform has a default ladder, use it. Otherwise specify:

| Current bid | Next increment |
|---|---|
| $0 – $24 | $1 |
| $25 – $99 | $5 |
| $100 – $499 | $10 |
| $500 – $999 | $25 |
| $1,000+ | $50 |

This gives buyers enough granularity to bid often (signal volume) without making the increments feel punitive.

### Why 7 lots, not more

| Lot count | Trade-off |
|---|---|
| 3 lots | Too few — can't observe concurrent close behavior or extension cascades |
| 5 lots | Workable but no margin for "unsold" + "refund target" + "snipe targets" |
| **7 lots** | **Recommended** — covers every test case; one operator can watch all in real time |
| 10+ lots | Operator overload; data quality drops as you miss real-time observations |

---

## 4. Pilot execution checklist (time-ordered)

Each step references the buyer who acts and the expected platform behavior. Hand off to Claude after the pilot for review against the audit log, but real-time execution is the operator's.

### T-30 min → T+0 (setup)

| Time | Actor | Action | Expected |
|---|---|---|---|
| T-30 | Operator | Confirm staging identity per `docs/sop-staging-validation-e.md` §0.2 | Three-line check passes |
| T-25 | Operator | Publish the pilot auction | Auction state → 'published', visible on discovery |
| T-20 | All 5 buyers | Log in, find the auction, register as bidders | Each receives a unique paddle number; registration confirmation email arrives |
| T-15 | B1, B2 | Browse lots, mark favorites (watchlist) | Watchlist records appear in DB |
| T-10 | B2 | Place an early bid on lot 2 ($30 over $25 starting) | Bid recorded, B2 is current winner of lot 2 |
| T-5 | B4 | Place a competing bid on lot 2 ($40) | B2 receives OUTBID notification (email + queue row); B4 is now winner |
| T-2 | B2 | Re-bid on lot 2 ($50) | B4 receives OUTBID; B2 is winner |
| T-1 | B2 | Set a proxy max on lot 3 ($75) with first bid of $25 | Proxy created; visible bid is $25 (or starting bid + 1 increment) |

### T+0 (auction enters its active window — bid count picks up)

| Time | Actor | Action | Expected |
|---|---|---|---|
| T+0 | B4 | Bid on lot 3 ($30) — triggers B2's proxy | B2's proxy auto-bids to $35; B2 is winner. B4 receives OUTBID. |
| T+2 | B4 | Bid on lot 3 ($50) — within B2's proxy max | B2's proxy auto-bids to $55. B4 OUTBID. |
| T+5 | B4 | Bid on lot 3 ($80) — EXCEEDS B2's $75 proxy | B2's proxy maxes at $75; B4 wins at $80. B2 receives OUTBID for losing the proxy. |
| T+10 | B5 | Bid on lot 6 ($1 — starting bid) | B5 is winner; no contest |
| T+12 | B1 | Bid on lot 7 ($1 — starting bid) | B1 is winner; no contest |
| T+15 | Nobody | Lots 1–7 all have intended state by this point; no bids on lot 1 | Lot 1 has zero bids |

### T+20 → T+24 (snipe positioning window)

| Time | Actor | Action | Expected |
|---|---|---|---|
| T+20 | B3 | Watch lots 4 and 5 closely; do nothing yet | — |
| T+22 | B2 | Place "leading" bid on lot 4 ($30) | B2 wins lot 4 currently |
| T+23 | B2 | Place "leading" bid on lot 5 ($40) | B2 wins lot 5 currently |

### T+24:30 → T+29 (close window with snipes + extensions)

| Time | Actor | Action | Expected |
|---|---|---|---|
| T+25:00 | — | **Lot 1 closes** (no bids) | Lot state → 'closed', winning_buyer_user_id IS NULL |
| T+26:00 | — | **Lot 2 closes** (B2 wins at $50) | Lot state → 'closed', winner = B2 |
| T+27:00 | — | **Lot 3 closes** (B4 wins at $80) | Lot state → 'closed', winner = B4 |
| T+27:30 | B3 | **Snipe lot 4**: bid $45, within 30 sec of close → triggers extension | Lot 4's closes_at += 2 min; extension_count = 1. B2 receives EXTENDED_BIDDING notification. |
| T+29:00 (was T+27:30 + 90s but extension reset) | Lot 4 closes (if no further bids) | B3 wins lot 4 at $45 | |
| T+27:45 | B3 | **Snipe lot 5**: bid $50 | Lot 5's closes_at += 2 min; extension_count = 1 |
| T+28:30 | B4 | Counter-snipe lot 5: bid $60 | Triggers second extension; extension_count = 2 |
| T+29:45 | B3 | Counter-snipe lot 5: bid $70 | Triggers third extension; extension_count = 3 |
| T+31:30 | Lot 5 closes | B3 wins lot 5 at $70 if no further bids | |
| T+30:00 | — | **Lot 6 closes** (B5 wins at $1) | Refund target |
| T+31:00 | — | **Lot 7 closes** (B1 wins at $1) | |

### Post-close: payment, refund, pickup, invoice

| Time after close | Actor | Action | Expected |
|---|---|---|---|
| +0–5 min | All winners (B1, B2, B3, B4, B5) | Receive AUCTION_WON email | Cross-check Postmark and `notifications_queue` |
| +5 min | B2 | Go through payment flow for lot 2 (uses test card `4242 4242 4242 4242`) | PaymentIntent created → confirmed → `payments.status='paid'` → invoice created → pickup assigned |
| +6 min | B2 | Receive PAYMENT_CONFIRMED and PICKUP_SCHEDULED emails | Both queue rows visible |
| +7 min | B4 | Pay for lot 3 | Same flow |
| +8 min | B3 | Pay for lots 4 and 5 (two separate payments) | Validates same-buyer multi-lot pickup grouping |
| +10 min | B5 | Pay for lot 6 (refund target) | Payment succeeds; status='paid' |
| +12 min | Operator/admin | **Issue refund** for lot 6 via admin endpoint (currently raw curl per `docs/sop-refunds.md` — Sub-batch 2's new endpoint adds the Idempotency-Key requirement) | Status → 'refunded'; audit row written; Stripe Dashboard shows refund |
| +15 min | B1 | Pay for lot 7 | Final paid lot |
| +20 min | Operator | Verify pickup_assignments table: B1, B2, B3, B4 (no B5 — refunded) each have entries | DB query |
| +25 min | All paying buyers | Visit `/api/me/invoices` or invoice page | Each sees their invoice list, status='paid' (or 'refunded' for B5's lot 6) |

### Post-pilot: audit + reconciliation

| Action | Check |
|---|---|
| Audit log review | `SELECT event_type, COUNT(*) FROM audit_log WHERE created_at > '<pilot_start>' GROUP BY event_type ORDER BY 1;` — expected types: `payment.created`, `payment.intent_attached`, `payment.paid`, `payment.refund_started`, `payment.refunded`, `auction.closed` |
| Stripe webhook events | All `stripe_webhook_events` from the pilot window have `status='processed'` |
| Invoice count | One invoice per paid payment (4 paid, 1 refunded but invoice still exists) |
| Pickup assignment count | 4 pickup assignments (B1, B2, B3, B3, B4) — note B3 has 2 (lots 4 + 5) |
| /api/health reconciliation surface | `payments_orphaned_intent_count = 0`, `webhook_failed_count_1h = 0` |
| `seller_payouts` row | One row for this auction with gross_revenue_cents, platform_fee_cents (10%), seller_payout_cents matching the paid lots minus refund |

---

## 5. Notification readiness status

### Email — OPERATIONAL via Postmark

| Component | Status | Evidence |
|---|---|---|
| Email transport | Postmark HTTP API | `src/services/emailService.js` |
| Required env | `SMTP_PASS` = Postmark Server API Token; `EMAIL_FROM` (with fallbacks) | Confirmed in `server.js` startup checks |
| Notification types wired | OUTBID, AUCTION_WON, LEADING, ENDING_SOON, EXTENDED_BIDDING, PAYMENT_CONFIRMED, PICKUP_SCHEDULED, REGISTRATION_CONFIRMATION | `src/services/notificationService.js` |
| Per-user opt-in | `notification_preferences.email_enabled` (defaults to TRUE) | `db/migrations/021` |
| Worker | `src/workers/notificationWorker.js` drains `notifications_queue` and calls Postmark | Confirmed |

**Pilot prep:** verify `SMTP_PASS` is set in staging env. Verify Postmark Dashboard shows the staging server's stream as active. No new infrastructure needed.

### SMS — WIRED but NOT YET PRODUCTION-VALIDATED; OPT-IN ONLY (per business rule)

| Component | Status | Evidence |
|---|---|---|
| SMS transport | Twilio | `src/services/smsService.js` |
| Required env | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Confirmed |
| Per-user opt-in gate | `notification_preferences.sms_enabled = TRUE` AND `sms_consent = TRUE` AND `phone_number` set | `db/migrations/021` |
| Worker support | `notificationWorker.js` calls `sendSMS` when SMS channel selected | Confirmed |
| Production validation | NOT YET completed | Twilio path has not been exercised end-to-end in staging with a real recipient |

**Pilot prep:** SMS is gated off by default for all 5 pilot buyers (per the seed defaults: `sms_enabled=FALSE`, `sms_consent=FALSE`). To exercise SMS during the pilot, manually enable for **at most one** buyer that has a real phone the operator controls:
```sql
UPDATE notification_preferences
   SET sms_enabled  = TRUE,
       sms_consent  = TRUE,
       sms_consent_at = now(),
       phone_number = '+1XXXXXXXXXX'
 WHERE user_id = (SELECT id FROM users WHERE email = 'pilot-buyer2@advantage.bid');
```
Validates the SMS path without spamming five strangers' phones (or, in this case, five seeded test addresses without real numbers). If the operator chooses to enable SMS for the pilot, that single delivery doubles as production validation of the Twilio path.

### Known notification gaps (current state)

| Gap | Impact on pilot | Recommendation |
|---|---|---|
| `notifications_queue.type` CHECK constraint covers only OUTBID/LEADING/WINNING/ENDING_SOON | New notification types (AUCTION_WON, PAYMENT_CONFIRMED, etc.) are sent via a separate code path (not via `notifications_queue.type` enum). Verify by inspecting: rows with these types are dispatched directly via `_deliverNotification`, not enqueued. | No fix needed for pilot. Inconsistency noted for Phase 2 cleanup. |
| No bounce / delivery-status tracking | If Postmark bounces an email, we don't know inside the platform | Watch the Postmark Dashboard manually during pilot. Phase 2 work to wire Postmark webhooks. |
| No SMS delivery confirmation | If Twilio fails to deliver, the worker logs but no platform-visible record | Same — manual check via Twilio Console during pilot. |
| Notification preferences UI for buyers | Buyers cannot self-serve enable SMS through the UI; only admin SQL or admin endpoint | Acceptable for pilot. Phase 2 UI work. |
| Per-notification-type opt-out (granular) | Current opt-in is per-channel, not per-notification-type — a buyer who enables email gets ALL email notification types | Acceptable for pilot. Phase 2 product decision. |
| Pickup-reminder notifications (24h before scheduled pickup) | Not implemented | Not required for pilot scope. |
| **Refund-issued notification to buyer** | **NOT IMPLEMENTED** (per `docs/sop-refunds.md` notes: "platform does NOT automatically notify buyers on refund — do it manually") | **Pilot operator note:** after the lot 6 refund, the operator must manually email B5. This is a known gap, not a defect. |

---

## 6. Pilot observer checklist

What to watch for during the pilot. Each item has a severity and an action.

### 6.1 Operational anomalies

| Watch for | Severity | Action |
|---|---|---|
| Bid recorded but UI doesn't update for the bidder | Medium | Refresh page; if persists, check socket connection in browser console. Capture timestamp. |
| Bid recorded but countdown does NOT extend when it should (within final 2 min) | High | Capture lot_id, bid_id, expected close vs actual. Possible anti-snipe regression. |
| Lot closes BEFORE its `closes_at` | Critical | Stop pilot immediately. Capture row state. Investigate scheduler. |
| Payment intent created but Stripe Dashboard shows no PI | Critical | Capture payment_id. Investigate orphan-prevention (Sub-batch 2). Check `/api/health` `payments_orphaned_intent_count`. |
| Webhook event row stuck in `status='received'` longer than 5 min | High | Note event_id. Possible handler stall. |
| `stripe_webhook_events.status='failed'` for any event during pilot | High | Note event_id + `last_error`. After pilot, `stripe events resend` to recover. |
| `seller_payouts` row not created after auction close | High | Capture auction_id. Investigate `closeAuction` payout snippet. |
| Audit row count drift (action with no matching audit row) | High | Note specific action + timestamp. |

### 6.2 Bidder confusion (UX signal)

| Watch for | Severity | Action |
|---|---|---|
| Buyer asks "did my bid go through?" | Medium | UI feedback gap. Note which screen, which lot. |
| Buyer is uncertain whether they're the current high bidder | Medium | "You are the leader" indicator missing or unclear. |
| Buyer doesn't realize bid extended the close time | Medium | Extension notification UX gap. |
| Buyer can't find the auction after registering | High | Discovery / navigation issue. |
| Buyer enters payment info and gets confused by the test card prompt | Low | Expected for test mode; document if frequent. |

### 6.3 Seller confusion (UX signal — operator's direct observation)

| Watch for | Severity | Action |
|---|---|---|
| Field-naming mismatch between form labels and what data is actually stored | Medium | Note field. |
| Required-vs-optional ambiguity (e.g., dimensions appear required but shouldn't be) | Medium | Note field. Verify against business rules. |
| 48-hour (non-professional) pickup rule rejection not clearly explained | Medium | Note error message text. |
| Featured-lot selection unclear (which 3 of 7 are featured?) | Medium | Note UI screen. |
| Submit-for-review button location / friction | Low | Note workflow time. |
| Lock-out after submit (seller realizes they need to edit something) | High | This is per CLAUDE.md "single-use submission" — admin override is the documented escape. Note if it was needed. |

### 6.4 Financial inconsistencies (CRITICAL — any of these is a stop-the-pilot event)

| Watch for | Severity | Action |
|---|---|---|
| Two payment rows for the same (lot, buyer) | Critical | STOP. Capture both rows. Rollback Sub-batch 2 candidate. |
| Two Stripe PIs for one successful charge | Critical | STOP. Capture both PI IDs (Dashboard). |
| Two refunds in Stripe for one platform refund request | Critical | STOP. Critical financial regression. |
| Payment marked paid but no invoice | High | Capture payment_id. |
| Payment marked paid but no pickup_assignment (and lot is pickup-eligible) | High | Capture. |
| Refund issued but `refunded_amount_cents` not updated | High | Capture. Sub-batch 2 regression candidate. |
| `seller_payouts.seller_payout_cents` doesn't equal (gross - 10% fee) for the auction | High | Capture. Math regression. |
| Buyer sees full address before their payment is confirmed | Critical | STOP. Privacy violation. |

### 6.5 UI friction (cumulative signal)

Track frequency of these — single occurrence is noise; recurring is signal:
- Page load > 3 seconds
- Bid button needs to be clicked twice
- Countdown jitter (stutters or jumps)
- Image upload silently fails or times out
- Login required twice in one session
- Mobile layout breaks specific flow

### 6.6 Rollback-worthy events

Any of these is sufficient cause to roll back deployed code and reschedule the pilot:

| Event | Rollback scope |
|---|---|
| Critical financial inconsistency (§6.4) | Sub-batch 2 candidate; consider reverting `f03809b` |
| Lot closes prematurely | Investigate before reverting; possibly DB clock issue |
| Stripe webhook signature verification failures > 1 | Sub-batch 1 candidate; check `STRIPE_WEBHOOK_SECRET` rotation |
| Audit log writes start failing | Migration 048 rollback candidate (`docs/admin-center-phase-a-plan.md` §7 procedure if 048 was applied) |
| Multiple buyers reporting "site is broken" | Stop pilot, investigate before resuming |

For any rollback-worthy event:
1. **Stop the pilot** (do not continue bidding)
2. Notify affected buyers via email (manual)
3. Capture full state: DB query outputs, server logs, Stripe Dashboard screenshots
4. Decide rollback scope with Claude review
5. Restart pilot only after root cause identified and fixed

---

## 7. What is explicitly NOT in this pilot prep

- ❌ No new infrastructure (no new tables, no new code, no new env vars)
- ❌ No RBAC implementation (Phase A still paused)
- ❌ No deployment (staging-only pilot)
- ❌ No new buyer/seller accounts beyond the existing seeded pilot 5
- ❌ No production data touched
- ❌ No new SOPs created beyond this one (existing `docs/sop-refunds.md`, `docs/sop-payout-release.md`, `docs/sop-incident-response.md` apply)

---

## 8. Coordination with Phase 1 §E staging validation

This pilot exercises **real seller + real bidder + real money flows** in staging. It is the natural complement to the §E synthetic validation:

| §E runbook | This pilot |
|---|---|
| Synthetic scenarios with forced hooks | Real human + real flow |
| Tests specific invariants | Tests holistic user experience |
| Capture is structured (SQL + log lines) | Capture is structured + observational |
| Pass/fail per scenario | Pass/fail per category (operational, UX, financial) |
| Operator role: scripted | Operator role: also the seller |

**Recommended order:**
1. Complete §E.1 → §E.7 (Sub-batch 1 staging validation) first — they verify the webhook + audit machinery in isolation.
2. Run this pilot — exercises the same machinery under real-world load + UX.
3. Complete §E.8 → §E.12 (Sub-batch 2 + orphan recovery + overspend) — these can reuse pilot-created payments where convenient, or use fresh lots.
4. §F sign-off and production deploy decision.

The pilot is not a substitute for §E — both are needed. Synthetic tests catch the cases real users won't hit; the pilot catches the cases the synthetic tests can't see.

---

## Review protocol

After the pilot completes, paste to Claude:
1. The chronological run log (which actions happened when, with timestamps)
2. The DB query outputs from §4's post-pilot audit + reconciliation block
3. Any observations from §6 (operational, UX, financial, friction)
4. Any rollback triggers encountered (even if recovered)

Claude responds with: pass/fail per category, expected-vs-actual diff for any anomaly, rollback recommendation if a stop condition fired, and explicit "OK to proceed to production deploy" once §F sign-off criteria across both runbooks are satisfied.

We remain in **validation-first operational discipline**: financial correctness over speed, no rushed pilot, no production deploy until both this pilot AND the §E runbook have passed.

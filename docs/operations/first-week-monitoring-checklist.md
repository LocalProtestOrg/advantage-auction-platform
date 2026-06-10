# First-Week Monitoring Checklist

**Window:** first 7 days post-launch (from 2026-06-10, release `e0f005f`). **Owner:** operator + on-call engineer. Stripe is TEST during the pilot.

## Daily (each morning + a spot-check each evening)
- [ ] **Health:** `GET /api/health` → `status:ok`, `db_reachable:true`, `email_configured:true`, `stripe_mode:test`. Record uptime/`started_at` (unexpected restarts = investigate).
- [ ] **Deploy integrity:** Railway shows expected commit `SUCCESS`, instance `RUNNING`, no crash-loop in logs.
- [ ] **Workers alive:** logs show `notificationWorker` + `imageProcessingWorker` running (no repeated "exited → respawn" every ~5s).
- [ ] **Email deliverability:** at least one real email observed delivered (agreement/notification/close), or run `POST /api/admin/email/test` to an owned address. Confirm not landing in spam (SPF/DKIM/DMARC pass).
- [ ] **Error log scan:** no recurring 5xx, unhandled rejections, or DB query errors (esp. none mentioning removed columns — `created_by_user_id`, `ends_at`, `l.position` should never appear).
- [ ] **Audit log sanity:** `GET /api/admin/audit-log` reflects the day's governance actions.

## Auction lifecycle watch
- [ ] **Scheduler working:** published auctions promote to `active` at `start_time`; lots **soft-close on the 1-min stagger**; ≤2-min bids extend by 2 min.
- [ ] **Closes complete:** auctions reach `closed` at/after `end_time`; **operational close email** delivered to seller.
- [ ] **Final reports:** when triggered, `send-final-report` PDF generates and is received.
- [ ] No auction stuck in `active` past its `end_time` (→ scheduler/worker check).

## Payments (TEST mode)
- [ ] Card verification (<$1 test charge) succeeds at signup/card-change using Stripe **test** cards.
- [ ] Stripe **test** dashboard shows expected PaymentIntents; no unexpected LIVE activity.
- [ ] No real refunds attempted (refund hardening not in prod) — escalate any refund need.

## Seller agreement system
- [ ] Agreements send, open via token, sign, and produce a signed PDF (Cloudinary signed URL).
- [ ] Resend/reissue/revoke behave as expected when used.

## Data & capacity
- [ ] Neon: no read-only errors; connection count healthy; storage trending normally.
- [ ] `notifications_queue` not backing up (sent rows keep pace with enqueued).
- [ ] Cloudinary uploads/enhancements succeeding (lot images render).

## Weekly review (end of week 1)
- [ ] Summarize incidents + resolutions.
- [ ] Confirm no security/privacy regressions (paddle-number anonymity intact; full addresses hidden pre-payment).
- [ ] Decide go/no-go items for week 2 (incl. whether Stripe LIVE cutover prep should begin — gated on Line B reconciliation).
- [ ] Back up / snapshot decision: confirm `prod-pre-promo-2026-06-10` retained or take a fresh Neon branch.

## Escalation triggers (page engineering)
- `db_reachable:false`, app down/crash-loop, worker crash-loop, auctions not closing, email outage, or any **real** (LIVE) Stripe charge observed.

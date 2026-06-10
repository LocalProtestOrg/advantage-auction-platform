# Pilot Launch Checklist

**Release:** `e0f005f` (Line A) on Railway `advantage-auction-platform`. **Date:** 2026-06-10. Stripe **TEST** mode.

## A. Pre-launch — infrastructure (DONE unless noted)
- [x] Production app deployed: `origin/main` = `e0f005f`, deploy `SUCCESS`, instance `RUNNING`.
- [x] DB migrations applied to prod: `046–057` (`schema_migrations` highest `057`, 54 total).
- [x] Neon pre-promotion backup branch created: `prod-pre-promo-2026-06-10`.
- [x] Prod DB is read-write (`default_transaction_read_only=off`, not a replica).
- [x] SES email env set + verified: `email-smtp.us-east-1.amazonaws.com:2587`, `SMTP_SECURE=false`, `EMAIL_FROM=notifications@advantage.bid`, `EMAIL_REPLY_TO=advantageauction.bid@gmail.com`. Transport `verify()` OK on 2587.
- [x] Health endpoint green (`/api/health`): db_reachable, stripe_configured, email_configured, `stripe_mode=test`.
- [x] Real admin account provisioned (`tylerwitt2015@gmail.com`, role admin, active).
- [x] **Admin access cleaned up (2026-06-10):** active admins = `admin@advantage.bid` (primary operational) + `tylerwitt2015@gmail.com` (personal/recovery). Seeded admins `validation-admin@advantage.bid` and `test-admin@example.com` **disabled** (`is_active=false`, not deleted). Login to `admin@advantage.bid` verified.

## B. Pre-launch — functional smoke (operator to confirm with real admin login)
- [ ] **Admin login** at `/login.html` → reaches `/admin/index.html`.
- [ ] **Admin dashboard** loads (moderation, agreements, config).
- [ ] **Controlled SES delivery test:** `POST /api/admin/email/test` `{ "to": "tylerwitt2015@gmail.com" }` → `message_id` returned **and** email received.
- [ ] **SPF / DKIM / DMARC** all **pass** in the received email's headers (`advantage.bid`).
- [ ] **Agreement workflow:** issue → seller receives → sign → signed PDF renders (use a controlled test seller).
- [ ] **Auction dry run:** create → submit → admin publish → goes active → soft-close → closes → operational close email → final report PDF.
- [ ] **Buyer dry run:** register (controlled address), card verification with Stripe **test** card, place bid, outbid notification, watchlist.

## C. Business-rule spot checks
- [ ] Pickup-gap enforced (non-professional ≥ 48h after close; never before close).
- [ ] Lot defaults: $1 start unless override; size category required; 3 featured lots.
- [ ] Buyer premium shown live; tax post-close; debit/credit only.
- [ ] Paddle-number anonymity; full address hidden until payment verified.
- [ ] Seller final submission locks editing; admin override works.

## D. Known constraints accepted for pilot (sign-off required)
- [ ] **Stripe TEST mode** — no real money. LIVE cutover is **gated** on Line B reconciliation (`docs/stripe-live-cutover-prerequisites.md`).
- [ ] **Seller payout auto-creation not wired** — payouts handled manually during pilot.
- [ ] **Refund/webhook hardening (Line B) not in prod** — no real refunds; escalate.
- [ ] **`missed_pickups` automation absent** — handle missed pickups manually.
- [ ] **Address-at-rest encryption not implemented** — address hiding is enforced at the view layer only (see gaps).
- [ ] **Public URL** = Railway domain (`...up.railway.app`); custom domain (`bid.advantage.bid`) deferred post-launch.

## E. Go / No-Go
- [ ] Sections A & B complete; C spot-checks pass; D constraints explicitly accepted by owner.
- [ ] On-call coverage assigned; incident runbook reviewed; first-week monitoring scheduled.
- [ ] **GO decision recorded** (who/when), or list blockers.

## F. Immediately after launch
- [ ] Begin `first-week-monitoring-checklist.md`.
- [ ] Watch the first real seller onboarding and first real auction end-to-end.
- [ ] Capture issues in an ops log for week-2 triage.

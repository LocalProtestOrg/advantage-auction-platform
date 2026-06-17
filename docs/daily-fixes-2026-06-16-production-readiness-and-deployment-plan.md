# Daily-Fixes Sprint — Production Readiness Review & Deployment Plan

**Status:** PREPARED, NOT EXECUTED. Do not deploy to production without explicit approval.
**Branch:** `fix/daily-fixes-2026-06-15` (6 commits ahead of `origin/main` @ `d95905f`)
**Stripe:** TEST (unchanged). No LIVE work. No env/payment/payout/premium changes. Buyer Terms v2 stays draft.
**Migrations:** NONE in this sprint (code + data only) — materially lowers deploy risk.

---

## 1. What ships (per commit)

| Commit | Item | Type | Surface |
|---|---|---|---|
| `b4930b3` | Auction header tabs + summary fields + sitemap/footer links | UI (frontend) | auction-view.html, sitemap, footers |
| `1ba8a55` | Footer Sitemap-link sweep across info pages | UI (frontend) | public/*.html footers |
| `032d13d` | Legal pages: Terms of Use + Privacy bodies (AAC text); Buyer Terms v2 **draft** | content + data | terms.html, privacy.html, terms_versions (v2 non-current) |
| `5774bed` | Miles units; /demo.html redirect; em-dash sweep + lint; Summer Showcase seed | UI + data + tooling | widgets/*, public/*, server.js, scripts/ |
| `7cd5e75` | Server-side auction start gate; Showcase uses open lots | **server logic (bidding)** | src/routes/lots.js, src/lib/biddingWindow.js |
| `ccc260a` | Align notification tests with em-dash sweep | test only | tests/ |

### Per-item readiness

- **Miles conversion** — UI-only (`× 0.621371` at render). Internal API still returns `distance_km` (verified). No data change. **Low risk.**
- **Demo redirect** — `/demo.html` → `/` via meta-refresh + `location.replace('/')`; dead `app.get('/')` route removed (static already served index at `/`). **Low risk.** Watch: any external links/bookmarks to `/demo.html` now bounce to home (intended).
- **Auction tabs** — auction-view header tabs + summary fields. **Low risk** (presentation). Validate on a real prod auction detail page post-deploy.
- **Legal pages** — Terms/Privacy bodies rendered from `<script type="text/plain">` via md-render. **Content risk only**; note in-page disclaimer that attorney review is still recommended. No activation of v2.
- **Footer sweep** — Sitemap links added to footers. **Low risk.**
- **Summer Showcase** — DATA via seed script (see §2). Auction `published`, opens 2026-07-15. 8 `open` lots; bidding blocked by §bid-guard. **No prod seed script exists yet — must be authored (prereq P1).**
- **Bid guard fix** — **highest-attention item.** `auctionBiddingOpen(state,start,now)`: biddable only when `state='active'` AND `start_time` passed. New 422 "Bidding has not opened for this auction yet" in `POST /api/lots/:lotId/bids`. Closes a latent bug (registered buyer could bid on a not-yet-started published auction). 8 unit tests + staging-proven (upcoming→422, active→passes to registration). **Medium risk: touches critical bidding infra** — validate active-auction bidding on prod post-deploy.

---

## 2. Production data steps (no migrations)

**P1 — `scripts/prod-seed-summer-showcase.js`** (AUTHORED 2026-06-16, NOT yet run).
Prod-guarded clone of `stg-seed-summer-showcase.js`: refuses the staging endpoint `ep-royal-dawn-anarou3f`, requires prod `ep-proud-leaf-an8pzkib`; body verified identical (same fixed UUIDs `5a000000-…`, `open` lots, no bids/winners/payments). Idempotent. Requires the bid-guard commit `7cd5e75` to be deployed first (it relies on the server start gate to keep the `open` lots unbiddable until 2026-07-15). Syntax-checked; awaiting approval to run as deploy step 7.

**P2 — `scripts/prod-create-buyer-terms-v2.js`** (EXISTS).
Inserts/re-syncs Buyer Terms v2 as **non-current draft** (em-dash-free body from terms.html). Confirmed it does NOT activate v2 (skips if v2 ever became current). Safe.

Both run via `railway run --service advantage-auction-platform --environment production node scripts/<name>.js` (executes locally with prod env injected; hits prod Neon). Each prints a PASS/FAIL self-check.

---

## 3. Backup branch / restore point (BEFORE anything)

1. Tag current prod head: `git tag pre-daily-fixes-2026-06-16 origin/main && git push origin pre-daily-fixes-2026-06-16`
2. Create a backup branch off prod head: `git branch backup/pre-daily-fixes-2026-06-16 origin/main && git push origin backup/pre-daily-fixes-2026-06-16`
3. Manual Neon prod branch/snapshot via Neon console (NEON_API_KEY not available to CLI — user creates). Capture: `terms_versions` row count + current buyer_terms version; confirm no `5a000000-…` auction exists pre-seed.
4. Record current prod `origin/main` SHA in the deploy log.

---

## 4. Deployment sequence (proposed — execute only on approval)

> Follow the existing `docs/production-promotion-runbook.md` for the exact prod trigger. Production auto-deploys from `main` (and the `deploy/seller-studio-1b` branch is FF-advanced in the same model). This sprint adds NO migrations, so the DB-migration prologue in the runbook is skipped.

1. **Pre-flight:** `npx jest tests/` green (21 suites / 189 tests); `node scripts/check-dashes.js` clean; working tree clean.
2. **Backup** (§3).
3. **Author + review P1** (prod seed script); dry-read only.
4. **Merge to main:** fast-forward `fix/daily-fixes-2026-06-15` → `main` (no squash needed; keep the 6 commits). Confirm FF (no divergence) before pushing.
5. **Push `main`** → triggers prod auto-deploy. FF-advance `deploy/seller-studio-1b` to match.
6. **Watch build/deploy** to green; confirm prod `/api/health` 200 and `/` 200.
7. **Run prod data scripts:** P2 (Buyer Terms v2 draft) then P1 (Summer Showcase seed). Confirm each prints PASS.
8. **Validation checklist** (§5).
9. If all green → done. If any red → **rollback** (§6).

---

## 5. Post-deploy validation checklist (prod)

**Code/UI**
- [ ] `/` 200; `/api/health` 200.
- [ ] `/demo.html` → redirects to `/`.
- [ ] Distance labels show "mi" (homepage radius select + any near-you cards); `/api/public/auctions/near` still returns `distance_km`.
- [ ] Auction-view tabs render on a real prod auction; legal pages (`/terms.html`, `/privacy.html`) render; footers show Sitemap link.
- [ ] `node scripts/check-dashes.js` clean against deployed tree; spot-fetch `/terms.html` `/privacy.html` `/buyer-faq.html` → 0 em/en dashes.

**Bid guard (critical)**
- [ ] Identify every prod auction currently `state='active'` with open lots → confirm bidding STILL works (place/raise a TEST-mode bid as a registered buyer; expect success, NOT the new 422).
- [ ] Confirm no prod auction depends on bidding while `state='published'` (the gate would now block it). If any exists, STOP and reassess.
- [ ] Summer Showcase lot → bid attempt returns 422 "Bidding has not opened for this auction yet".

**Summer Showcase**
- [ ] Appears in `/api/public/auctions` as `published`, opens 2026-07-15, subtitle "Coming Soon - Demo Showcase".
- [ ] 8 `open` lots, 0 bids/winners; auction detail shows "Auction starts Jul 15, 2026".
- [ ] Pre-registration reachable (advances to terms/card gate; `can_bid:false`).
- [ ] NO payments/invoices/winners created.

**Buyer Terms v2**
- [ ] `terms_versions`: buyer_terms v1 still `is_current=true`; v2 `is_current=false` (draft). NOT activated.

**Regression**
- [ ] Existing prod TEST auction close→payout path unaffected (no payout/premium changes shipped — confirm by inspection, not re-run, unless a TEST auction is already mid-cycle).

---

## 6. Rollback plan

**Code rollback** (fast, low-risk — no migrations to reverse):
- Revert prod `main` to `pre-daily-fixes-2026-06-16` (reset/FF or `git revert` the merge), push → auto-deploy restores prior build. Backup branch `backup/pre-daily-fixes-2026-06-16` is the restore source.

**Data rollback** (only if needed; all additive/reversible):
- Summer Showcase: delete the seeded rows by fixed UUID — `lot_images` (8) → `lots` (`5a000000-…-011..018`) → `auctions` (`5a000000-…-010`) → `seller_profiles` (`…-002`) → `users` (showcase-demo). No FKs from real buyer data point at these (no bids/payments/invoices), so deletion is clean. (Author `scripts/prod-unseed-summer-showcase.js` if a one-command revert is wanted.)
- Buyer Terms v2 draft: `DELETE FROM terms_versions WHERE kind='buyer_terms' AND version_int=2 AND is_current=false;` (never touch v1).

**Bid guard rollback:** it's the code rollback above (no data). The guard is pure-additive logic; reverting `7cd5e75` restores prior bid behavior.

**Decision rule:** any failed checklist item in the "Bid guard (critical)" group → immediate code rollback. Cosmetic/content issues (legal copy, footer) → fix-forward, no rollback.

---

## 7. Marketing-surface note (NOT an auction-platform change)

**Architecture clarification (owner, 2026-06-16):** `bid.advantage.bid` (this auction platform) is the **auction platform / upcoming-auctions page**, NOT the public marketing homepage. The real marketing homepage is **Advantage.bid, built on Brilliant Directories (BD)**, which should funnel visitors *to* bid.advantage.bid. Therefore: **do NOT add an "Upcoming Auctions" section to the auction-platform index/homepage.** (Aligns with the integration contract: BD is an external presentation/identity adapter; core auction logic stays on the platform.)

The earlier "homepage visibility" observation still holds technically — the upcoming Showcase appears in none of the auction-platform's curated sections (`sec-current`/active, `featured`, `ending-soon`, `recently-added`, `trending` all require `a.state='active'`); it's reachable via Browse/Search/Category. That is **acceptable and intended** for the platform page, because discovery/marketing belongs on the BD homepage.

### Future work item (BD widget — do NOT build now)
Create an embeddable Advantage.bid widget/section for the **Brilliant Directories homepage**:
- **Purpose:** promote upcoming auctions and drive traffic to bid.advantage.bid.
- **Initial CTA:** "View Upcoming Auctions".
- **Style:** visually trust-building, lightweight (mirror the existing `public/widgets/featured-*.js` embed pattern: anonymous reads of `/api/public/*`, no auth, no core logic in the widget).
- **Data source:** `/api/public/auctions?state=published` (upcoming) — already returns the Showcase once prod-seeded.
- **Must be able to feature the Summer Showcase** once it exists on production.
- **No auction-platform homepage/index change required.**
- Read `docs/integration-contract-bd.md` before designing.

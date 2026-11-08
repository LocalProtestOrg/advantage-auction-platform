# Baseline release 2026-11 (owner approval required before merge or deploy)

Branch `release/baseline-2026-11` = origin/main 2e3a543 plus the owner-authorized work:

| Branch | What it does |
|---|---|
| `fix/baseline-corrections` | 5% / 9% pricing references; migration 226; the two `seller_profiles.updated_at` 500s; seller-registration campaign attribution; Terms of Service v4 source + publisher; privacy update; agreement renderer fix (wrapped bold in v4) |
| `fix/admin-security-ads` | Owner-only sensitive settings with audit + owner notices; paid-ad authorizations (amount, dates, creative) and overspend/stop safeguards; package checkout ownership; postal address in commercial email (fails closed); migrations 222, 223 |
| `fix/sasha-r1-pro` | Sasha never recruits buyers or individuals (chat, email, phone); standard rates from code; R-1 Professional onboarding track |
| `fix/buyer-safeguards` | Registration requires accepting the current buyer terms (versioned, timestamped); bid rate limit; verified-email requirement built but OFF |
| `fix/baseline-r2-pricing` | Public "Just 7% Total Seller Fees" (4% platform + 3% processing) on seven public pages |
| `fix/baseline-r2-sasha` | Sasha uses the approved 7% wording; storefront-only Professional Sellers count as activated, with distinct storefront milestones; no message announces agreement or terms updates |
| `fix/baseline-r2-acceptance` | Current Seller Agreement accepted when a seller starts new listing activity (enforced at publish, all paths); nothing sent on publish; buyer terms asked only at the next transaction; /terms.html stays the full static Terms |
| `fix/baseline-r2-admin` | Owner email corrected; only packages whose benefits are delivered can be bought (all blocked today); legacy purchase route retired; Event Partner invitation unsubscribe; owner recovery; zero-spend Meta verification |

Nothing here turns on storefront checkout, shipping, payouts or ad spend. Migrations 218 to 220 (PR #86) are NOT part
of this release.

## Deploy order (each step needs the owner's go-ahead)

1. **Backup.** Neon branch `prod-pre-baseline-2026-11` from production.
2. **Read-only pre-checks done 2026-11-08:** `prod-migrate-222.js --check` PASS, `prod-migrate-226.js --check` PASS
   (the four keys hold exactly the seeded values 0, 0, 0, 1100, so the Reverse restores them identically);
   223's check passes only after 222 (by design).
3. **Migrations, before the code** (the new code fails closed without 222), each `--check`, `--dry-run`, then apply:
   `scripts/prod-migrate-222.js`, `scripts/prod-migrate-223.js`, `scripts/prod-migrate-226.js`.
   - 222: `users.is_platform_owner`, `platform_setting_audit`, `owner.notify_emails` = tylerwitt2015@gmail.com and
     advantageauction.bid@gmail.com (only if absent).
   - 223: `marketing_paid_authorizations` + nullable attribution columns on `marketing_paid_campaigns`.
   - 226: deletes 4 unused config rows (old 11% storefront rate, retired 0% pilot values).
4. **Designate the platform owner:** `scripts/prod-set-platform-owner.js --email=tylerwitt2015@gmail.com --apply`
   (verified read-only 2026-11-08: one account, active admin). `admin@advantage.bid` stays an ordinary admin.
   Recovery: `docs/operations/platform-owner-recovery.md`.
5. **Engage the advertising emergency stop** (owner decision 2026-11-08):
   `scripts/prod-engage-ad-kill-switch.js` (dry run), then `--apply`. Sets `marketing.paid.global_kill` = true through the
   audited safety-stop path (owner notified). It makes **no call to Meta**, so the historical campaigns and every
   campaign record stay exactly as they are (the Emergency Stop button would also query and pause campaigns at Meta).
   Clearing it is the owner's decision, never part of this deployment.
6. **Postal address for commercial email** (owner instruction 2026-11-07): set `company.postal_address` to
   "Advantage.Bid, 2205 Ogden Hwy, Adrian, MI 49221" (today it holds the Jersey City address). Owner-only once 222 and
   step 4 are done; audited and notified.
7. **Merge to main and push** (Railway auto-deploys). Confirm with `/api/health` started_at and the deployment status.
8. **Verify on production:** the seven pricing pages show "Just 7% Total Seller Fees"; registration shows the unchecked
   terms box; /terms.html shows the full Terms with 6A Text Messages; an admin who is not the owner is refused a
   pricing change; the seller marketing page shows every package "Not Available Yet"; Admin, Agreements: the v4
   preview, a signing page and a generated PDF show no `**`; owner notice email and text arrive for one harmless
   sensitive-setting change made by the owner.
9. **Baseline record:** git tag `baseline-2026-11`, Neon branch `baseline-2026-11`, and the baseline document.

Buyer Terms v4 (the full Terms of Service as accepted buyer terms) is **not** published in this deploy: it waits for the
owner's decision on its substantive provisions (see "Owner decisions").

## Rollback

- Code: revert the merge commit on main and push (auto-deploys the previous code).
- 226: re-insert the four rows (Reverse section in the migration file).
- 222 / 223: additive; the previous code ignores them. Drop only if required (Reverse sections in each file).
- Owner designation: `prod-set-platform-owner.js --replace` for another admin, only with the owner's authorization.
- Full restore: the Neon backup branch from step 1.

## Owner decisions (2026-11-08)

1. **Buyer Terms v4: not published.** Live terms and acceptance behaviour are unchanged. Review of the provisions that
   need approval: `docs/legal/buyer-terms-v4-substantive-review.md`.
2. **Contact address: 2205 Ogden Hwy, Adrian, MI 49221** everywhere (privacy policy, data-deletion page, Terms page and
   v4 source: done in this release; commercial-email setting: deploy step 4). The phone number is unchanged.
3. **Waivers preserved** (records unchanged). Investigation (read-only, 2026-11-08): **10** sellers (not 11), all waived
   on 2026-06-17, the day the Seller Agreement system launched, all created before it (May to June 17). None has ever
   signed an agreement; 5 have auctions (up to 21). No audit row records who set them (a launch-time bulk grandfathering).
   Their purpose was to keep existing sellers' dashboards open when signing became a gate, not to accept terms. In this
   **Approved and implemented:** the waivers keep access, but these sellers accept the current version at their next new
   listing (see "Resolved for the deployment").
4. **Auction Partner page kept:** "passed through at actual cost, with no markup" matches the program (migration 186,
   actual processing pass-through). Standard Professional auctions advertise 7% total (4% + 3%).
5. **Seller Agreement §7.6 (payouts ACH only) vs the payout page (also offers a mailed check).** Production: 0 sellers chose
   a check, 0 payouts paid by check (4 ACH, 42 settled manually). **Approved and implemented:** the seller page and routes
   offer ACH only.

## Resolved for the deployment (owner decisions 2026-11-08)

- **Waivers:** the 10 launch-time waivers are preserved unchanged (account, dashboard, existing listings stay open), but a
  waiver no longer counts as acceptance of the current Seller Agreement: these sellers accept it at their next new
  listing, like everyone else. No notification is sent.
- **Payouts:** the seller payout page offers direct deposit (ACH) only, matching Seller Agreement 7.6; both seller save
  routes refuse a mailed check. Historical payout and check records and the administrator's manual settlement are
  unchanged. (Production: 0 sellers chose a check, 0 payouts paid by check.)
- **Seller activation:** the new Professional track has its own switch, `seller_activation.pro_mode`, which defaults to
  record-only: Professional Sellers receive no automated check-in after this deployment (decisions are only recorded)
  until the owner sets it live (typed LIVE confirmation, owner-only). The Individual track is unchanged. Transactional
  notifications are not affected.
- **Advertising:** the emergency stop is engaged at deploy (step 5). No spend is authorized; no authorization exists.
- **Unchanged restrictions:** Buyer Terms v4 unpublished; storefront checkout, Sell Online, auction shipping, claimed-listing
  sending and Event Partner outreach stay off; PR #86 (migrations 218 to 220) is not part of this release.

## Known issues not fixed here

- The admin Marketing Agency browser test is opt-in (`RUN_PGLITE_BURST_TESTS=1`): on the in-memory test database a
  burst of parallel requests intermittently goes unanswered; reproduced on main; production is unaffected. Its rules are
  covered by API tests.
- `paidCostIngestionService` measurement status writes and `bidder_phone.required_since` write settings without an
  audit row.
- Owned marketing placements are recorded but never displayed; packages stay blocked until a public surface shows them.
- Seller Agreement §7.6 says ACH only while the payout page offers checks; §11.2 liability cap may be $0 for individuals.
- Two local-only test failures on Windows (line endings in migration 158; a timing test under load); both pass in CI.

# Baseline release 2026-11 (owner approval required before merge or deploy)

Branch `release/baseline-2026-11` = origin/main 2e3a543 plus four owner-authorized branches:

| Branch | What it does |
|---|---|
| `fix/baseline-corrections` | 5% / 9% pricing references; migration 226; the two `seller_profiles.updated_at` 500s; seller-registration campaign attribution; Terms of Service v4 source + publisher; privacy update; agreement renderer fix (wrapped bold in v4) |
| `fix/admin-security-ads` | Owner-only sensitive settings with audit + owner notices; paid-ad authorizations (amount, dates, creative) and overspend/stop safeguards; package checkout fixes; postal address in commercial email (fails closed); migrations 222, 223 |
| `fix/sasha-r1-pro` | Sasha never recruits buyers or individuals (chat, email, phone); standard rates from code; R-1 Professional onboarding track (2 per stage, quiet periods) |
| `fix/buyer-safeguards` | Registration requires accepting the current Terms (versioned, timestamped); Terms pages render the current version; bid rate limit; verified-email requirement built but OFF |

Nothing here turns on storefront checkout, shipping, payouts or ad spend. Migrations 218 to 220 (PR #86) are NOT part
of this release.

## Deploy order

1. **Backup.** Neon branch `prod-pre-baseline-2026-11` from production (scratchpad mkbackup script).
2. **Migrations, before the code** (the new code fails closed without 222):
   `railway run node scripts/prod-migrate-222.js --check`, then `--dry-run`, then apply. Same for 223 and 226.
   - 222: `users.is_platform_owner`, `platform_setting_audit`, `owner.notify_emails` (only if absent).
   - 223: `marketing_paid_authorizations` + nullable attribution columns on `marketing_paid_campaigns`.
   - 226: deletes 4 unused config rows (old 11% storefront rate, retired 0% pilot values).
3. **Designate the platform owner:** `scripts/prod-set-platform-owner.js --email=<owner account> --apply`.
   Until this runs, every sensitive setting change and every paid authorization is refused (stops still work).
4. **Merge to main and push** (Railway auto-deploys). Confirm with `/api/health` started_at and the deployment status.
5. **Publish Terms of Service v4:** `scripts/prod-publish-buyer-terms-version.js` (dry run), then `--apply`.
   Do this right after the deploy: the new /terms.html shows the current version from the database.
6. **Verify on production:** /terms.html and /buyer-terms.html show v4; registration shows the unchecked terms box;
   the FAQ, Professional Sellers page and Seller Demo show 5% / 9% and 4% + 3%; an admin who is not the owner gets
   "Only the platform owner can make this change." on a pricing change; Admin > Agreements preview of v4 shows no `**`.
7. **Baseline record:** git tag `baseline-2026-11`, Neon branch `baseline-2026-11`, and the baseline document
   (commit, migrations, backup, agreement versions, fees, switches, disabled features, known issues).

## Rollback

- Code: revert the merge commit on main and push (auto-deploys the previous code).
- 226: re-insert the four rows (Reverse section in the migration file).
- 222 / 223: additive; the previous code ignores them. Drop only if required (Reverse sections in each file).
- Terms v4: publish the previous text as a new version (history is never rewritten; acceptances of v4 stay recorded).
- Full restore: the Neon backup branch from step 1.

## Owner decisions before deploy

1. Which account is the platform owner (the active production admin accounts are admin@advantage.bid and
   tylerwitt2015@gmail.com).
2. Owner notice email addresses: seeded as tylerwitt@gmail.com and advantageauction.bid@gmail.com as instructed; the
   production admin account is tylerwitt2015@gmail.com. Confirm.
3. Premium and Signature packages are blocked (their v1 lists paid advertising as optional extras). Sell them now only
   via new versions without the paid extras.
4. Publishing Terms v4 asks every buyer to accept again at their next registration, bid or storefront purchase.
5. Sasha will state the standard rates (4% + 3%; 5% / 9%) and stop all sales talk with buyers and individuals.
6. A Professional Seller with only live storefront items counts as activated (onboarding check-ins stop).
7. Public pages now state the standard 4% + 3% (your 2026-11-06 instruction replaces the 2026-09-27
   "no standard % advertised" rule).

## Known issues not fixed here

- `paidCostIngestionService` measurement status writes and `bidder_phone.required_since` still write settings without an
  audit row.
- Event Partner invitations have no unsubscribe link (postal address added).
- Package v1 deliverable keys `dedicated_email` and `homepage_module` do not match the feature catalog. No purchases
  exist (production audit 2026-11-07: 0 package or promotion purchases), so nothing is affected yet.
- Seller Agreement §7.6 says ACH only while the payout page offers checks; §11.2 liability cap may be $0 for individuals
  (owner/counsel decisions, docs/legal/pre-counsel-publication-record.md).
- Two local-only test failures on Windows (line endings in migration 158; a timing test under load); both pass in CI.

# Paid advertising: resume and run a monthly campaign (owner runbook)

Owner decision 2026-11-06. Paid advertising is preserved and resumable. Every campaign now needs an explicit,
written owner authorization before anything can be built, created or activated at Meta. This runbook is the exact
order of steps. Nothing here is automatic.

## One-time setup at deploy

1. Apply migrations in order (production guard, each with `--check`, then `--dry-run`, then apply):
   - `railway run node scripts/prod-migrate-222.js --check` (owner designation, setting audit, owner notice addresses)
   - `railway run node scripts/prod-migrate-223.js --check` (campaign authorizations, campaign attribution columns)
2. Designate the platform owner (one active admin account):
   `railway run node scripts/prod-set-platform-owner.js --email=<owner email>` (dry run), then add `--apply`.
   Until this is done every sensitive setting change and every authorization is refused (fail closed). Stopping
   spend (pause, stop, emergency stop) keeps working for every admin.
3. Confirm the owner notice addresses in Admin (platform setting `owner.notify_emails`, owner only).

## Each campaign

1. **Prepare.** The Marketing Director (or a script) prepares the campaign record and its audience experiment as today
   (`prepareCampaign`, `planExperiment`). Use a NEW campaign key and experiment key each month
   (for example `2026-12-individual-seller-houston` / `EXP-IS-HOU-2026-12`): provider objects are keyed, so a new key
   is what gives the new month new ad sets carrying the new authorized end date.
2. **Approve creative.** Admin, Marketing Agency, Production creative: **Approve** the exact asset (owner only). The
   creative package's words must also be Owner-approved (`marketing_creative_packages.approval_state`).
3. **Authorize.** Admin, Marketing Agency, Owner authorizations: **Authorize Campaign** with
   - the campaign key, channel (Meta), market key,
   - the most it may be given (must fit the per-campaign and monthly ceilings),
   - start and end (the ad sets are scheduled to end at the authorized end, so delivery stops at the provider),
   - the one approved creative, and optionally the creative package.
   The owner receives an email and a text. One open authorization per campaign; revoke it to change it.
4. **Open the gates** (owner only, platform settings): `marketing.paid.execution_enabled`, the channel gate
   `marketing.destinations.meta_ads_enabled`, `marketing.paid_growth.mode` = `live`, and clear the kill switch
   (Marketing Agency, **Clear Kill Switch**). Each change is audited and notifies the owner.
5. **Build (paused).** Run the build for the experiment (`metaDeliveryService.buildExperimentHierarchy`, or the script
   for that campaign with `--create`). The build refuses unless the authorization covers the amount, dates and creative,
   reserves the campaign's budget in the ledger itself, links the campaign to the authorization, and marks the
   campaign `auto_stop_at_authorization` (it pauses itself when provider spend reaches the authorization). Everything
   is created PAUSED.
6. **Verify.** Read every object back (`--verify` in the campaign script) and check the Marketing Agency delivery panel:
   account, geography, audience, creative, destination, attribution, budgets, schedule end.
7. **Activate.** `--activate` (or `activateExperiment`). It refuses unless the authorization still covers the campaign,
   the creative actually built is the authorized creative, and every ad set ends inside the authorized window.
   Activation **consumes** the authorization: resuming later needs a new one.
8. **Monitor.** Marketing Agency: spend control (re-read spend), the monthly paid report, the campaigns table. The
   hourly spend sync reconciles the ledger; a ceiling breach pauses all delivery automatically.
9. **Stop.** Any admin: Pause / Stop per campaign, or **Emergency Stop** for everything. The emergency stop also asks
   Meta about every campaign we created that our records consider finished and pauses any still active there. Clearing
   it afterwards is the owner's decision.

## What is refused, and why

| Attempt | Refused because |
|---|---|
| Build or create without an open authorization | no owner authorization for the campaign |
| Campaign budget or arm allocation above the authorized amount | exceeds the authorization |
| A creative or package other than the authorized one | creative differs from the authorization |
| Schedule ending after the authorized end | delivery must end by the authorized end |
| Activate after the authorization expired, was revoked or was used | no open owner authorization |
| An ad set built without an end date (older builds) | rebuild it under the current authorization (new keys) |
| A non-owner authorizing, approving creative, changing spend settings or clearing the kill switch | platform owner only |

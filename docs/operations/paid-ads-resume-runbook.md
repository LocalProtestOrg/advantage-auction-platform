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

## Known limitation: the emergency stop was tested only against simulated Meta responses

The emergency stop's new step (ask Meta about every campaign we created that our records consider finished, and pause
any still running there or whose status cannot be read) was tested with the Meta provider **mocked**
(`tests/paid-authorization-safeguards.test.js`). It has **not** been run against the real Meta account. Do not trigger
the emergency stop against existing campaigns merely as a test without the owner's approval.

## Before resuming live advertising: controlled zero-spend verification (owner approval for each stage)

Nothing in these stages activates delivery or creates spend. Run them in order; stop at the first problem.

1. **Read-only account check.** Admin, Marketing Agency, spend control: **Re-read spend** (`POST /spend/sync`, read-only at
   Meta). Confirms the access token, the ad account, the account currency and time zone, and that this month's provider
   spend matches the ledger. Writes only our own reconciliation record.
2. **Read-only status of historical campaigns.** The Marketing Agency campaigns table and delivery panel read each
   campaign's status from Meta (Sept 2026: three campaigns, ended 9/30). Every one must read as not delivering. This is
   exactly what the emergency stop reads first, so it also checks that read path, without pausing anything.
3. **Chain certification (writes paused objects; needs the owner's explicit go-ahead).**
   `railway run node scripts/certify-meta-chain.js` validates the campaign and creative with Meta's validate-only mode,
   creates the minimum PAUSED ad set and ad needed to validate them (a spend cap is set and nothing is ever active),
   reads every object back, then deletes them. Zero impressions, zero spend.
4. **Emergency stop rehearsal (optional; needs the owner's explicit go-ahead).** Only against the paused certification
   artifacts from stage 3 run with `--keep`, never against historical campaigns: engage the stop, confirm the artifacts
   read back PAUSED, then clear the stop (owner only) and delete the artifacts.

Only after these stages pass does the owner authorize a real campaign (section "Each campaign").

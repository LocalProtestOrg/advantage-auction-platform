# SOP: Staging Signoff — Governance Regression Gate

*Release-gating validation for moderation, governance, audit, and seller-suspension changes. Runs the `governance-regression.spec.js` Playwright suite against staging and produces a structured `governance-summary.json` signoff receipt.*

**Spec:** `e2e/governance-regression.spec.js`
**Aliases:** `npm run test:governance` or `npm run test:release`
**Runtime:** ~55 seconds (35 tests, chromium only)
**Pass criteria:** 35/35 pass, `governance-summary.json` `"overall": "pass"`

---

## When to run

Run before any deploy that touches:

- `src/routes/admin.js` — admin endpoints, especially moderation actions
- `src/routes/sellers.js` — seller-facing audit endpoint (AUD-EXP)
- `src/routes/auth.js` — suspension / login gating (OPS-3)
- `src/services/auctionService.js` — INT-2 audit retrofit lives here
- `src/lib/auditLog.js` — shared audit writer
- `db/migrations/*` involving `auctions.state` CHECK, `notifications_queue` CHECK, audit columns
- `public/admin/moderation.html` — admin moderation UI
- `public/seller-dashboard.html` — seller revision + rejected banners
- `e2e/governance-regression.spec.js` — the spec itself

Also run:

- As a routine spot-check before a longer staging session
- Before any production release tag (`vX.Y.Z`)
- When in doubt about whether a change is governance-adjacent — running the suite costs <1 minute and removes the doubt

**Not for:** lot auto-close validation (use the manual test plan), financial regression (covered when `financial-regression.spec.js` lands), or real-user pilot work (`docs/sop-pilot-validation.md`).

---

## Pre-flight

Before running, confirm three things in your shell:

1. **Working tree is the candidate release commit.**
   `git status` shows clean (or only documentation working changes). `git rev-parse HEAD` matches what you intend to deploy.

2. **BASE_URL points at staging.**
   ```powershell
   $env:BASE_URL = "https://advantage-staging-production.up.railway.app"
   ```
   The spec refuses to run if `BASE_URL` does not contain the substring `staging`. This is a deliberate positive-whitelist guard against accidentally pointing at production.

3. **Staging is up.**
   ```powershell
   Invoke-RestMethod -Uri "$env:BASE_URL/api/health" -TimeoutSec 10
   ```
   Expect `{ status: "ok" }`. If staging is down or cold-starting, wait or trigger a deploy before running — a flaky run obscures real failures.

### Optional: enable `VERIFIED-DB` mode

The spec has two notification-verification modes:

- **`INFERRED-AUDIT`** (default when `STAGING_DATABASE_URL` is unset): the suite verifies that the `audit_log` row was written by the GOV-RET / GOV-REJ endpoints. Because those endpoints insert into `audit_log` and `notifications_queue` inside the same transaction, audit presence implies queue presence. Strong inference, fast, no DB credential needed.
- **`VERIFIED-DB`** (when `STAGING_DATABASE_URL` is set): the suite ALSO queries `notifications_queue` directly to verify the row exists with the expected payload.

Use `VERIFIED-DB` when:

- A change touched `notifications_queue` migrations, the CHECK constraint, or the worker.
- You want the strongest possible assertion for a release-critical tag.

To enable, set `STAGING_DATABASE_URL` in the current PowerShell session **only**:

```powershell
$env:STAGING_DATABASE_URL = "<staging-neon-branch-url>"
```

After the run, clear it:
```powershell
Remove-Item Env:STAGING_DATABASE_URL
```

**Never** use `DATABASE_URL` for this purpose. The suite explicitly refuses to read `DATABASE_URL` — that variable is conventionally populated by dotenv from `.env`, which points at production. The `STAGING_DATABASE_URL` name is distinct on purpose.

---

## Procedure

```powershell
$env:BASE_URL = "https://advantage-staging-production.up.railway.app"
# Optional: $env:STAGING_DATABASE_URL = "<staging-neon-url>"
npm run test:governance
```

Equivalent (without the alias):
```powershell
npx playwright test e2e/governance-regression.spec.js --project=chromium
```

### Expected output

Console summary block at the end:

```
─────────────────────────────────────────────────────
GOVERNANCE REGRESSION SUMMARY
─────────────────────────────────────────────────────
Staging base URL : https://advantage-staging-production.up.railway.app
Test auction     : <uuid>
Seller           : pilot-seller2@advantage.bid
Admin            : validation-admin@advantage.bid

INT-2 audit retrofit            : PASS
GOV-RET return-to-draft         : PASS
GOV-REJ reject                  : PASS
AUD-EXP seller audit endpoint   : PASS
AUD-EXP admin audit timeline    : PASS
OPS-3 suspension                : PASS

Notifications queue           : INFERRED-AUDIT | VERIFIED-DB
Overall                       : PASS
─────────────────────────────────────────────────────
```

Followed by:

```
Wrote governance summary: C:\...\governance-summary.json
35 passed (NNs)
```

A pass means: signoff achieved. Proceed to deploy.

### On failure

1. **Do not deploy.**
2. Open `playwright-report/index.html` in a browser. The failure context, test source, and diagnostic trace are inline.
3. Identify whether the failure is a spec defect, environment issue, or actual platform defect (see the classification framework in chat history if needed).
4. Fix and re-run before resuming the deploy.

---

## Post-run review

### Signoff receipt — `governance-summary.json`

Produced fresh per run at the repo root. Structure:

```json
{
  "started_at": "...",
  "finished_at": "...",
  "staging_base_url": "https://advantage-staging-production.up.railway.app",
  "staging_database_url_present": true | false,
  "test_seller": "pilot-seller2@advantage.bid",
  "test_admin": "validation-admin@advantage.bid",
  "notification_verification": "VERIFIED-DB" | "INFERRED-AUDIT",
  "results": {
    "INT-2 audit retrofit": "pass",
    "GOV-RET return-to-draft": "pass",
    "GOV-REJ reject": "pass",
    "AUD-EXP seller audit endpoint": "pass",
    "AUD-EXP admin audit timeline": "pass",
    "OPS-3 suspension": "pass"
  },
  "notes": [...],
  "auction_id": "<uuid>",
  "overall": "pass"
}
```

This file is the signoff receipt. **Do not commit it to source control** — it is `.gitignore`d. Instead:

- **Pilot phase**: paste the JSON into the deploy commit message body OR attach it to the GitHub release notes when cutting a `vX.Y.Z` tag.
- **Post-pilot phase**: when a CI gate is later added (Phase 3 of the operationalization plan), the runner will upload it as an artifact automatically.

### Cleanup of residual staging state — current pilot policy

The suite leaves **one test auction on staging** per successful run, in terminal `rejected` state.

**Current policy (pilot phase): preserve.** Test auctions remain on staging for operator inspection and troubleshooting. They are:

- Invisible to public discovery (filtered by positive whitelist on auction state).
- Visible only on `pilot-seller2`'s dashboard (with the red rejected banner) and in the admin moderation Auctions tab under the `Rejected` filter chip.
- Titled `Governance Regression <timestamp>` for easy identification.
- Harmless to leave indefinitely.

To clean up manually, an admin can:

- Use the admin moderation UI's DELETE control on the rejected auction.
- Or `DELETE /api/auctions/:id` with an admin JWT (admin bypasses the strict-delete rule).

`CLEANUP_TEST_AUCTIONS=true` is supported as an opt-in env flag — when set, the spec's `afterAll` deletes the test auction via the admin DELETE endpoint. **Not recommended during pilot** — preservation supports troubleshooting. Revisit after pilot.

The seller (`pilot-seller2`) is **always** restored to active by `afterAll`, regardless of suspension test outcome. The unsuspend safety net is idempotent and runs even when the suite aborts mid-Phase 11.

---

## What this SOP does NOT cover

- **Lot auto-close validation (INT-1)** — requires real-time scheduler ticks over multiple minutes. Use the manual test plan from the chat session (Lot Auto Close Paths A–D).
- **Financial regression** — payment intent creation, charge, refund, payout. Will be covered by `financial-regression.spec.js` when authored. Track separately.
- **Real-user pilot work** — covered by `docs/sop-pilot-validation.md`. The governance gate is a prerequisite of that pilot, not a replacement.
- **Bidding regression (anti-snipe, proxy bidding)** — will be covered by `bidding-regression.spec.js` when authored.
- **Discovery, ranking, search** — will be covered by `discovery-regression.spec.js` when authored.
- **Production deploy mechanics** — see `docs/deployment-readiness.md`.

---

## Coordination

- **`docs/deployment-readiness.md`** — its "Before Pilot Go-Live" checklist references this SOP as a required step before any production deploy.
- **`docs/sop-pilot-validation.md`** — references this SOP as a prerequisite before pilot kickoff.
- **Project memory** — `governance-regression.spec.js` is the documented release-gating tool for moderation/governance changes. See `project_validation_identities.md` for the seeded credentials the suite uses.

---

## Future regression-pack structure

The governance suite is the first member of a planned `*-regression.spec.js` family. As additional members are authored, the `npm run test:release` script should be updated to glob:

```json
"test:release": "playwright test e2e/*-regression.spec.js --project=chromium"
```

Until that happens, `test:release` is an alias for `test:governance` — same single spec, same single signoff.

Anticipated future members (none authored yet):

- `financial-regression.spec.js`
- `bidding-regression.spec.js`
- `discovery-regression.spec.js`
- `identity-regression.spec.js`

Each will be authored when the corresponding feature commit lands and gating becomes valuable.

---

## Review protocol

After running, paste to Claude (when requesting review or before deploy authorization):

1. The console summary block (the `─────` block at the end).
2. The contents of `governance-summary.json`.
3. Any failures (with the test name and the assertion error from `playwright-report`).

Claude responds with: pass/fail confirmation, defect classification (spec / environment / platform) if anything failed, and explicit "OK to deploy" if all areas pass.

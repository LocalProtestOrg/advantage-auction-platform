> ⛔ **SUPERSEDED (2026-06-01) — historical reference only.** Postmark was abandoned (account rejected); the platform is migrating to **Amazon SES (SMTP mode)**. **Do not use this document for current email setup or validation.** Current source of truth: `docs/postmark-to-ses-migration-plan.md`, `docs/aws-ses-onboarding-checklist.md`, `docs/postmark-to-ses-phase1-emailservice-spec.md`.

# SOP: Postmark Transactional-Email Validation

*One-shot smoke-test utility for the platform's Postmark integration. Reusable for future deliverability validation (new sender signatures, DNS changes, account-reputation reviews).*

**Script:** `scripts/send-postmark-validation-email.js`
**Transport:** `src/services/emailService.js` (existing Postmark HTTP transport — no duplicate transport logic)
**Related:** `docs/sop-postmark-dkim-remediation.md` (DKIM history, resolved 2026-05-15)

---

## When to run

- Postmark requests evidence of legitimate transactional usage
- After adding a new sender signature in Postmark Dashboard
- After DNS changes that could affect deliverability (DKIM, SPF, DMARC, Return-Path)
- Before a pilot/production rollout where email is on the critical path
- As a "did anything break?" probe after dependency upgrades

**Not for:** bulk testing, deliverability A/B testing, or marketing-content review. This is a single transactional probe.

---

## Operational note — current sender-authentication state

*Captured at the time of this SOP's creation. Re-verify in Postmark Dashboard before each run.*

| Signal | Current operator-observed status | Notes |
|---|---|---|
| **Return-Path** | ✅ Verified | `pm-bounces.advantage.bid` MX → Postmark bounce handlers — confirmed via the prior remediation (see `docs/sop-postmark-dkim-remediation.md`) |
| **DKIM** | ⚠️ **Pending** (operator-reported) | Despite the 2026-05-15 remediation closing the `advantage.bid` apex DKIM issue, the operator currently observes DKIM as not fully verified for the sender signature in use. Treat as unverified until the Postmark Dashboard shows a green checkmark on the signature. |
| **SPF** | ✅ Verified (per prior remediation) | `include:spf.mtasv.net` |
| **DMARC** | ✅ `p=none` monitoring | Not enforcing yet |

### Deliverability risk if DKIM remains unverified

A sender with verified Return-Path but unverified DKIM will:
- Send successfully through Postmark (the API will not reject the message)
- Risk being placed in spam by Gmail, Outlook, and other major receivers — they treat DKIM as a strong authenticity signal
- Risk reputation degradation on the `advantage.bid` domain if recipients mark messages as spam
- Risk `p=quarantine`/`p=reject` policies on receiver-side DMARC if/when the operator hardens DMARC

**This is not a blocker for the validation send itself.** The script will work and Postmark will accept the message. But the probe email may land in spam at the recipient, which is itself a useful signal during pilot validation.

### Recommendation — parallel DNS troubleshooting

Continue troubleshooting DKIM **in parallel** with the rest of the pilot work:

1. In Postmark Dashboard → Sender Signatures (or Domains), inspect the current signature/domain in use.
2. Compare the DKIM selector Postmark expects to what is currently published in DNS.
3. Re-run the verification snippet in `docs/sop-postmark-dkim-remediation.md` → "Verification procedure".
4. If selector mismatch, update DNS to match Postmark's current selector (the prior remediation taught us cPanel Zone Editor can silently truncate or store literal quote chars — re-check those failure modes).
5. Capture all four resolver responses; pass criteria is `DER=294B` on all four.

**This work does NOT block:**
- Validation-email preparation (the script is ready now)
- Pilot planning (`docs/sop-pilot-validation.md`)
- §E staging validation work (`docs/sop-staging-validation-e.md`)

---

## Pre-flight (on the staging server, before running the script)

1. **Confirm staging identity:**
   ```bash
   echo "NODE_ENV=$NODE_ENV"
   node -e "require('dotenv').config(); console.log('SMTP_PASS set:', process.env.SMTP_PASS ? 'yes' : 'no');"
   ```
   Expect: `NODE_ENV=staging` (or your staging marker) and `SMTP_PASS set: yes`.

2. **Confirm sender signature in Postmark Dashboard:**
   - Open Postmark → Sender Signatures (or Domains).
   - Locate the sender you intend to use (e.g., `info@advantage.bid`).
   - Green checkmark on **Return-Path** is required for sending at all.
   - Green checkmark on **DKIM** is recommended; if pending, the send still works but may be flagged spam at the receiver (see operational note above).
   - If neither is verified, **stop** and verify the signature first.

3. **Choose recipient address.** Must be one you can monitor for receipt timing and spam-folder placement.

---

## Execution

### Standard invocation (single send)

```bash
EMAIL_FROM=info@advantage.bid \
POSTMARK_VALIDATION_RECIPIENT=advantageauction.bid@gmail.com \
node scripts/send-postmark-validation-email.js
```

### Using the existing default sender (skip From override)

If `info@advantage.bid` isn't ready and the staging env already has `EMAIL_FROM` set to a verified default:

```bash
EMAIL_FROM=$(node -e "require('dotenv').config(); console.log(process.env.EMAIL_FROM)") \
POSTMARK_VALIDATION_RECIPIENT=advantageauction.bid@gmail.com \
node scripts/send-postmark-validation-email.js
```

(The script's strict-EMAIL_FROM check requires you to pass it explicitly even if it's already in the env. This is intentional: every invocation declares the sender on the command line for auditability.)

### Re-send after a fix (rare; requires explicit force)

If the first attempt failed and you've applied a Postmark-side fix (e.g., verified the sender signature), re-run with `--force` to bypass the sentinel:

```bash
EMAIL_FROM=info@advantage.bid \
POSTMARK_VALIDATION_RECIPIENT=advantageauction.bid@gmail.com \
node scripts/send-postmark-validation-email.js --force
```

---

## Expected success output

```
[postmark-validation] preflight passed
  Started at       : 2026-05-20T15:42:00.123Z
  NODE_ENV         : staging
  EMAIL_FROM       : info@advantage.bid
  EMAIL_REPLY_TO   : (default: advantageauction.bid@gmail.com)
  SMTP_PASS set    : yes (length=36)
  Recipient        : advantageauction.bid@gmail.com
  Subject          : Advantage Auction Platform Transactional Email Test
  Force flag       : no

[postmark-validation] sending …
[email] Sent "Advantage Auction Platform Transactional Email Test" to advantageauction.bid@gmail.com — messageId: <uuid>

[postmark-validation] SUCCESS
  Postmark accepted  : yes (HTTP 200)
  MessageID          : <uuid>
  Recipient          : advantageauction.bid@gmail.com
  Sender             : info@advantage.bid
  Started at         : 2026-05-20T15:42:00.123Z
  Finished at        : 2026-05-20T15:42:00.876Z
  Elapsed (ms)       : 753
  Sentinel written   : /tmp/advantage-postmark-validation.sent

Next steps:
  1. Postmark Dashboard → Activity → search this MessageID;
     confirm status is "Sent" (or progresses to "Delivered").
  2. Check the recipient inbox; capture timing if relevant.
  3. If sharing evidence with Postmark support, the MessageID
     above is the canonical reference.
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success — Postmark accepted; MessageID printed |
| `1` | Precondition failed (env var unset, malformed address, sentinel exists without `--force`) — **no Postmark call was made** |
| `2` | Postmark API rejected the send — error code + message printed; consult Troubleshooting below |
| `3` | Unexpected error (network failure, etc.) |

---

## Capture (for sharing with Postmark or recording in the validation log)

After a successful send, record:

1. **Environment** — the three-line preflight output (`NODE_ENV`, `EMAIL_FROM`, `SMTP_PASS set: yes/no`)
2. **MessageID** — the printed UUID
3. **Postmark Activity status** — Dashboard → Activity → status field (`Sent` / `Delivered` / `Bounced` / etc.)
4. **Inbox confirmation** — timing of inbox arrival; folder placement (inbox vs spam)
5. **Headers from the received email** — useful evidence of DKIM/SPF/DMARC results at the receiver

---

## Troubleshooting reference

### `SMTP_PASS is not set in the environment`

| Cause | Fix |
|---|---|
| Running from local dev shell that doesn't have the Postmark token | Move to the staging server, or set `SMTP_PASS` explicitly for the single command (least preferred — token transits shell history) |
| Token rotated and `.env` not updated | Pull the latest Postmark Server API Token from Postmark Dashboard → Servers → API Tokens; update env |

### `EMAIL_FROM is not set` / `POSTMARK_VALIDATION_RECIPIENT is not set`

| Cause | Fix |
|---|---|
| The strict-mode check requires both env vars on every invocation | Pass both on the command line as shown in §Execution |

### Sender-signature failure — `Postmark code 412 "The 'From' address … is not a Sender Signature"`

| Cause | Fix |
|---|---|
| `info@advantage.bid` is not verified in the Postmark server you're sending from | Postmark Dashboard → Sender Signatures → add and verify `info@advantage.bid` OR verify the `advantage.bid` domain (covers any address on it) |
| The `SMTP_PASS` you're using belongs to a different Postmark server than the sender | Use the API token from the Postmark server that owns the sender signature; tokens are per-server, not per-account |

### DKIM failure (received but flagged as failed-DKIM at the receiver)

The send succeeds — Postmark accepts the message — but the **receiver** (Gmail, Outlook, etc.) flags it as DKIM-failed and may route to spam or reject.

| Diagnostic | Where to look |
|---|---|
| Postmark's DKIM status for the sender signature | Postmark Dashboard → Sender Signatures → the row → DKIM column |
| DNS-published DKIM selector content | Run the verification snippet in `docs/sop-postmark-dkim-remediation.md` |
| Receiver-side DKIM verdict | Inspect the received email's full headers — look for `Authentication-Results: ... dkim=pass/fail/none` |

| Cause | Fix |
|---|---|
| DKIM selector in DNS doesn't match what Postmark expects | Postmark Dashboard shows the expected selector + value; update DNS to match. Re-run the verification snippet from the DKIM remediation SOP. |
| DKIM TXT record was truncated at 255 chars (cPanel Zone Editor pitfall) | See `docs/sop-postmark-dkim-remediation.md` → Root cause 3 |
| DKIM TXT record contains literal `"` chars from cPanel storage | See `docs/sop-postmark-dkim-remediation.md` → Root cause 4 |
| DNS propagation delay | DKIM TXT changes can take up to 24h to propagate; check across multiple resolvers per the verification snippet |

### `Postmark API error 401`

| Cause | Fix |
|---|---|
| `SMTP_PASS` token is invalid, revoked, or expired | Postmark Dashboard → Servers → API Tokens → generate new token; update env; re-run |
| Token belongs to a different Postmark account or environment | Verify token-to-server mapping in Dashboard; use the correct token |

### `Postmark API error 422` (validation error — generic)

| Code | Meaning | Fix |
|---|---|---|
| 406 | "Inactive recipient" — recipient is on suppression list (prior bounce / complaint / unsubscribe) | Dashboard → Suppressions → remove the address if intentional; then re-run with `--force` |
| 412 | Sender signature not verified | See above |
| 422 (generic) | Other field-level rejection — body too large, invalid HTML, etc. | Check error message text printed by the script |

### `Postmark API error 405 "Account is pending approval"` / similar deactivated states

| Cause | Fix |
|---|---|
| Postmark account is under review (new-account hold, sudden volume spike, reputation issue) | Contact Postmark support directly. The validation email scenario itself is often the evidence Postmark wants — provide the script source + intended use case + this SOP as context. |
| Server has been deactivated | Dashboard → Servers; reactivate or open a new server if needed |

### Unexpected exit code 3

| Cause | Fix |
|---|---|
| Network failure mid-request | Re-run with `--force` after confirming the staging host can reach `api.postmarkapp.com:443` |
| Crash in the emailService transport | Capture the stack trace; investigate the service. Should not happen under normal operation. |

---

## What this script does NOT do

- ❌ Does not bypass Postmark's API to "force-send" anything
- ❌ Does not modify any DNS records
- ❌ Does not modify any Postmark account settings
- ❌ Does not log the Postmark API token
- ❌ Does not send to multiple recipients
- ❌ Does not enable bulk testing
- ❌ Does not change global `EMAIL_FROM` for the running application — the override is per-invocation only

---

## Standing by

The script is in place; nothing has been sent. Operator runs it on staging per §Execution, captures per §Capture, and pastes results back for review. We remain in controlled operational validation mode.

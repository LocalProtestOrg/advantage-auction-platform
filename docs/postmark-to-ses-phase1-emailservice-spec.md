# Phase 1 Implementation Spec — `emailService.js` → nodemailer over SES SMTP

*Planning only. No code implemented. Defines the exact, behavior-preserving rewrite of the **internals** of `src/services/emailService.js`. The public surface (`sendEmail` signature, return shape, throw-on-failure, skip-safe, exports) is unchanged → **zero caller changes, zero template changes.***

## 1. Target file (only file changed in Phase 1)
- **`src/services/emailService.js`** — replace the Postmark HTTPS call with a nodemailer SES-SMTP transport. No other source file changes. The two existing nodemailer senders (`operationalCloseEmailService.js`, `pdfGenerationService.js`) are env-only (not part of Phase 1 code).

## 2. Current behavior to preserve (contract — must not change)
| Contract | Current | Phase 1 (preserved) |
|---|---|---|
| Signature | `sendEmail({ to, subject, html, text })` | identical |
| From resolution | `process.env.EMAIL_FROM \|\| SMTP_FROM \|\| SMTP_USER \|\| 'noreply@advantageauction.bid'` | **identical** ⚠️ see §2a |
| Reply-To | `EMAIL_REPLY_TO` (default `'advantageauction.bid@gmail.com'`) | identical → nodemailer `replyTo` |
| Skip-safe when unconfigured | `if (!SMTP_PASS) → { skipped: true }` (warn, no throw) | preserved + widened to also require `SMTP_HOST`/`SMTP_USER` (still returns `{ skipped:true }`, never throws) |
| Success return | `{ messageId }` | `{ messageId: info.messageId }` |
| Skip return | `{ skipped: true }` | identical |
| Failure | **throws** an `Error` (so callers/worker retry) | preserved — `transporter.sendMail` rejection is rethrown |
| `text` handling | included only when provided | identical (`...(text ? { text } : {})`) |
| `html` support | required body | identical (nodemailer `html`) |
| Logging prefix/shape | `[email] Sent "<subj>" to <to> — messageId: …` / `[email] Delivery failed for <to> — …` / warn-and-skip | preserved (Postmark-specific wording dropped) |
| Exports | `module.exports = { sendEmail }` | identical |
| `require('dotenv').config()` | present | kept |

### 2a. ⚠️ From-fallback nuance under SES (behavior-preserving but flagged)
The From chain ends in `SMTP_USER`. Under Postmark, `SMTP_USER` was the token (not an email) and prod always set `EMAIL_FROM`. Under **SES, `SMTP_USER` is the SES SMTP username** (e.g. `AKIA…`, not an email). The fallback chain is **preserved unchanged**, but Phase 1 adds a **one-time startup warning** if the resolved From is not a plausible `@advantage.bid` address, and acceptance requires `EMAIL_FROM` (or `SMTP_FROM`) to be a **verified `@advantage.bid` sender** (SES rejects unverified/From-mismatch). No behavior change; just a guard + a hard config requirement.

## 3. New implementation approach (intended structure — illustrative, NOT yet written)
```
'use strict';
require('dotenv').config();
const nodemailer = require('nodemailer');

const { SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM,
        SMTP_PORT, SMTP_SECURE,
        EMAIL_REPLY_TO = 'advantageauction.bid@gmail.com' } = process.env;

const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_FROM || SMTP_USER || 'noreply@advantageauction.bid';

function isConfigured() { return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS); }

let _transporter = null;            // lazy singleton (reuse connection settings)
function getTransporter() {
  if (_transporter) return _transporter;
  const port   = parseInt(SMTP_PORT || '587', 10);
  const secure = SMTP_SECURE === 'true' || SMTP_SECURE === '1' || port === 465; // 587 → false (STARTTLS)
  _transporter = nodemailer.createTransport({
    host: SMTP_HOST, port, secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000,
  });
  return _transporter;
}

async function sendEmail({ to, subject, html, text }) {
  if (!isConfigured()) {
    console.warn('[email] SMTP/SES not configured — skipping delivery to', to);
    return { skipped: true };
  }
  try {
    const info = await getTransporter().sendMail({
      from: EMAIL_FROM, to, subject, html,
      ...(text ? { text } : {}),
      replyTo: EMAIL_REPLY_TO,
    });
    console.log(`[email] Sent "${subject}" to ${to} — messageId: ${info.messageId}`);
    return { messageId: info.messageId };
  } catch (err) {
    console.error(`[email] Delivery failed for ${to} — ${err.message}`);
    if (err.responseCode) err.statusCode = err.responseCode; // analog of the old Postmark err.statusCode
    throw err;
  }
}

module.exports = { sendEmail };
```
Notes: single transporter reused; `secure:false` on 587 (STARTTLS) per SES; no Postmark header/`MessageStream`; attachments are **not** introduced in Phase 1 (the two nodemailer senders keep their own paths). Optional (deferred): `pool:true` for throughput, `transporter.verify()` on boot.

## 4. Required environment variables
| Var | Phase 1 value | Notes |
|---|---|---|
| `SMTP_HOST` | `email-smtp.us-east-1.amazonaws.com` | SES SMTP endpoint (region-specific) |
| `SMTP_PORT` | `587` | STARTTLS |
| `SMTP_SECURE` | `false` | true only on 465 |
| `SMTP_USER` | SES SMTP **username** | from SES "Create SMTP credentials" |
| `SMTP_PASS` | SES SMTP **password** | secret — Railway env only, never committed |
| `EMAIL_FROM` **or** `SMTP_FROM` | **`notifications@advantage.bid`** (preferred primary sender) | **required** under SES; any `@advantage.bid` address is covered by the verified domain identity (see §2a) |
| `EMAIL_REPLY_TO` | **`info@advantage.bid`** (or `support@advantage.bid`) | preferred reply-to; replaces the legacy gmail default unless constraints require otherwise |
| `PUBLIC_BASE_URL` / `FRONTEND_URL` / `SITE_URL` | prod/staging domain | used by **callers** for links (not emailService) — set so agreement/notification links resolve |

## 5. Validation plan
- **Unit test (new — `tests/emailService.test.js`):** `jest.mock('nodemailer')` to assert, **without sending**: (a) skip-safe returns `{ skipped:true }` and does not call the transport when unconfigured; (b) `sendMail` receives `{ from, to, subject, html, text?, replyTo }` correctly mapped; (c) success returns `{ messageId }`; (d) a transport rejection is **rethrown** (callers can retry). *(No existing email unit test today — this is additive.)*
- **Functional matrix (staging, then prod smoke):**
  1. `POST /api/admin/email/test` → delivered; headers show SPF/DKIM/DMARC = pass.
  2. **Registration / account verification** email.
  3. **Password reset** email.
  4. **Seller agreement** signing-link email (`agreementService`).
  5. **Outbid** notification (`notificationWorker`).
  6. **Winning-bidder** notification.
  7. **Governance notification** (return-to-draft / rejected).
  8. **Operational close** email (`operationalCloseEmailService`, nodemailer/SES).
  9. **Seller final report PDF attachment** (`pdfGenerationService`, nodemailer/SES) — attachment intact.
- **Queue resilience:** confirm `notifications_queue` drains on success and **retries** on a forced failure (no loss).

## 6. Staging rollout
1. Set SES SMTP env (§4) on the **staging** Railway service.
2. Deploy the one-file change to **staging only** (auto-deploy from `deploy/seller-studio-1b`).
3. Run `POST /api/admin/email/test` → confirm delivery.
4. Run the full §5 functional matrix (seeded/internal recipients; clean up).
5. **Inspect received headers** for `spf=pass`, `dkim=pass`, `dmarc=pass`.
6. Confirm SES console shows sends + healthy bounce/complaint rates.

## 7. Production rollout
1. **Preconditions:** SES domain **verified**, **DKIM active**, **production access approved** (out of sandbox), `EMAIL_FROM` is a verified `@advantage.bid` sender, `PUBLIC_BASE_URL` set to the prod domain.
2. Set SES SMTP env on the **prod** service; deploy the one-file change.
3. Smoke test: `/api/admin/email/test` + one of each functional category to an internal address.
4. **Monitor:** Railway logs (`[email] Sent …` / failures) + SES console (delivery, bounce <5%, complaint <0.1%).
5. After stable, remove Postmark DNS leftovers (DKIM TXT, `pm-bounces` CNAME, `spf.mtasv.net`) and decommission the Postmark token.

## 8. Rollback
- **Code:** revert the `emailService.js` commit + redeploy prior build (change is isolated to one file).
- **Queued notifications preserved:** `notifications_queue` + worker retry means a sending outage **queues, doesn't lose** mail; `sendEmail` returns `{ skipped:true }` when unconfigured rather than crashing.
- **Postmark is NOT a viable rollback provider** (account rejected). Fallbacks: **SES config correction** (fix env/credentials/region) or repoint `SMTP_*` at an **alternate SMTP provider** — both are env changes, no redeploy.

## 9. Acceptance criteria (Phase 1 — exact)
- [ ] `sendEmail({ to, subject, html, text })` signature, exports, and `{ messageId }` / `{ skipped:true }` return shapes **unchanged**; **no caller or template edits**.
- [ ] Throws on delivery failure (worker-retry behavior intact); skip-safe (no throw) when `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` missing → `{ skipped:true }`.
- [ ] From resolves to a **verified `@advantage.bid`** address — preferred **`notifications@advantage.bid`**; startup warns if the resolved From is implausible; `EMAIL_REPLY_TO` (preferred **`info@advantage.bid`**) applied.
- [ ] Sends via **SES SMTP** (`email-smtp.us-east-1.amazonaws.com:587`, STARTTLS); no Postmark code/headers remain.
- [ ] `html` and optional `text` both delivered; the **final-report PDF attachment** path still works (via its nodemailer sender on the same SES creds).
- [ ] New unit test passes (mapping, skip, return, rethrow).
- [ ] Staging: all 9 functional emails delivered with **SPF/DKIM/DMARC = pass**; `notifications_queue` drains + retries.
- [ ] No regression in non-email flows; `[email]` log lines present for sends/failures.
- [ ] Prod gated on SES verified + DKIM active + production access + `EMAIL_FROM`/`PUBLIC_BASE_URL` set.

---

*End of Phase 1 spec. No code, env, DNS, or AWS changes performed. Awaiting approval (and SES onboarding completion) before implementation.*

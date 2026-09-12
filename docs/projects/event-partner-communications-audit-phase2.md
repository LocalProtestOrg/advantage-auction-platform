# Event Partner Communications — Phase 2 architecture audit

Internal project documentation. Completed 2026-09-12, after Phase 1 (migration 153, commit `4b3989f`)
was deployed and verified in production. Companion to
`event-partner-communications-requirement.md`, which states the requirement; this document states the
architecture chosen to meet it and the evidence behind it.

Audit only — nothing was sent, configured, or changed while producing it.

## Correction carried forward from the Phase 1 report

The Phase 1 report stated that SPF not authorizing Amazon SES was "a real defect today." That was
wrong, and the record is corrected here.

SES **is** authenticated for `advantage.bid`, via a custom MAIL FROM subdomain:
`bounce.advantage.bid` MX → `feedback-smtp.us-east-1.amazonses.com`, with DKIM-aligned DMARC. This was
proven by a live delivery round-trip on 2026-09-08, and `a7ReadinessService.evaluateSpf` was already
corrected to evaluate the custom MAIL FROM rather than only the root record.

Adding `include:amazonses.com` to the root SPF record is an optional improvement, not a fix. The root
record still lists `sendgrid.net` and `spf.mtasv.net` (Postmark) from earlier providers.

## Measured DNS state (2026-09-12)

| Name | Type | Value | Meaning |
|---|---|---|---|
| `advantage.bid` | MX | `mail.advantage.bid` (pref 0) | Brilliant Directories mailboxes. **Must not change.** |
| `advantage.bid` | TXT | `v=spf1 a mx ip4:66.147.236.122 include:sendgrid.net include:spf.mtasv.net ~all` | No `amazonses` include; SES aligns via MAIL FROM instead |
| `_dmarc.advantage.bid` | TXT | `v=DMARC1; p=none; sp=none; adkim=r; aspf=r; rua=mailto:info@advantage.bid` | Monitoring only |
| `bounce.advantage.bid` | MX | `feedback-smtp.us-east-1.amazonses.com` | SES custom MAIL FROM — already configured |
| `bounce.advantage.bid` | TXT | *(none found)* | SPF TXT for the MAIL FROM subdomain appears missing |
| `reply.advantage.bid` | — | NXDOMAIN | **Free for the inbound namespace** |
| `_amazonses.advantage.bid` | TXT | NXDOMAIN | Verification is via DKIM CNAMEs, not the TXT method |

## 1. Recommended architecture

### Outbound — remain on Amazon SES

Not because SES suits transactional mail, but because the **certified safety spine is already wired
to it**: SNS feedback → `/api/ses/feedback` → `email_suppressions` / `email_deliverability` /
`ses_feedback_events`; a durable idempotent dispatch queue in `marketing_job_queue`; a running
`marketingDispatchWorker`; and per-recipient re-checks at send time. Changing vendor would abandon
proven suppression and split sending reputation across two hosts.

Partner outreach must use a **separate sending identity and its own SES configuration set**, so its
reputation can never damage bid notifications, invoices, or password resets.

### Inbound — the binding constraint

`events@advantage.bid` is an **apex** address, and the apex MX belongs to Brilliant Directories. SES
(or any other provider) cannot receive mail for an apex address without moving that MX record, which
is forbidden. Therefore:

- The **visible identity stays `events@advantage.bid`** in the `From` header. SES can send as it,
  because the domain identity is verified.
- The **machine channel is a per-conversation `Reply-To` on a new subdomain**, `reply.advantage.bid`,
  whose MX points at an inbound-parse provider. The apex is never touched and `info@advantage.bid` is
  unaffected.
- **Safety net:** Brilliant Directories forwards `events@` to the reply subdomain's catch-all, so a
  company that replies to the `From` address is still captured. The BD mailbox stays dormant as a
  pass-through and is never a monitored production inbox. Normal seller and customer inquiries
  continue to `info@advantage.bid`, which the Owner monitors, and are never routed to A15.

### Inbound provider — Postmark Inbound, ahead of SES Receipt Rules

Postmark delivers **parsed JSON** (From, Subject, TextBody, HtmlBody, full Headers, SpamScore,
attachments) plus `MailboxHash`, which is natively the per-conversation token this design needs.

SES Receipt Rules deliver **raw MIME** and would require an S3 bucket, an IAM role, most likely a
Lambda, a MIME parser, management of the 150 KB SNS payload ceiling, and object lifecycle policy —
real surface area to build and own for a low-volume channel. Postmark already appears in the root SPF
record (`spf.mtasv.net`), so the vendor relationship likely pre-exists.

SES inbound remains the single-vendor alternative; choose it only if avoiding a second vendor is worth
that additional build.

### Rejected options

| Option | Why rejected |
|---|---|
| BD IMAP/POP polling | No webhooks; a credential to store; fails both event-driven receipt and machine-readable conversation state. Owner excluded it. |
| MCP / editor connectors | None configured in this environment; an interactive developer session must never be production runtime. |
| SendGrid Inbound Parse | Works, but multipart form rather than JSON, and no equally clean per-conversation hash. Vendor sprawl for no gain. |
| Changing the apex MX | Forbidden — it would break `info@` and every other BD mailbox. |

## 2. Reusable infrastructure

Confirmed present in the repository: `emailDispatchService`, `marketingDispatchWorker`,
`marketingSendService`, `audienceEligibilityService`, `a7ReadinessService`, `sesFeedback` route,
`sesNotificationParser`, `marketingContactService`, `marketingEmailToken`, `marketingQueueService`.
Plus `marketing_job_queue`, `email_suppressions`, `email_deliverability`, `ses_feedback_events`, the
`advantage-bid-marketing` configuration set, and all of Phase 1 — the authorization registry, hashed
single-use tokens, the nine-state machine, claim tokens, host attribution, and the ≥100 performance
service.

Greenfield: inbound receipt and ingestion, thread state, reply classification, the outreach proposal
and approval artifact, listing population from verified data, and the outreach template. Verified by
search: no `mailparser`, no `inbound-smtp`, no `MailboxHash` anywhere in the codebase — inbound is
entirely new.

## 3. Owner configuration eventually required

1. Verify the Event Partner sender identity in SES; create a dedicated configuration set with an SNS
   destination.
2. Create a Postmark server, enable Inbound, and take the inbound MX target and webhook URL.
3. Add DNS for `reply.advantage.bid` **only** — one MX record to the inbound provider. Do not touch
   the apex MX or `mail.advantage.bid`.
4. In Brilliant Directories, forward `events@advantage.bid` to the reply-subdomain catch-all. No
   mailbox monitoring, no password shared.
5. Supply the CAN-SPAM postal address.
6. Approve the pilot cohort explicitly; confirm whether the 336 imported directory contact addresses
   may be used.
7. Optional: add `include:amazonses.com` to the root SPF record and drop the two unused providers;
   add the SPF TXT record on `bounce.advantage.bid` (its MX exists but no TXT was found).

## 4. A15 permission changes

Phase 1 shipped: `draft_partner_outreach`, `propose_partner_outreach`, `read_partner_metrics`, with
publish / spend / review all false.

Phase 2 adds, each separately gated: `classify_inbound_reply` (read-only judgement, no state effect),
`record_reply_thread`, `draft_partner_reply`, then later `send_approved_outreach` (restricted to an
approved cohort and an approved template version) and `send_templated_reply` (fixed templates only).

Never grantable: granting or broadening authorization, changing an authorized domain without
re-authorization, activating collection, granting listing ownership, spending, publishing unrelated
marketing, or answering normal seller/customer service messages.

## 5. Inbound reply decision matrix

| Class | Detection | Automated action | Authorization effect | Escalation |
|---|---|---|---|---|
| HARD BOUNCE | Deterministic (DSN / provider webhook) | Suppress address; mark invitation undeliverable | None | Only if sole contact |
| SOFT BOUNCE | Deterministic (DSN codes) | Retry budget; suppress only at threshold | None | After N failures |
| OUT OF OFFICE | Deterministic (`Auto-Submitted: auto-replied`, `Precedence: auto_reply`, RFC 3834) | Ignore; not a reply; no timer reset | None | None |
| STOP / UNSUBSCRIBE | Deterministic (One-Click header, explicit tokens) | Terminal outreach suppression | **None** — does not revoke an existing authorization | None, logged |
| DECLINE | Keyword + classifier | Set `declined`; stop outreach | Never authorizes | Optional review |
| YES / AFFIRMATIVE | Classifier | **Send or re-send the secure authorization link** | **Never** — a reply cannot authorize | None |
| ALREADY AUTHORIZED | Deterministic (registry state) | Confirm nothing further is needed | None | None |
| CORRECTED WEBSITE | Classifier extracts; deterministic validation | Propose a domain change | None; an authorized company must re-authorize a new domain | **Always admin** |
| WRONG CONTACT | Classifier | Record; do not re-send to the same address | None | Admin |
| QUESTION | Classifier | Templated reply where covered by approved FAQ, else escalate | None | Admin / Owner |
| LEGAL / RIGHTS | Keyword + classifier | No automated reply | None | **Always human** |
| UNKNOWN / HUMAN REQUIRED | Default | No state change | None | Always |

**Governing rule:** classification may only ever move state in the *stopping* direction. Anything
that grants, expands, or re-scopes permission requires the deterministic token flow or explicit human
approval. An affirmative reply is converted into a link, never into authorization, which keeps
authorization deterministic and evidence-backed with no interpretation in the chain.
`authorization_method` stays limited to the four evidence types already in the schema; a classifier
verdict is not one of them and must never become one unless the Owner explicitly adds that evidence
type to the authorization policy.

## 6. Compliance and safety gates

Accurate sender identity and subject line; a real postal address; a working opt-out honored in both
directions; suppression checked at **send time**, not queue time; bounce and complaint handling
through the existing SNS receiver with a complaint-rate halt; per-company and global rate limits; an
append-only audit trail of every message in and out, attributable to company, authorization, agent,
and timestamp.

**Cohort containment** needs a hard technical gate, not policy: an approved-cohort table, and a send
path that refuses any recipient not in a cohort whose approval row exists and is unexpired. Combined
with `event_partners.outreach_enabled`, that is two independent locks.

Event Partner suppression and thread state belong in **their own tables**, bound to the authorization
record. `marketing_contacts.permission_basis` carries a CHECK constraint with no value for legitimate
business-to-business outreach, and its frequency caps were designed for consumer marketing — reusing
it would either misclassify the permission basis or force a CHECK migration, and would contaminate
the consent separation required in Phase 1. Reuse the suppression and deliverability *pipeline*; not
the consumer consent model.

Separation to preserve: outreach unsubscribe, company decline, event-source authorization,
authorization revocation, claim ownership, and seller activation are six distinct records. STOP does
not revoke an authorized source unless the company explicitly asks. Revocation does not imply a
marketing unsubscribe unless requested.

## 7. Proposed state machine

The lifecycle maps onto the nine existing states plus two new artifacts and one gap:

```
prospective
  → site verification recorded on the row
  → [outreach proposal]            (new artifact; approved before sending)
  → invited
  → one-click authorization
  → authorized
  → source validation
  → source_configured
  → collecting
  → events collected + host-attributed        (built in Phase 1)
  → [listing populated]                       (the gap)
  → performance measured                      (built in Phase 1)
  → claim invitation, gated at >= 100         (gate built; email not)
  → secure claim                              (built in Phase 1)
```

The nine states need no change. What is missing is an outreach-proposal artifact, a reply-thread
artifact, and listing population.

## 8. Automated versus human-approved

Safe to automate fully: bounce and complaint handling, out-of-office detection, unsubscribe,
suppression, decline recording, reply threading and classification, re-sending an authorization link
on an affirmative reply, source collection once activated, host attribution from an authorized
source, performance computation, and the ≥100 eligibility decision.

Must require a human: cohort approval, the first send of any template version, any authorized-domain
change, source validation and activation, publishing a populated listing, issuing a claim link,
revocation on anything other than an explicit company request, and every gate flip.

## 9. Phase 2 sequence

1. Inbound transport and receipt — subdomain, provider, webhook, signature verification,
   raw-message archive. No sending.
2. Thread state and deterministic classification — bounces, auto-replies, unsubscribe, keyword
   decline. Still no sending.
3. Cohort approval, template, and the outreach proposal artifact, with the send path gated and
   cohort-bound.
4. Probabilistic classification with escalation, and templated replies.
5. Listing population from verified data, with admin publish.
6. Claim invitation using the existing ≥100 gate.

## 10. Defects and missing foundations found

- **The SEO requirement conflicts with what Phase 1 shipped.** `/authorize-event-promotion.html` is
  `noindex, nofollow`, absent from the sitemap, and linked from nowhere. That was deliberate — it is a
  private credential URL. It cannot also be a search-discoverable entry point. The fix is to split
  them: keep the token page `noindex`, and add a separate indexable acquisition page, registered in
  the curated static list in `server.js` (around line 208), linked from contextual pages such as
  `after-estate-sale.html` and `downsizing-liquidation.html` — and deliberately kept out of
  `public-nav.js` and every Start Selling call-to-action block, so it is never presented as an easier
  alternative to professional seller onboarding.
- **A self-serve entry point must never mint an authorization link on demand.** If a visitor arriving
  from search can request a link for any domain, they can authorize a competitor's website. Some form
  of requester-to-company verification is mandatory before a link is issued. (Owner revision of
  2026-09-12 replaces technical domain-control proof with a lightweight trust ladder; see
  `event-partner-self-service-verification.md`.)
- **SNS message-signature verification is still not implemented** — the feedback receiver is
  shared-secret only. Acceptable for delivery receipts; not acceptable once inbound company
  correspondence flows through the same pattern.
- `marketing_contacts.permission_basis` has no value for business-to-business outreach.
- No SPF TXT record on `bounce.advantage.bid`, although its MX exists.
- `email_suppressions.scope` is free text, so a partner scope needs no migration — but the send path
  must honor both the new scope and the existing `marketing` scope as hard stops.

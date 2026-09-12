# Event Partner Communications — the production requirement (Phase 2 design input)

Status: **requirement only. Nothing in this document is built, configured or activated.**
Written alongside Phase 1 (migration 153) so Phase 2 designs against a stated need rather than
rediscovering it once companies start replying.

## Owner decision that frames everything here

`events@advantage.bid` exists as a Brilliant Directories mailbox and is to be left **completely
dormant**. It is not integrated, not polled, not used as a sender or reply-to, not forwarded, and its
password is neither stored nor requested. The Owner does not want another human-managed inbox.

The long-term intent is that Event Partner correspondence is handled by the Marketing Director's
delegated **A15 Event Partner Outreach** agent — not by a person watching a mailbox.

Phase 1 therefore ships A15 with an identity, a capability definition and audit visibility, and with
no ability to send, publish, spend, authorize a source or grant a claim.

## What a production channel must provide

The requirement is **an agent-manageable, programmatic inbound/outbound channel with event-driven
receipt and machine-readable conversation state.** Concretely:

1. **Event-driven inbound.** An incoming reply must arrive as a delivered event (webhook), not as
   something a process has to go and look for. Polling a mailbox reintroduces exactly the babysitting
   the Owner is removing.
2. **Machine-readable conversation state.** Each message must resolve to a thread, a company, an
   authorization record and a position in the conversation, without a human reading it to work out
   which company it belongs to. That means a routable reply address or token per conversation, and
   durable thread state in our own database.
3. **Outbound on an identity we control.** Reputation, DKIM alignment, suppression and complaint
   handling must all sit with Advantage.Bid.
4. **Isolation from transactional mail.** Partner correspondence must never share a sending identity
   or configuration set with bid notifications, invoices or password resets. A reputation problem in
   one must not be able to damage the other.
5. **Complete audit.** Every inbound and outbound message must be attributable to a company, an
   authorization, an agent and a timestamp.

## What must NOT be relied on

- **The Brilliant Directories mailbox.** It is on a shared host, gives no webhooks, no programmatic
  reply handling and no sending reputation we control. It stays dormant.
- **IMAP/POP polling of anything.** Fails requirements 1 and 2, and creates a credential to store.
- **Desktop or editor tool connectors (MCP).** These are interactive developer sessions. They are not
  production runtime and must never appear in a runtime path.
- **Any sender identity activated without Owner approval.**

## Likely shape (not a decision)

Amazon SES remains the likely outbound provider: it is already the platform's sender, already has
separate transactional and marketing connection pools and configuration sets, and already has a
feedback path (`/api/ses`) for bounces and complaints. The natural inbound design reuses that same
event-driven pattern on a dedicated reply subdomain, so the apex MX — which Brilliant Directories
site mail depends on — is never touched.

**No sender identity is to be created or verified as part of Phase 1.**

## Owner actions this will eventually require

These are listed so they are visible early; none is needed for Phase 1.

1. Verify a dedicated Event Partner sending identity in SES, with DKIM.
2. **Add SES to SPF.** The current record authorizes SendGrid and Postmark — both unused — and does
   **not** authorize Amazon SES. This is a real defect today, independent of this programme.
3. Decide and delegate a reply subdomain for inbound, leaving the apex MX with Brilliant Directories.
4. Supply the postal address required on commercial email.
5. Approve the first pilot cohort and confirm whether the imported directory contact addresses may be
   used for outreach.

## Phase boundary

Phase 1 (shipped, migration 153) establishes: the authorization registry and its evidence, one-click
authorization, secure claim tokens, per-company import sources behind a validation checklist and an
Owner gate, the host-organization model, event-view and outbound-click measurement, the >=100
performance rule, the admin surface, and A15's powerless identity.

Phase 2 designs and builds the channel described above, then controlled outreach on top of it.

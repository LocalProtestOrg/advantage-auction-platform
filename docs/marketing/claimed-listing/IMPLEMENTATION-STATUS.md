# Claimed Listing: Implementation Status (VS Code)

Built and deployed 24 Sep 2026 (migrations 169 + 170). **Real outreach is OFF.** Nothing can send until the Owner completes the pilot steps below.

## Gates
| Gate | Status |
|---|---|
| L-A identity, journey lock, EP exclusion, eligibility, scoring, identity dry run | Built. Identity is **dry-run only**: companies are created on demand when staff act; `scripts/company-identity-backfill.js --apply --confirm=LINK-COMPANIES` is the Owner/Desktop step. |
| L-B token-first claim, self-request, redemption, help/dispute, exits, em dash copy fixes | Built. Self-request is OFF (`claimed_listings.self_request_enabled`). |
| L-C templates, cohorts, sequences, send gate, SES stream, unsubscribe, inbound, Toolbox, funnel | Built, running in SHADOW. A 50-member shadow run produced renders and gate results with zero sends. |
| L-D seed test to staff inboxes | Needs Owner infrastructure (below). |
| L0 pilot | Owner only. |

## Where things are
- Toolbox: `/admin/sales.html`, **Claimed Listings** tab (rows, company timeline, locks, tasks, cohorts, templates, shadow run, funnel, identity dry run, program switches). API: `/api/admin/claimed-listings`.
- Claim page `/claim/<token>`, directory landing `/claim-listing.html?org=`, owner checklist on `/org/profile.html`.
- Services: `src/services/acquisition/*`, `src/services/claimedListings/*`. Worker: `src/workers/claimedListingWorker.js`.
- Reports: `reports/` (identity dry run, badge verification, About replacements). BD changes: `bd-agent-handoff.md`.

## To run the pilot (Owner, in order)
1. **O1 postal address.** Toolbox program settings, or set `company.postal_address`. Until it is set, every render fails closed.
2. **Mail infrastructure** (see the list at the end).
3. **L-D seed test** to staff Gmail, Outlook and Yahoo inboxes. Check SPF, DKIM and DMARC alignment, the one-click unsubscribe, links and the footer.
4. **O2 templates.** Toolbox: *Load blueprint templates as drafts*, review, and *Approve* E1, E2_NOCLICK, E2_CLICKED, E3 (and E4_REFRESH, CL_SELF_REQUEST, A1 if wanted). Approved versions are immutable.
5. **Cohort.** *Propose a pilot cohort (50)*: eligible listings, with the 23 Houston and NY-area listings first. Assign the signing rep (Kym), bind the approved template ids, run *Shadow run*, then *Approve* (Super Admin).
6. **O7 counsel review** of the approved templates.
7. **Turn sending on** (Super Admin, requires the phrase `START-CLAIMED-LISTING-OUTREACH`).

After step 7, every send still re-checks all nine gates:
- the Tue to Thu 09:30 to 11:30 window
- a cap of 10 per day
- 90 seconds between sends
- one message per recipient domain per day
- stream health

A bounce or complaint breach auto-pauses the programme and texts the Owner.

## Infrastructure the Owner/infra must provide (not code)
- SES configuration set `advantage-bid-claimed-listing` with an event destination to the existing SNS topic, and env `SES_CLAIMED_LISTING_CONFIGURATION_SET=advantage-bid-claimed-listing`.
- `listings@advantage.bid` verified on the domain (From). `claimed_listings.from_address` must be on the verified sending domain, or the gate refuses.
- Env `LISTING_OUTREACH_UNSUB_SECRET` (a random secret).
- Replies go to `listings+l<key>@reply.advantage.bid`. The inbound provider route and the reply DNS are the same pending items as Event Partner. After that, set `claimed_listings.inbound_enabled = true`.

## Owner decisions still open
O1 postal address · O2 pilot cohort and templates · O3 badge corrections (41 records, list verified) · O4 About replacements (report ready) · O5 national houses stay excluded (seeded), keep or remove from the directory · O6 Professional Seller fee reconciliation (not touched here) · O7 counsel review.

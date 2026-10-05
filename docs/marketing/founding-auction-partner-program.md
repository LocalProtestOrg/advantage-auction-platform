# Founding Auction Partner Program — foundation (2026-10-05)

Owner-approved Priority #1. This document records the commercial rule, the standing positioning direction, and how
staff operate the program. Partner selection, outreach and final emails are **out of scope** for this foundation.

## Commercial rule (permanent unless the Owner changes it)

- Advantage.Bid may temporarily waive **its own professional auction platform/software fee** for a Founding Partner.
- **Payment processing is never waived.** For an auction published under the 0% partner fee, the seller's processing
  deduction is the **actual Stripe processing fee** on that auction's buyer payments (hammer + premium + tax as charged),
  passed through at cost: no markup, no subsidy (Owner policy 2026-10-05; migration 186). Other auctions keep the
  3%-of-hammer policy rate.
- The global default professional fee, any public promotional pricing and **Storefront pricing (flat 11%)** do not change.
- No duration is assumed. An introductory end date is optional and set per partner.

## Standing positioning direction (marketing)

- Advantage.Bid must **not** present itself as a startup looking for its first auctions.
- **Advantage Auction Company has served clients since 2011.** Say that, and position Founding Partner outreach as
  an **expansion into the partner's local market**.
- Do **not** claim the Advantage.Bid platform itself has existed since 2011 unless that is accurate.
- Lead with the partner's benefit (see the pro-seller messaging rule); never use dollar or percentage savings claims
  that have not been approved.

## How it works

| Step | Who | What changes |
| --- | --- | --- |
| **Place under protection** (`prospect`) | Super Admin, `/admin/founding-partners.html` | Company moves into the `FOUNDING_PARTNER` acquisition journey; open Claimed Listing sequences stop; the person handling it takes the company contact lock; records are tagged in `acquisition.founding_partner`. **No fee changes.** |
| **Link seller + apply fee** (`active`) | Super Admin | The introductory rate (default 0%) is written to the seller's existing rate (`seller_profiles.platform_fee_bps`, the Moderation "Stored Platform Fee"), audited as `seller_platform_fee_changed` (source `founding_partner`). Refused while a pricing agreement exists or for a non-professional seller. |
| **Publish** | normal flow | The publish snapshot freezes the platform fee, the processing basis (`processing_fee_basis = actual_stripe` while the 0% partner fee is applied) and stamps `auctions.founding_partner_id`. For a reduced-fee professional a snapshot failure **stops the publish** rather than publishing unfrozen. |
| **Settle** | normal admin flow | Processing = actual Stripe fee of the auction's collected payments, net of any fee Stripe returned on a refund. If any payment's actual fee is not recorded, the settlement stays in review and **cannot be paid** (no percentage fallback). |
| **Restore return fee** | Super Admin (never automatic) | Puts the return rate back. Only auctions published afterwards use it. Refused if someone changed the seller's rate elsewhere. |
| **End** | Super Admin | Record kept for attribution. Must restore the fee first. The journey stays `FOUNDING_PARTNER` until a Super Admin moves it in the Claimed Listings toolbox (fail closed). |

Reminders: an Owner alert is sent once when an applied introductory period is 14 days from its end date and once
after it passes without the return fee being restored. The Founding Partners page shows a prominent warning. Automatic
reversion is deliberately not built: the end date is optional and negotiable, and a fee increase on a partner should be
a person's decision.

## Cross-program protection

- **Claimed Listing:** screening returns `EXCLUDE_FOUNDING_PARTNER`; the send gate already requires the
  `CLAIMED_LISTING` journey at send time; a journey move stops open sequences.
- **Event Partner:** screening returns `EXCLUDE_FOUNDING_PARTNER` on a strong identity match; a resemblance is held
  for review; no invitation can be attached to a Founding Partner organization (fails closed if the journey is unknown).
- **1:1 rep email (Sales & Marketing Toolbox):** only the contact-lock holder may email a Founding Partner; a free
  lock is not taken automatically.
- **Identity:** a company whose records resemble another company without a matching identifier, or that sits in a
  refused merge, is refused until the identity is reviewed.

## Attribution

`founding_partners` (the program record), `organizations.acquisition.founding_partner` /
`seller_profiles.acquisition.founding_partner` (designation tag), and `auctions.founding_partner_id` (stamped at first
publish, never moved) let future reporting identify Founding Partner sellers and their auctions.

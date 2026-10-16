# Professional Seller staff accounts — permission design (for owner approval)

Status: **design for approval** (2026-10-16). The permission catalog and the server-side checkpoint are built and live-ready
(`src/lib/sellerRbac.js`, `src/middleware/requireSellerPermission.js`); today the checkpoint resolves only the company
owner. Staff membership, invitations and step-up verification are **not built** until this design is approved.

## 1. Model

| Concept | Rule |
|---|---|
| Seller organization | The existing `seller_profiles` row (the verified Professional Seller). Every staff record belongs to exactly one. |
| Owner | The `seller_profiles.user_id` account. Exactly one owner per company; ownership transfer is an Advantage.Bid admin action, audited. |
| Staff member | A normal Advantage.Bid user account linked to ONE seller organization with ONE role. A person may hold staff roles in more than one company only through separate memberships, and acts for one company at a time (explicit company switcher; never inferred from a URL). |
| Platform staff | Completely separate (`users.role='admin'` / `staff_role`, `src/lib/rbac.js`). Seller roles live in a different namespace (`company.*`) and are never read by platform authorization. A seller role can never produce Super Admin. Enforced by tests. |

Proposed table (`seller_staff_members`): `id, seller_id (FK seller_profiles), user_id (FK users), role, status
('invited','active','suspended','removed'), invited_by, invited_at, accepted_at, removed_by, removed_at, session_version`,
with UNIQUE `(seller_id, user_id)` and an append-only `seller_staff_events` history (invite, accept, role change, removal,
sensitive action) naming the seller from the membership row — the same database pattern as migration 197.

## 2. Roles and permissions

| Permission | Owner | Inventory Manager | Fulfillment Staff | Finance Manager |
|---|---|---|---|---|
| `company.storefront.manage` — storefront page, branding, default pickup location | ✓ | | | |
| `company.staff.manage` — invite, change role, remove (step-up) | ✓ | | | |
| `company.inventory.view` / `company.inventory.edit` — listings, photos, prices, imports | ✓ | ✓ | | |
| `company.orders.view` — order list, without buyer contact | ✓ | ✓ | ✓ | ✓ |
| `company.orders.fulfil` — paid orders needing fulfilment, plus only the buyer contact needed to ship or arrange pickup; record shipping/pickup | ✓ | | ✓ | |
| `company.issues.view` / `company.issues.respond` — buyer issues on the company's orders | ✓ / ✓ | | ✓ / – | ✓ / – |
| `company.finance.view` — fees, proceeds, settlement reports | ✓ | | | ✓ |
| `company.payout.manage` — payout destination (step-up; see §4) | ✓ | | | |

Nobody in a seller company can change an order's seller, buyer, amounts, payment records or history — the database refuses
it (migration 197) regardless of role.

## 3. Enforcement

1. Every seller route passes `requireSellerPermission(perm)`. It resolves the company from the **session** (owner →
   `seller_profiles.user_id`; staff → an `active` membership), never from a URL, body, header or widget parameter.
2. Services keep verifying that each row belongs to the resolved company (defense in depth), so a route that forgot its
   check still cannot reach another company's data.
3. Read models are permission-shaped: `company.orders.view` without `company.orders.fulfil` returns orders **without**
   buyer name, email or ship-to.
4. Revocation: removing a member, suspending them or changing their role bumps the member's `session_version`; the
   membership is checked on every request (same mechanism as migration 194), so access ends immediately.
5. Audit: invitations, acceptances, role changes, removals and every sensitive action (fulfilment, issue responses,
   finance exports, payout changes) are written to the append-only history with actor, company and time.

## 4. Financially sensitive actions (additional authorization)

- Changing the payout destination or bank details requires the **owner**, a fresh password re-entry plus a one-time code
  to the owner's verified phone, and is followed by a 72-hour payout hold on the next settlement and an email to the
  owner's address on file. Payout accounts themselves are verified by the payment processor (Stripe Connect onboarding);
  Advantage.Bid never stores bank numbers.
- Inviting a staff member or granting Finance/Fulfillment access requires the same step-up.
- Finance Managers can view and export, never change payout destinations.

## 5. Invitations

Owner enters an email + role → a single-use, 7-day invitation link to that address → the invitee signs in or registers
with that same (case-insensitive) email → membership becomes `active`. An invitation for an email already attached to
another company's ownership is refused. Invitations are rate-limited per company.

## 6. Decisions needed

1. Approve the four roles and the permission table above (or adjust).
2. Approve the step-up for payout and staff changes (password + phone code + 72-hour payout hold after a payout change).
3. May one person be staff at more than one company (with an explicit switcher), or one company per person?
4. Should Finance Managers see buyer names on financial reports (needed for some reconciliations), or order numbers only?

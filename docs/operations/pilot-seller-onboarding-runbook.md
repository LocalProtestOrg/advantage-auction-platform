# Pilot Seller Onboarding Runbook

**Audience:** Advantage admin/operator. **Goal:** take a pilot seller from invite to a publishable auction, with the Seller Agreement signed and governance respected.

## Roles & permissions (enforced server-side)
- **Seller:** limited rights; **loses edit access after final submission** (single-use lock). Cannot publish.
- **Admin (Advantage):** unrestricted edits at all times; **Advantage publishes auctions, not sellers.**

## Seller types & the pickup-gap rule (`src/services/sellerTypeRules.js`)
`seller_type` ∈ `business`, `private`, `other`, `auction_house`, `estate_sale_company`, `professional_liquidator`.
- **Non-professional** (`private`, `business`, `other`, untyped): pickup must begin **≥ 48h after auction close**.
- **Professional** (`auction_house`, `estate_sale_company`, `professional_liquidator`): exempt; may set their own pickup timing.
- **No seller** may set pickup before the auction closes. Enforced server-side.

## Onboarding steps
1. **Create / confirm the seller account.** Seller registers at `/login.html` (or admin provisions). Role = `seller`, `is_active=true`.
2. **Set seller type** (admin). Drives pickup-gap enforcement and capability gating (e.g., reserve price visibility). Recorded with audit entry.
3. **Capture seller identity & terms** (Seller Agreement system). Admin area: `/admin/agreements`.
   - Create/select an **agreement template** (`POST /api/admin/agreements/templates`, versioned).
   - Review seller identity/terms: `GET /api/admin/agreements/sellers/:sellerProfileId/identity` and `.../terms`.
4. **Issue the agreement.** `POST /api/admin/agreements/agreements` → generates a tokenized agreement. Seller receives an email (SES) with a `by-token` link.
   - Resend: `POST /api/admin/agreements/agreements/:id/resend`. Reissue (new token): `.../reissue`. Revoke: `.../revoke`.
5. **Seller signs.** Seller opens `/api/agreements/by-token/:token`, reviews, signs (`POST /api/agreements/:id/sign`, typed or drawn). Signed PDF available at `GET /api/agreements/:id/pdf` (Cloudinary private asset via short-lived signed URL).
6. **Seller builds the auction & lots** (Lot Studio). Required per lot: **size category** (dimensions optional). Each lot defaults to **$1** start unless admin overrides.
7. **Seller selects 3 featured lots** before final submission (admin may override later).
8. **Seller final submission.** This is **single-use** and **locks seller editing**. State moves `draft → submitted`. From here, only admin can edit.
9. **Admin governance review** → see `auction-publish-runbook.md`.

## Verification (read-only)
- Agreement signed: `GET /api/admin/agreements/agreements/:id` → status `signed`/`countersigned`.
- Audit trail: `GET /api/admin/audit-log` (filter by seller/auction).

## Common issues
| Symptom | Likely cause / action |
|---|---|
| Seller can't edit after submitting | Expected — submission locks editing. Admin edits on their behalf, or return-to-draft (see publish runbook). |
| Agreement email not received | Check spam; confirm SES send in worker logs; resend via `/resend`; verify recipient address. Reply-to is `advantageauction.bid@gmail.com`. |
| Pickup window rejected server-side | Non-professional seller set pickup < 48h after close, or before close. Adjust schedule or change seller_type if genuinely professional. |
| Reserve price field not visible to seller | Gated by seller capability/type; admin enables if appropriate. |

## Guardrails
- Do not bypass the agreement step — onboarding is agreement-gated by design.
- Address details stay hidden until buyer payment is verified; do not share full seller/pickup addresses prematurely.
- SMS notifications are **opt-in only**.

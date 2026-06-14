# Admin Auction-Editing Controls — Audit & Matrix

**Status: AUDIT ONLY.** No code change. Grounded in current `fix/stabilization-sprint-1`.

## How admin auction editing works today
- Dedicated admin edit UI exists: `public/admin/moderation.html` → Auctions tab → per-card **Edit** (inline form, `saveAuctionEdit`).
- Generic endpoint **`PATCH /api/admin/auctions/:auctionId`** → `auctionService.updateAuction(..., 'admin', {overrideReason})`.
- `updateAuction` enforces a **hard-coded field whitelist** (`auctionService.js:140-147`). Anything not whitelisted (or lacking a purpose-built endpoint) is **uneditable by anyone, including admin.**
- Admin **bypasses seller ownership** and the draft-only edit lock; admin may set any `state`.
- Whitelisted edits are **audit-logged** with a field-level from/to diff (`auction_updated`).
- UI hides Edit when `state==='closed'`, but the **service layer has no closed-state guard** (a direct API call could still mutate whitelisted fields on a closed auction).

## Matrix
Legend — Status: ✅ editable+audited · ⚠️ partial/endpoint-only · ❌ gap. Priority: **B**=launch blocker · **L**=before Stripe LIVE · **S**=soon after launch · **F**=future.

| Field / Setting | Schema | API | Admin UI | Current status | Priority | Recommendation |
|---|---|---|---|---|---|---|
| title | ✅ | ✅ whitelist | ✅ | ✅ | — | none |
| subtitle | ✅ | ✅ | ✅ | ✅ | — | none |
| description | ✅ | ✅ | ✅ | ✅ | — | none |
| start_time | ✅ | ✅ | ✅ | ✅ (re-publish regenerates staggered closes) | — | none |
| end_time | ✅ | ✅ | ✅ | ✅ (schedule rule re-validated) | — | none |
| pickup_window_start/end | ✅ | ✅ | ✅ | ✅ (48h rule; admin override w/ reason) | — | none |
| preview_start/end | ✅ | ✅ | ✅ | ✅ | — | none |
| street_address/city/state/zip | ✅ | ✅ | ✅ | ✅ | — | none |
| banner_image_url / cover_image_url | ✅ | ✅ | ✅ (URL text only) | ⚠️ no uploader | S | add admin image upload (reuse `uploads.js`) |
| shipping_available | ✅ | ✅ | ✅ | ✅ | — | none |
| state / lifecycle (publish/close/reject/return-to-draft) | ✅ | ✅ dedicated endpoints | ✅ buttons | ✅ | — | none |
| is_archived (hide) | ✅ (064) | ✅ /archive,/unarchive | ❌ no UI | ⚠️ endpoint only | S | wire archive button into moderation UI |
| lat/lng + marketplace_priority | ✅ (039/040) | ✅ /discovery | ❌ no UI; **not audited** | ⚠️ | S | add UI + audit-log the /discovery endpoint |
| **staggered-close interval** | ❌ no column | ❌ hardcoded `LOT_CLOSE_INTERVAL_SECONDS=60` | ❌ | ❌ not configurable | S | matches the 1-min rule; make configurable post-launch (document as accepted exception) |
| **anti-snipe window/extend** | ❌ | ❌ hardcoded (≤120s → +2min, `bidService.js`) | ❌ | ❌ not configurable | S | matches the 2-min rule; configurable later (accepted exception) |
| **seller_id reassignment** | ✅ | ❌ not whitelisted | ❌ | ❌ gap | S | add admin reassignment endpoint (audited) |
| **auction_terms (per-auction terms text)** | ✅ (`001:51`) | ❌ read-only | ❌ | ❌ gap | S | add to whitelist + UI (CLAUDE.md: terms editable) |
| **increment_ladder** | ✅ (`001:66`) | ❌ no write path | ❌ | ❌ gap | S | core rule; today the platform ladder is correct + flat per-auction/house override exists (migration 020) — full ladder editor is "soon" |
| default_starting_bid_cents | ✅ (`001:65`) | ❌ | ❌ | ❌ gap | S | wire to whitelist |
| timezone | ✅ (`001:56`) | ❌ | ❌ | ❌ gap | S | wire to whitelist |
| admin_notes / disclaimers | ✅ (`001:69` JSONB) | ❌ unreachable | ❌ | ❌ gap | S | wire to whitelist |
| public_auction_type | ✅ (`001:51`) | ❌ read-only | ❌ | ❌ gap | S | wire to whitelist (drives public filtering) |
| marketing_selection | ✅ (`001:68`) | ❌ TODO stubs | ❌ | ❌ gap | F | campaign upsell config (admin-editable per CLAUDE.md) — future |
| pickup instructions (free text) | ❌ no column | ❌ | ❌ | ❌ absent | S | add column + edit control |
| walkthrough video | ✅ (038) | ✅ approve/reject/visibility | ✅ moderation tabs | ⚠️ admin moderates, can't add/replace | S | admin video upload/replace (uploader) |
| **buyer_premium (per auction)** | ❌ no auctions column | ❌ | ❌ | ❌ absent (0% today) | L (if charging) | see `buyer-premium-audit-and-plan.md` |
| **sales tax settings** | ❌ no column | ❌ | ❌ | ❌ absent | L | see `tax-exemption-reseller-certificate-plan.md` (tax not implemented at all) |
| payment settings (platform fee) | ❌ no column | ❌ hardcoded 10% (2 files) | ❌ | ❌ | F | make configurable later |

## Biggest gaps
1. **Financial settings have no admin edit path at all** — buyer premium (no column; 0% hardcoded), **sales tax (no column anywhere)**, platform fee (hardcoded 10%). These are the high-impact gaps (see the dedicated premium + tax docs).
2. **Whitelist orphans** — `auction_terms`, `increment_ladder`, `default_starting_bid_cents`, `timezone`, `admin_notes`, `public_auction_type` exist as columns but no one can write them. Several are CLAUDE.md business rules (editable terms, editable increment ladder).
3. **Hardcoded timing** — staggered-close interval + anti-snipe window match the spec but are not editable (contradicts "do not assume immutable" / admin-override principles).
4. **No admin `seller_id` reassignment.**
5. **Endpoints without UI** (`/discovery`, `/archive`) and **`/discovery` not audited**; **no closed-state guard** on the generic PATCH at the service layer.

## Launch classification (auction editing)
- **The currently-editable set (title, description, times, pickup, address, images, lifecycle) is sufficient for a TEST-mode public launch** and is audited — **not a launch blocker**, provided the hardcoded staggered/anti-snipe (which match the rules) are accepted as a documented exception.
- **Before Stripe LIVE:** buyer premium + sales-tax editability become relevant only if a premium/tax is to be charged (see those docs).
- **Soon after launch:** wire the orphan columns (esp. editable per-auction terms + increment ladder), archive/discovery UI + audit, seller reassignment, closed-state guard, admin image/video upload.

# Launch Readiness Dashboard

**What:** an admin-only, read-only view of Advantage.Bid's operational-launch readiness.
**Where:** `/admin/launch-readiness.html` (UI) → `GET /api/admin/launch-readiness` (API). Admin auth required.
**Safety:** purely diagnostic — no writes; each metric query is isolated (one failure can't break the report).

## What it reports (statuses: OK / IN PROGRESS / TO DO)

**Platform Foundation**
- Latest migration (expect 077/078).
- Platform tenant capabilities (expect 12/12).
- Plan→capability mapping (expect 17).
- Branding config (expect ≥5 branding keys).

**Marketplace Content**
- Event markets (≥2: houston, nyc_tristate).
- Event categories (≥8).
- Partner organizations (≥1; grows with onboarding).
- Published events — Houston (target 10).
- Published events — NYC/Tri-State (target 10).
- Syndicated published auctions (>0).

**Platform Legal Documents (published)**
- buyer_terms / seller_agreement / privacy_policy / refund_policy / pickup_policy — each OK once a platform-level published version exists.

**BD Integration**
- Widget assets deployed (OK — `/widgets/events.js` + iframe + embed live).
- City-page embeds (TO DO until applied in BD — manual, requires BD page-edit access).

## How to read it
- **All green (OK)** across Content + Legal + BD embeds = ready for public launch.
- **IN PROGRESS** (amber) = partial (e.g., some events published but below the per-market target).
- **TO DO** (red) = not started.

Thresholds are intentionally conservative (10 published events/market) and can be tuned in `src/routes/adminLaunchReadiness.js` (`EVENT_TARGET`).

## Status of this deliverable
Built and staging-validated in Phase 3. **Production deploy of the dashboard is gated** (production deployment) — pending owner approval alongside the other Phase 3 prod steps.

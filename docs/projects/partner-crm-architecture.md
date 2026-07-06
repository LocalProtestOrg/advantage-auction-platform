# Phase 3C — Nationwide Partner CRM (PROPOSED architecture — awaiting approval)

Governed by `project-constitution.md` (§20–§22) + `partner-lifecycle.md`. **Design only — no implementation.**

## Premise (the vision shift)
Every BD company is a **potential Partner**, not merely a directory listing. The ~344 nationwide inactive Organization shells (imported one‑way) become **CRM records**. The CRM is the engine that converts the directory → Active Partners → White‑Label Partners. It operationalizes the lifecycle: **Prospect → Directory Listing → Inactive → Claimed → Verified → Active Partner → White‑Label → Enterprise → Ambassador.**

## Organization‑First (reaffirmed)
The **Organization is the CRM record.** Everything hangs off `organization_id`: activity/outreach history, health, pipeline stage, owner, communications. No separate CRM entity, no per‑partner code (Zero‑Fork). Nationwide by construction (every shell is a CRM record).

## Two status axes (kept distinct, related)
- **`lifecycle_state`** — the **platform** state (inactive → claimed → verified → active_partner → …). Authoritative for capabilities/visibility.
- **`crm_stage`** — the **relationship/sales** stage (`none → contacted → demo_scheduled → interested → claimed → activated → inactive → former → ambassador`). Drives outreach + pipeline. Set by CRM actions; loosely tracks lifecycle (e.g., contacting an `inactive` shell → crm_stage `contacted`).

## Data model (additive)
- **`organization_activity`** (append‑only CRM/communication timeline): `id, organization_id, type(outreach|note|status_change|email|system), channel(email|phone|meeting|note), actor_id, subject, body, metadata, created_at`. The human/outreach spine; `audit_log` remains the platform‑event spine; the org timeline = union of both.
- **`organizations` additions**: `crm_stage`, `crm_owner_id`(→users, assigned rep), `health_score`(int, cached), `health_computed_at`, `next_action_at`(follow‑up), `last_contacted_at`.
- **(defer)** `outreach_campaigns` / `campaign_targets` for structured campaigns.

## Health / completion scoring
`healthScoreService.compute(org)` → 0–100 + component breakdown, **derived from existing fields** and **cached** to `health_score` (list views over 344+ orgs can't derive per‑row on demand). Recompute on lifecycle/content change + nightly.
Weighted components: claimed (20) · verified (15) · has ≥1 auction (15) · has ≥1 event (10) · recent activity ≤90d (10) · marketplace participation (10) · website (5) · description (5) · logo (5) · profile completeness (5).

## Services
- **`crmActivityService`** — log/list activity per org; builds the unified timeline (activity + audit_log).
- **`healthScoreService`** — compute + cache the score and breakdown; refresh hooks.
- **`crmService`** — pipeline stage transitions, owner assignment, next‑action; **target lists**: high‑potential unclaimed by state (recruitment), claimed‑not‑verified (onboarding assist), verified‑not‑active (activation nudge), active‑going‑stale (re‑engagement).
- **`outreachService`** — claim‑invite emails to the **stored contact email (invite/verify only — never public)**; logs activity; sets `crm_stage=contacted` + `last_contacted_at`. Reuses the platform email pipeline.

## Admin CRM surface (routes + console)
- API (`/api/admin/crm`): `GET /organizations` (filter by state/lifecycle/crm_stage/health, sort by health), `GET /organizations/:id` (profile + timeline + health breakdown), `POST /organizations/:id/activity` (note/outreach), `PUT /organizations/:id/crm` (stage/owner/next_action), `POST /organizations/:id/invite` (outreach). Admin‑only.
- Console pages: **partner list** (nationwide, filterable), **org detail** (profile + activity timeline + health + actions: contact / verify / activate / note), **pipeline board** (by crm_stage), recruitment/target views.

## The recruitment → activation → white‑label loop
1. **Recruit:** target unclaimed high‑potential shells (by state/health) → outreach (claim invite) → track.
2. **Onboard:** claim → confirm profile → Partner Agreement → (3B flow).
3. **Activate:** admin verify → activate → auctions/events syndicate.
4. **Grow:** health + activity drive re‑engagement; top partners → **white‑label** (Phase 5) → **enterprise** → **ambassador**.
The CRM measures and moves each org along this loop; each Active Partner strengthens discovery for the rest.

## Compliance, privacy, security (must‑address)
- **Outreach email = commercial email to real businesses** → **CAN‑SPAM** applies: unsubscribe mechanism, honest sender identity, physical mailing address, honor opt‑outs. This is a **gate** on the outreach sub‑phase (legal + email deliverability/domain reputation).
- Contact PII (email/phone) used **only** for invite/verify — never publicly displayed; CRM surfaces are **admin‑only**.
- CRM is **admin‑facing** (no partner self‑service writes) → doesn't itself trigger the RLS decision; but the **3B claim/onboarding self‑service** (already live) remains the trigger for the RLS/isolation call.

## Proposed 3C sub‑phases (each gated as noted)
- **3C.1 CRM foundation** (additive migration 081: `organization_activity` + crm/health columns; `crmActivityService` + `healthScoreService` with cached scores + backfill). *Gate: prod deploy.*
- **3C.2 Admin CRM API + console** (list/detail/timeline/stage/owner/health). *Gate: prod deploy.*
- **3C.3 Recruitment/outreach** (target lists + claim‑invite emails). *Gates: prod deploy + **CAN‑SPAM/email compliance** + sending to real businesses.*
- **3C.4 (defer)** structured campaigns, automation, nationwide import (all states) once the CRM is proven.

## Out of scope / deferred (triggers)
Nationwide full import beyond Houston (until CRM proven) · white‑label host resolution (Phase 5) · RLS (per the 3B self‑service trigger) · Stripe/settlement · two‑way BD sync · public org discovery.

## Open questions for the Product Owner
1. **crm_stage vs lifecycle_state** — keep both (recommended) or collapse into one?
2. **Outreach emails** — do we build sending in 3C (needs CAN‑SPAM + a warmed sending domain), or start CRM as **tracking‑only** (log manual outreach) and add automated email later?
3. **Market focus** — CRM is nationwide, but which states do we *work* first (Houston is imported; CA is the largest at 44)? Do we import more states now or after 3C.1/3C.2?
4. **Rep assignment** — single operator now, or multi‑rep `crm_owner` from the start?

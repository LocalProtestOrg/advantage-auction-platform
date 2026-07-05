# Launch Content & Marketplace Rollout — Roadmap (planning only)

**Status:** PLANNING ONLY — do not implement from this document. Sequences the next phase after the Organizations & Events v1 production release (`f0a7648`, migration 076). Prerequisite platform is live; this plan is about **content, onboarding, and rollout**, not new engineering (engineering items are called out as deferred/prereqs).

## Guiding principle
Railway is the system of record; BD is presentation. Launch = seed real organizations + events in the two live markets (`houston`, `nyc_tristate`), then surface them on BD city pages via the already-shipped widgets. Prioritize trustworthy, non-empty marketplace pages before broad promotion.

## Houston launch strategy
- Target market slug: `houston` (BD page `/houston`).
- Recruit 5–10 Houston estate-sale / auction organizations as initial Organizations (free tier to start).
- Seed 10–20 published Houston events spanning the next 4–6 weeks so the feed is never empty.
- Embed the JS widget on BD `/houston` below intro content (manual, pending BD page-edit access).
- Success metric: `/events.html?market=houston` and the BD `/houston` widget show a full, current card set.

## NYC / Tri-State launch strategy
- Target market slug: `nyc_tristate`, mapped across BD pages `/new-york` (primary), `/new-jersey`, `/connecticut` (no single tri-state page exists).
- Recruit organizations across all three states; tag every event `market=nyc_tristate` regardless of state page.
- Seed 10–20 published events; embed the widget (`data-market="nyc_tristate"`) on all three BD pages.
- Consider a future per-state filter (schema already stores `city`/`state`).

## Initial organization onboarding
- Onboard via the live portal (`/org/profile.html`, auto-onboard on first event) OR admin-assisted (admin-created orgs are currently deferred — would extend `organizationsService`).
- Capture: name, contact email/phone, city/state, logo, website. Verify legitimate organizers → move `verification_status` to `community`/`verified` once the verification workflow ships (deferred).
- Start all on **free** plan (3 active / 10 images); upgrade high-volume organizers to standard/premium.

## Initial event population
- Prioritize real, upcoming events with good cover imagery (Cloudinary upload via portal).
- Moderation: every seeded event goes through submit → Approve & Publish so the audit trail and public feed reflect the real workflow.
- Maintain a rolling 4–6 week horizon per market; archive past events (they auto-drop from the feed at `end_at`).

## Advantage Auction Company (AAC) launch events
- Create an "Advantage" organization (source `admin` → badge "Advantage") to seed flagship AAC events in both markets as anchor content.
- Use AAC events to demonstrate the full buyer journey (discovery → event detail → any linked auction).
- Coordinate with the historical archive work (separate track) so AAC's brand presence is consistent.

## Public launch checklist
- [ ] ≥10 published events per market with cover images.
- [ ] Widget embedded + visually verified on `/houston`, `/new-york` (+ `/new-jersey`, `/connecticut`).
- [ ] Create-Event deep-link (`/org/events/new?market=…`) present on each BD page.
- [ ] `EVENTS_ALLOWED_ORIGINS` confirmed to include both BD origins in prod.
- [ ] Public pages (`/events.html`, `/event.html`) reviewed on mobile + desktop.
- [ ] Moderation SLA defined (who approves, how fast).
- [ ] Analytics/UTM on widget → platform funnel.

## BD widget rollout plan
1. **Pilot:** embed JS widget on `/houston` only; verify render, CORS, funnel.
2. **Expand:** add `/new-york`, then `/new-jersey`, `/connecticut`.
3. **Fallback:** use the iframe snippet only where a `<script>` can't be added.
4. **Create-Event CTA:** add the deep-link button near each widget.
5. Keep BD native events untouched until parity is proven, then retire them.
6. All BD edits are **manual** until BD page-edit access is enabled.

## Future BD MCP integration
- No BD MCP exists today (BD access = read-only REST API, `X-Api-Key`). To automate BD page edits, either connect a custom BD MCP or use a write-scoped BD content API (unverified BD supports it).
- When added, apply least-privilege permissions: read/list/get/search = allow; create/update/publish = ask; delete = deny unless explicitly approved.
- Until then, BD embeds and any BD content changes remain human-in-the-loop.

## Imported event strategy
- `events.source = 'imported'` + attribution fields are already in the schema (deferred/unbuilt).
- Plan: optional ingestion of third-party/BD-native events as **imported** listings (badge "Imported Listing", attribution shown), clearly distinguished from organizer-submitted events, never auto-published without moderation.
- Sequence after organic organizer content proves the model.

## Unified authentication roadmap
- Today: native Railway auth for organizers; sellers use the existing seller path; BD is not an identity provider.
- Plan: unify seller ↔ organization identity and move media upload behind **capability-based authz** (e.g. `requireCapability('media_upload')`) so sellers and organizations share one pipeline (see `local-events-architecture.md` roadmap note). No deep two-way BD login sync.

## Marketplace launch priorities
1. Non-empty, trustworthy market pages (content first).
2. BD widget embedded + funnel measurable.
3. Moderation operations + SLA.
4. Organizer growth (onboarding + verification workflow).
5. Then: imports, per-state discovery, memberships/advertising, monetization.

---
*Blueprint reference: `docs/projects/local-events-architecture.md`. Release notes: `docs/releases/organizations-events-v1.md`.*

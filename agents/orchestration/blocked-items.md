# Blocked Items — Cross-Stream Registry

Last updated: 2026-05-11
Maintained by: Human Operator

This file tracks work that is blocked because it depends on another stream's output.
Each blocker has an owner (the blocked stream) and an unblocking dependency (the stream
that must act first). Blockers are resolved — never deleted. When resolved, move the
entry to the Resolved section with a resolution date and commit reference.

---

## Active Blockers

*No active blockers as of 2026-05-11. All streams are IDLE and unblocked.*

---

## Blocker Template

```
### BLOCKED-NNN — [Short description]

**Blocked stream:** [Stream name]
**Blocked work:** [What cannot proceed]
**Blocking stream:** [Stream name that must act first]
**Blocking dependency:** [Exactly what that stream must deliver]
**Logged:** [Date]
**Urgency:** LOW | MEDIUM | HIGH

**Context:**
[Why this dependency exists — what breaks if the blocked stream proceeds without it]

**Unblock criteria:**
- [ ] [Specific deliverable from blocking stream]
- [ ] [Checkpoint or commit reference if needed]
- [ ] [Any secondary conditions]

**Escalation path:**
If [blocking stream] cannot unblock within [timeframe], escalate to human operator.
```

---

## Known Sequencing Dependencies (Not Yet Active Blockers)

These are dependencies that will become blockers if both streams become active
simultaneously. They are not yet blockers because neither stream has started the
relevant work cycle.

| Blocked Stream | Blocked Work | Depends On | Blocking Stream |
|---|---|---|---|
| Charlie-BD | `featured-near-you.js` refactor to Config-First | `AAPConfig` API must be stable | Charlie-BD itself (self-dependency — no parallel risk) |
| Bravo-Discovery | Seller profile enrichment endpoint | Seller route architecture decision | Alpha-Core |
| Delta-Testing | Soft close + bid extension timer spec | Timer logic implemented in server | Alpha-Core |
| Delta-Testing | Analytics event ingestion spec | Events flowing into `analytics_events` | Bravo-Discovery |
| Marketplace Intelligence | Live telemetry query playbook | Sufficient event volume in `analytics_events` | Time + widget emission |
| Frontend Ops | Deploy `featured-lots` v1.0.0 | Operator deployment approval | Human Operator |
| Growth Ops | SEO city landing page strategy | BD city page infrastructure decision | Charlie-BD / Human Operator |

---

## Resolved Blockers

*None yet — registry established 2026-05-11.*

---

## Escalation Rules

**24-hour rule:** If a blocker has not been resolved within 24 hours of being logged
and it is rated HIGH urgency, the operator must be notified.

**Deadlock rule:** If Stream A is blocked on Stream B AND Stream B is blocked on
Stream A, this is a deadlock. Do not attempt to resolve autonomously. Escalate
immediately.

**Cross-stream file rule:** If a blocker requires one stream to hand off a file it
currently owns to another stream, use the handoff protocol in `handoff-protocol.md`.
Do not transfer file ownership informally.

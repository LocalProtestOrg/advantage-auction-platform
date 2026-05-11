# Handoff Protocol

Last updated: 2026-05-11
Maintained by: Human Operator

A handoff is required any time work crosses a stream boundary: when an engineering
stream produces an artifact that another stream consumes, when a blocker is resolved,
or when file ownership transfers between streams.

---

## When a Handoff Is Required

| Scenario | Handing-Off Stream | Receiving Stream | Handoff Type |
|---|---|---|---|
| Engineering publishes a new widget export | Charlie-BD | Frontend Ops | **Engineering → Ops** |
| Engineering ships a new public API endpoint | Bravo-Discovery | Charlie-BD | **Engineering → Engineering** |
| Engineering changes analytics schema/service | Bravo-Discovery | Marketplace Intelligence | **Engineering → Analysis** |
| Growth Ops needs a new public endpoint | Growth Ops | Bravo-Discovery | **Ops → Engineering Request** |
| MI proposes new event type or telemetry field | Marketplace Intelligence | Bravo-Discovery | **Analysis → Engineering Request** |
| A blocker is resolved | Blocking stream | Blocked stream | **Blocker Resolution** |
| File ownership transfers between streams | Current owner | New owner | **Ownership Transfer** |

---

## Handoff Format

Every handoff must be recorded as a comment block in `active-work-queue.md` under
the receiving stream's section, using this format:

```
**HANDOFF from [Stream] on [Date]**
Commit: [short hash or tag]
Artifact: [file path or endpoint or feature name]
Summary: [one sentence — what was delivered]
Consumer action required: [what the receiving stream must do next]
Validation: [how the receiving stream confirms the artifact is usable]
```

---

## Engineering → Ops Handoffs (Charlie-BD → Frontend Ops)

This is the most common handoff type. It occurs when Charlie-BD publishes a new
or updated export package to `/exports/frontend-widgets/`.

### Charlie-BD responsibilities before handoff:
1. All source widget files are committed and pushed to `main`
2. Export package is written to `/exports/frontend-widgets/[package-name]/`
   with `widget.js`, `widget.css`, `README.md`, `version.json`
3. `exports/frontend-widgets/CHANGELOG.md` is updated with the new version entry
4. A checkpoint tag is applied: `checkpoint-bd-[name]-v[N]`
5. The handoff entry is written in `active-work-queue.md` under Frontend Ops

### Frontend Ops responsibilities after handoff:
1. Read the package `README.md` and `version.json`
2. Compare to `CHANGELOG.md` to understand what changed
3. Follow the pre-deployment checklist in `deployment-log.md`
4. Log the deployment in `deployment-log.md` before going live
5. If any issue is found, DO NOT deploy — log a blocker in `blocked-items.md`
   pointing back to Charlie-BD

### What Frontend Ops must NEVER do during this handoff:
- Modify `widget.js` or `widget.css` in the package
- Deploy without logging
- Claim the deploy succeeded without verifying the widget loads on the target page

---

## Engineering → Engineering Handoffs (Bravo → Charlie)

When Bravo-Discovery ships a new or modified `/api/public/*` endpoint that
Charlie-BD widgets must consume.

### Bravo-Discovery responsibilities before handoff:
1. New endpoint is committed, tested, and pushed
2. `agents/bravo-discovery/current-work.md` is cleared (status: IDLE)
3. Endpoint response shape is documented in the relevant checkpoint log entry
4. The handoff entry is written in `active-work-queue.md` under Charlie-BD

### Charlie-BD responsibilities after handoff:
1. Read the Bravo checkpoint log entry to understand the endpoint contract
2. Update its `current-work.md` to list the new endpoint under "API Endpoints Being Consumed"
3. Build the consuming widget or feature against the new endpoint

### What must NEVER happen:
- Charlie-BD must not write code that calls a Bravo endpoint before Bravo has
  checkpointed. Mid-cycle APIs may change shape without notice.
- Bravo must not change an existing endpoint's response shape without first
  notifying Charlie-BD and verifying no widget depends on the old shape.

---

## Engineering → Analysis Handoffs (Bravo → Marketplace Intelligence)

When the analytics schema or service changes in a way that affects how MI queries data.

### Bravo-Discovery responsibilities before handoff:
1. Migration is applied to the database
2. `docs/analytics-telemetry.md` is updated to reflect schema changes
3. A handoff entry is written in `active-work-queue.md` under Marketplace Intelligence

### Marketplace Intelligence responsibilities after handoff:
1. Review the updated `docs/analytics-telemetry.md`
2. Update any active query playbooks to reflect schema changes
3. If a schema change breaks a planned query, log a blocker in `blocked-items.md`
   and propose a correction to Bravo-Discovery

---

## Analysis/Ops → Engineering Requests (MI or Growth → Engineering)

When a non-engineering stream needs a platform change to unblock their work.

### Process:
1. The requesting stream writes a **cross-stream request** entry in `blocked-items.md`
   using the blocker template — but with type `REQUEST` instead of `BLOCKED`
2. The request includes:
   - What is needed (specific endpoint, field, event type, etc.)
   - Why it is needed (the business or reporting use case)
   - Which engineering stream is the right owner
   - Priority (LOW / MEDIUM / HIGH)
3. The human operator reviews and approves or rejects
4. If approved, the operator assigns it to the relevant engineering stream's
   `current-work.md` as a queued item
5. The requesting stream does NOT proceed with code changes. It waits.

---

## Blocker Resolution Handoffs

When a blocking stream resolves a dependency and the blocked stream can proceed:

1. Blocking stream updates `blocked-items.md`: move the blocker entry to Resolved,
   add resolution date and commit hash
2. Blocking stream writes a handoff entry in `active-work-queue.md` under the
   previously-blocked stream: "BLOCKED-NNN resolved — [what was delivered]"
3. Blocked stream updates its `current-work.md` to ACTIVE and starts the work

---

## Ownership Transfer Handoffs

When a file's ownership permanently moves from one stream to another (rare).

1. Human operator must approve the transfer
2. Current owner checkpoints any in-progress work on the file
3. Orchestration layer updates `ownership-matrix.md`
4. New owner's `agents/[stream]/owned-files.md` is updated
5. Former owner's `agents/[stream]/owned-files.md` is updated
6. Entry is added to `active-work-queue.md` under both streams

---

## Handoff Checklist (Quick Reference)

Before any handoff:
- [ ] Work is committed and pushed to `main`
- [ ] Per-agent `current-work.md` is cleared (status: IDLE)
- [ ] Checkpoint tag applied if engineering stream
- [ ] Handoff entry written in `active-work-queue.md` for receiving stream
- [ ] `blocked-items.md` updated if this resolves a blocker

After receiving a handoff:
- [ ] Handoff entry acknowledged in own `current-work.md`
- [ ] Artifact or endpoint validated before building against it
- [ ] Any issues logged in `blocked-items.md` immediately

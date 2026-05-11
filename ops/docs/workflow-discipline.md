# Workflow Discipline for Growth Operations

How the growth operations team works safely within the Advantage.Bid platform
structure — without disrupting engineering, production, or infrastructure.

---

## The Two-Machine Model

Advantage.Bid runs on a deliberate two-domain model:

```
Engineering Machine                 Growth Operations Domain
────────────────────────────────    ────────────────────────────────
/src (backend code)                 /ops (growth planning + docs)
/db  (migrations)                   Campaigns
/e2e (tests)                        SEO content
/public/widgets                     CRM workflows
/docs (engineering docs)            Scenario pages (copy)
/agents (agent OS)                  Outreach sequences
Infrastructure                      Branding
Stripe / payments                   AI agent designs
Deployments                         Partner assets
API design
```

Growth operations **never touches** the engineering side.
Engineering **reads** growth planning to understand requirements.

---

## Daily Workflow for Growth Operations

### Starting work

1. Pull latest from main before starting: `git pull origin main`
2. Check `ops/docs/operations.md` for active work queue
3. Work only inside `/ops/` — no other folders

### Creating a new planning document

1. Identify the correct subfolder (campaign, scenario, outreach, etc.)
2. Create a `.md` file with a clear filename: `[topic]-[type].md`
3. Start with: Status, Owner, and Engineering Dependency fields
4. Include an **Engineering Request** section if anything needs to be built
5. Never create HTML, JS, SQL, or config files — Markdown only

### Committing work

```bash
git add ops/
git commit -m "ops: [short description of what was planned]"
```

Examples:
- `ops: draft estate sale onboarding campaign copy`
- `ops: add liquidation scenario page copy brief`
- `ops: update CRM workflow logic with ops review SLA`

Never use `git commit -m "eng: ..."` — that prefix is reserved for engineering commits.
Never commit files outside `/ops/` unless explicitly authorized.

### Requesting engineering work

See `operations.md` for the formal request process. Never informally request
changes to production, APIs, or infrastructure in commit messages or planning docs
alone — submit a proper request through the defined process.

---

## What Growth Agents Can Do

| Permitted | Not Permitted |
|---|---|
| Create/edit `.md` files in `/ops/` | Create any file outside `/ops/` |
| Draft copy, campaigns, workflows | Write HTML, JS, SQL, JSON configs |
| Document engineering requirements | Submit code changes to engineering files |
| Link to existing production pages | Modify existing production pages |
| Reference existing API endpoints | Create or modify API endpoints |
| Reference existing widget demos | Modify widget files |
| Plan CRM workflows | Implement CRM integrations |
| Design AI agent concepts | Deploy AI agents to production |
| Commit to `/ops/` with `ops:` prefix | Commit to any other directory |

---

## Versioning and Review

**Ops documents are living documents.** They change as plans evolve.
Every document should have a `*Last updated: YYYY-MM-DD*` footer.

For major strategy changes, note what changed and why at the top of the document:
> *Updated 2026-06-01: Revised CTA from "Get started" to "See if you qualify"
> based on A/B test results from May campaign.*

**Do not delete old planning documents.** Archive them by adding `[ARCHIVED]`
to the filename and moving to an `/ops/archive/` folder.

---

## When Growth Needs Engineering

Write an engineering request section in your planning document, then hand it
to the engineering machine in a new session with:

1. A clear statement of what needs to be built
2. A link to the planning document (file path in the repo)
3. Priority level
4. No design prescriptions — describe what it should *do*, not how it should
   be implemented. Engineering decides implementation.

*Last updated: 2026-05-11*

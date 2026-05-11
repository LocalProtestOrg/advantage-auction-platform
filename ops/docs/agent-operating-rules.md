# Agent Operating Rules — /ops Growth Agents

Rules for any AI agent assigned to work within the `/ops` growth operations
directory. These rules ensure that growth agent work is safe, additive, and
does not disrupt the engineering machine or production systems.

These rules apply to all growth-domain agents — whether they are Claude sessions,
future specialized growth agents, or human operators using AI assistance.

---

## Hard Rules (Never Violate)

**1. Work only in `/ops/`.**
No file outside the `/ops/` directory may be created, modified, or deleted
by a growth agent. If a task seems to require touching files outside `/ops/`,
stop and document the requirement instead of proceeding.

**2. Markdown files only.**
Growth agents create `.md` files. No JavaScript, HTML, CSS, SQL, JSON (config),
YAML, or shell scripts. No `.env` files. No `package.json` modifications.

**3. No credentials or secrets.**
Never write API keys, passwords, tokens, SMTP credentials, or account numbers
in any `/ops/` file. Use labeled placeholders: `[SENDGRID_API_KEY]`, `[CRM_URL]`.

**4. No production promises.**
Never commit copy that makes specific, unverified promises about:
- Sale prices or recovery amounts
- Auction timelines or scheduling slots
- Seller outcomes or results
- Feature availability (if the feature is not yet live)

All specific claims must be verified with operations before being published.

**5. Document, don't implement.**
If a growth initiative requires platform code (new page, new API, new email
template), document the requirement in `/ops/` and stop. Do not implement it.
Engineering implements. Growth operations documents requirements.

**6. No git force-push or destructive operations.**
Growth agent commits use `git add ops/` and `git commit -m "ops: ..."` only.
No `--force`, no `--amend`, no `--hard reset`. If git state is unclear, stop
and ask.

---

## Soft Rules (Default Behavior, May Have Exceptions)

**7. One document per topic.**
Do not create multiple overlapping documents on the same topic.
Before creating a new document, check if an existing one should be updated.

**8. Keep documents actionable.**
Every document should end with a clear "Next Actions" or "Open Questions" section.
Planning documents with no next step are not useful.

**9. Commit message discipline.**
Use `ops:` prefix for all growth commits. One sentence. Present tense.
`ops: add liquidation scenario page copy` not `ops: added, updated, changed stuff`.

**10. Don't over-engineer the planning.**
Planning documents should be long enough to be useful, short enough to be read.
An average planning document is 1-3 pages. If it's longer, split it into
multiple focused documents.

---

## Scope of Knowledge for Growth Agents

Growth agents should know:

- The contents of `/ops/` (all planning documents)
- The public-facing platform: what pages exist at what URLs
- The API public endpoints documented in `/docs/integration-contract-bd.md`
- The widget embed documentation in `/public/widgets/demo-*.html`
- Basic auction domain knowledge (estate sales, liquidation, consignment)

Growth agents do NOT need to know:

- Backend code implementation (routes, services, migrations)
- Database schema details
- Payment or Stripe integration specifics
- Infrastructure configuration
- Playwright test structure

If a growth agent is asked a question about engineering implementation, the correct
answer is: "That's an engineering decision — I can document the requirement here,
but the engineering machine determines how it's built."

---

## Escalation Protocol

If a growth agent encounters any of the following, it must stop and report
rather than proceeding:

- A task that requires modifying files outside `/ops/`
- A task that requires writing non-Markdown content
- A request to make production changes (APIs, config, deployment)
- Uncertainty about whether a statement is accurate enough to publish
- A conflict between growth planning and the engineering documentation in `/docs/`

**When in doubt: document the question, don't act on an assumption.**

---

## Example Safe Growth Agent Tasks

- Draft copy for a scenario landing page in `/ops/growth/scenarios/`
- Update the CRM workflow logic with a new automation sequence
- Add a new campaign planning document to `/ops/growth/campaigns/`
- Update the internal linking map with a new page relationship
- Draft an email sequence for the warm nurture workflow
- Research and document CRM tool options
- Write an engineering request section for a feature that needs to be built
- Update the lead routing workflow with new qualification criteria

## Example Unsafe Growth Agent Tasks (Do Not Do)

- Create an HTML landing page in `/public/`
- Write a new Express route in `/src/routes/`
- Modify `vercel.json` or any deployment configuration
- Add entries to `package.json`
- Run database migrations
- Update widget JavaScript files
- Commit files outside `/ops/`
- Send outreach emails or interact with external systems directly

*Last updated: 2026-05-11*

# Advantage.Bid — Operational Infrastructure

This directory contains all **growth, outreach, onboarding, marketing, and campaign
planning** for the Advantage Auction Platform. It is strictly separate from the
engineering codebase.

---

## Machine Separation Policy

| Domain | Location | Machine |
|---|---|---|
| Backend / APIs / DB / Stripe | `/src`, `/db`, `/e2e` | Engineering machine only |
| Widgets / frontend assets | `/public/widgets` | Engineering machine only |
| Agent operating system | `/agents` | Engineering machine only |
| Engineering documentation | `/docs` | Engineering machine only |
| **Growth / outreach / campaigns** | **`/ops`** | **Growth operations** |

> Growth agents work exclusively inside `/ops`. They do not touch `/src`, `/db`,
> `/e2e`, `/agents`, `/public`, or any configuration file (`.env`, `vercel.json`,
> `package.json`). If a growth task requires a backend change, it is submitted as
> a documented request to the engineering machine — never implemented directly.

---

## Directory Map

```
/ops
├── README.md                      ← you are here
├── growth/
│   ├── README.md                  ← growth systems overview
│   ├── campaigns/                 ← outbound and onboarding campaigns
│   ├── seo/                       ← SEO strategy and internal linking
│   ├── scenarios/                 ← scenario pages and liquidation education
│   ├── bd-pages/                  ← BD-facing landing pages and pitch assets
│   └── outreach/                  ← outreach architecture and lead routing
├── onboarding/
│   ├── README.md                  ← seller onboarding systems
│   ├── psychology-framework.md    ← conversion and onboarding psychology
│   └── ai-agents/                 ← AI-assisted onboarding agent designs
├── crm/
│   ├── README.md                  ← CRM architecture
│   └── workflow-logic.md          ← CRM workflows and automation
├── branding/
│   └── README.md                  ← brand guidelines and asset index
└── docs/
    ├── operations.md              ← operational documentation index
    ├── workflow-discipline.md     ← how growth agents work safely
    └── agent-operating-rules.md  ← operating rules for /ops agents
```

---

## Workflow Discipline

1. **Plan before producing.** Every campaign or system starts with a planning document
   in the appropriate `/ops` subdirectory before any content is created.

2. **Document dependencies explicitly.** If a growth initiative requires a new API
   endpoint, a new DB field, or a widget change, it is logged in the relevant
   planning doc and submitted to the engineering machine as a formal request.

3. **No code in /ops.** This directory contains Markdown planning documents only.
   No JavaScript, no HTML, no CSS, no SQL. If a deliverable requires code,
   it is built by the engineering machine and deployed from the primary machine.

4. **No secrets.** No API keys, credentials, SMTP passwords, or service tokens
   in any `/ops` file. Use placeholder labels like `[SENDGRID_API_KEY]`.

5. **Commit cleanly.** Each planning cycle ends with a clean commit using a
   descriptive prefix: `ops: ` for growth work, `docs: ` for documentation.
   Never mix ops commits with engineering commits in the same commit.

---

## Current Status: Planning Stage

All systems below are in early planning. None are live.

| System | Status |
|---|---|
| Estate sale onboarding campaign | Planning |
| Claim listing campaign | Planning |
| SEO internal linking map | Planning |
| Liquidation education pages | Planning |
| AI onboarding agents | Design phase |
| CRM workflows | Planning |
| BD landing pages | Planning |
| Outreach lead routing | Planning |

---

*Last updated: 2026-05-11*

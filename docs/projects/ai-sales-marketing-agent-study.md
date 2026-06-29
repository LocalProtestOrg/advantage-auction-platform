# Advantage AI Sales & Marketing Agent — Architecture & Roadmap Study

**Status:** RESEARCH / PLANNING ONLY. No implementation. Post-launch-stabilization phase.
Does not interrupt or reprioritize current work (admin controls, buyer account controls,
nav/back, launch stabilization, monitoring, seller onboarding). All recommendations honor
the platform's engineering priorities: **adapter-based integration (never dependency)**,
server-side enforcement, simple/stable/editable systems, and platform independence from BD.

---

## 1. Executive Summary

Advantage should build a **Growth subsystem** whose system-of-record is the platform's own
Postgres database (a native, lightweight CRM), orchestrated by **one Sales & Marketing
"Growth Orchestrator" agent that delegates to a small set of specialized sub-agents**
(Lead-Gen, Outreach, Content, Video, Analytics). This hybrid avoids both the brittleness of
a single monolith and the coordination overhead of many fully-independent agents.

The highest-ROI, most defensible asset AAC already owns is a **working product**: Seller
Studio, the AI Catalog Assistant, real auction creation, proxy bidding, anti-snipe. The
marketing strategy should therefore be **demonstration-led** — screen recordings of the real
platform with AI voiceover — not generic stock/avatar fluff. This is cheaper, more credible,
and impossible for competitors to copy.

**Biggest single risk to manage from day one:** cold-seller-acquisition email must **never**
share the transactional SES domain (`advantage.bid`) — a separate sending domain + a dedicated
cold-email tool protects deliverability of bids/invoices/agreements.

**30-day quick wins (~$200–400/mo):** native CRM tables + Apollo (lead sourcing) + Instantly/
Smartlead (cold email on a separate domain) + Claude-authored content + screen-recorded demo
videos with ElevenLabs voiceover. This is enough to start measurable seller acquisition.

---

## 2. Recommended Architecture — Hybrid (Orchestrator + Sub-agents)

**Recommendation: Hybrid.** One **Growth Orchestrator** owns goals, scheduling, and the CRM
write path; it dispatches to specialized sub-agents that each own a bounded capability and a
narrow tool set.

```
                ┌──────────────────────────────────────────────┐
                │           GROWTH ORCHESTRATOR                  │
                │  goals · scheduling · budget caps · CRM writes │
                │  guardrails (compliance, deliverability)       │
                └──────┬───────┬───────┬───────┬───────┬─────────┘
                       │       │       │       │       │
              ┌────────▼─┐ ┌───▼────┐ ┌▼──────┐ ┌▼─────┐ ┌▼─────────┐
              │ Lead-Gen │ │Outreach│ │Content│ │Video │ │Analytics │
              │ sub-agent│ │sub-agent│ │sub-ag.│ │sub-ag│ │sub-agent │
              └────┬─────┘ └───┬────┘ └──┬────┘ └─┬────┘ └────┬─────┘
                   └───────────┴─────────┴────────┴───────────┘
                                     │
                        ┌────────────▼─────────────┐
                        │  CRM SPINE (Postgres)     │
                        │  prospects · leads ·       │
                        │  campaigns · touches ·     │
                        │  scores · assets · metrics │
                        └────────────────────────────┘
```

**Core responsibilities of the Growth Orchestrator**
- Translate a quarterly acquisition goal (e.g. "+25 active sellers") into campaigns + budgets.
- Enforce hard guardrails: send caps, suppression lists, compliance, per-tool spend ceilings.
- Own all CRM writes (sub-agents propose; orchestrator commits → single audit trail, reuses
  the existing `audit_log` pattern).
- Schedule recurring jobs (daily sourcing, sequence steps, weekly content, monthly reporting).

**Sub-agents (bounded contexts)**
| Sub-agent | Owns | Tools |
|---|---|---|
| Lead-Gen | discover → qualify → score → enrich → segment | Apollo/Clay APIs, Google Maps, directories, web fetch |
| Outreach | sequences, personalization, follow-ups, nurture | Instantly/Smartlead API, template store, suppression list |
| Content | blog, social, landing, case studies, SEO | Claude, CMS/file output, image gen |
| Video | scripts, voiceover, screen-capture assembly, captions | ElevenLabs, Remotion/Creatomate, HeyGen, asset store |
| Analytics | funnel, CAC, ROI, engagement, attribution | PostHog, Postgres marts, provider webhooks |

**Tradeoffs**
- *Single unified agent:* simplest to start, but one prompt/context juggling lead-gen +
  video + analytics becomes unreliable and hard to budget-cap per function. Rejected for the
  permanent subsystem (fine as a 30-day MVP shim).
- *Many fully-independent agents:* clean separation, but every agent needs its own CRM
  access, scheduling, and guardrails → duplicated logic, race conditions on CRM writes,
  fragmented audit. Overkill now.
- *Hybrid (chosen):* sub-agents stay small and independently testable; the orchestrator
  centralizes the risky parts (spend, compliance, CRM writes). Matches the platform's
  existing "specialized assistants" roadmap (Catalog, Agreement, Seller Success…).

**Data flow (one prospect's life):** source (Lead-Gen) → enrich + score → segment by seller
type → Orchestrator commits to CRM → Outreach enrolls in the matching sequence → engagement
events stream back (opens/clicks/replies) → Analytics updates score + funnel → qualified
reply → routed to human/Seller Success Assistant → on signup, CRM marks converted and
attributes CAC. Every state change is audit-logged.

---

## 3. Recommended Technology Stack

Reuse what's already in production; add only budget-friendly, API-first tools.

| Layer | Use existing | Add |
|---|---|---|
| Runtime / data | Node/Express, Postgres (Neon), Railway | CRM tables in the same Postgres |
| AI | Claude (already in stack) | — (Claude for content, scoring, personalization) |
| Email | SES (transactional only) | **Instantly or Smartlead** for cold outreach (separate domain) |
| Media | Cloudinary | ElevenLabs (VO), Remotion or Creatomate (assembly), HeyGen (avatars) |
| Lead data | — | Apollo (primary), Clay (90-day), Google Maps, directories |
| Analytics | audit_log | PostHog (free tier), Postgres marts |
| CRM UI | admin moderation pattern | optional HubSpot Free, or a native admin "Growth" tab |

Principle: **the platform's Postgres is the CRM system of record**; any external CRM
(HubSpot) is an *adapter/mirror*, never the source of truth — same rule the project applies
to BD.

---

## 4. Recommended Claude Code Skills

Author these as repo skills (`.claude/skills/`) so the Growth agents call them deterministically:
- `lead-enrich` — given a company/domain, return normalized firmographics + seller-type
  classification + a 0–100 fit score with rationale.
- `seller-segment` — classify a prospect into the 10 seller types and pick the campaign.
- `outreach-compose` — generate a personalized cold email / follow-up from a template +
  prospect context, with compliance footer + suppression check.
- `content-write` — blog/landing/social/case-study generator with house style + SEO brief.
- `video-script` — turn a platform feature or success story into a screen-recording shot list
  + VO script + captions.
- `campaign-report` — pull CRM + PostHog metrics into a weekly/monthly markdown report.
- `crm-upsert` — validated, audit-logged writes to the CRM spine (orchestrator-only).

---

## 5. Recommended MCP Servers
- **Postgres MCP** (read/scoped-write) — CRM spine + platform data for personalization.
- **HubSpot MCP** (if HubSpot Free is adopted) — contacts/deals mirror.
- **Apollo / Clay** — via their REST APIs wrapped as a thin internal MCP (no official MCP needed).
- **Web search + fetch MCP** — directory/Google-Maps sourcing, prospect research.
- **PostHog MCP** — analytics queries for reporting.
- **Cloudinary MCP** — store/retrieve generated video + image assets.
- **Stripe MCP (read-only)** — revenue/CAC attribution (never write).
- **Filesystem MCP** — content/asset artifacts in-repo.

All external MCPs are **adapter-based and optional** — the subsystem must function with just
Postgres + Claude + one email tool if a provider is dropped.

---

## 6. Recommended APIs & Services (with evaluation)

**Lead generation / data**
| Tool | Verdict | Notes |
|---|---|---|
| **Apollo** | ✅ Primary | Best value: sourcing + enrichment + basic sequences in one; ~$49–99/seat/mo. Good US SMB coverage (estate/antique/liquidation). |
| **Clay** | ✅ 90-day | Powerful waterfall enrichment + automation; ~$149–349/mo. Add once volume justifies it. |
| **ZoomInfo** | ❌ Skip (now) | Best data but enterprise pricing (often $15k+/yr). Not budget-appropriate pre-scale. |
| **HubSpot** | ◐ Optional | Free CRM tier is a fine UI/mirror; paid Marketing Hub not needed early. |
| **Instantly** | ✅ Outreach | Cheap, high-volume cold email + inbox rotation + warmup; ~$37–97/mo. |
| **Google Maps (Places)** | ✅ High-ROI | Source local estate-sale companies, antique dealers, consignment/auction houses by geo. Pay-as-you-go, cheap. |
| **Industry directories** | ✅ High-ROI | EstateSales.net, EstateSales.org, AuctionZip, NAA (auctioneers), antique-dealer assns, consignment directories — rich, targeted, low cost. |
| **LinkedIn workflows** | ⚠️ Caution | Strong for auctioneers/dealers but automated scraping/outreach violates ToS and risks bans — use manual/Sales-Navigator-assisted, not automated scraping. |
| Smartlead | ✅ Alt to Instantly | Similar price/features; either is fine. |

**Recommended sourcing mix for AAC's seller types:** Google Maps + directories (local
estate/antique/consignment/auction) → Apollo enrichment → Clay later for hard-to-find
executors/downsizers/online resellers (intent + waterfall).

---

## 7. Video Generation Architecture — Demonstration-Led (the differentiator)

**Recommendation: Hybrid = real screen recordings + AI voiceover + lightweight programmatic
assembly, with optional avatar intros for personalization.** AAC's unfair advantage is a
*working platform*; show it.

```
  Feature/story → video-script skill → shot list + VO script + captions
        │
        ├─ Screen capture of REAL flows (Seller Studio, AI Catalog, auction create, bidding)
        ├─ Voiceover: ElevenLabs (consistent brand voice, multilingual later)
        ├─ Optional avatar intro/outro: HeyGen (talking-head, per-seller-type personalization)
        ├─ Assembly: Remotion (code-driven, in-repo, free) OR Creatomate (templated API)
        └─ Output → Cloudinary → landing pages / email / social (auto-captioned short cuts)
```

**Tool evaluation**
| Tool | Role | Verdict |
|---|---|---|
| **ElevenLabs** | Voiceover | ✅ Core — cheap (~$22/mo), best-in-class TTS, one brand voice across all videos. |
| **Remotion** | Code-driven assembly (React) | ✅ Core if we want full control + in-repo templates; free, fits a Node shop. |
| **Creatomate** | Templated video API | ✅ Alt — faster to start than Remotion, per-render pricing; good for scale. |
| **HeyGen** | AI avatars / personalized video | ◐ Selective — recruitment intros + per-seller-type personalization at scale (~$29–89/mo). |
| **Synthesia** | AI avatars (enterprise) | ❌ Skip — pricier than HeyGen for the same need. |
| **FFmpeg** | Encoding/crop/caption | ✅ Glue — free, already trivial on Railway; powers short-form cropping + caption burn-in. |
| **CapCut automation** | Short-form edit | ◐ Manual fallback — no stable API; use Remotion/FFmpeg for automation instead. |
| **Runway / Veo** | Generative b-roll | ◐ Occasional — expensive per-second; only for hero/brand pieces, never the core demo loop. |
| **Bannerbear** | Templated images/thumbnails | ✅ Cheap — auto thumbnails, social cards, ad creative. |

**Why demonstration-led wins for AAC:** higher trust (sellers see exactly what they'd do),
zero stock-footage cost, infinitely re-cuttable into shorts, and it doubles as onboarding/
help content. Personalize by seller type by swapping the avatar intro + the example lot
category (jewelry for estate, tools for liquidators, antiques for dealers).

---

## 8. Lead Generation Architecture

```
 SOURCES → INGEST → DEDUPE → ENRICH → CLASSIFY(seller type) → SCORE(fit 0-100) →
 SEGMENT → SUPPRESS-CHECK → ROUTE to campaign → CRM(prospects/leads) → Outreach
```
- **Sources:** Google Maps Places (geo + category), industry directories (scraped within ToS
  / via partnerships), Apollo search, referrals, inbound forms.
- **Qualify/score:** rule + Claude hybrid — firmographic fit (type, size, geo, has inventory
  cadence) + signals (active estate sales, frequent listings) → 0–100, with rationale stored.
- **Enrich:** Apollo first; Clay waterfall for misses (email, phone, owner, socials).
- **Segment:** the 10 seller types → distinct value props + sequences + demo videos.
- **Route:** score ≥ threshold → outreach; mid → nurture; low → hold. All transitions
  audit-logged; suppression + do-not-contact enforced server-side.

---

## 9. CRM Architecture

**Native, Postgres-first (system of record); external CRM optional mirror.**
Proposed tables (additive, gated migration when built — not now):
- `gtm_prospects` (company, domain, seller_type, geo, source, fit_score, status, owner)
- `gtm_contacts` (person, email, phone, role, prospect_id, consent/suppression flags)
- `gtm_campaigns` (name, seller_type, channel, budget_cents, goal, status)
- `gtm_sequences` + `gtm_sequence_steps`
- `gtm_touches` (contact_id, campaign_id, channel, sent/open/click/reply, ts)
- `gtm_scores` (history), `gtm_assets` (content/video refs), `gtm_metrics` (daily marts)
Reuse `audit_log` for every state change. Optional HubSpot Free as the human-facing UI via a
one-way (or two-way) adapter; never the source of truth. Surface a "Growth" tab in the
existing admin app rather than a new app.

---

## 10. 30-Day Roadmap (Quick Wins)
1. Stand up the **CRM spine** (Postgres tables + a read-only admin "Growth" view).
2. **Apollo** account + manual+API sourcing of 3 seller types (estate companies, antique
   dealers, liquidators) in target metros.
3. **Separate cold-email domain** (e.g. `try.advantage.bid` / a fresh domain) + **Instantly**
   with warmup; do NOT touch the SES transactional domain.
4. **Claude content**: 4 cornerstone blog posts + 12 social posts + 1 landing page per seller
   type (start with 2 types).
5. **2–3 demonstration videos** (screen capture + ElevenLabs VO + FFmpeg/Remotion) of Seller
   Studio + AI Catalog + "create your first auction."
6. Launch one **cold sequence** per seller type (50–100 prospects each) and measure.

## 11. 90-Day Roadmap (Medium-Term)
- Add **Clay** for waterfall enrichment + harder seller types (executors, downsizers, online
  resellers); add **Google Maps** automated geo-sourcing.
- **Growth Orchestrator + Lead-Gen/Outreach/Content sub-agents** (hybrid) replace the manual
  MVP; orchestrator owns CRM writes + spend caps.
- **HeyGen** personalized intro videos per seller type; scale to ~15–20 videos.
- **PostHog** funnel + CAC/ROI dashboards; weekly auto `campaign-report`.
- Optional **HubSpot Free** mirror for human reps; retargeting pixel on landing pages.

## 12. 12-Month Roadmap (Strategic)
- Full **autonomous, budget-capped campaign management** (orchestrator runs daily, proposes,
  human approves spend over a threshold).
- **Content/video flywheel**: every closed auction → success-story short auto-drafted.
- **Attribution model** tying spend → signups → GMV (CAC vs LTV by seller type).
- Self-hosted/owned data assets (proprietary seller directory) to reduce provider dependence.
- Cross-pollinate with **Seller Success / Buyer Success / Agreement** assistants on the shared
  CRM spine (one customer graph).

---

## 13. Budget Estimates (monthly, USD; ranges)
| Phase | Tools | Est. /mo |
|---|---|---|
| 30-day | Apollo ($49–99), Instantly ($37–97), ElevenLabs ($22), domain/warmup ($15–30), Claude API usage ($50–150), Bannerbear ($0–49) | **~$200–450** |
| 90-day | + Clay ($149–349), HeyGen ($29–89), PostHog (free→$0–50), Google Maps API ($20–100), Creatomate (opt $41+) | **~$450–1,000** |
| 12-mo | + scaled sends/seats, retargeting ad spend (variable), possible HubSpot paid | **~$1,000–2,500 + ad spend** |
Compute/storage ride on existing Railway/Neon/Cloudinary. ZoomInfo intentionally excluded.

## 14. Risk Analysis
- **Deliverability / domain reputation (HIGH):** cold outreach on the SES transactional
  domain would jeopardize bids/invoices/agreements. *Mitigate:* separate domain + dedicated
  cold-email tool + warmup + strict volume ramps.
- **Compliance (HIGH):** CAN-SPAM, CASL, GDPR/CCPA — consent, unsubscribe, suppression,
  data-retention. *Mitigate:* server-side suppression + footer + opt-out honored everywhere;
  legal review before scale.
- **LinkedIn / scraping ToS (MED):** automation risks bans/legal. *Mitigate:* manual/Sales-
  Navigator-assisted only; no automated scraping.
- **Data accuracy / wasted spend (MED):** bad emails hurt deliverability + CAC. *Mitigate:*
  verify before send (bounce checks), score before enrich.
- **Brand damage from over-automation (MED):** spammy AI content/video erodes trust.
  *Mitigate:* human approval gates, quality bars, demonstration-led (real) content.
- **AI content SEO risk (LOW-MED):** thin AI pages can be devalued. *Mitigate:* depth,
  originality, real platform data/case studies.
- **Provider lock-in / cost creep (MED):** *Mitigate:* adapter pattern, Postgres as source of
  truth, monthly spend caps in the orchestrator.
- **Distraction from launch (MED):** *Mitigate:* this is explicitly post-stabilization; do not
  start until current priorities ship.

## 15. Ranked Implementation Priorities
Ranked by ROI × speed ÷ cost/complexity:
1. **CRM spine in Postgres** — enables everything; ~free; foundation. (Quick)
2. **Demonstration videos (screen + ElevenLabs)** — unique, cheap, reusable for marketing
   AND onboarding. (Quick)
3. **Apollo + Instantly cold outreach on a separate domain** — fastest path to measurable
   seller conversations. (Quick)
4. **Claude content engine** — SEO + nurture fuel; near-zero marginal cost. (Quick)
5. **Analytics (PostHog + marts)** — without CAC/ROI you can't optimize. (Medium)
6. **Hybrid agent orchestration** — turns the manual MVP into a scalable subsystem. (Medium)
7. **Clay + Google Maps + directories at scale** — deeper/wider sourcing. (Medium)
8. **HeyGen personalization + retargeting** — incremental conversion lift. (Medium/Long)
9. **Full autonomous, budget-capped campaigns + attribution** — strategic compounding. (Long)

Lowest priority / defer: ZoomInfo, Synthesia, generative b-roll (Runway/Veo) as core,
CapCut automation — flashy or costly relative to seller-acquisition impact.

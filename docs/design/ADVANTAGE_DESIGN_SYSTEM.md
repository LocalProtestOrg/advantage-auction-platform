# Advantage.Bid Design System

The governing design reference for Advantage.Bid. Practical, not a thesis — it documents the standards
the product actually uses. **New pages reference this document instead of redefining the design
language.** The implementation lives in **`public/widgets/shared/onboarding.css`** (the `ob-` component
classes). Terminology follows `MARKETPLACE_ARCHITECTURE.md`.

---

## Principles

- **Brand philosophy.** Refined, trustworthy, editorial. A serif display face (Fraunces) over a warm
  paper background signals a curated marketplace, not a generic web app. Calm palette, generous space,
  one clear action per screen.
- **"Stupid Easy" UX.** One primary action per screen; the software figures out routing (sign-in →
  auto-continue). Never make the user hunt. Plain language over jargon.
- **Trust-first.** Say what happens next and what stays private *before* asking for anything. No dark
  patterns, no aggressive upsell. Show security/no-obligation reassurance near the CTA.
- **Mobile-first.** Design the single-column phone layout first; grids collapse to one column at
  ≤640px. Tap targets ≥44px. Content width caps so lines stay readable on desktop.
- **Accessibility.** Visible keyboard focus (`:focus-visible`), semantic heading order, labeled
  inputs, `prefers-reduced-motion` honored, sufficient contrast, real `<button>`/`<a>` elements.

## Typography

- **Display / headings:** `Fraunces` (700 h1, 600 h2/h3), `Georgia, serif` fallback. Loaded via the
  standard Google Fonts link. `--ob-serif`.
- **Body / UI:** `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`. `--ob-body`.
- **Scale:** h1 `clamp(30px,6vw,46px)`; lede `18px`; body `~15px`; captions/hints `12.5–13.5px`;
  uppercase eyebrow/kicker `12.5px`, weight 800, letter-spacing `.09em`.
- Line-height `1.55` body; headings `1.08–1.2`; `text-wrap:balance` on h1.

## Spacing

- Page container: `--ob-maxw: 860px` (narrow forms `600px`), side padding `18px`.
- Hero padding `48px 18px 30px`; section padding `~24px`; card padding `18–22px`.
- Grid/stack gap `12–16px`. Prefer fl/grid `gap` over per-element margins.

## Colors (tokens)

| Token | Value | Use |
|---|---|---|
| `--ob-ink` | `#0B1B2B` | primary text |
| `--ob-paper` | `#FBFAF7` | page background |
| `--ob-surface` | `#fff` | cards/panels |
| `--ob-muted` | `#5b6b7e` | secondary text |
| `--ob-hair` | `#ECE8E0` | borders/dividers |
| `--ob-accent` | `#2F6BFF` | primary action, links |
| `--ob-live` | `#B5273B` | urgency / estate-sale CTA |
| `--ob-ok` | `#16A34A` | success / checklist ticks |

Semantic color (ok/warn/live) is separate from the accent. Design for light theme; keep contrast AA.

## Reusable components (`ob-` classes in onboarding.css)

- **Hero pattern** — `.ob-hero` > `.ob-kick` (eyebrow) + `.ob-h1` + `.ob-lede`, centered, one primary CTA.
- **Three-question strip** — `.ob-answers` (3 × `.ob-ans` with `.ob-ans-q`/`.ob-ans-a`). Every
  onboarding page answers **What am I doing? · What happens next? · Will my info be public?** before
  scroll. Collapses to one column on mobile.
- **"Why Advantage.Bid" benefit block** — `.ob-grid` of `.ob-card`s (h3 + p). Standard four cards:
  *Why Advantage.Bid · Simple and quick · Found everywhere · No strings attached.*
- **Cards** — `.ob-card` (surface, hair border, radius 14). Feature grid `.ob-grid` (2-up → 1-up).
- **Forms** — `.ob-form` (labels 13.5px/600, inputs 11–12px padding, radius 9, focus ring = accent),
  `.ob-hint`, `.ob-err`, required marker `.req`. Panel form on `.ob-panel`.
- **Buttons** — primary `.ob-cta` (accent) / urgency `.ob-cta.ob-cta-live`; secondary `.ob-cta-2`
  (outline); `.ob-cta-full` for forms. One primary per view.
- **Tables** — light rows on surface, hair row-dividers, `font-variant-numeric: tabular-nums` for
  figures, wrap wide tables in an `overflow-x:auto` container.
- **Callouts** — `.ob-callout` variants `.ob-privacy` (private), `.ob-privacy-pro` (professional),
  `.ob-success`, `.ob-warn`.
- **FAQ** — `.ob-faq` `<details>`/`<summary>` accordions (+/– affordance). Pair with FAQ JSON-LD.
- **Progress indicators** — `.ob-steps` pills (`1. … 2. … 3. …`) for multi-step funnels.
- **Empty states** — centered icon/emoji + one line of what's missing + one action link. Never a bare
  "no data".
- **Loading states** — a single muted line ("Loading…") in the content area; skeletons only for
  data-dense views. Never a blank screen.
- **Dashboard panels** — `.ob-panel` (surface card, soft shadow) as the panel unit; summary before
  detail; state shown as a pill/badge, not just a number.

## Privacy messaging (required)

- **Private/individual sellers:** "Your personal profile stays private — never published as a
  searchable profile. Only the auctions and events you publish are visible." **Enforced server-side**
  (`src/lib/sellerBranding.js`: private/individual are always anonymous).
- **Professional sellers:** "Your company profile, events, and Advantage.Bid Auctions are public —
  build trust and attract customers through your profile."
- **Claim Listing:** claiming does not immediately unlock Marketplace posting; upgrades are tasteful,
  never aggressive.

## Microcopy

- Buttons say exactly what happens: "Continue to seller agreement →", "Promote My Estate Sale",
  "Sign in / Create account". Sentence case.
- Errors explain what's wrong and how to fix it, no apologies. Success confirms the action.
- One vocabulary everywhere (see below). Reuse the same phrasing across pages — don't say the same
  thing three different ways.

## Navigation terminology (locked — see MARKETPLACE_ARCHITECTURE.md)

Customer-facing families: **Advantage.Bid Auctions · Auction Partner Events · Estate Sales ·
Marketplace** (fixed-price). **Professionals** is a separate directory, never labeled "Marketplace".
Do not use "Events/Auctions" as a family label, "Promotional Events", or "Other Estate Services".

## SEO + AI requirements (per indexable page)

Title, meta description, `rel=canonical`, OpenGraph, Twitter card, appropriate JSON-LD (Event /
Service / Organization / BreadcrumbList / FAQ), semantic HTML + correct heading order, internal links.
Authenticated funnels use `noindex` (no SEO markup needed). Content must be machine-readable for Google
and AI search (ChatGPT/Perplexity/Gemini/Claude).

## Dashboard standards

Role-aware shell + shared nav; summary-first; state as pills; `.ob-panel` cards; empty/loading states
per above; same tokens/typography as onboarding. (Full dashboard retrofit = Consistency Week.)

## Email standards

Single-column, ≤600px, system font stack (email clients don't reliably load Fraunces — use a serif
fallback for headings), accent CTA button, plain-text fallback, unsubscribe honored, SMS opt-in only,
one vocabulary. No vendor names in customer-visible copy.

---

*Implementation: `public/widgets/shared/onboarding.css`. Governing terminology:
`MARKETPLACE_ARCHITECTURE.md`. Data/integrity: `docs/architecture/marketplace-integrity-architecture.md`.*

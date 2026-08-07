# Roadmap Milestone — Consistency Week (pre-launch)

**Status:** PLANNED milestone. **No feature work — polish only.** One complete crawl of the entire
platform before launch to make every surface feel like one professionally designed product.

## Purpose
A single, focused pass across the whole platform (Railway + Brilliant Directories + emails +
dashboards + widgets) to eliminate visual, terminology, and structural inconsistencies. The Phase 6A
onboarding design system (`public/widgets/shared/onboarding.css`) and the locked marketplace
vocabulary (`src/lib/marketplaceVocabulary.js`) are the reference standards.

## Scope (audit + polish, no new features)
- **Surfaces:** Railway pages, Brilliant Directories pages, transactional emails, seller/buyer/admin
  dashboards, widgets, navigation, every public page, every onboarding page, every dashboard.
- **Dimensions:** SEO (titles/description/canonical/OG/Twitter/JSON-LD), schema validity,
  accessibility (focus states, alt text, heading order, contrast), internal linking, terminology (one
  vocabulary everywhere), spacing, icons, colors, button styles, typography, tooltips.

## Checklist (per surface)
1. Uses the onboarding design system (or the platform's shared components) — no bespoke one-off styles.
2. Terminology matches the locked vocabulary (Advantage.Bid Auctions / Auction Partner Events / Estate
   Sales / Marketplace; Professionals kept separate). No "Events/Auctions" used as a family label, no
   "Other Estate Services", no "Marketplace" used for the directory.
3. SEO head complete on every indexable page; `noindex` correct on authenticated pages.
4. First screen answers: what am I doing / what happens next / will my info be public.
5. Accessibility: keyboard focus visible, `prefers-reduced-motion` honored, semantic headings.
6. Buttons, CTAs, success/error copy use the standardized microcopy.
7. Mobile + desktop verified.

## Gates
- `npm run gate` (jest + strict Marketplace Integrity) green.
- Manual desktop + mobile spot-check of the top 20 pages.
- BD-side items that cannot be changed from Railway are collected into an owner manual-update checklist.

## Explicitly out of scope
No new features. No importer/architecture changes. Polish and consistency only.

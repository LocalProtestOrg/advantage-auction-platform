# Deliverable 7 — Calibration / Weighting Model

**Phase 3P · 2026-09-09**

## Part A — Reference weighting

| Owner status | Weight | Meaning |
|---|---|---|
| OWNER_APPROVED | 1.0 | In the library because the Owner put it there |
| OWNER_GOLD_STANDARD | 2.0 | The Owner said this one is the standard for its kind |
| OWNER_DO_NOT_USE | −1.0 | Negative evidence: its attributes become anti-patterns for the class; never a positive reference |
| RETIRED | 0 | File removed; record kept for provenance |

Effective weight = owner weight × relevance factor (primary 1.0 / secondary 0.5 / family-compatible-only 0.25) × facet similarity (0–1).

**Current state: all 13 references are OWNER_APPROVED (1.0).** No information in the folders or the brief distinguishes one image from
another, so nothing was promoted. Gold Standard is deliberately scarce: the system never promotes automatically, not on performance, not on
frequency of retrieval, not on analyst opinion.

**How the Owner promotes one, simply:** say it — "the Fine Art & Antiques one is gold standard" — to Desktop Marketing, or move the file into
a `gold-standard/` sub-folder inside its category. Either path appends a `status_history` entry with the date, the source and (for a
statement) his words, sets `owner_status`, and the indexer recomputes the weight. Demotion is the same sentence in reverse.

Suggested first candidates for the Owner to consider (his call, not made for him): REF-02 for general auctions, REF-09 or REF-10 for
on-site estate sales, REF-12 for single hero lots, REF-13 for category lineups.

## Part B — Reference calibration score (per generated creative)

The score answers one question: *does this new creative behave the way the Owner's approved references behave, without looking like any
of them?* It is computed after the existing audit, never instead of it.

### B1. Measurable principles (from the existing compositor metrics + new measurements) — 60 points

| Principle | Measure | Target | Points |
|---|---|---|---|
| Merchandise-forward | `merchandise_pct` (or photograph area for ENVIRONMENTAL_PHOTO) | inside the family band (e.g. scene 50–65; scatter 65–85; lineup 45–55; environmental 50–65; single lot 45–60) | 12 |
| Restrained copy | `text_region_pct` | ≤ 18 (GENERAL), ≤ 26 (LOGISTICS), ≤ 12 (TEASER) | 8 |
| Copy count | `text_budget_audit` block count | ≤ profile budget | 6 |
| Hierarchy: one dominant title | largest text box height ≥ 2.2 × next text box; title 2–6 words | pass | 8 |
| Date > time | date box height > time box height | pass (event families) | 3 |
| Controlled occupancy | `largest_empty_pct` | ≤ 6 (scene) · ≤ 10 (panel families) · n/a (single lot: negative space is deliberate) | 6 |
| Merchandise rises | `upper_half_merch_pct` | ≥ 30 (scene/panel) | 5 |
| Depth diversity | planes present, meaningful ≥ decorative overlaps | scene families only | 6 |
| Light ground | ground luminance ≥ family threshold | as family requires | 3 |
| Brand frame | logo, band, wordmark present at spec | pass | 3 |

Points are awarded fully inside the band, linearly down to 0 at ±50% outside it.

### B2. Judged principles (vision-model rubric, principle adherence not similarity) — 40 points

The judge receives the candidate render, the `principle_profile` text, and the family — **not the reference images**. It scores each item
0–4 with a one-line reason:

1. The eye enters at the presenter, moves to one event title, then to the merchandise (hierarchy clarity).
2. The merchandise looks staged by a set designer: heavy things sit, art hangs, small things come forward (scene families) / objects are
   arranged for comparison (lineup) / the room is inviting and legible (environmental).
3. Objects have confident scale variation and at least one clear anchor.
4. Typography is confident and, where used expressively, truthful to the event.
5. Colour comes from the merchandise; the ground and panels stay quiet.
6. Nothing reads as filler: no slogans, no icon piles, no words on merchandise, no duplicate URLs.
7. It reads at thumbnail size (headline + wordmark legible at 281px).
8. It would not be mistaken for a template with swapped merchandise (editorial irregularity).
9. It does not look like any specific competitor ad (the judge is asked whether it evokes a particular seller's identity; a "yes" scores 0).
10. Overall: would the Owner say "good" (0), "much better" (2), "love this" (4)? — the judge must justify with reference to items 1–9.

Judge prompt and model version are recorded in provenance. Two judge runs with different seeds; average; if they disagree by > 8 points,
flag for Desktop Marketing.

### B3. Hard checks (any failure → score 0 and HARD FAIL regardless of points)

- Seller-mark leak (OCR / logo match against `do_not_copy`).
- Similarity to any retrieved or library reference above τ_ref, or to the published-graphic anchor above τ_pub (Deliverable 10).
- Any object whose `auction_id` differs from the brief's.
- `merchandise_mode = representative` in an auction/estate/notable-lot/closing campaign.
- Claim manifest failure (A2) — including a lot-count or material claim that cannot be verified.

### B4. Thresholds and decision

| Score | Decision |
|---|---|
| ≥ 70 | ACCEPT (subject to the existing gates and any Owner-review flag) |
| 50–69 | REGENERATE |
| < 50 | FALLBACK to the certified default family, re-score; if still < 50 → BLOCKED_CALIBRATION |

Confidence modifiers: an empty-class retrieval sets confidence LOW and forces `owner_review_required = true` whatever the score; a class
with a Gold Standard reference raises the ACCEPT bar to 75 because the Owner has told us exactly what good looks like.

### B5. Regression anchors

Score the certified 3M.3 B1/B2/B3 renders against the library with the CENTERED_WHITE profile on the first run and store the result as
the regression baseline (expected: high on hierarchy, depth and brand frame; merchandise share below the new band → a score in the 60s
is plausible and would confirm the C6 calibration finding rather than fail the build). Any change to the scorer must re-run these anchors.

## Part C — Two signals, kept apart

| | Owner approval | Campaign performance |
|---|---|---|
| Source | Owner statements, folder placement, review buttons | `marketing_performance_facts`, social insights, email metrics |
| Stored in | `owner_status`, `owner_weight`, `status_history` | `performance` (reference) / `marketing_learnings` (creative) |
| Can raise a reference's weight | yes | **no** |
| Can demote a reference | yes | **no** |
| Can choose among candidates | via calibration score | only among candidates that already passed calibration and Owner gates |
| Can add a reference to the library | yes (Owner says "love this" on a generated creative) | no — a high-performing creative is proposed to the Owner, never auto-added |
| Can change a rule | yes, through Desktop Marketing → RULE_PROPOSAL → Owner | can only *propose* (CALIBRATION_REPORT) |

Both matter. A creative the Owner loves that underperforms is a learning about placement, timing or audience first; a creative that performs
but the Owner would not put in the library is not the house style, however well it did.

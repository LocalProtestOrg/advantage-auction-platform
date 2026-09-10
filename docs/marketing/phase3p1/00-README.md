# Phase 3P.1 — Owner Creative Feedback + Authentic Media Selection + Physical Merchandise Intelligence

**Advantage.Bid Autonomous Marketing Agency · Desktop Marketing · 2026-09-10**

Converts the Owner's review of the first six production proving-ground creatives (West University A/B/C, Individual Seller A/B/C,
2026-09-09) into a precise refinement of the creative intelligence system and a VS Code handoff. Production was not modified. Nothing was
published, generated for external marketing, or spent. No production code was written; two reference implementations with tests are
included for porting.

## Missions

| # | Mission | File | Machine artifact |
|---|---|---|---|
| 1 | Record feedback model (attribute-level; scorer post-mortem) | `01-owner-feedback-record.md` | `owner-feedback-2026-09-10.jsonl`, `config/feedback-record.schema.json`, `config/approved-messages.json`; 7 lines appended to `approved-creative-examples/owner-decisions.jsonl` |
| 2 | Authentic media-first Creative Director | `02-authentic-media-director.md` | `config/media-source-hierarchy.json` |
| 3 | Video walkthrough intelligence | `03-video-walkthrough-intelligence.md` | (pipeline spec; tier 2 of the config) |
| 4 | Physical merchandise intelligence | `04-physical-merchandise-intelligence.md` | `config/object-taxonomy.json` (54 classes), `config/relationship-rules.json`, `reference/physical_audit.py` + tests |
| 5 | Composition intelligence (scene planning) | `05-composition-intelligence.md` | plan shape in the doc |
| 6 | Space utilization | `06-space-utilization.md` | `config/coverage-bands.json` |
| 7 | Brand prominence | `07-brand-prominence.md` | `config/prominence-rules.json` |
| 8 | Event-type prominence | `08-event-type-prominence.md` | `config/prominence-rules.json` |
| 9 | Capitalization | `09-capitalization.md` | `config/capitalization-rules.json`, `reference/title_case.py` (12/12) |
| 10 | Next proving grounds | `10-next-proving-grounds.md` | — |
| 11 | VS Code handoff | `11-vscode-handoff.md` | — |

## What the Owner's feedback established (short form)

A real photograph taken by a person beats manufactured composition — the Director now evaluates event media before it may build a
collage. "Estate Sale" must be visually obvious — the event type is a first-class text role with size floors. Advantage.Bid identity must
be recognisable at feed size — prominence is measured, not assumed. Objects must obey believable size and physical relationships — a
semantic taxonomy, a relative-scale model and a collision audit run before rendering (the reference audit finds twelve violations in
Individual Seller A and none in a planned alternative). Merchandise must use the canvas — coverage and accidental voids are hard gates.
Headlines use the Owner's title-style capitalization. "You Can Do This." is approved copy even though its first visual execution was
not. Nothing was marked Gold Standard.

## Certification questions

| Question | Answer |
|---|---|
| Was any Owner decision overstated (Gold Standard, library admission, message approval)? | NO — C is rank 1 of 3 with `explicitly_not_gold`; only "You Can Do This." is OWNER_APPROVED_MESSAGE |
| Was production modified, anything published, external marketing generated, or money spent? | NO |
| Was any video, photograph or object invented, generated or enhanced beyond crop/straighten/exposure? | NO — the only images produced are audit test renders of existing demo assets, labelled as evidence |
| Are Phase 3P's anti-copy, seller-identity stripping, factual QA, provenance and Owner-review safeguards preserved? | YES — unchanged and extended |
| Did the reference audit reproduce the Owner's objections to Individual Seller A? | YES — through, protected-feature occlusion, scale and support violations |

ADVANTAGE.BID PHASE 3P.1 PHYSICAL CREATIVE INTELLIGENCE: READY FOR VS CODE

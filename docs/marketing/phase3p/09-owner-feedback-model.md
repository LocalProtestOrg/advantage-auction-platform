# Deliverable 9 — Future Owner Feedback Model

**Phase 3P · 2026-09-09**

## Design goal

The Owner says what he thinks in his own words, wherever he already is. The system turns that into durable calibration data. He never
opens a metadata file, never learns what JSON is, and never has to remember a vocabulary.

## Three input paths, one ledger

| Path | Available | How the Owner uses it | What the system does |
|---|---|---|---|
| **1. Say it to Desktop Marketing** (chat) | now | "That one's gold standard." "Love the Fine Art & Antiques one." "Don't use the mancave scatter style again." "The West University test is good, come back 10% on the title." | Desktop Marketing resolves which reference or generated creative he means (by name, by description, by the last thing shown), writes the sidecar change and an entry in `owner-decisions.jsonl`, and commits to the repo. VS Code ingests on the next index build. |
| **2. Move a file** (folder) | now | Drop into a category folder = approved. Move into `<category>/gold-standard/` = gold. Move into `<category>/do-not-use/` = negative. Delete = retire. | The indexer reconciles folders against sidecars by content hash and writes the status change with source `owner_folder_move`. A new image without a sidecar is indexed as OWNER_APPROVED with a stub record and a task for Desktop Marketing to write the visual read. |
| **3. Press a button** (admin page, future) | after VS Code builds it | An admin page "Creative References" shows library thumbnails and the queue of generated creatives awaiting review, each with **Good / Love this / Gold standard / Don't use this style / Note…** | Buttons write the same fields through an API with source `admin_ui_button` (library) or `owner_review_of_generated_creative` (queue); a generated creative marked "Love this" or "Gold standard" is copied into the library with Advantage.Bid provenance and a sidecar generated from its brief and metrics. |

All three paths append to one append-only ledger, `approved-creative-examples/owner-decisions.jsonl`:

```json
{"ts":"2026-09-20T15:04:00Z","source":"owner_statement_via_desktop_marketing","owner_words":"that fine art and antiques one is the gold standard for general auctions","resolved":{"reference_id":"REF-02","sha256":"…"},"action":"SET_STATUS","status":"OWNER_GOLD_STANDARD","recorded_by":"desktop-marketing"}
{"ts":"2026-09-21T09:12:00Z","source":"owner_review_of_generated_creative","owner_words":"good, come back 10% on the title","resolved":{"creative_job_id":"cj_…"},"action":"CALIBRATION_NOTE","note":{"element":"title","direction":"smaller","amount_pct":10},"recorded_by":"admin-ui"}
```

The ledger is the audit trail; the sidecars are the current state; `index.json` is the build.

## Vocabulary mapping (conceptual equivalents, not required words)

| The Owner says (or presses) | Meaning | Effect |
|---|---|---|
| good · approved · like it · yes · keep | OWNER_APPROVED | library: status; generated creative: eligible to be added to the library as OWNER_APPROVED (Advantage.Bid provenance) and passes Owner review |
| love this · gold · gold standard · perfect · that's it | OWNER_GOLD_STANDARD | status and weight 2.0; class ACCEPT bar rises to 75 |
| don't use this style again · no · never that · not us | OWNER_DO_NOT_USE | negative evidence; if he names the *style* ("scatter", "dark", "too much text") the attribute is recorded as an anti-pattern for the class, not just the file |
| come back 10% · bigger · smaller · less text · more merchandise | CALIBRATION_NOTE | a band adjustment proposal for the family (RULE_PROPOSAL to VS Code after Desktop Marketing confirms) — never an instant rule change |
| remove it · take it out | RETIRED | record kept, file may be deleted |
| this one for estate sales (moving or naming a category) | reclassify | `owner_folder` updated; primary class re-evaluated by Desktop Marketing |

Ambiguity is resolved by asking one question ("the Fine Art & Antiques square, or the Estate Auction landscape?"), never by guessing.

## Generated creatives → library (closing the loop)

When the Owner approves a generated creative (proving ground or production), it becomes the first non-Lewis & Maese reference:

1. The render is copied into the category folder with a stable name (`advantagebid-<class>-<date>-<jobid>.png`).
2. A sidecar is generated automatically from the brief, metrics, audit, retrieved references and calibration score — no analyst needed —
   with `source.seller = "Advantage.Bid"`, `seller_hierarchy` from the brief, and the Owner's words in `status_history`.
3. The index rebuilds; seller concentration falls below 100% for the first time; the co-brand hierarchy gets its first calibrated example.

This is how the library grows without dilution: only what the Owner approves enters.

## What the Owner is never asked to do

Edit a file. Learn a schema. Remember a keyword. Approve every creative (only classes without references, first creatives of a new
family, and proving grounds require his review). Explain why — his words are recorded as given; the analysis is Desktop Marketing's job.

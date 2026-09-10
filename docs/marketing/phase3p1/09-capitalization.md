# Mission 9 — Capitalization

**Phase 3P.1 · 2026-09-10 · Config: `config/capitalization-rules.json` · Reference: `reference/title_case.py` (12/12 Owner and edge-case tests pass)**

## The Owner's convention, formalised

Primary creative headlines and major labels use natural title-style capitalization where grammatically appropriate:

> It's Built to Be Easy. · You Can Do This. · Help Is Here. · Estate Sale

Not mechanically uppercase. Not sentence-style lowercase. The six proving-ground creatives set every headline in sentence case
("It's built to be easy.", "You can do this.", "Help is here.") and the event type as a sentence-case subtitle; the place plate was fully
uppercase. All three are now wrong by rule.

## Where each style applies

| Style | Roles |
|---|---|
| **Title style** | headline, event type, event title, CTA, major labels, day labels, place names |
| **Sentence style** | support lines ("Create your own online auction on Advantage.Bid."), help lines, legal and representative-disclosure lines, session hours |
| **Uppercase (small-label device only)** | place plate bar, the locked kicker "ADVANTAGE.BID PRESENTS", AM/PM — never a headline, event type or title |
| **Fixed** | brand and proper-noun casing: Advantage.Bid, Lewis & Maese, Rolex |

## The rule set (Chicago-style, tuned to the Owner's examples)

Capitalize the first and last word, nouns, pronouns, verbs (Is, Are, Be, Do, Can, Will), adjectives, adverbs, subordinating
conjunctions, both halves of a hyphenated compound (On-Site, Two-Day), and the word after a colon or dash. Keep lowercase, unless first
or last: articles (a, an, the), coordinating conjunctions (and, but, or, nor, for, yet, so), short prepositions (at, by, in, of, on, to,
up, for, off, out, via, per) and "with". Apostrophes capitalize only the first letter (It's). Ampersands stay. A headline may carry a
trailing period if the copy source has one; an event type or label never gains one.

## Why "Do" is capitalized in "You Can Do This."

Because it is a verb — not for emphasis. The engine capitalizes by part of speech, not by visual weight, so the results stay consistent
across headlines the Owner has not seen yet.

## Engine integration

`title_case(text, role)` runs on every drawn string at brief-assembly time, after the copy engine and before rendering; the drawn-text
list already returned by the renderers (for the seller-mark gate) is checked again after render — a headline that OCRs as all-uppercase or
all-lowercase is a hygiene violation. Fixed tokens and Owner-approved messages are stored in their canonical casing and pass through
untouched. The kicker constant and the footer wordmark are outside the function (locked brand-frame values).

## Tests

The config carries twelve cases: the four Owner examples, hyphenation, ampersand, a mid-line article and preposition, the brand token in
two positions, a fully uppercase input, and a sentence-case support line. VS Code's port must pass all twelve and add one per new role.

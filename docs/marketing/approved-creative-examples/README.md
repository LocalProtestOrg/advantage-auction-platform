# Approved Creative Examples — how this folder works

This folder is the Owner's hand-picked library of advertisements he considers good creative work. It is deliberately small. It is **not** a
place to keep every ad ever made — only the ones the Owner would point to and say "like that".

## What the Owner does (no JSON, no Markdown, ever)

| You want to… | You do… | The system does… |
|---|---|---|
| Add a good example | Drop the image into the category folder that fits (`auction/`, `estate-sale/`, `notable-lot/`, `geographic-event/`, `individual-seller/`, `professional-seller/`, `buyer-growth/`) | On the next index build it is recorded as **OWNER APPROVED**, and Desktop Marketing is asked to write its description record |
| Say one is the best of its kind | Move it into a `gold-standard/` sub-folder inside its category (create the sub-folder if it is not there), **or** just tell Desktop Marketing "that one is gold standard" | It becomes **OWNER GOLD STANDARD** and counts double in calibration |
| Say "don't use this style again" | Move it into a `do-not-use/` sub-folder inside its category, **or** tell Desktop Marketing | It stays on file as a *negative* example — never used as something to aim for, only as something to avoid |
| Remove one | Delete the file | Its record is kept as RETIRED for history; it is never retrieved again |
| Rename or move one | Just do it | Records are keyed to the image itself (a content hash), so moving or renaming loses nothing |
| Change your mind | Move it back, or tell Desktop Marketing | Every change is kept in the record's history with the date |

You can also simply say things in conversation with Desktop Marketing — "good", "approved", "love this", "gold standard", "never that style
again", "come back 10%" — and it will turn those into the records. Nothing requires you to open a `.json` file.

## What is beside each image

`<image>.reference.json` — a description record written by Desktop Marketing after looking at the image: what kind of campaign it is, why it
works, which lessons transfer to Advantage.Bid, and which parts are the seller's own identity and must **not** be copied. These files are for
the software, not for you.

`index.json` — the machine index the production creative engine reads. `OWNER-CREATIVE-REFERENCE-INDEX.md` — the same map, readable.
`reference.schema.json` — the contract those records follow.

## What the references are used for — and not

The creative engine uses these images as **calibration evidence**: it learns *why* you like them (strong hierarchy, merchandise leading,
restrained copy, grounded objects, confident typography) and checks its own new work against those principles. It never copies a layout,
logo, colour scheme, typeface, wording or merchandise from them, and it never publishes them. Lewis & Maese's burgundy, gold, crest and
flourishes stay Lewis & Maese's.

Empty category folders are fine. They mean "no approved example yet for this kind of campaign", and the engine treats that class with extra
caution (Owner review is mandatory until you approve a first example).

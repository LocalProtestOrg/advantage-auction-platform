# Mission 8 — Event-Type Prominence

**Phase 3P.1 · 2026-09-10 · Config: `config/prominence-rules.json` → `event_type`**

## The finding

Every West University candidate set "West University" as a 134px headline and "Exclusive On-Site Estate Sale" as a sentence-case
subtitle. The place name was the largest thing on the page; what the event *was* took a second read. The Owner: "Event Type must be
substantially more prominent. 'Estate Sale' should be visually obvious."

This came from a Phase 3P rule derived half-right from the references: "place-name-led titles for on-site sales" (Katy, Pine Haven).
In those references the place name and the event type sit **together at the same size** ("KATY ESTATE SALE"; "PINE HAVEN / Estate
Sale"). The place led; the type never dropped to a subtitle. The published West University graphic — made by the seller — goes further
and leads with "ESTATE SALE". The corrected rule follows both.

## Text roles, separated

| Role | What it is | Source |
|---|---|---|
| SELLER | the presenter (co-brand) | seller record |
| EVENT_TYPE | what the event is: Estate Sale, Online Auction, On-Site Auction, Live Auction, Marketplace Sale… | event record (`event_mode` + `sale_type`); never invented |
| EVENT_TITLE | the name or place: West University, Heritage & Home | event record |
| DATE_TIME | date, sessions, hours | event record |
| LOCATION | city/state, neighbourhood, place plate | event record |
| ADVANTAGE_BID_PARTNERSHIP | the relationship line + logo mark (co-brand) or the presenter (Advantage.Bid-led) | brand frame |

Modifiers — "Exclusive", "On-Site", "Two-Day" — are qualifiers, not the type. They are set at no more than 45% of the event type's cap
height, or moved to the support line. They never dilute the type.

## Hierarchy rules

Comprehension order (seller-led): SELLER → EVENT_TYPE → EVENT_TITLE → DATE_TIME → LOCATION → PARTNERSHIP. Advantage.Bid-led:
ADVANTAGE_BID → EVENT_TYPE → EVENT_TITLE → DATE_TIME → LOCATION. This is the order in which a viewer should be able to answer "who,
what, which, when, where" — not a strict size ladder (the seller line may be smaller than the event type).

Size floors: the event type's cap height is at least 80% of the largest text element and at least 4.8% of canvas height; the date's cap
height is at most 85% of the event type's. The event type is never a subtitle, never wrapped into an orphan ("… Estate / Sale"), never
below the date in size.

Title-unit patterns the engine may choose:

- **TYPE_LED** — "Estate Sale" largest; "West University" on a second line at 60–100% of it. The pattern the Owner asked for.
- **UNIT** — place and type as one line at equal size: "West University Estate Sale" — only when it fits on ≤ 2 lines without an orphan.
- **TWO_LINE_UNIT** — "Pine Haven" / "Estate Sale", type ≥ 80% of the place line.

## Comprehension test (judge v2)

At the feed proxy the judge answers three questions: what kind of event is this; who is running it; when. The first must return the
event type, the second the seller (co-brand) or Advantage.Bid, the third the date. A wrong or hesitant answer is a hierarchy failure
regardless of the pixel measures.

## Vocabulary

Event types come from the production record only. If a record carries no type the creative uses the record's title and the packet flags
`event_type_missing` — the engine does not guess "Estate Sale" from a photograph of a living room.

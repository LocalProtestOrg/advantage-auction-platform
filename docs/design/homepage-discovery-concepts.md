# Advantage.Bid — Homepage / Discovery: Three Concepts

*The emotion we're designing for: a person opens Advantage.Bid and thinks **"I wonder what's around me."** Curiosity, not chores.*

This document does the thing the brief asked: **research → 3 completely different concepts → honest critique → one recommendation.** No code yet. The companion `ux-redesign-proposal.md` holds the full system (nav, design language, dashboards, perf) and supports whichever concept wins.

---

## Research — the *feeling* each product engineers (and the mechanic behind it)

Not "what they look like" — **what they make you feel**, and the trick that does it.

| Product | The feeling | The mechanic (what we can borrow) |
|---|---|---|
| **Google Earth** | Orientation + awe | A camera *move* from far → here. Spatial continuity = "I understand where I am." |
| **FlightRadar24** | Ambient liveness | Things move/pulse in real time. The world is *happening now*, and you're watching it. |
| **Pokémon GO** | "Stuff near me is interesting" | Location turns the mundane map outside your window into a board full of reasons to look. |
| **Airbnb** | Confident browsing | Map ⇄ list duality; you never feel lost choosing between "explore" and "decide." |
| **Zillow / Expedia** | Planning power | Pins + cards + "search this area." The map is a tool, not decoration. |
| **National Geographic** | Wonder | One enormous, gorgeous photograph. Story before specs. |
| **Spotify** | Effortless taste | Editorial rails with *human* titles. The app has opinions, so you don't have to work. |
| **Robinhood** | Calm confidence with data | Big numbers, tiny chrome, gentle motion. Serious, but not heavy. |
| **Apple / Tesla** | Premium minimalism | One decision per view; the product photo is the UI; everything else recedes. |
| **Arc / Notion** | "It gets me" | A command bar that is the whole app. Type intent, receive the world. |
| **Figma** | It's alive / multiplayer | Presence cues (cursors, counts) make a static canvas feel inhabited. |

**The synthesis question:** what should be the *center of gravity* of our homepage — the **map** (spatial wonder), the **feed** (editorial beauty), or the **command** (intelligent calm)? Each yields a genuinely different product. Here are all three.

---

## Concept A — **The Living Map** ("Atlas")
*Center of gravity: the map. Lineage: Google Earth + FlightRadar24 + Pokémon GO.*
**This is the literal answer to "I wonder what's around me."**

**The loading moment.** A deep, calm canvas. A soft map of the U.S. fades up. Then the camera **glides** — Google-Earth smooth, ~1.5s — from the national overview toward your place. As it settles, **auction pins bloom in**, one after another, like lights coming on in a city at dusk. Live auctions breathe with a soft pulse; "ending tonight" pins glow warm. A quiet counter rises: **"14 auctions near you."** Nothing asks you to do anything. You just *watch your area come alive.*

**Identity.** The map **is** Advantage.Bid. Tagline: *"Treasure is closer than you think."* It's a living radar of opportunity around you — a feeling no auction site has.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Advantage.Bid          ⌕ Search auctions, lots, places…       📍 ▾    ◎   │ ← floating translucent capsule
│                                                                            │
│              · · pins bloom in around your location · ·                    │
│         ◉ Estate Jewelry                                                   │
│              ◉ (pulsing: LIVE)        ◉ ◉                                   │
│                       ◉  ⟶  hover ⟶  ┌───────────────────┐                 │
│        ◉ ◉                            │ ▢ photo            │                │
│              YOU ◎                    │ Mid-Century Estate │                │
│                          ◉           │ Royal Oak · 9 mi   │                │
│         ◉                            │ Ends in 2h · 38 lots│                │
│                ◉ (glow: ends tonight) └───────────────────┘                │
│                                                                            │
│   ╭─────────────────────────────────────────────────────────────────────╮ │
│   │ 14 auctions near you   ·   Ending tonight  ·  Nearby  ·  Archive  ▸  │ │ ← results drawer (drag up)
│   ╰─────────────────────────────────────────────────────────────────────╯ │
└───────────────────────────────────────────────────────────────────────────┘
```
**Interaction.** Pins = auctions (clustered when dense). Hover/tap → an elegant preview card. A translucent command capsule floats top. A results drawer rises from the bottom (mobile) / docks right (desktop) — Airbnb duality, so map-lovers explore and list-lovers decide. Pan → "Search this area."

**Critique.**
- ✅ Nails the exact target emotion and makes the map the identity (both explicitly requested).
- ✅ Genuinely *justified* — our items are local (pickup), so place-first is honest, not gimmick.
- ✅ Screenshot-worthy; unlike any competitor.
- ⚠️ **Biggest real risk: sparse data.** Early on we have few live auctions — an empty map kills the magic. *Mitigation:* blend in the **8 historical-archive auctions** + nearest-active-regardless-of-distance + auto-expand radius until the board feels full + the drawer always lists *something*.
- ⚠️ Perf/SEO/accessibility: a map-hero can hurt LCP, thin the indexable text, and exclude non-spatial users. *Mitigation (already speced):* static map image for LCP, lazy-hydrate the GL map, full **list equivalent** in the drawer, `prefers-reduced-motion` skips the fly-in, SEO text below the fold.
- ⚠️ Some visitors *just want a list* — the drawer must be one tap to "full list."

---

## Concept B — **The Estate Story** ("Cover")
*Center of gravity: photography + curation. Lineage: National Geographic + Spotify + Apple.*

**The loading moment.** One breathtaking, full-bleed photograph of a real find — a crystal chandelier, a Patek dial, a Danish teak chair — fills the screen and drifts (slow Ken-Burns). A confident headline fades in: *"Every home has a story. Bid on the best ones."* Then it yields to a cinematic vertical scroll: editorial **collections** ("The Whitfield Estate — Evanston, IL"), Spotify-style rails, a quiet map *band* midway. Magazine-grade, photography-led.

**Identity.** Taste and curation. Advantage has an *eye*; you're browsing a beautifully edited gallery, not a database.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Advantage.Bid                              ⌕            📍 ▾          ◎   │
│                                                                            │
│        ███████████  full-bleed estate photograph (drifts) ███████████      │
│                                                                            │
│            Every home has a story.                                         │
│            Bid on the best ones.            [ Explore near me ]            │
├───────────────────────────────────────────────────────────────────────────┤
│  Ending tonight near you            →  [▢ big card][▢][▢][▢]               │ ← Spotify rails
│  Featured estates                   →  [▢ cinematic][▢][▢]                 │
│  The Historical Archive · 1,802 lots   [▢ collection cover]                │
│  ┌──────── quiet map band: "12 near you — open the map ▸" ───────────┐     │
│  └────────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────┘
```
**Critique.**
- ✅ The most universally "premium/beautiful"; safest perf; best for SEO + shareable marketing.
- ✅ Works great even with *few* auctions (curation hides sparsity).
- ⚠️ It's **editorial, not alive** — admiration, not "I wonder what's around me." It can feel like a magazine you read, not a board you explore.
- ⚠️ The map is a citizen, not the identity — directly under-delivers on your "map = identity" instruction.
- ⚠️ Curation is **human work** — someone must compose collections regularly or it goes stale.

---

## Concept C — **The Concierge** ("Ask")
*Center of gravity: a command bar. Lineage: Arc + Notion + Tesla + Robinhood.*

**The loading moment.** Near-instant. A calm, almost-empty warm-paper screen. A single contextual line greets you: *"Good evening. 12 auctions end near you tonight."* One large search/command field breathes gently. Beneath it, 3–4 smart chips: **Near me · Ending tonight · Jewelry · The Archive.** Type or tap, and the surface *transforms* into the answer (a map, a rail, a result). The interface literally disappears until you ask.

**Identity.** Intelligence and ease — your stated principle ("the interface should disappear") taken to its logical end.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Advantage.Bid                                                        ◎    │
│                                                                            │
│                                                                            │
│              Good evening. 12 auctions end near you tonight.               │
│                                                                            │
│        ┌──────────────────────────────────────────────────────┐           │
│        │ ⌕  What are you looking for?                          │           │
│        └──────────────────────────────────────────────────────┘           │
│            ◦ Near me   ◦ Ending tonight   ◦ Jewelry   ◦ The Archive        │
│                                                                            │
│                       (everything else appears on intent)                  │
└───────────────────────────────────────────────────────────────────────────┘
```
**Critique.**
- ✅ Calmest, fastest, most "reduce thinking"; ages beautifully; perfect Lighthouse.
- ✅ Scales to any catalog size; no curation burden.
- ⚠️ Might be **too quiet to feel "alive"** on first load — the "wonder" is muted; it rewards intent rather than sparking it.
- ⚠️ Puts the burden on the user to *act*; less ambient discovery.
- ⚠️ Under-delivers on "map = identity" (map is just one answer among many).

---

## Recommendation — **Concept A: The Living Map**, productionized with B's beauty and C's calm

Only Concept A delivers the precise emotion you named — *"I wonder what's around me"* — and makes the map the identity, both of which you asked for explicitly. B is the most beautiful and C is the calmest, but neither makes you *lean in and explore your own neighborhood.* A does.

The trick is to make A feel **warm and alive, not like a cold GIS tool**, by absorbing the best of the other two:
- **From B (Cover):** the preview cards and collection covers are gorgeous full-photography; the area never feels like data — it feels like *finds*. Below the map fold, B's editorial rails provide a grounded, SEO-friendly, sparse-data-proof fallback.
- **From C (Ask):** a single floating **command capsule** with a contextual greeting ("14 auctions near you") gives the calm, intelligent, low-clutter feel — discovery without forms.

**And we de-risk the one thing that can break it (sparse data):** the map is *never* allowed to look empty. It blends live auctions + the historical archive + auto-expanding radius + an always-populated drawer list, so on day one with three live auctions it still feels alive.

So: **a living, photographic, intelligent map that glides to your home and shows you treasure nearby — with a calm command bar floating over it and beautiful editorial rails beneath.** That's the thing people remember.

---

## What "build it" looks like (after you lock the direction)

Per your process — *recommend one, **then** build* — I'd build a **clickable HTML prototype of Concept A** next (no engine/API/Stripe/bidding changes; uses the existing `/api/public/auctions` + `/near` data, or static fixtures for the prototype). Specifically:
1. The fly-in + pin-bloom loading moment (with `prefers-reduced-motion` + static LCP).
2. Pins ⇄ preview cards ⇄ results drawer, with the sparse-data blending.
3. The floating command capsule + location chip.
4. Mobile map/list toggle + bottom-sheet preview.

It would be flag-gated and live alongside today's homepage so nothing in production changes until you say so.

**Before I build, two decisions gate everything (see §13 of the proposal):** which concept to commit to, and the **map provider** (recommend MapLibre GL + vector tiles for 60fps, custom look, and no per-load Google fee).

---

## Living Canvas — locked direction (Concept A + your additions)

Decision: **Concept A (The Living Map)** with **MapLibre GL**, treated as a **living brand canvas, not a navigation widget**. Captured additions:

- **Auction visual language (not generic pins):** a custom **gavel marker** on a glowing disc, with distinct states that *are* the brand —
  - **Live** — steady accent ring + aura.
  - **Ending Soon** — urgent pulsing ring (`ping`).
  - **Historical** — muted/grayscale, archival.
  - **Coming Soon** — dashed ring, quiet anticipation.
- **Emotionally adaptive palette:** basemap + glow shift by **time of day** (positron/voyager → dark-matter) and **season/holiday** accent. Subtle, not gimmicky — frequent visitors feel it's alive.
- **First-visit cinematic:** fade from black → softly-lit U.S. → ~1.7s glide to the saved/known region → **staggered pin bloom** → "N auctions near you" label → interactive. `prefers-reduced-motion` → instant jump, no fly.
- **Returning-visitor "what's changed":** as the camera settles, surface deltas — *new auctions nearby · closing today · a lot you viewed has new bids* — so the homepage rewards coming back (no other auction platform does this).
- **Anti-empty guarantee:** the map must never look barren early on — blend live + historical-archive + auto-expanding radius so it always feels populated.

Prototype: `public/prototype/living-map.html` (standalone, not linked from production nav; CDN MapLibre + key-free CARTO basemaps; fixture data). Production wires the same UI to `/api/public/auctions` + `/near` with Cloudinary photos and a custom MapTiler/Protomaps brand style — **no engine/API/Stripe/bidding/seller changes.**

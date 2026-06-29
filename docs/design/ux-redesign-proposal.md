# Advantage.Bid — UX Redesign Proposal (Phase 1)

*Discovery-first, location-led, premium. A proposal — not code.*

---

## 0. The one idea everything hangs on

Estate and consignment auctions are **inherently local**. The single biggest difference between Advantage.Bid and HiBid / LiveAuctioneers / MaxSold is that **our items live in a place and must be picked up from a place.** Distance-to-pickup is a real buying decision, not metadata.

So the thesis of this redesign is:

> **Lead with place, not catalog.**
> Competitors are *catalogs with a search box*. Advantage.Bid becomes a *map of opportunities near you* — Zillow/Airbnb for estate finds. That is the thing people remember.

This reframes every screen:
- The homepage answers **"What great auctions are happening near me, right now?"** before it asks the user anything.
- The map is not a gimmick bolted onto a list — it is the **spine of discovery**, because location is genuinely load-bearing for our product.
- Everything catalog-y (filters, dropdowns, categories) becomes **progressive** — revealed on intent, never on arrival.

Everything below serves that thesis. None of it requires changing APIs, the auction engine, Stripe, bidding, or seller workflows — the data we need (`lat`/`lng`, `city`/`state`, `cover_image_url`, `state`, `public_auction_type`, `end_time`) already exists and is already served by `/api/public/auctions`, `/api/public/auctions/near`, etc.

---

## 1. Design principles (the philosophy, made testable)

These are the rules we hold every screen against. Each is a pass/fail, not a vibe.

| Principle | Concrete test |
|---|---|
| **Reduce thinking** | The first screen asks for **zero** required decisions. Location is inferred; results appear unprompted. |
| **The interface disappears** | On any screen, ≥70% of pixels are content (photos, map, lots) — not chrome (nav, filters, labels). |
| **Discovery over filtering** | Default state is *curated rails + map*, never an empty grid waiting for filters. |
| **Every click is intentional** | No dead ends; every screen has exactly one obvious primary action. (We already fixed the post-sign dead end — apply that everywhere.) |
| **Place first** | Location context is visible and changeable from anywhere in two taps. |
| **Trust is the aesthetic** | Generous whitespace, real photography, restrained motion. We're selling valuable property — the UI must feel like it can be trusted with a credit card. |
| **One product across devices** | Mobile is not a shrunk desktop; desktop is not a stretched phone. Same mental model, device-native ergonomics. |

**Anti-goals (what "feels different" means by contrast):**
- ❌ A wall of dropdowns on load (MaxSold/HiBid).
- ❌ Dense data tables and tiny thumbnails (LiveAuctioneers).
- ❌ A horizontal nav with 10 links that scrolls sideways (today's Advantage.Bid).
- ❌ Decorative animation that delays content.

---

## 2. What we borrow (interactions, not visuals)

The brief named eleven products. Here's the *specific mechanic* we steal from each — and where it lands.

| Source | The mechanic we borrow | Where it lands in Advantage.Bid |
|---|---|---|
| **Google Earth** | The "fly-to-me" — a calm camera move from globe → your region that orients you spatially. | Homepage hero: map eases from US → your area over ~1.2s (reduced-motion: instant). |
| **Google Maps / Zillow** | Map ⇄ list **two-way sync**: hovering a card highlights its pin and vice-versa; panning the map refilters the list ("Search this area"). | The `/explore` split view. |
| **Airbnb** | Mobile **Map/List toggle** + a floating "Map" pill; bottom-sheet previews; "category pills" that re-theme results. | Mobile discovery + the search bar's category row. |
| **Apple / Tesla** | Ruthless reduction; huge type; one decision per view; product photography as hero. | Design language, homepage hero, auction detail. |
| **Spotify** | Horizontally-scrolling **content rails** with editorial titles ("Ending Tonight Near You", "Fresh Estates"). | Homepage + browse. (Rails scroll *their own* content — the *page* never scrolls sideways.) |
| **Arc Browser / Notion** | The **command palette** (`⌘K`) — one keystroke to search anything (auctions, lots, sellers, places, your account). | Global search; replaces most of the nav links. |
| **Stripe** | Calm, confident density; crisp typographic hierarchy; micro-interactions that feel "engineered". | Component system; dashboards. |
| **Realtor.com** | Saved searches + "notify me when new auctions appear near X". | Buyer dashboard + Watchlist evolution (future). |

The point isn't to look like these apps. It's that each contributes one *interaction primitive* — and together they form a coherent, modern discovery system.

---

## 3. Design language

A premium, airy, confident system. Tokens below are a starting direction (one of the open decisions is the exact palette — see §13).

**Color**
- Foundation stays in the brand family: deep navy (`--brand-navy`) as the "ink", a refined blue accent, warm neutral paper.
- Shift from today's flat navy bars toward **lots of paper-white space with navy as ink and accents**, not navy as background. Premium reads as *light and airy*, not dark and heavy.
- Reserve a single confident accent for primary actions; reserve red strictly for live/urgent ("Ending soon", "Outbid").

```
Ink        #0B1B2B  (near-navy, text + logo)
Paper      #FBFBF9  (warm off-white, page bg)
Surface    #FFFFFF  (cards)
Accent     #2563EB  (primary actions, links)   ← keep brand blue
Live       #E5484D  (urgency only: ending, outbid)
Sold/closed#16A34A  (green, as today on archive)
Muted      #64748B  (secondary text)
Hairline   #ECECE7  (1px dividers — barely there)
```

**Type** — pair a confident display face with a clean text face.
- Display: a modern geometric/serif for headlines ("Discover estate auctions near you") — large, tight tracking. (Quicksand reads friendly today; consider something with more authority for trust — open decision.)
- Text/UI: a neutral grotesque (system-ui stack is fine and fast) for everything else.
- Scale is **big**: hero headline ~48–64px desktop, generous line-height, lots of air.

**Space & shape**
- 8px spacing grid; generous (24–40px) section padding.
- Rounded-12–16px cards, soft shadows (`0 1px 3px / 0 8px 24px` on hover), 1px hairline borders.
- Photography is the hero of every card — 4:3 or 3:2, never letterboxed, lazy-loaded, blurhash/low-res placeholder.

**Motion** (see §11 for the perf contract)
- Default easing `cubic-bezier(.2,.7,.2,1)`; durations 150–300ms for UI, ~1200ms for the one signature map move.
- Motion communicates *spatial continuity* (where did this come from / go to), never decoration.
- **Everything** wraps in `@media (prefers-reduced-motion: reduce)` → transitions collapse to instant.

**Components** (a small, sharp kit — built once, reused everywhere)
- `AuctionCard` (photo, title, place + distance, ending countdown, lot count, premium badge)
- `LotTile` (photo, title, current bid / SOLD, watch heart)
- `LocationChip` ("📍 Detroit, MI · 25 mi" — tap to change)
- `Pill` (category / quick filter, toggle state)
- `Rail` (horizontal scroller with snap, edge-fade, keyboard + drag)
- `BottomSheet` / `SlideOver` (mobile detail + filters)
- `CommandPalette` (⌘K search)
- `MapCanvas` (lazy, clustered pins, two-way sync)

---

## 4. Navigation — completely rethought

Today there are **two** different navs (buyer `buyer-nav.js`, marketing `marketplace.css`), one of which scrolls sideways with 10 links. We unify them into **one adaptive system** with a tiny set of primary destinations and a command palette for the long tail.

**Decision: remove the custom "Back" button.** It duplicates the browser back, adds chrome, and confuses state. Replace with: (a) the browser back for history, and (b) a *contextual* "← All auctions" link only on detail pages where leaving would lose scroll/filter state. Net: less chrome, clearer mental model.

**Decision: branding more prominent.** A real wordmark lockup ("**Advantage**.Bid") left-aligned, slightly larger, with breathing room — it's the anchor, not one link among ten.

### Concepts considered

- **Concept A — Slim bar + Command palette (Arc/Stripe/Notion).** Desktop: a thin top bar = logo · big search/`⌘K` · "Sell" · account avatar. Everything else (Categories, Locations, Past Auctions, FAQ…) lives inside search and a left drawer. *Pro:* radically calm, scales infinitely, no horizontal pressure. *Con:* power users must learn the palette.
- **Concept B — Adaptive bar + bottom tabs (Airbnb/Spotify).** Desktop top bar; **mobile bottom tab bar** with 4 primary destinations. *Pro:* mobile-native, thumb-reachable, familiar. *Con:* bottom bar competes with bidding CTAs on lot pages (solvable: hide on lot detail).
- **Concept C — Map-anchored shell.** The map is the home; nav is a translucent floating capsule over it. *Pro:* maximal "wow". *Con:* heavy, risky for SEO/Lighthouse and for users who just want a list.

### ✅ Recommendation: **A + B hybrid**

One system, two ergonomic expressions:

**Desktop / tablet — slim top bar**
```
┌───────────────────────────────────────────────────────────────────────────┐
│  Advantage.Bid      ⌕ Search auctions, lots, places…   📍Detroit ▾   Sell  ◎│
└───────────────────────────────────────────────────────────────────────────┘
   logo (prominent)     command-style search (⌘K)        location  CTA  avatar
```
- No link row at all. The search field *is* the nav. Click it (or `⌘K`) → command palette with sections: **Auctions**, **Lots**, **Sellers**, **Places**, plus quick actions (My Bids, Watchlist, Sell, Past Auctions…).
- `📍 Location` chip is global and always one click from changing place.
- Avatar menu holds account/billing/invoices/sign-out.

**Mobile — bottom tab bar + drawer**
```
 ┌─────────────────────────────┐
 │  Advantage.Bid        ⌕  ☰  │   ← slim top: logo + search + drawer
 │ … content …                 │
 │                             │
 ├─────────────────────────────┤
 │  🧭        ⌕        ♡       ◎ │   ← bottom tabs (thumb zone)
 │ Explore  Search  Saved  You │
 └─────────────────────────────┘
```
- 4 tabs: **Explore** (map/discovery), **Search**, **Saved** (watchlist/bids), **You** (account). The drawer (`☰`) holds the long tail (Sell, How it works, Past Auctions, FAQ, Locations, Categories).
- Bottom bar auto-hides on the lot page so it never competes with the bid button.
- **No horizontal scrolling anywhere** — destinations are a fixed small set; overflow goes to the drawer/palette, never a sideways row.

This is the same product on every device: *search-forward, location-aware, four ideas deep.*

---

## 5. Homepage — "opening a discovery app"

The homepage runs the **three-step** the brief describes, but answers steps 1–3 *for* the user so they arrive at results without deciding anything.

> **Step 1 — Where am I?** Inferred (see §6). Shown as an editable chip, never a required field.
> **Step 2 — What am I looking for?** One search field + a few category pills. Optional.
> **Step 3 — Show me great auctions.** Curated rails + a live map, already populated.

### Concepts considered
- **Concept 1 — Map-first hero.** Full-bleed live map as the hero with a floating search. *Pro:* unforgettable. *Con:* risk to LCP/SEO; some users want a list immediately.
- **Concept 2 — Editorial + live map band.** A calm headline + location/search, then a *band* of map, then Spotify-style rails. *Pro:* fast, SEO-friendly, progressive, still signature. *Con:* map is a band, not the whole hero.
- **Concept 3 — Permanent split (Zillow).** Map+cards split as the landing. *Pro:* power-discovery. *Con:* heavy for a first impression / casual visitor.

### ✅ Recommendation
**Concept 2 for `/` (homepage)** — approachable, fast, brand-building — **and Concept 3 for `/explore`** (the dedicated map experience). The signature Google-Earth fly-in lives in the homepage map band *and* as the entrance to `/explore`.

**Desktop homepage wireframe**
```
┌───────────────────────────────────────────────────────────────────────────┐
│  Advantage.Bid     ⌕ Search auctions, lots, places…    📍Detroit ▾  Sell  ◎│
├───────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│     Discover estate auctions near you.                                      │
│     Real homes. Real finds. Bid from anywhere, pick up nearby.              │
│                                                                             │
│     ┌──────────────────────────────────────────────┐  [ Near me ]          │
│     │ ⌕  Search auctions, lots, sellers or places…  │                       │
│     └──────────────────────────────────────────────┘                       │
│     ◦ Jewelry  ◦ Furniture  ◦ Art  ◦ Tools  ◦ Collectibles   (category pills)│
│                                                                             │
├───────────────────────────────────────────────────────────────────────────┤
│   ┌─────────────────────────────┐   Auctions near Detroit          [Map →] │
│   │        LIVE  MAP  BAND       │   ┌───────┐ ┌───────┐ ┌───────┐          │
│   │   • pins fly in to your area │   │ photo │ │ photo │ │ photo │          │
│   │   • hover pin ⇄ hover card   │   │Estate…│ │Mid-Cn…│ │Jewel… │          │
│   └─────────────────────────────┘   └───────┘ └───────┘ └───────┘          │
├───────────────────────────────────────────────────────────────────────────┤
│   Ending tonight near you            →  [card] [card] [card] [card] [card]  │  ← rail
│   Fresh estates this week            →  [card] [card] [card] [card] [card]  │
│   Featured by Advantage              →  [card] [card] [card] [card]         │
│   Browse the Historical Archive      →  [collection cover: 8 AAC auctions]  │
└───────────────────────────────────────────────────────────────────────────┘
```

**Mobile homepage wireframe**
```
┌─────────────────────────────┐
│ Advantage.Bid          ⌕  ☰ │
├─────────────────────────────┤
│ Discover estate auctions    │
│ near you.                   │
│ ┌─────────────────────────┐ │
│ │ ⌕ Search…               │ │
│ └─────────────────────────┘ │
│ 📍 Detroit, MI ▾   [Near me]│
│ ◦Jewelry ◦Furniture ◦Art →  │  (pills scroll within the rail only)
├─────────────────────────────┤
│ ┌─────────────────────────┐ │
│ │     mini live map       │ │  tap → /explore (full map)
│ │   "12 auctions near you" │ │
│ └─────────────────────────┘ │
├─────────────────────────────┤
│ Ending tonight near you   → │
│ [card][card][card]  (rail)  │
│ Fresh estates             → │
│ [card][card][card]          │
├─────────────────────────────┤
│  🧭     ⌕      ♡      ◎     │
│ Explore Search Saved  You   │
└─────────────────────────────┘
```

Rails are powered by existing endpoints: `Ending tonight` → `/api/public/auctions?sort=ending_soon`, `Fresh estates` → `?state=active`, `Near you` → `/api/public/auctions/near?lat&lng`, `Featured` → existing featured flag, `Archive` → `public_auction_type='historical_archive'`. **No new APIs.**

---

## 6. Location-first (the Google-Earth moment) — done with restraint

The brief's instinct is right; the danger is gimmickry, a permission prompt that nukes trust, and an LCP hit. Here is the disciplined version.

**Resolution order (no surprise prompts):**
1. **Already-granted geolocation** → use it silently. (Query `navigator.permissions.query({name:'geolocation'})`; only read position if state is already `granted`.)
2. Else **saved location** (from account or `localStorage`).
3. Else **USA** (continental view).
4. A visible **"Near me"** affordance is the *only* thing that triggers the OS permission prompt — i.e., we ask on **intent**, never on arrival. (Better trust *and* better Lighthouse "best-practices".)

**The animation:**
- Map mounts already centered on the resolved location's region as a **static raster image** (instant LCP). Then the interactive vector map hydrates and performs a single eased `flyTo` from a slightly-zoomed-out frame into the location (~1.2s, one move, no bounce).
- `prefers-reduced-motion: reduce` → **no fly-in**; the map simply starts at the location.
- The library and tiles **lazy-load after first paint** and only on pages that show a map — they never block the homepage's text/hero.

The result is subtle delight that *means something* (here's where the action is, relative to you) rather than spectacle.

---

## 7. Interactive map discovery — the signature surface (`/explore`)

This is the thing people screenshot.

**Desktop — split (Zillow/Google Maps)**
```
┌───────────────────────────────────────────────────────────────────────────┐
│  Advantage.Bid   ⌕ Search…   📍Detroit ▾   [ Search this area ]        ◎   │
├───────────────────────────────┬───────────────────────────────────────────┤
│                               │  47 auctions in this area      Sort: Ending │
│        M A P   ( 60%)         │  ┌───────────────┐ ┌───────────────┐        │
│     • clustered pins          │  │ ▢ photo       │ │ ▢ photo       │        │
│     • hover pin → card lifts  │  │ Estate Jewelry │ │ Mid-Century…  │        │
│     • click pin → preview     │  │ Detroit · 6 mi │ │ Royal Oak·9mi │        │
│     ┌─────────────────┐       │  │ Ends in 2h 14m │ │ Ends Sat      │        │
│     │ ◉ 8   ◉ 3  ◉ 12 │       │  │ 40 lots · BP18%│ │ 38 lots       │        │
│     └─────────────────┘       │  └───────────────┘ └───────────────┘        │
│                               │  ┌───────────────┐ ┌───────────────┐  …     │
│   [ as I pan: list refilters ]│  hover card ⇄ pin glows                     │
└───────────────────────────────┴───────────────────────────────────────────┘
```
- **Two-way sync:** hover card → its pin scales + lifts; hover pin → its card highlights and scrolls into view.
- **"Search this area"** appears when the user pans/zooms; clicking re-queries `/api/public/auctions/near` with the new viewport bounds. (Auto-on-pan is an option; a manual button is calmer and avoids jitter — recommend manual, Zillow-style.)
- **Clustering** via supercluster so 500 auctions never become 500 DOM pins.
- Cards carry the genuinely-useful local signal we own: **distance to pickup** and **city**.

**Mobile — Airbnb-style toggle**
```
┌─────────────────────────────┐        ┌─────────────────────────────┐
│  ‹  Explore           ⌕     │        │  ‹  Explore           ⌕     │
│ ┌─────────────────────────┐ │        │  47 auctions · Detroit      │
│ │                         │ │        │ ┌─────────────────────────┐ │
│ │       FULL  MAP         │ │        │ │ ▢ photo  Estate Jewelry │ │
│ │   • pins + clusters     │ │  ⇄     │ │   Detroit · 6 mi · 2h   │ │
│ │                         │ │        │ ├─────────────────────────┤ │
│ │   tap pin → bottom sheet│ │        │ │ ▢ photo  Mid-Century    │ │
│ └─────────────────────────┘ │        │ │   Royal Oak · 9 mi      │ │
│        [ ▤ List ]           │        │        [ 🗺 Map ]           │
└─────────────────────────────┘        └─────────────────────────────┘
        MAP view                                 LIST view
```
- Floating **Map ⇄ List** pill (one tap).
- Tapping a pin raises a **bottom sheet** preview (photo, ending, distance, "View auction") that can be dragged up to full detail or flicked away.
- Large touch targets; pins are tappable at 44px minimum hit area.

---

## 8. Search — progressive disclosure

Today: many dropdowns exposed at once. New model: **one field, then reveal on intent.**

```
Resting:     ┌───────────────────────────────────────────────┐  [ Near me ]
             │ ⌕  Search auctions, lots, sellers or places…   │
             └───────────────────────────────────────────────┘

Focused      ┌───────────────────────────────────────────────┐
(palette):   │ ⌕ jewel▌                                       │
             ├───────────────────────────────────────────────┤
             │ NEAR YOU   📍 Use my location                  │
             │ AUCTIONS   Estate Jewelry & Fine Watches · 6mi │
             │ LOTS       14k gold tennis bracelet · Detroit  │
             │ SELLERS    Advantage Auction Company           │
             │ PLACES     Royal Oak, MI · Birmingham, MI      │
             │ ─────────────────────────────────────────────  │
             │ ⚙ Filters: Category · Distance · Ending · Price │  ← collapsed
             └───────────────────────────────────────────────┘
```
- One input handles auctions, lots, sellers, **and places** (typing a city recenters the map).
- **Advanced filters are a single "Filters" affordance** that expands a slide-over (desktop) or bottom sheet (mobile) with Category, Distance radius, Ending window, Price, Has-shipping. They are **never** all on screen at rest.
- `Near Me` is a first-class, always-present quick action (the only thing that prompts for geolocation).
- Empty/zero-result states suggest *widen distance* or *browse nearby* — never a blank grid.

This is also the desktop **`⌘K` command palette** — same component, same data, available everywhere.

---

## 9. Browse & cards — make it visual

Replace list-think with **collections + rails + big photography**.

- **AuctionCard** (the workhorse):
```
┌─────────────────────────┐
│                         │
│        photo 3:2        │   ← lazy + blurhash; the hero
│                  ♡      │   ← watch toggle
├─────────────────────────┤
│ Estate Jewelry & Watches│   ← title, 1 line, truncate
│ 📍 Detroit · 6 mi       │   ← place + distance (our edge)
│ ⏱ Ends in 2h 14m   ●LIVE│   ← urgency, red only when imminent
│ 40 lots · Buyer prem 18%│   ← the facts that matter, nothing more
└─────────────────────────┘
```
- **Rails** for: *Ending tonight near you*, *Fresh estates*, *Featured by Advantage*, *Nearby*, *Trending* (by view/bid velocity if available; else recency), *The Historical Archive* (collection cover → the 8 AAC auctions).
- **Collections** are editorial covers (a single beautiful image + count) — e.g., "The Historical Archive · 8 auctions · 1,802 lots". Spotify-playlist energy.
- Auction detail and lot detail keep their existing logic/bidding but get the **gallery-first** treatment: large hero image, filmstrip, calm bid panel, live premium display (already required), soft-close timer with a tasteful pulse near the end.

---

## 10. Dashboards

Same engine, calmer surfaces. Stripe-like clarity.

**Buyer dashboard ("You")**
```
┌───────────────────────────────────────────────────────────┐
│  Hi Jane                                    📍 Detroit ▾   │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐  │
│  │ Active    │ │ Watching  │ │ Won /     │ │ Invoices  │  │
│  │ bids  3   │ │   12      │ │ to pay 1  │ │  pay now  │  │
│  └───────────┘ └───────────┘ └───────────┘ └───────────┘  │
│  Ending soon in your watchlist        → [tile][tile][tile] │
│  Saved searches  ·  "Jewelry within 25mi"  🔔 notify       │  (Realtor.com idea)
│  Pickups & invoices  ·  next: Sat 10–2, Detroit            │
└───────────────────────────────────────────────────────────┘
```
Surfaces existing data: bids, watchlist, invoices, payment methods, addresses, notification prefs. Adds **saved searches + notify** as the one new buyer primitive (high retention, no engine change — it's a stored query + the existing notification system).

**Seller dashboard**
```
┌───────────────────────────────────────────────────────────┐
│  Your auctions                         [ + Create catalog ]│  ← the CTA we just added, everywhere
│  ┌──────────────────────────────────────────────────────┐ │
│  │ Spring Estate · DRAFT · 18 lots · needs review        │ │
│  │ ▢▢▢▢ photos      [ Continue building → ]               │ │
│  └──────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ Winter Estate · CLOSED · payout $4,210 · 14-day track │ │
│  └──────────────────────────────────────────────────────┘ │
│  Tasks: ① add photos  ② set pickup window  ③ submit        │  ← guided, one next action
└───────────────────────────────────────────────────────────┘
```
Keeps the seller workflow exactly as-is (create → lots → submit → publish), but presents it as a **guided, single-next-action checklist** instead of a form. The "Create Auction Catalog" CTA (already shipped post-signing) becomes the persistent primary action.

---

## 11. Motion & performance contract

Non-negotiable, because "premium" dies the instant it's janky.

- **60fps or it doesn't ship.** Animate only `transform`/`opacity`. No layout-thrash, no animating `width`/`top`.
- **Map is lazy & isolated.** The map library + tiles load **after** first paint, **only** on `/` (the band) and `/explore`. Homepage text/hero never waits on the map. Static map image for LCP; hydrate to interactive after.
- **`prefers-reduced-motion: reduce`** disables the fly-in and all non-essential transitions, globally.
- **No unnecessary JS.** Rails are CSS scroll-snap (no carousel library). Bottom sheets/slide-overs are CSS transforms + a few lines of JS. The command palette is one small component. We *add* a map lib; we *remove* the two divergent nav scripts and assorted page chrome — aim for net-neutral or lighter.
- **Lighthouse guardrails:** budget LCP < 2.5s on 4G mobile, CLS < 0.1 (reserve image/map dimensions), TBT low (defer/idle-load the map). Image pipeline already on Cloudinary → serve responsive `srcset` + AVIF/WebP + blurhash placeholders.
- **Accessibility:** full keyboard path (palette, rails, map list), focus-visible rings, 44px touch targets, semantic landmarks, map has an always-available **list equivalent** (the cards) so nothing is map-only.

---

## 12. How this ships without touching the engine

This is a **presentation-layer** redesign. Mapping proposed surfaces → existing, unchanged backends:

| New surface | Existing API (unchanged) |
|---|---|
| Homepage rails | `/api/public/auctions?state=active|closed&sort=ending_soon`, featured flag |
| Near-you rail + map | `/api/public/auctions/near?lat&lng` (+ viewport bounds param if we choose auto-refilter — additive query param, optional) |
| Search / `⌘K` | existing search endpoints (auctions/lots/sellers); "places" is client-side geocode → recenter |
| Auction/lot detail | unchanged bidding, premium, soft-close, paddle, Stripe |
| Buyer/seller dashboards | existing account/bids/watchlist/invoices/seller endpoints |
| Saved searches + notify | stored query + existing notifications worker (small additive table; no engine change) |

**No changes** to: auction engine, bidding, Stripe/payments, buyer premium, tax, settlements, seller submission/lock, agreement flow. The only *possibly*-new backend is an additive "viewport bounds" query param on the existing `near` endpoint and a small saved-searches table — both optional, both Phase 3+.

---

## 13. Open decisions (I recommend, you choose)

1. **Map provider** — *(recommend)* **MapLibre GL JS** (open-source, GPU/vector, 60fps) + a vector tile source (MapTiler or Protomaps) to avoid Google's per-load pricing and keep the look custom/premium. Alternatives: **Mapbox GL** (most polished, paid) or **Google Maps** (familiar, heavier, less brand-custom). Trade-off is cost vs. polish vs. control.
2. **Display typeface** — keep friendly Quicksand, or move to a more authoritative display face for "trust"? (I lean: a confident display for headlines, system-ui for UI.)
3. **Palette direction** — confirm the shift to *light/airy paper with navy ink* (recommended) vs. keeping today's dark navy bars.
4. **Homepage hero** — Concept 2 (editorial + map band) for `/` with Concept 3 (split) for `/explore` — confirm, or go full map-first.
5. **"Search this area"** — manual button (calm, recommended) vs. auto-refilter on pan.
6. **Scope of Phase 2** — do we prototype the full `/explore` map first (highest "wow"), or the navigation + homepage shell first (highest daily value)? (I lean: nav + homepage shell first; it de-risks everything and immediately reads as a new product.)

---

## 14. Proposed roadmap (after you approve direction)

- **Phase 1 — this document.** Concepts, wireframes, interaction spec, decisions.
- **Phase 1.5 — Hi-fi mockups / clickable prototype** of: homepage, `/explore`, nav (3 breakpoints), one auction detail. (Figma or a static HTML prototype — no app wiring.)
- **Phase 2 — Navigation + Design system** (tokens, AuctionCard, Rail, CommandPalette, the unified nav). Replaces both legacy navs. Ship behind a flag; zero API changes.
- **Phase 3 — Homepage** (3-step, rails, location resolution, map band with the fly-in).
- **Phase 4 — `/explore`** (the split map experience + mobile toggle/bottom sheets).
- **Phase 5 — Dashboards + saved searches.**
- Each phase is independently shippable, flag-gated, measured (engagement, time-to-first-auction-view, mobile bounce), and **never touches the auction engine**.

---

## 15. Why this is "the one people remember"

Catalog auction sites make you *work*: pick a category, set filters, sort, scan a table. Advantage.Bid will instead **open to a living map of opportunities near you**, animate gently to your place, and hand you beautiful, local, time-sensitive finds before you've made a single decision. It feels like Zillow/Airbnb for estate treasure — calm, confident, spatial, and *yours* — which is exactly what no auction competitor feels like.

That's the difference people remember.

# BD City-Page Event Widget Integration — Handoff

**Goal:** the existing Railway event feed, embedded on Brilliant Directories (BD) city/location pages,
auto-recognizes the page's city/state and shows nearby events on first load — no retyping, one reusable
widget, no per-city hardcoding, Railway remains the canonical source of truth.

**Railway side is DONE and LIVE** (`main@31150bc`): `public/widgets/marketplace-feed.js` now reads the
page's location from the iframe URL. Nothing else on Railway needs to change. This doc is the BD side.

---

## What the widget now accepts (iframe URL params)

Add these to the existing embed URL `https://bid.advantage.bid/widgets/marketplace-feed.html`:

| Param | Example | Meaning |
|---|---|---|
| `preset` | `all-events` \| `auctions` \| `estate-sales` | Which feed (server-enforced). City pages should use `all-events`. |
| `city` + `state` | `city=Houston&state=Texas` | Geocoded honestly server-side → nearby events. **Recommended for city pages.** |
| `lat` + `lng` (+ `label`) | `lat=29.76&lng=-95.36&label=Houston,%20TX` | Explicit coordinates (no geocode round-trip). |
| `radius` | `radius=50` or `radius=nationwide` | Optional. Default 50 miles. |

**Precedence:** URL location (the BD page's city) → the visitor's stored preference → nationwide. A
visitor who types a different location overrides it for the session; changing the distance never clears
the city; changing the city resets pagination to page 1. On geocode failure the widget degrades to a
truthful nationwide state — it never invents a market.

---

## Verified BD architecture (live, 2026-08-02)

| BD page type | Live URL pattern | Location signal available |
|---|---|---|
| State directory page | `https://www.advantage.bid/{state-slug}` — e.g. `/texas`, `/michigan`, `/new-york` | State in URL slug + H1 ("Texas Estate Sales & Auctions") + breadcrumb. **No coords.** |
| Company/listing page | `https://www.advantage.bid/united-states/{city-slug}/{type}/{business}` — e.g. `/united-states/houston/auction-house/...` | City in URL slug. **No coords.** |
| Canonical event listing pages | `/all-events`, `/auctions`, `/estate-sales` | Already embed the widget (preset only) — do **not** add location here. |

BD content pages expose location as URL slug + on-page text, **not** as coordinates and not (confirmed) as
a single global smart tag. Two integration options below; **Option A is preferred where your template
exposes a location variable, Option B works with zero BD variables.**

---

## OPTION A (preferred) — put the location in the iframe `src` with your BD template variable

Zero JavaScript, zero reload. Use this when the BD location template renders the city/state as a
dynamic value you can insert into the widget markup.

**1. BD Admin navigation:** `Content → Custom Pages / Templates` (or `Design → Templates`) → open the
**location/city template** that renders the state or city page (the one whose H1 is
"{State} Estate Sales & Auctions" or the city landing template). If you use a BD **Custom Widget** in
that template's content area, edit that widget (`Content → Widgets → [your location widget] → HTML tab`).

**2. Insertion point:** immediately **below** the page's existing H1 / intro copy and **above** the
professional listings — so the native city H1, description, breadcrumbs, listings, and internal links are
all preserved. Do not replace any native content; add the widget as an additional block.

**3. Copy-paste (state page template):**
```html
<iframe src="https://bid.advantage.bid/widgets/marketplace-feed.html?preset=all-events&state=[STATE_NAME]&radius=nationwide"
        title="Upcoming Auctions & Estate Sales" loading="lazy" allow="geolocation"
        style="width:100%; min-height:800px; border:0; display:block"></iframe>
```

**3b. Copy-paste (city page template):**
```html
<iframe src="https://bid.advantage.bid/widgets/marketplace-feed.html?preset=all-events&city=[CITY_NAME]&state=[STATE_NAME]&radius=50"
        title="Auctions & Estate Sales Near [CITY_NAME]" loading="lazy" allow="geolocation"
        style="width:100%; min-height:800px; border:0; display:block"></iframe>
```

**4. Dynamic BD variables to insert** (replace the bracketed placeholders with your template's real
smart tags — confirm the exact tag name in your template; BD location templates expose the current
page's city/state as a template variable):
- `[STATE_NAME]` → the page's state (e.g. renders `Texas`).
- `[CITY_NAME]` → the page's city (e.g. renders `Houston`), on city templates only.

> **You must confirm the exact tag** because BD smart-tag names are install/template-specific. To verify:
> temporarily put the tag as plain text in the template, save, view the live page, and confirm it renders
> the city/state. If it does, move it into the iframe `src` exactly as-is. If your template has no such
> tag, use **Option B** (needs no tag).

The state-page snippet uses `radius=nationwide` because a whole state exceeds a 50-mile radius; the
city-page snippet uses `radius=50`. The visitor can adjust the slider either way.

---

## OPTION B (universal fallback) — derive the location from the page URL (no BD variable needed)

Works on every location template using only the URL patterns verified above. One script, added once.

**1. BD Admin navigation:** `Toolbox → Custom Codes → Footer Scripts` (the same script-allowed area
where `marketplace-embed.js` already lives). Do **not** put this in a widget content box (BD strips
`<script>` from widget HTML).

**2. Place the widget markup** (in the location template's content/widget area) with **preset only**:
```html
<iframe src="https://bid.advantage.bid/widgets/marketplace-feed.html?preset=all-events"
        title="Auctions & Estate Sales Near You" loading="lazy" allow="geolocation"
        style="width:100%; min-height:800px; border:0; display:block"></iframe>
```

**3. Add this once in Footer Scripts** (it only acts on state/city URLs and only if the iframe has no
location yet; on `/all-events` etc. it does nothing):
```html
<script>
(function () {
  // US state slugs BD uses at the path root (/texas, /new-york, …). Maps slug → proper name.
  var STATES = {'alabama':'Alabama','alaska':'Alaska','arizona':'Arizona','arkansas':'Arkansas','california':'California','colorado':'Colorado','connecticut':'Connecticut','delaware':'Delaware','florida':'Florida','georgia':'Georgia','hawaii':'Hawaii','idaho':'Idaho','illinois':'Illinois','indiana':'Indiana','iowa':'Iowa','kansas':'Kansas','kentucky':'Kentucky','louisiana':'Louisiana','maine':'Maine','maryland':'Maryland','massachusetts':'Massachusetts','michigan':'Michigan','minnesota':'Minnesota','mississippi':'Mississippi','missouri':'Missouri','montana':'Montana','nebraska':'Nebraska','nevada':'Nevada','new-hampshire':'New Hampshire','new-jersey':'New Jersey','new-mexico':'New Mexico','new-york':'New York','north-carolina':'North Carolina','north-dakota':'North Dakota','ohio':'Ohio','oklahoma':'Oklahoma','oregon':'Oregon','pennsylvania':'Pennsylvania','rhode-island':'Rhode Island','south-carolina':'South Carolina','south-dakota':'South Dakota','tennessee':'Tennessee','texas':'Texas','utah':'Utah','vermont':'Vermont','virginia':'Virginia','washington':'Washington','west-virginia':'West Virginia','wisconsin':'Wisconsin','wyoming':'Wyoming'};
  function titleCase(slug){ return slug.split('-').map(function(w){ return w ? w.charAt(0).toUpperCase()+w.slice(1) : w; }).join(' '); }
  function locFromPath(path){
    var segs = path.replace(/^\/+|\/+$/g,'').split('/').filter(Boolean);
    if (segs.length === 1 && STATES[segs[0].toLowerCase()]) return { state: STATES[segs[0].toLowerCase()], radius: 'nationwide' };
    if (segs.length >= 2 && segs[0].toLowerCase() === 'united-states') return { city: titleCase(decodeURIComponent(segs[1])), radius: 50 };
    return null;                                   // not a location page → leave the widget nationwide
  }
  function apply(){
    var loc = locFromPath(location.pathname); if (!loc) return;
    var frames = document.querySelectorAll('iframe[src*="/widgets/marketplace-feed.html"]');
    for (var i=0;i<frames.length;i++){
      var f = frames[i], src = f.getAttribute('src') || '';
      if (/[?&](city|state|lat|lng)=/.test(src)) continue;     // explicit location already present → respect it
      var join = src.indexOf('?') === -1 ? '?' : '&', extra = '';
      if (loc.city)   extra += join + 'city='  + encodeURIComponent(loc.city),  join = '&';
      if (loc.state)  extra += join + 'state=' + encodeURIComponent(loc.state), join = '&';
      if (loc.radius) extra += join + 'radius='+ encodeURIComponent(loc.radius);
      f.setAttribute('src', src + extra);          // set once, before the lazy iframe fetches
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
})();
</script>
```

This reads only `window.location.pathname` (already available), never the widget's cross-origin DOM, and
adds no new allowed origin. If the widget already carries an explicit `city`/`state`/`lat`/`lng` (Option A),
the script leaves it alone.

---

## Widget modes on each page type
- **City / location pages → `preset=all-events`** (the primary experience).
- The same URL supports **`preset=auctions`** and **`preset=estate-sales`** if a page wants a single type.
  One implementation, three server-enforced presets — never three separate widgets.

## SEO / canonical / AI-discovery (unchanged, preserve)
- Keep the native BD city **H1, description, breadcrumbs, metadata, canonical URL, internal links, and
  professional listings**. The widget adds a live block; it must not replace page content or be the only
  thing on the page.
- The widget iframe is `noindex` and creates **no** canonical URL and **no** BD event records. Every event
  links to its canonical Railway page (`bid.advantage.bid/...`). Railway remains the single source of
  truth; do not create native BD event/auction records.
- Do not add event JSON-LD to the BD city page for these live events (Railway already emits per-event
  JSON-LD on the canonical detail pages) — avoid duplicate/misleading structured data.

## Analytics (unchanged)
- The widget is already excluded from its own standalone GA page tagging, so embedding it in BD does not
  double-count. Do not add extra GA to the widget. The widget's own interaction events now include a
  distinct `city_page_init` + `source:'city_page'` parameter for city-page loads.

## Save & publish
1. Paste the markup (Option A) or the Footer Script (Option B).
2. Save the template/widget/Footer Scripts.
3. Verify on a **preview/unpublished** copy of one city page first, then publish.

## Testing (per city)
Open the live city page and confirm: the city/state is recognized; results show on first load without
pressing Search; the distance slider is active immediately and adjusting it re-filters; the map position
matches the city; List/Map agree; numbered pagination works; the type filter works; item links open the
canonical Railway page; mobile and desktop both work; a city with no nearby inventory shows the truthful
empty state ("No events found within 50 miles of {City}" + Increase distance / View nationwide). Suggested
cities: New York NY, Houston TX, Atlanta GA, Chicago IL (currently empty at 50 mi → empty-state check),
Detroit MI, a West-Coast city (Los Angeles CA), and a remote area (empty-state check).

## Rollback
- Remove the iframe block from the template (Option A) or delete the Footer Script (Option B). No Railway
  change needed; every other page is unaffected.
- Railway rollback (only if ever needed): `git revert 31150bc` — the change is additive (the widget simply
  stops reading URL location and reverts to stored/nationwide).

## Applies globally or per template?
- **Option A** applies only to the specific location template(s) you edit (per-template).
- **Option B** Footer Script is global but self-scopes: it acts only on `/{state}` and
  `/united-states/{city}/...` URLs and is a no-op everywhere else (including `/all-events`).

## Remaining Product Owner action
1. Decide which BD location template(s) get the widget (state pages, city/company pages, or both).
2. Choose Option A (confirm your template's city/state smart-tag name) **or** Option B (paste the Footer
   Script — no tag needed).
3. Paste, preview, publish, and run the per-city test list above.
No unrelated BD header/auth/GA/navigation code is touched by either option.

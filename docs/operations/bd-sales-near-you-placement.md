# Brilliant Directories — Sales Near You placement (Owner action)

**Status:** the code is built, deployed and verified on Railway. Pasting the snippet into Brilliant
Directories is an **Owner manual action** — there is no MCP connector configured in this environment
and the BD REST API is read-only (`GET /user/get` with `X-Api-Key`), so BD pages cannot be edited
programmatically from here.

Railway remains the single source of truth. **BD stores no subscribers.** Every BD submission posts
into the same canonical system as a Railway submission — same endpoint, same consent evidence, same
dedupe, same geocoding, same suppression and unsubscribe, same 30-mile audience engine.

## The snippet

Paste this **once**, into the BD global footer block if your theme has one (Appearance → Footer, or a
sitewide custom-HTML block). One placement covers every public page.

```html
<script src="https://bid.advantage.bid/widgets/shared/local-alerts.js"
        data-placement="bd_footer" defer></script>
```

That is the whole integration. No API key, no secret, no configuration.

### Why nothing else is needed

- **Cross-origin already works.** `/api/public/*` and `/widgets/*` are served with
  `Access-Control-Allow-Origin: *`, verified live by preflight from `https://www.advantage.bid`.
  No CORS change was made and no API security was weakened.
- **BD's CSP already allows it.** The site sends `script-src https: 'unsafe-inline' 'unsafe-eval'`
  and `connect-src *`, so a Railway-hosted script loads and can post.
- **There is precedent.** BD already loads `bid.advantage.bid/widgets/marketplace-embed.js`.
- **`defer` protects your page speed** — it never blocks rendering, and the script fetches nothing
  on load.

## What the visitor sees

A quiet signup strip just above your footer, and — only after genuine engagement — a modal:

> **Never Miss a Sale Near You Again!**
> Get notified when new estate sales and auctions are added near you.
>
> Email Address · City · State → **Notify Me About Nearby Sales**

The modal never appears on page load. It needs ~25 seconds of real engagement (a hidden tab does not
count), or a second event viewed, or desktop exit intent. Then: once per session, at most once every
7 days, a dismissal respected for 30 days, at most 3 times ever, and never to someone already
subscribed. On a phone it is a bottom sheet with large touch targets, not a full-screen interstitial.

## Where it deliberately will not appear

The script suppresses itself on sensitive paths, using BD's route vocabulary as well as the
platform's: `/login`, `/logout`, `/signup`, `/register`, `/password`, `/forgot`, `/reset`,
`/account`, `/my-account`, `/member`, `/dashboard`, `/profile`, `/settings`, `/cart`, `/checkout`,
`/billing`, `/invoice`, `/admin`, plus `/privacy`, `/terms` and `/legal`.

So a single global footer placement is safe: it will not interrupt a login, a checkout, an account
area, or someone reading your legal pages.

## Optional per-page placement

If you would rather place it on specific pages than sitewide, use the same snippet with a label that
describes the page, so acquisition is attributable:

| BD page | `data-placement` |
|---|---|
| Global footer (recommended) | `bd_footer` |
| Homepage | `bd_home` |
| Estate sales browsing | `bd_estate_sales` |
| Auction / event browsing | `bd_auctions` |
| Professionals / directory | `bd_directory` |
| Blog / articles | `bd_blog` |
| City / state / local pages | `bd_city_page` |

Omitting `data-placement` is fine — the script classifies the page from its own path.

## How to confirm it is working

1. Open a public BD page (not a login or checkout page) in a private window.
2. The signup strip should appear just above the footer.
3. Submit a real address you control, with a city and state.
4. In **Admin → Subscribers** the record appears with `source_domain` showing the BD origin and the
   placement you set — that is what distinguishes BD acquisition from platform acquisition.
5. Browser console should be clean, and the page's layout, canonical URL and structured data
   unchanged.

If the strip does not appear, check that the BD block allows raw `<script>` (some themes strip it);
if so, use a "Custom HTML"/"Raw HTML" block rather than a rich-text editor.

## What this does NOT do

It does not send email. Sales Near You sending stays gated
(`marketing.email.sales_near_you_enabled = false`), and event-level entitlement still governs what
may ever be sent.

**EVERYONE MAY SUBSCRIBE. NOT EVERY EVENT MAY SEND.**

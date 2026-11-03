# Sell Online page: launch instructions (staged; do not publish before the commerce launch)

The page is built and verified on the isolated test environment (`tests/browser/sell-online.browser.test.js`, launch switch
on: desktop, tablet and phone, headings, canonical and social tags, structured data matching the visible FAQ, sitemap, every
internal link, registration with "Retail Shop, Gallery or Studio" preselected, 5% / 9% pricing). In production it stays hidden
until the owner launches online purchasing.

| Address | Today (switch off) | At launch |
|---|---|---|
| `https://bid.advantage.bid/sell-online` | 404, not in the sitemap | the page (canonical address) |
| `https://bid.advantage.bid/sell-online.html` | 404 | permanent redirect to `/sell-online` |
| `https://www.advantage.bid/sell-online` | not set up | permanent (301) redirect to `https://bid.advantage.bid/sell-online` |

## Launch steps (owner, in this order, only after online purchasing is authorized)
1. Railway (production service): set `SELL_ONLINE_PAGE_ENABLED=true`. The deploy restarts the app; nothing else changes.
2. Check `https://bid.advantage.bid/sell-online` loads and `https://bid.advantage.bid/sitemap.xml` lists it.
3. Brilliant Directories admin (www.advantage.bid), redirect: in the site's 301 redirect settings, add a redirect from
   `/sell-online` to `https://bid.advantage.bid/sell-online` (permanent / 301). Test it in a private browser window.
4. Brilliant Directories menu link: in the main menu editor, add a link labelled **Sell Online** pointing to
   `https://bid.advantage.bid/sell-online` (same window), placed with the other seller links (for example next to Professional
   Sellers). Save and check it on a phone.
5. Optional: link to it from the Professional Sellers page and the seller FAQ.

Rollback: set `SELL_ONLINE_PAGE_ENABLED=false` (the page answers 404 again) and remove the Brilliant Directories menu link;
the redirect can stay (it then lands on the 404) or be removed.

Wording rules kept: no "coming soon" or checkout-unavailable text on the page; 5% website / 9% marketplace commission
including card processing; no monthly or listing fee; no artificial-intelligence or vendor names; no long dashes.

'use strict';

/**
 * shopPageService — server-rendered, crawlable /shop page (the Advantage.Bid fixed-price marketplace). Real HTML before
 * any script: item cards linking to canonical product pages, category links, numbered ?page pagination, canonical +
 * Open Graph tags, and CollectionPage + BreadcrumbList + ItemList structured data. Data: shopService (one rule).
 * Built from strings with every value escaped; there is no inline script, so no closing-tag text can leak.
 */

const shop = require('./shopService');
const { publicBaseUrl } = require('../lib/publicUrls');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: Number(c) % 100 ? 2 : 0, maximumFractionDigits: 2 });
const TITLE = 'Shop Antiques, Art, Vintage and Home Decor';
const DESC = 'Buy antiques, fine art, vintage finds, jewelry, furniture and home decor from professional sellers on Advantage.Bid. Every item is offered at a set price by an established shop, gallery, estate sale company or dealer.';

function pageUrl(base, { category, page }) {
  const q = [];
  if (category) q.push('category=' + encodeURIComponent(category));
  if (page > 1) q.push('page=' + page);
  return base + '/shop' + (q.length ? '?' + q.join('&') : '');
}

async function render({ page = 1, category = null } = {}) {
  const base = publicBaseUrl().replace(/\/+$/, '');
  const [list, cats] = await Promise.all([shop.listItems({ page, category }), shop.categoryCounts()]);
  const { items, pagination } = list;
  const cat = list.category;
  const canonical = pageUrl(base, { category: cat && cat.key, page: pagination.page });
  const heading = cat ? `${cat.label} for Sale` : TITLE;
  const title = heading + (pagination.page > 1 ? ` (Page ${pagination.page})` : '') + ' | Advantage.Bid';
  const desc = cat ? `${cat.label} from professional sellers on Advantage.Bid, offered at a set price. ${DESC.split('. ')[1]}` : DESC;

  const cards = items.map((it) => {
    const loc = [it.city, it.state].filter(Boolean).join(', ');
    const img = it.image ? `<img src="${esc(it.image)}" alt="${esc(it.image_alt)}" loading="lazy" width="400" height="300">` : '<span class="ph" aria-hidden="true"></span>';
    const seller = it.seller.storefront_url
      ? `<a class="s" href="${esc(it.seller.storefront_url)}">${esc(it.seller.name)}</a>` : `<span class="s">${esc(it.seller.name)}</span>`;
    return `<li class="c"><a class="ci" href="${esc(it.url)}">${img}<span class="t">${esc(it.title)}</span>`
      + (it.price_cents != null ? `<span class="p">${esc(money(it.price_cents))}</span>` : '')
      + (loc ? `<span class="m">${esc(loc)}</span>` : '') + `</a>${seller}</li>`;
  }).join('');

  let pag = '';
  if (pagination.total_pages > 1) {
    const parts = [];
    const at = (n) => pageUrl(base, { category: cat && cat.key, page: n });
    if (pagination.has_previous) parts.push(`<a rel="prev" href="${esc(at(pagination.page - 1))}">Previous</a>`);
    for (let n = 1; n <= pagination.total_pages; n++) parts.push(n === pagination.page ? `<span aria-current="page">${n}</span>` : `<a href="${esc(at(n))}">${n}</a>`);
    if (pagination.has_next) parts.push(`<a rel="next" href="${esc(at(pagination.page + 1))}">Next</a>`);
    pag = `<nav class="pg" aria-label="Shop pages">${parts.join('')}</nav>`;
  }
  const chips = cats.length ? `<nav class="cats" aria-label="Shop by category"><a href="${esc(base)}/shop"${cat ? '' : ' aria-current="page"'}>All items</a>`
    + cats.map((c) => `<a href="${esc(pageUrl(base, { category: c.key, page: 1 }))}"${cat && cat.key === c.key ? ' aria-current="page"' : ''}>${esc(c.label)} (${c.count})</a>`).join('') + '</nav>' : '';
  const body = items.length ? `<ol class="grid">${cards}</ol>${pag}`
    : `<div class="empty"><p>${cat ? 'Nothing in this category right now.' : 'New items are added often.'} Browse live auctions in the meantime.</p>`
      + `<a class="btn" href="${esc(base)}/search.html">Browse Auctions</a></div>`;

  const crumbs = [{ '@type': 'ListItem', position: 1, name: 'Home', item: base + '/' }, { '@type': 'ListItem', position: 2, name: 'Shop', item: base + '/shop' }];
  if (cat) crumbs.push({ '@type': 'ListItem', position: 3, name: cat.label, item: pageUrl(base, { category: cat.key, page: 1 }) });
  const graph = [
    { '@type': 'CollectionPage', name: heading, description: desc, url: canonical },
    { '@type': 'BreadcrumbList', itemListElement: crumbs },
    { '@type': 'ItemList', name: heading, numberOfItems: pagination.total,
      itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: (pagination.page - 1) * pagination.per_page + i + 1, url: it.url, name: it.title })) },
  ];
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}</script>`;
  const at = (n) => pageUrl(base, { category: cat && cat.key, page: n });
  const rel = (pagination.has_previous ? `<link rel="prev" href="${esc(at(pagination.page - 1))}">` : '') + (pagination.has_next ? `<link rel="next" href="${esc(at(pagination.page + 1))}">` : '');
  // An empty category page is not worth indexing; everything else is.
  const robots = items.length ? 'index,follow' : 'noindex,follow';

  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${esc(canonical)}">${rel}
<meta property="og:type" content="website"><meta property="og:site_name" content="Advantage.Bid"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc((items[0] && items[0].image) || base + '/img/social-card.png')}"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="/marketplace.css">   <!-- the shared header's layout (as on every public page) -->
${jsonLd}
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#0f172a;margin:0;background:#f8fafc}
 .wrap{max-width:1180px;margin:0 auto;padding:22px 16px 60px}
 h1{font-size:28px;margin:0 0 6px}.lead{color:#475569;margin:0 0 16px;font-size:17px;line-height:1.5;max-width:760px}
 .cats{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 20px}
 .cats a{padding:7px 13px;border:1px solid #d7dde5;border-radius:999px;background:#fff;color:#0f172a;text-decoration:none;font-size:14px;font-weight:600}
 .cats a[aria-current]{background:#0f172a;color:#fff;border-color:#0f172a}
 .grid{list-style:none;padding:0;margin:0;display:grid;gap:18px;grid-template-columns:repeat(4,minmax(0,1fr))}
 @media(max-width:1024px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
 @media(max-width:760px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
 @media(max-width:520px){.grid{grid-template-columns:minmax(0,1fr)}}
 .c{background:#fff;border:1px solid #e6e9ef;border-radius:16px;overflow:hidden;display:flex;flex-direction:column}
 .ci{display:flex;flex-direction:column;text-decoration:none;color:inherit}
 .c img,.c .ph{width:100%;aspect-ratio:4/3;object-fit:cover;background:#eef1f5;display:block}
 .c .t{font-weight:700;font-size:15px;padding:12px 14px 2px;overflow-wrap:anywhere}.c .p{font-weight:800;padding:2px 14px;font-size:17px}
 .c .m{color:#64748b;font-size:13px;padding:2px 14px 0}.c .s{display:block;padding:6px 14px 14px;font-size:13px;color:#1d4ed8;font-weight:600;text-decoration:none}
 .pg{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin:26px 0}
 .pg a,.pg span{min-width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;padding:0 12px;border:1px solid #e2e8f0;border-radius:10px;font-weight:700;text-decoration:none;color:#0f172a;background:#fff}
 .pg span[aria-current]{background:#0f172a;color:#fff;border-color:#0f172a}
 .empty{text-align:center;padding:50px 20px;color:#475569}.btn{display:inline-block;margin-top:8px;background:#2563eb;color:#fff;padding:10px 18px;border-radius:11px;text-decoration:none;font-weight:700}
 .sell{margin-top:36px;padding:20px;border:1px solid #e6e9ef;border-radius:16px;background:#fff;color:#334155}.sell a{color:#1d4ed8;font-weight:700}
</style></head><body>
<div data-adv-public-nav></div>
<main class="wrap">
<h1>${esc(heading)}</h1>
<p class="lead">Items for sale at a set price from professional sellers: shops, galleries, estate sale companies and dealers. Open any item for photos, condition, pickup and shipping details.</p>
${chips}
${body}
<p class="sell">Run a shop, gallery or estate sale company? <a href="${esc(base)}/professional-sellers.html">Sell on Advantage.Bid</a>.</p>
</main>
<script src="/widgets/shared/public-nav.js" defer></script>
</body></html>`;
  return { html, status: 200, canonical };
}

module.exports = { render, pageUrl };

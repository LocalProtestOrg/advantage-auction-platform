'use strict';

/**
 * Server-rendered public pages for a Professional Seller's own policies (migration 203; roadmap §7.3):
 *   /pro/:slug/terms            Store Terms & Conditions
 *   /pro/:slug/shipping-pickup  Shipping & Pickup Policy
 * Stable, crawlable URLs on Advantage.Bid (sellers without a website still have them). Plain text from the seller is
 * escaped and shown as paragraphs — no seller HTML. Demo storefronts are noindex. A note makes clear these are the
 * seller's own terms and that Advantage.Bid's Buyer Terms also apply and prevail.
 */
const storefront = require('./storefrontService');
const policies = require('./sellerPolicyService');

const PAGE_TO_KIND = { terms: 'store_terms', 'shipping-pickup': 'shipping_pickup' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paragraphs = (text) => String(text || '').split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');

function shell({ title, description, canonical, noindex, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  ${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
  <meta name="robots" content="${noindex ? 'noindex' : 'index,follow'}">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box}
    body{margin:0;font-family:Inter,-apple-system,sans-serif;color:#0f172a;background:#f6f8fb;line-height:1.6}
    .wrap{max-width:820px;margin:0 auto;padding:24px 16px}
    a{color:#2563eb}
    h1{font-family:Fraunces,serif;font-size:28px;margin:6px 0 4px}
    .crumb,.meta{color:#64748b;font-size:14px}
    .tabs{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
    .tabs a{padding:8px 14px;border:1px solid #e6eaef;border-radius:999px;background:#fff;text-decoration:none;color:#0f172a;font-weight:600;font-size:14px}
    .tabs a[aria-current="page"]{background:#0f172a;color:#fff;border-color:#0f172a}
    .card{background:#fff;border:1px solid #e6eaef;border-radius:14px;padding:20px 22px;overflow-wrap:anywhere}
    .note{font-size:13px;color:#475569;margin-top:16px}
  </style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}

/** Returns { status, html } — 404 (noindex) when the storefront is not public or the policy is not published. */
async function render(slug, page, base) {
  const kind = PAGE_TO_KIND[page];
  const notFound = () => ({ status: 404, html: shell({ title: 'Policy not found | Advantage.Bid', description: '', noindex: true,
    body: '<h1>Policy not found</h1><p class="meta">This seller has not published this policy.</p><p><a href="/">Explore Advantage.Bid</a></p>' }) });
  if (!kind) return notFound();
  const sp = await storefront.resolveBySlug(slug);
  if (!storefront.isPublicStorefront(sp)) return notFound();
  const all = await policies.publishedFor(sp.id);
  const p = all[kind];
  if (!p) return notFound();
  const name = storefront.sellerName(sp);
  const b = String(base).replace(/\/+$/, '');
  const url = `${b}/pro/${sp.storefront_slug}/${page}`;
  const tabs = [`<a href="/pro/${esc(sp.storefront_slug)}#shop">Shop Items</a>`,
    all.store_terms ? `<a href="/pro/${esc(sp.storefront_slug)}/terms"${kind === 'store_terms' ? ' aria-current="page"' : ''}>Store Terms &amp; Conditions</a>` : '',
    all.shipping_pickup ? `<a href="/pro/${esc(sp.storefront_slug)}/shipping-pickup"${kind === 'shipping_pickup' ? ' aria-current="page"' : ''}>Shipping &amp; Pickup Policy</a>` : '']
    .filter(Boolean).join('');
  const published = p.published_at ? new Date(p.published_at).toISOString().slice(0, 10) : '';
  const body = `<nav class="crumb" aria-label="Breadcrumb"><a href="/">Advantage.Bid</a> › <a href="/pro/${esc(sp.storefront_slug)}">${esc(name)}</a> › ${esc(p.label)}</nav>
<h1>${esc(p.label)}</h1>
<div class="meta">${esc(name)} · version ${esc(p.version)}${published ? ' · published ' + esc(published) : ''}</div>
<nav class="tabs" aria-label="Store sections">${tabs}</nav>
<article class="card">${paragraphs(p.body)}</article>
<p class="note">These are ${esc(name)}'s own store policies, written by the seller. Advantage.Bid's <a href="/buyer-terms.html">Buyer Terms</a> also apply to every purchase on Advantage.Bid and take priority where they differ; nothing here limits your rights under applicable law.</p>`;
  return { status: 200, html: shell({ title: `${p.label} | ${name} | Advantage.Bid`, description: `${p.label} for ${name} on Advantage.Bid.`,
    canonical: url, noindex: !!sp.is_demo, body }) };
}

module.exports = { render, PAGE_TO_KIND };

#!/usr/bin/env node
/* gen-demo-images.js — generate SELF-CREATED, demo-safe SVG placeholder images for the sales-demo
 * catalog. No copyrighted photography is used; these are simple branded category cards clearly marked
 * "DEMO". Output: public/demo/lot-<slug>.svg (committed static assets). Run once; re-run to regenerate.
 */
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'public', 'demo');
fs.mkdirSync(OUT, { recursive: true });

// [slug, label, background, accent]
const CATS = [
  ['furniture', 'Antique Furniture', '#f5efe6', '#8a6d3b'],
  ['artwork', 'Fine Artwork', '#eef2f7', '#3b5b8a'],
  ['jewelry', 'Estate Jewelry', '#f7eef4', '#8a3b6d'],
  ['silver', 'Sterling Silver', '#eef1f2', '#5b6b70'],
  ['collectible', 'Collectibles', '#f2eff7', '#5b3b8a'],
  ['decor', 'Vintage Decor', '#f7f3ee', '#8a5b3b'],
  ['tools', 'Tools & Workshop', '#eef4ef', '#3b8a5b'],
  ['household', 'Household', '#f4f4f2', '#6b6b5b'],
  ['specialty', 'Specialty Piece', '#fdf6ec', '#b8860b'],
];

function svg(label, bg, accent) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600" role="img" aria-label="${label} (demo image)">
  <rect width="800" height="600" fill="${bg}"/>
  <rect x="24" y="24" width="752" height="552" fill="none" stroke="${accent}" stroke-width="3" stroke-dasharray="10 8" opacity="0.5"/>
  <circle cx="400" cy="250" r="90" fill="none" stroke="${accent}" stroke-width="6" opacity="0.8"/>
  <text x="400" y="262" font-family="Georgia, 'Times New Roman', serif" font-size="54" fill="${accent}" text-anchor="middle" opacity="0.85">A.B</text>
  <text x="400" y="400" font-family="Georgia, serif" font-size="40" fill="#1f2937" text-anchor="middle">${label}</text>
  <text x="400" y="446" font-family="-apple-system, Segoe UI, sans-serif" font-size="22" fill="#6b7280" text-anchor="middle">Advantage.Bid Sample Catalog</text>
  <rect x="330" y="500" width="140" height="34" rx="17" fill="${accent}" opacity="0.9"/>
  <text x="400" y="523" font-family="-apple-system, sans-serif" font-size="18" font-weight="700" fill="#ffffff" text-anchor="middle">DEMO</text>
</svg>`;
}

let n = 0;
for (const [slug, label, bg, accent] of CATS) {
  fs.writeFileSync(path.join(OUT, `lot-${slug}.svg`), svg(label, bg, accent), 'utf8');
  n++;
}
// A company banner for the demo storefront/company presence.
fs.writeFileSync(path.join(OUT, 'company-banner.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="360" viewBox="0 0 1200 360" role="img" aria-label="Heritage and Home Estate Services (demo banner)">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#243b53"/><stop offset="1" stop-color="#3b5b8a"/></linearGradient></defs>
  <rect width="1200" height="360" fill="url(#g)"/>
  <text x="60" y="170" font-family="Georgia, serif" font-size="56" fill="#ffffff">Heritage &amp; Home Estate Services</text>
  <text x="62" y="220" font-family="-apple-system, sans-serif" font-size="26" fill="#cdd9e5">Estate Sales &amp; Online Auctions - Serving the Greater Region</text>
  <rect x="60" y="260" width="150" height="40" rx="20" fill="#ffffff" opacity="0.15"/>
  <text x="135" y="286" font-family="-apple-system, sans-serif" font-size="18" font-weight="700" fill="#ffffff" text-anchor="middle">DEMO</text>
</svg>`, 'utf8');
n++;
console.log(`Generated ${n} demo SVG assets in public/demo/`);

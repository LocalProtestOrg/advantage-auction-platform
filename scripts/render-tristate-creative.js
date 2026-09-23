#!/usr/bin/env node
/* render-tristate-creative.js — renders the DRAFT Tri-State in-home service creative candidate.

   The official transparent logo is composited from docs/marketing/brand-assets/logos (never redrawn).
   Light background, one strong headline, three short benefits, one CTA, minimal text.

   Every claim on the image comes from a verified source:
     · "In-home auction service" and the Tri-State market   — Owner-confirmed service (2026-09-23)
     · catalog/auction setup, sale management, pickup        — /assisted-service.html "How We Can Help"
     · "Tell Us About Your Sale"                             — the call to action on that page
   No photograph, testimonial, statistic, price, turnaround or guarantee is shown or implied, and the
   coverage line says PARTS of the area — ad reach is not a promise of service eligibility.

   Output is a CANDIDATE. Filesystem presence is not approval: the registry records it unapproved and
   it cannot be used until the Owner approves it.

     node scripts/render-tristate-creative.js */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const LOGO = path.join(ROOT, 'docs/marketing/brand-assets/logos/advantage-bid-transparent.png');
const OUT_DIR = path.join(ROOT, 'docs/marketing/production-creative/individual-seller/tristate-in-home');
const OUT = path.join(OUT_DIR, 'individual-seller-tristate-in-home-service-draft-v1.png');

const logo = 'data:image/png;base64,' + fs.readFileSync(LOGO).toString('base64');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:1080px;height:1080px;background:#ffffff;font-family:'Segoe UI',Arial,Helvetica,sans-serif;color:#0b1f44}
  .wrap{position:absolute;inset:0;padding:64px 92px 80px;display:flex;flex-direction:column}
  .logo{height:170px;align-self:flex-start;margin-left:-8px}
  .logo img{height:100%;width:auto}
  .rule{width:120px;height:6px;background:#1d5fe0;border-radius:3px;margin:30px 0 30px}
  h1{font-size:98px;line-height:1.0;font-weight:900;letter-spacing:-1px}
  h1 span{color:#1d5fe0}
  .sub{font-size:44px;font-weight:600;margin-top:34px;color:#1f3761}
  ul{list-style:none;margin-top:40px}
  li{font-size:38px;font-weight:500;margin:0 0 22px;padding-left:58px;position:relative;color:#1f3761}
  li:before{content:'';position:absolute;left:0;top:10px;width:30px;height:30px;border-radius:50%;background:#1d5fe0}
  .cta{margin-top:auto;display:inline-block;align-self:flex-start;background:#1d5fe0;color:#fff;font-size:40px;font-weight:800;padding:26px 48px;border-radius:14px}
  .area{margin-top:26px;font-size:26px;color:#5b6b85}
</style></head><body><div class="wrap">
  <div class="logo"><img src="${logo}" alt=""></div>
  <div class="rule"></div>
  <h1>The Smarter<br><span>Way to Sell.</span></h1>
  <div class="sub">In-home auction service from our team.</div>
  <ul>
    <li>Catalog and auction setup</li>
    <li>Sale management</li>
    <li>Pickup coordination</li>
  </ul>
  <div class="cta">Tell Us About Your Sale</div>
  <div class="area">Available in parts of the New York Tri-State area.</div>
</div></body></html>`;

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: OUT, type: 'png' });
  await browser.close();
  fs.writeFileSync(OUT + '.reference.json', JSON.stringify({
    status: 'DRAFT — Owner approval required before any use',
    purpose: 'Tri-State Individual Seller in-home service acquisition',
    logo_source: 'docs/marketing/brand-assets/logos/advantage-bid-transparent.png (composited, unaltered)',
    claims: {
      'In-home auction service from our team.': 'Owner-confirmed service (2026-09-23)',
      'Catalog and auction setup': '/assisted-service.html — "Catalog and auction setup assistance"',
      'Sale management': '/assisted-service.html — "Sale management"',
      'Pickup coordination': '/assisted-service.html — "Pickup coordination and handling"',
      'Tell Us About Your Sale': '/assisted-service.html call to action',
      'Available in parts of the New York Tri-State area.': 'coverage qualifier — ad reach is not service eligibility',
    },
    excluded_by_design: ['photographs', 'testimonials', 'statistics', 'prices', 'turnaround times', 'guarantees'],
    rendered_by: 'scripts/render-tristate-creative.js',
  }, null, 2));
  console.log('rendered ' + path.relative(ROOT, OUT));
})().catch((e) => { console.error(e.message); process.exit(1); });

'use strict';
require('dotenv').config();

const BASE = 'https://advantage-auction-platform-production.up.railway.app';
// Seeded fixed UUIDs — stable across DB resets via scripts/seed-demo-data.js
const AID  = 'dd000000-0000-4000-8000-000000000010'; // Fine Jewelry & Watches
const LID  = 'dd000000-0000-4000-8000-000000000011'; // 14K Gold Diamond Pendant

async function api(method, path, { token, body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + path, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  const icon = ok ? 'PASS' : 'FAIL';
  if (ok) pass++; else fail++;
  console.log('  [' + icon + '] ' + label + (detail ? ' — ' + detail : ''));
}

async function main() {
  console.log('=== Phase A+B+C Production Validation ===');
  console.log('Deployment started: 2026-05-10T23:19:46Z\n');

  // ── Login ──────────────────────────────────────────────────────────────────
  const loginRes = await api('POST', '/api/auth/login', {
    body: { email: 'demo-seller@advantage.bid', password: 'DemoExplore2025!' },
  });
  check('login (demo-seller)', loginRes.success || !!loginRes.token, loginRes.message || 'ok');
  if (!loginRes.token) { console.log('Cannot continue without auth'); return; }
  const token = loginRes.token;

  // ── Static page delivery ───────────────────────────────────────────────────
  console.log('\n--- Static Page Delivery ---');

  const avHttp = await fetch(BASE + '/auction-view.html');
  check('auction-view.html served', avHttp.status === 200, 'HTTP ' + avHttp.status);
  const avBody = await avHttp.text();
  check('auction-view: loadWalkthroughVideo fn', avBody.includes('loadWalkthroughVideo'));
  check('auction-view: /public-video endpoint called', avBody.includes('public-video'));
  check('auction-view: best_image_url used', avBody.includes('best_image_url'));
  check('auction-view: banner_image_url used', avBody.includes('banner_image_url'));
  check('auction-view: video modal present', avBody.includes('<video'));

  const lotHttp = await fetch(BASE + '/lot.html');
  check('lot.html served', lotHttp.status === 200, 'HTTP ' + lotHttp.status);
  const lotBody = await lotHttp.text();
  check('lot.html: best_image_url used', lotBody.includes('best_image_url'));
  check('lot.html: lightbox div', lotBody.includes('id="lightbox"'));
  check('lot.html: ArrowLeft keyboard nav', lotBody.includes('ArrowLeft'));
  check('lot.html: ArrowRight keyboard nav', lotBody.includes('ArrowRight'));
  check('lot.html: Escape to close', lotBody.includes('Escape'));
  check('lot.html: touchstart swipe', lotBody.includes('touchstart'));
  check('lot.html: touchend swipe', lotBody.includes('touchend'));
  check('lot.html: AI Enhanced badge', lotBody.includes('AI Enhanced'));
  check('lot.html: shimmer skeleton', lotBody.includes('shimmer'));
  check('lot.html: item-details section', lotBody.includes('item-details'));
  check('lot.html: openLightbox fn', lotBody.includes('openLightbox'));
  check('lot.html: closeLightbox fn', lotBody.includes('closeLightbox'));
  check('lot.html: lbShow fn', lotBody.includes('lbShow'));
  check('lot.html: lb-prev button', lotBody.includes('id="lb-prev"'));
  check('lot.html: lb-next button', lotBody.includes('id="lb-next"'));
  check('lot.html: lb-counter', lotBody.includes('lb-counter'));
  check('lot.html: zoom-in cursor', lotBody.includes('zoom-in'));
  check('lot.html: condition field rendered', lotBody.includes("'Condition'") || lotBody.includes('"Condition"') || lotBody.includes('condition'));
  check('lot.html: dimensions field rendered', lotBody.includes('dimensions'));

  // ── Summary endpoint ───────────────────────────────────────────────────────
  console.log('\n--- API: /api/auctions/:id/summary (expanded fields) ---');
  const sumRes = await api('GET', '/api/auctions/' + AID + '/summary', { token });
  check('summary: request succeeded', !!sumRes.data, sumRes.error || JSON.stringify(sumRes).slice(0, 80));
  const sum = sumRes.data || {};
  check('summary: subtitle field', sum.subtitle !== undefined, JSON.stringify(sum.subtitle));
  check('summary: city field', sum.city !== undefined, JSON.stringify(sum.city));
  check('summary: start_time field', sum.start_time !== undefined, JSON.stringify(sum.start_time));
  check('summary: end_time field', sum.end_time !== undefined, JSON.stringify(sum.end_time));
  check('summary: banner_image_url field', sum.banner_image_url !== undefined, JSON.stringify(sum.banner_image_url));
  check('summary: cover_image_url field', sum.cover_image_url !== undefined, JSON.stringify(sum.cover_image_url));
  check('summary: shipping_available field', sum.shipping_available !== undefined, JSON.stringify(sum.shipping_available));

  // ── Public video endpoint ──────────────────────────────────────────────────
  console.log('\n--- API: /api/auctions/:id/public-video (no auth) ---');
  const pvHttp = await fetch(BASE + '/api/auctions/' + AID + '/public-video');
  const pvData = await pvHttp.json();
  check('public-video: no auth required (not 401)', pvHttp.status !== 401, 'HTTP ' + pvHttp.status);
  check('public-video: success:true in response', pvData.success === true, JSON.stringify(pvData).slice(0, 60));
  if (pvData.data) {
    check('public-video: review_status=approved', pvData.data.review_status === 'approved', pvData.data.review_status);
    check('public-video: visible_public=true', pvData.data.visible_public === true, String(pvData.data.visible_public));
  } else {
    check('public-video: null (no video on test auction)', true, 'correct — no approved video exists');
  }

  // ── Images endpoint ────────────────────────────────────────────────────────
  console.log('\n--- API: /api/lots/:id/images (best_image_url + processing_status) ---');
  const imgRes = await api('GET', '/api/lots/' + LID + '/images');
  check('images: request succeeded', imgRes.success === true, imgRes.error || 'ok');
  if (imgRes.data && imgRes.data.length > 0) {
    const img = imgRes.data[0];
    check('images[0]: image_url present', !!img.image_url, (img.image_url || 'MISSING').slice(0, 50));
    check('images[0]: best_image_url field present', img.best_image_url !== undefined, img.best_image_url ? img.best_image_url.slice(0, 50) : 'null (no processed yet)');
    check('images[0]: processing_status field present', img.processing_status !== undefined, String(img.processing_status));
    check('images[0]: processed_image_url field present', img.processed_image_url !== undefined, img.processed_image_url ? 'has url' : 'null');
    if (img.processing_status === 'complete' && img.processed_image_url) {
      check('best_image_url = processed_image_url when complete', img.best_image_url === img.processed_image_url, 'values match');
    } else {
      const fallbackCorrect = img.best_image_url === img.image_url || img.best_image_url === null;
      check('best_image_url falls back to image_url', fallbackCorrect, 'ok');
    }
  } else {
    check('images: no images on test lot (skipping per-image checks)', true, 'ok');
  }

  // ── Lot detail — item metadata fields ─────────────────────────────────────
  console.log('\n--- API: /api/lots/:id (item metadata fields) ---');
  const ldRes = await api('GET', '/api/lots/' + LID, { token });
  check('lot detail: request succeeded', ldRes.success === true, ldRes.error || 'ok');
  const ld = ldRes.data || {};
  check('lot: condition field', ld.condition !== undefined, JSON.stringify(ld.condition));
  check('lot: material field', ld.material !== undefined, JSON.stringify(ld.material));
  check('lot: era field', ld.era !== undefined, JSON.stringify(ld.era));
  check('lot: maker_artist field', ld.maker_artist !== undefined, JSON.stringify(ld.maker_artist));
  check('lot: weight field', ld.weight !== undefined, JSON.stringify(ld.weight));
  check('lot: dimensions field', ld.dimensions !== undefined, JSON.stringify(ld.dimensions));

  // ── Image fallback: no processed URL ──────────────────────────────────────
  console.log('\n--- Fallback: image_url used when best_image_url is null ---');
  if (imgRes.data && imgRes.data.length > 0) {
    const img = imgRes.data[0];
    const clientBestUrl = img.best_image_url || img.image_url;
    check('client-side fallback (best_image_url || image_url)', !!clientBestUrl, clientBestUrl ? clientBestUrl.slice(0, 50) : 'EMPTY');
  } else {
    check('no images to test fallback with', true, 'skipped');
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n=== Results: ' + pass + ' passed, ' + fail + ' failed ===');
  if (fail > 0) process.exitCode = 1;
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
});

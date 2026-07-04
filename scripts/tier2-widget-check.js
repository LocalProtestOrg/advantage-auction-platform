#!/usr/bin/env node
/* Tier 2 — widget render check in a real browser (staging).
 * Loads the JS-widget embed page + the iframe fallback and asserts event cards render. */
'use strict';
const BASE = process.env.BASE_URL || 'https://advantage-staging-production.up.railway.app';
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  try { ({ chromium } = require('@playwright/test')); } catch (e2) { console.log('PLAYWRIGHT_UNAVAILABLE'); process.exit(3); }
}
const TITLE = 'Houston Estate Showcase'; // the one published Houston event from the HTTP battery

(async () => {
  const browser = await chromium.launch();
  let pass = 0, fail = 0;
  const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };
  try {
    // 1) JS widget (Shadow DOM) on the embed page
    const p1 = await browser.newPage();
    const errs = [];
    p1.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await p1.goto(BASE + '/widgets/events-embed.html', { waitUntil: 'load', timeout: 30000 });
    const shadow = await p1.evaluate(async (title) => {
      for (let i = 0; i < 30; i++) {
        const host = document.querySelector('[data-advantage-events]');
        const sr = host && host.shadowRoot;
        if (sr) {
          const html = sr.innerHTML || '';
          const links = sr.querySelectorAll('a').length;
          if (html.includes(title)) return { rendered: true, hasTitle: true, links };
          if (links > 0 && i > 10) return { rendered: true, hasTitle: html.includes(title), links };
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      const host = document.querySelector('[data-advantage-events]');
      return { rendered: !!(host && host.shadowRoot), hasTitle: false, links: 0 };
    }, TITLE);
    ok('JS widget mounts a Shadow DOM', shadow.rendered);
    ok('widget renders the published event card (title present)', shadow.hasTitle);
    ok('no console errors in widget', errs.length === 0);
    if (errs.length) errs.slice(0, 3).forEach((e) => console.log('     err: ' + e.slice(0, 100)));

    // 2) iframe fallback page renders cards
    const p2 = await browser.newPage();
    await p2.goto(BASE + '/widgets/events.html?market=houston', { waitUntil: 'load', timeout: 30000 });
    const iframeHasCard = await p2.evaluate(async (title) => {
      for (let i = 0; i < 30; i++) {
        if ((document.body.innerText || '').includes(title)) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    }, TITLE);
    ok('iframe fallback renders the published event', iframeHasCard);

    console.log('\nWIDGET RESULT: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  } finally { await browser.close(); }
})().catch((e) => { console.error('WIDGET CHECK ERROR:', e.message); process.exit(1); });

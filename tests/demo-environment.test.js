'use strict';

/**
 * Permanent sales-demo environment — safety + integrity guards.
 *
 * The demo must never contaminate real business: excluded from the public marketplace, never
 * auto-closed (so no payouts/settlement/Stripe/tax), clearly classified is_demo, resettable, and it
 * must never embed a usable credential. These are source-level guards over the exact mechanisms.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('is_demo classification (migration 112)', () => {
  const mig = read('db/migrations/112_demo_data_flag.sql');
  test('adds is_demo to seller_profiles, auctions, and users (default false)', () => {
    expect(mig).toMatch(/ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false/);
    expect(mig).toMatch(/ALTER TABLE auctions\s+ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false/);
    expect(mig).toMatch(/ALTER TABLE users\s+ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false/);
  });
});

describe('demo excluded from the public marketplace (visibility predicate)', () => {
  const vis = read('src/lib/marketplaceVisibility.js');
  test('the native-auction predicate excludes is_demo', () => {
    expect(vis).toMatch(/activeNativeAuctionSql/);
    expect(vis).toMatch(/is_demo IS NOT TRUE/);
  });
});

describe('demo never auto-closes (no payouts/settlement/tax)', () => {
  test('the state-transition close query skips is_demo auctions', () => {
    const worker = read('src/workers/notificationWorker.js');
    const dueBlock = worker.slice(worker.indexOf('const due = await db.query'), worker.indexOf('const due = await db.query') + 400);
    expect(dueBlock).toMatch(/a\.is_demo IS NOT TRUE/);
  });
});

describe('demo excluded from operational auction diagnostics', () => {
  test('the admin auction-state count filters out is_demo', () => {
    expect(read('src/routes/admin.js')).toMatch(/COUNT\(\*\)::int AS count FROM auctions WHERE is_demo IS NOT TRUE GROUP BY state/);
  });
});

describe('seed/reset script safety', () => {
  const seed = read('scripts/demo-environment.js');
  test('the auction is active, hidden from marketplace, and far-future (never closes)', () => {
    expect(seed).toMatch(/'active',true,'hidden',false/);
    expect(seed).toMatch(/now\(\) \+ interval '365 days'/);
  });
  test('all created records are flagged is_demo', () => {
    expect(seed).toMatch(/is_active, is_demo/); // users
    expect(seed).toMatch(/seller_type, is_demo/); // seller_profile
  });
  test('destructive rebuild is guarded: asserts is_demo and is scoped to the demo auction id', () => {
    expect(seed).toMatch(/REFUSE: target auction is not is_demo/);
    expect(seed).toMatch(/DELETE FROM bids WHERE auction_id = \$1/);
    expect(seed).toMatch(/DELETE FROM lots WHERE auction_id = \$1/);
    expect(seed).toMatch(/async function assertDemo/);
  });
  test('NO usable credential is embedded: password hash is a random, discarded secret', () => {
    expect(seed).toMatch(/unusablePasswordHash/);
    expect(seed).toMatch(/crypto\.randomBytes/);
    // No plaintext password assignment literal.
    expect(seed).not.toMatch(/password\s*[:=]\s*['"][A-Za-z0-9!@#]{6,}['"]/);
  });
  test('provides seed and reset modes', () => {
    expect(seed).toMatch(/mode === 'seed'/);
    expect(seed).toMatch(/mode === 'reset'/);
  });
});

describe('demo imagery is self-generated (no copyrighted photos)', () => {
  test('generator emits SVG placeholders under public/demo', () => {
    const gen = read('scripts/gen-demo-images.js');
    expect(gen).toMatch(/public', 'demo'/);
    expect(gen).toMatch(/<svg/);
    // The catalog references only local /demo/*.svg assets, never a remote image host.
    const seed = read('scripts/demo-environment.js');
    expect(seed).toMatch(/\/demo\/lot-\$\{cat\}\.svg/);
    expect(seed).not.toMatch(/https?:\/\/[^'"]*\.(jpg|jpeg|png)/i);
  });
});

describe('toolbox integration + no credential exposure', () => {
  const html = read('public/admin/sales.html');
  test('links to the permanent demo auction and documents reset', () => {
    expect(html).toMatch(/00000000-0000-4000-a000-0000000d0003/);
    expect(html).toMatch(/demo-environment\.js reset/);
  });
  test('the demo playbook uses OPEN/SHOW/SAY/ASK', () => {
    expect(html).toMatch(/OPEN:/);
    expect(html).toMatch(/SHOW:/);
    expect(html).toMatch(/SAY:/);
    expect(html).toMatch(/ASK:/);
  });
  test('no password/credential is exposed in the toolbox', () => {
    expect(html).not.toMatch(/password\s*[:=]\s*['"][^'"]+['"]/i);
    expect(html.toLowerCase()).not.toMatch(/demo (password|login) is\b/);
  });
  test('the admin page stays noindex', () => {
    expect(html).toMatch(/noindex, nofollow/);
  });
});

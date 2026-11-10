'use strict';

/**
 * Automatic storefront link (owner 2026-11-10; src/lib/storefrontLink.js). Real Postgres (PGlite) with the production
 * unique index on lower(storefront_slug) (migration 119): duplicate names, punctuation, reserved words, simultaneous
 * registrations, existing addresses kept, and a business name change never changing the link.
 */

const path = require('path');
const { Worker } = require('worker_threads');
const link = require('../src/lib/storefrontLink');

jest.setTimeout(60000);

function startPg() {
  const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js'));
  worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}
let pg; let runner;
const newProfile = async (slug = null) => (await runner.query('INSERT INTO seller_profiles (storefront_slug) VALUES ($1) RETURNING id', [slug])).rows[0].id;

beforeAll(async () => {
  pg = startPg();
  runner = { query: async (sql, params) => { const r = await pg.query(sql, params || []); return { rows: r.rows, rowCount: r.affectedRows || r.rows.length }; } };
  await pg.exec(`CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), storefront_slug text);
    CREATE UNIQUE INDEX uq_seller_profiles_storefront_slug ON seller_profiles (lower(storefront_slug)) WHERE storefront_slug IS NOT NULL;`);
});
afterAll(async () => { if (pg) await pg.close(); });
beforeEach(async () => { await pg.exec('DELETE FROM seller_profiles'); });

describe('the address is made from the business name', () => {
  test('spaces, capitals, punctuation and special characters become one clean address', () => {
    expect(link.slugify('Timeless Treasures')).toBe('timeless-treasures');
    expect(link.slugify('  TIMELESS   Treasures!!! ')).toBe('timeless-treasures');
    expect(link.slugify("Tyler's Antiques & Collectibles, LLC.")).toBe('tylers-antiques-and-collectibles-llc');
    expect(link.slugify('Café Mañana Estate Sales')).toBe('cafe-manana-estate-sales');
    expect(link.slugify('A/B -- Vintage #1')).toBe('a-b-vintage-1');
    expect(link.slugify('***')).toBeNull();
    const long = link.slugify('x'.repeat(40) + ' ' + 'y'.repeat(40));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('-')).toBe(false);
  });
  test('the numbered address stays within the length limit', () => {
    expect(link.candidate('timeless-treasures', 1)).toBe('timeless-treasures');
    expect(link.candidate('timeless-treasures', 3)).toBe('timeless-treasures-3');
    expect(link.candidate('a'.repeat(60), 12)).toHaveLength(60);
  });
});

describe('assignment', () => {
  test('a taken name gets the next free number', async () => {
    const a = await newProfile(); const b = await newProfile(); const c = await newProfile();
    expect(await link.ensureStorefrontSlug(runner, a, 'Timeless Treasures')).toBe('timeless-treasures');
    expect(await link.ensureStorefrontSlug(runner, b, 'Timeless Treasures')).toBe('timeless-treasures-2');
    expect(await link.ensureStorefrontSlug(runner, c, 'timeless treasures!')).toBe('timeless-treasures-3');
  });
  test('existing addresses (any capitalisation) are reserved; a gap is reused', async () => {
    await newProfile('Harbor-Antiques'); await newProfile('harbor-antiques-3');
    expect(await link.ensureStorefrontSlug(runner, await newProfile(), 'Harbor Antiques')).toBe('harbor-antiques-2');
    expect(await link.ensureStorefrontSlug(runner, await newProfile(), 'Harbor Antiques')).toBe('harbor-antiques-4');
  });
  test('protected system words are never given out as they are', async () => {
    for (const w of ['admin', 'api', 'login', 'shop', 'pro', 'advantage']) expect(link.isReserved(w)).toBe(true);
    expect(await link.ensureStorefrontSlug(runner, await newProfile(), 'Admin')).toBe('admin-2');
    expect(await link.ensureStorefrontSlug(runner, await newProfile(), 'Advantage')).toBe('advantage-2');
  });
  test('a name with no letters or digits still gets a working address', async () => {
    const id = await newProfile();
    expect(await link.ensureStorefrontSlug(runner, id, '!!!')).toMatch(/^seller-[0-9a-f]{8}$/);
  });
  test('an existing address is never changed, whatever the name is now', async () => {
    const id = await newProfile('timeless-treasures');
    expect(await link.ensureStorefrontSlug(runner, id, 'Completely New Name')).toBe('timeless-treasures');
    expect((await runner.query('SELECT storefront_slug FROM seller_profiles WHERE id = $1', [id])).rows[0].storefront_slug).toBe('timeless-treasures');
  });
  test('simultaneous registrations with the same name: every one gets a different address (the database decides)', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => newProfile()));
    const got = await Promise.all(ids.map((id) => link.ensureStorefrontSlug(runner, id, 'Timeless Treasures')));
    expect(new Set(got).size).toBe(6);
    expect(got.sort()).toEqual(['timeless-treasures', 'timeless-treasures-2', 'timeless-treasures-3', 'timeless-treasures-4', 'timeless-treasures-5', 'timeless-treasures-6'].sort());
    const rows = (await runner.query('SELECT count(DISTINCT lower(storefront_slug))::int n FROM seller_profiles')).rows[0];
    expect(rows.n).toBe(6);
  });
  test('the same profile asked twice at once keeps one address', async () => {
    const id = await newProfile();
    const [x, y] = await Promise.all([link.ensureStorefrontSlug(runner, id, 'Oak & Iron'), link.ensureStorefrontSlug(runner, id, 'Oak & Iron')]);
    expect(x).toBe(y);
    expect((await runner.query('SELECT count(*)::int n FROM seller_profiles WHERE storefront_slug IS NOT NULL')).rows[0].n).toBe(1);
  });
});

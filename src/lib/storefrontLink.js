'use strict';

/**
 * storefrontLink: the automatic storefront address, /pro/<slug> (owner 2026-11-10). Sellers never type or edit it.
 *
 *   - made from the business name: lower case, accents removed, "&" read as "and", apostrophes dropped, every other run
 *     of punctuation or spaces becomes one hyphen (Timeless Treasures -> timeless-treasures);
 *   - when that address is taken or reserved, the next free number is used: timeless-treasures-2, -3, ...;
 *   - the database decides: seller_profiles has a unique index on lower(storefront_slug) (migration 119), so two
 *     simultaneous registrations can never get the same address; the one that loses the race takes the next number;
 *   - assigned once and then kept: an existing address is never regenerated (a business name change keeps it), so shared
 *     links, website widgets, QR codes, search results and item links keep working.
 */

const MAX_LEN = 60;

// Words that are, or could be mistaken for, Advantage.Bid pages or functions. A business with one of these names gets
// the next number instead (e.g. admin-2). Existing storefront addresses are protected by the unique index.
const RESERVED = new Set(['admin', 'administrator', 'api', 'app', 'login', 'logout', 'signin', 'signup', 'register', 'account',
  'settings', 'dashboard', 'seller', 'sellers', 'buyer', 'buyers', 'pro', 'shop', 'store', 'storefront', 'item', 'items',
  'new', 'edit', 'create', 'search', 'help', 'support', 'contact', 'about', 'terms', 'privacy', 'legal', 'static', 'assets',
  'widgets', 'public', 'www', 'mail', 'email', 'advantage', 'advantagebid', 'advantage-bid', 'official', 'staff', 'null', 'undefined']);

function slugify(name) {
  let s = String(name == null ? '' : name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/&/g, ' and ').replace(/['’‘`]/g, '');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN).replace(/-+$/g, '');
  return s || null;
}

function isReserved(slug) { return RESERVED.has(String(slug || '').toLowerCase()); }

// Candidates in order: base, base-2, base-3, ... (the number keeps the whole address within MAX_LEN).
function candidate(base, n) {
  if (n <= 1) return base;
  const suffix = '-' + n;
  return base.slice(0, MAX_LEN - suffix.length).replace(/-+$/g, '') + suffix;
}

/**
 * Give a seller profile its storefront address if it has none. Returns the address (existing or new). Never changes an
 * existing one. `runner` is a pg pool/client (not inside an open transaction: a unique conflict must not abort it).
 */
async function ensureStorefrontSlug(runner, sellerProfileId, businessName) {
  const cur = (await runner.query('SELECT storefront_slug FROM seller_profiles WHERE id = $1', [sellerProfileId])).rows[0];
  if (!cur) return null;
  if (cur.storefront_slug) return cur.storefront_slug;
  const base = slugify(businessName) || ('seller-' + String(sellerProfileId).replace(/-/g, '').slice(0, 8));
  // Start at the lowest number that is not visibly taken; the unique index settles any race.
  const taken = new Set((await runner.query(
    `SELECT lower(storefront_slug) s FROM seller_profiles WHERE lower(storefront_slug) = $1 OR lower(storefront_slug) LIKE $2`,
    [base, base.replace(/[%_]/g, '') + '-%'])).rows.map((r) => r.s));
  for (let n = 1, tries = 0; tries < 200; n++) {
    const c = candidate(base, n);
    if (isReserved(c) || taken.has(c)) continue;
    tries++;
    try {
      const r = await runner.query(
        'UPDATE seller_profiles SET storefront_slug = $2 WHERE id = $1 AND storefront_slug IS NULL RETURNING storefront_slug', [sellerProfileId, c]);
      if (r.rows[0]) return r.rows[0].storefront_slug;
      // someone else gave this profile an address in the meantime: keep that one
      return (await runner.query('SELECT storefront_slug FROM seller_profiles WHERE id = $1', [sellerProfileId])).rows[0].storefront_slug;
    } catch (e) {
      if (e && e.code === '23505') { taken.add(c); continue; }   // another seller just took it: next number
      throw e;
    }
  }
  throw new Error('could not find a free storefront address');
}

module.exports = { slugify, isReserved, candidate, ensureStorefrontSlug, RESERVED, MAX_LEN };

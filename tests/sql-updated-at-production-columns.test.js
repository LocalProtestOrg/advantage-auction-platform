'use strict';

/**
 * Regression guard (production 500s, 2026-11-05/06): code wrote `updated_at = now()` to seller_profiles, which has no
 * updated_at column in production. The Individual-to-Professional upgrade, the Professional branding visibility switch
 * (PATCH /api/sellers/me/branding) and the admin follower-email permission switch
 * (POST /api/admin/follower-emails/sellers/:id/privilege) all failed with a 500.
 * Every UPDATE in src/ and scripts/ that sets updated_at must target a table that has that column in production
 * (tests/fullstack/production-columns.txt, captured read-only from production's information_schema).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const prod = fs.readFileSync(path.join(__dirname, 'fullstack', 'production-columns.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
const tables = new Set(prod.map((k) => k.split('.')[0]));
const columns = new Set(prod);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));

test('no UPDATE sets updated_at on a production table that has no updated_at column', () => {
  const bad = [];
  for (const f of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/UPDATE\s+(\w+)\s+(?:\w+\s+)?SET([\s\S]{0,600}?)(?:\bWHERE\b|\bRETURNING\b|\bFROM\b|[`'"]\s*[,)])/gi)) {
      const t = m[1].toLowerCase();
      if (tables.has(t) && /\bupdated_at\s*=/.test(m[2]) && !columns.has(t + '.updated_at')) {
        bad.push(path.relative(ROOT, f) + ':' + s.slice(0, m.index).split('\n').length + ' ' + t);
      }
    }
  }
  expect(bad).toEqual([]);
});

test('the two switches named in the 2026-11-06 audit no longer write seller_profiles.updated_at', () => {
  expect(columns.has('seller_profiles.updated_at')).toBe(false);
  const sellers = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'sellers.js'), 'utf8');
  const follower = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'adminFollowerEmails.js'), 'utf8');
  expect(sellers).toMatch(/UPDATE seller_profiles SET show_branding_to_buyers = \$2 WHERE id = \$1/);
  expect(follower).toMatch(/UPDATE seller_profiles SET follower_email_enabled=\$2 WHERE id=\$1/);
});

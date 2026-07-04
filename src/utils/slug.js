'use strict';

const db = require('../db');

// Only these tables may be slug-checked (table name is interpolated, so it must be
// a fixed allowlist — never user input).
const ALLOWED_TABLES = new Set(['organizations', 'events']);

/**
 * Convert arbitrary text into a URL-safe slug.
 * lowercase · strip accents · non-alphanumerics → single '-' · trim dashes · cap length.
 */
function slugify(input) {
  const s = String(input == null ? '' : input)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'item';
}

/**
 * Generate a slug unique within `table` (allowlisted). Appends -2, -3, … on collision,
 * with a timestamp-suffixed fallback in the pathological case.
 * @param {'organizations'|'events'} table
 * @param {string} base           source text (e.g., org name or event title)
 * @param {object} [q]            optional pg client (to check within a transaction); defaults to db
 */
async function generateUniqueSlug(table, base, q) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`slug: table not allowed: ${table}`);
  const runner = q || db;
  const root = slugify(base);
  let candidate = root;
  for (let i = 2; i <= 200; i++) {
    const { rows } = await runner.query(`SELECT 1 FROM ${table} WHERE slug = $1 LIMIT 1`, [candidate]);
    if (!rows.length) return candidate;
    candidate = `${root}-${i}`;
  }
  return `${root}-${Date.now().toString(36).slice(-5)}`;
}

module.exports = { slugify, generateUniqueSlug };

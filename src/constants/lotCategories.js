'use strict';

/**
 * lotCategories — the ONE controlled auction-lot category vocabulary. Canonical `key` + human `label`.
 *
 * Compatibility: the legacy free-text value stays in lots.category; the normalized canonical key lives in
 * lots.category_key (nullable, populated going forward). Nothing bulk-rewrites historical/imported data —
 * unknown/legacy free-text simply yields a null key, and consumers fall back to the free-text matcher.
 *
 * This provides the authoritative Clothing/Apparel classification consumed by the Marketing Phase 3B
 * eligibility rule. It deliberately does NOT classify jewelry, watches, handbags, textiles/linens, or
 * collectibles as clothing.
 */

const CATEGORIES = Object.freeze([
  { key: 'furniture',        label: 'Furniture' },
  { key: 'fine_art',         label: 'Fine Art' },
  { key: 'jewelry',          label: 'Jewelry & Watches' },
  { key: 'clothing',         label: 'Clothing & Apparel' },
  { key: 'handbags',         label: 'Handbags & Accessories' },
  { key: 'home_decor',       label: 'Home Decor' },
  { key: 'lighting',         label: 'Lighting' },
  { key: 'rugs_textiles',    label: 'Rugs & Textiles' },
  { key: 'ceramics_glass',   label: 'Ceramics & Glass' },
  { key: 'silver_metalware', label: 'Silver & Metalware' },
  { key: 'collectibles',     label: 'Collectibles' },
  { key: 'coins_currency',   label: 'Coins & Currency' },
  { key: 'books_media',      label: 'Books & Media' },
  { key: 'electronics',      label: 'Electronics' },
  { key: 'tools',            label: 'Tools & Equipment' },
  { key: 'antiques',         label: 'Antiques' },
  { key: 'general',          label: 'General' },
]);

const CLOTHING_KEYS = Object.freeze(['clothing']);
const VALID_KEYS = new Set(CATEGORIES.map((c) => c.key));

// Explicit free-text/label → canonical key synonyms. Jewelry/watches → jewelry; handbags → handbags
// (NOT clothing). Deliberately conservative; unknown values return null (preserve legacy free-text).
const SYNONYMS = {
  'furniture': 'furniture',
  'fine art': 'fine_art', 'art': 'fine_art', 'art & wall décor': 'fine_art', 'art & wall decor': 'fine_art', 'sculpture': 'fine_art', 'paintings': 'fine_art',
  'jewelry': 'jewelry', 'jewelry & watches': 'jewelry', 'jewellery': 'jewelry', 'watches': 'jewelry', 'watch': 'jewelry',
  'clothing': 'clothing', 'clothing & accessories': 'clothing', 'clothing & apparel': 'clothing', 'apparel': 'clothing', 'clothes': 'clothing',
  'handbags': 'handbags', 'handbags & accessories': 'handbags', 'purses': 'handbags', 'bags': 'handbags',
  'home decor': 'home_decor', 'home décor': 'home_decor', 'decorative objects': 'home_decor', 'decor': 'home_decor',
  'lighting': 'lighting', 'lighting & decorative accessories': 'lighting', 'lighting & fixtures': 'lighting',
  'rugs & textiles': 'rugs_textiles', 'rugs & carpets': 'rugs_textiles', 'rugs': 'rugs_textiles', 'textiles': 'rugs_textiles', 'linens': 'rugs_textiles',
  'ceramics & glass': 'ceramics_glass', 'crystal & glass': 'ceramics_glass', 'glass': 'ceramics_glass', 'pottery & ceramics': 'ceramics_glass', 'porcelain & decorative ceramics': 'ceramics_glass', 'porcelain': 'ceramics_glass',
  'silver & metalware': 'silver_metalware', 'silver & tableware': 'silver_metalware', 'silver': 'silver_metalware',
  'collectibles': 'collectibles', 'art & collectibles': 'collectibles', 'militaria': 'collectibles',
  'coins & currency': 'coins_currency', 'coins': 'coins_currency',
  'books & media': 'books_media', 'books & manuscripts': 'books_media', 'books': 'books_media',
  'electronics': 'electronics',
  'tools': 'tools', 'tools & equipment': 'tools',
  'antiques': 'antiques', 'asian antiques': 'antiques',
  'clocks & timepieces': 'collectibles', 'clocks': 'collectibles', 'gemstones': 'jewelry',
  'general': 'general', 'other': 'general', 'gemstone': 'jewelry',
};

// Map a free-text/label category to a canonical key. Returns null when unknown (legacy free-text preserved).
function normalizeToCategoryKey(input) {
  const n = String(input == null ? '' : input).toLowerCase().trim();
  if (!n) return null;
  if (VALID_KEYS.has(n)) return n;
  if (Object.prototype.hasOwnProperty.call(SYNONYMS, n)) return SYNONYMS[n];
  // Robust clothing/apparel fallback (covers e.g. "Men's Apparel", "Vintage Clothing").
  if (n.startsWith('clothing') || n.includes('apparel') || n.includes('clothes')) return 'clothing';
  return null;
}

function isClothingKey(key) {
  return key != null && CLOTHING_KEYS.includes(String(key).toLowerCase());
}

module.exports = { CATEGORIES, CLOTHING_KEYS, VALID_KEYS, SYNONYMS, normalizeToCategoryKey, isClothingKey };

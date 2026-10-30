'use strict';

/**
 * storefrontCategoryService — automatic marketplace categories for Professional Seller inventory (migration 209).
 *
 * ONE taxonomy: src/constants/lotCategories.js (the same categories auction lots use). No second vocabulary.
 *
 * Order of evidence for an item:
 *   1. The seller's own choice (category_source 'seller') is final: automatic processing never changes it.
 *   2. A category from the seller's spreadsheet, when it maps to the taxonomy (normalizeToCategoryKey, the Smart
 *      Catalog Tools vocabulary): source 'spreadsheet'.
 *   3. The item's own words: a conservative, deterministic classifier over the spreadsheet category text, title,
 *      material and description (weighted, title first; the noun that names the item counts most). Assigned only when
 *      the evidence is clear: source 'automatic' with a confidence.
 *   4. Otherwise the category is left PENDING internally rather than guessed. A pending item is still a normal draft:
 *      categorisation never blocks inventory creation. An optional background pass (refinePending) asks the Smart
 *      Catalog Tools text classifier about pending items when it is configured; it, too, only assigns with confidence.
 *
 * classify() is pure and synchronous, so import previews and bulk imports can categorise every row immediately.
 */

const { CATEGORIES, VALID_KEYS, normalizeToCategoryKey } = require('../constants/lotCategories');

const LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));
const ASSIGN_MIN_SCORE = 4;      // evidence needed to assign automatically
const ASSIGN_MIN_SHARE = 0.6;    // the winning category's share of all evidence
const AUTO_MIN_CONFIDENCE = 0.6; // minimum confidence recorded for an automatic assignment

// Terms per category. Multi-word terms are matched as phrases; plurals match automatically. Kept deliberately
// specific: a word that commonly appears across categories (e.g. "vintage", "set", "pair", "style") is not evidence.
const TERMS = {
  furniture: ['table', 'chair', 'sofa', 'couch', 'settee', 'loveseat', 'desk', 'dresser', 'chest of drawers', 'drawer chest', 'chest on chest',
    'chest', 'highboy', 'lowboy', 'cabinet', 'credenza', 'sideboard', 'buffet', 'armoire', 'wardrobe', 'bookcase', 'bookshelf', 'bench',
    'ottoman', 'stool', 'nightstand', 'night stand', 'console', 'etagere', 'hutch', 'bed', 'headboard', 'vanity', 'secretary desk', 'commode',
    'recliner', 'rocker', 'rocking chair', 'armchair', 'chaise', 'coffee table', 'end table', 'side table', 'nesting table', 'dining set',
    'curio', 'china cabinet', 'tea cart', 'bar cart', 'bureau', 'slant front', 'ladder back chair', 'pedestal', 'bar stool', 'daybed', 'footstool'],
  fine_art: ['painting', 'oil on canvas', 'oil on board', 'oil on panel', 'oil on linen', 'acrylic on canvas', 'acrylic', 'watercolor', 'watercolour',
    'gouache', 'lithograph', 'serigraph', 'silkscreen', 'screenprint', 'woodblock print', 'woodcut', 'etching', 'engraving', 'giclee',
    'artist proof', 'sculpture', 'statue', 'bust', 'portrait', 'still life', 'framed art', 'artwork', 'pastel', 'charcoal drawing', 'drawing',
    'mixed media', 'work on paper', 'paint on paper', 'on paper', 'photograph', 'diptych', 'triptych', 'portfolio', 'limited edition',
    'assemblage', 'relief', 'canvas', 'original on wood', 'nude study', 'untitled'],
  jewelry: ['ring', 'necklace', 'bracelet', 'bangle', 'earring', 'brooch', 'pendant', 'cufflink', 'cuff link', 'jewelry', 'jewellery',
    'diamond', 'sapphire', 'emerald', 'ruby', 'pearl', 'gemstone', '14k', '18k', '10k', '14kt', '18kt', 'karat', 'carat', 'watch',
    'wristwatch', 'pocket watch', 'rolex', 'omega', 'cartier', 'bulgari', 'bvlgari', 'patek philippe', 'breitling', 'tag heuer', 'chronograph', 'chronometer'],
  clothing: ['dress', 'coat', 'jacket', 'blouse', 'shirt', 'skirt', 'trousers', 'pants', 'jeans', 'sweater', 'suit', 'tuxedo', 'gown', 'scarf',
    'shoes', 'boots', 'hat', 'gloves', 'fur coat', 'mink coat', 'apparel', 'clothing', 'kimono', 'vest'],
  handbags: ['handbag', 'purse', 'clutch', 'tote', 'wallet', 'luggage', 'suitcase', 'louis vuitton', 'chanel bag', 'hermes bag', 'gucci bag', 'satchel', 'crossbody'],
  home_decor: ['vase', 'mirror', 'figurine', 'candlestick', 'planter', 'urn', 'centerpiece', 'bookend', 'screen', 'room divider', 'basket',
    'tray', 'box', 'jewelry box', 'picture frame', 'obelisk', 'display stand', 'decorative', 'decor', 'jardiniere', 'wall hanging'],
  lighting: ['lamp', 'chandelier', 'sconce', 'lantern', 'floor lamp', 'table lamp', 'pendant light', 'light fixture', 'lighting', 'illuminated',
    'torchiere', 'candelabra', 'lamp shade', 'lampshade', 'desk lamp', 'converted to lamp'],
  rugs_textiles: ['rug', 'carpet', 'runner', 'kilim', 'tapestry', 'quilt', 'textile', 'linen', 'tablecloth', 'blanket', 'pillow', 'needlepoint',
    'embroidery', 'oriental rug', 'persian rug', 'area rug', 'oushak', 'heriz', 'hand knotted'],
  ceramics_glass: ['porcelain', 'ceramic', 'pottery', 'stoneware', 'earthenware', 'faience', 'majolica', 'glass', 'crystal', 'art glass',
    'murano', 'lalique', 'waterford', 'baccarat', 'stemware', 'goblet', 'decanter', 'bowl', 'plate', 'platter', 'teapot', 'tea set',
    'dinnerware', 'bone china', 'china set', 'charger', 'cloisonne', 'celadon', 'satsuma', 'imari', 'famille rose', 'blue and white', 'wedgwood',
    'wedgewood', 'meissen', 'compote', 'porcelain vase', 'ceramic vase', 'glass vase'],
  silver_metalware: ['sterling', 'sterling silver', 'silver plate', 'silverplate', 'silverplated', 'flatware', 'pewter', 'brass', 'copper', 'bronze',
    'tea service', 'coffee service', 'candelabrum', 'trophy', 'chalice', 'silver tray', 'cutlery', 'serving spoon', 'zinc', 'galvanized', 'tin'],
  collectibles: ['collectible', 'memorabilia', 'autograph', 'autographed', 'signed baseball', 'trading card', 'baseball card', 'comic',
    'action figure', 'doll', 'toy', 'model train', 'die cast', 'diecast', 'militaria', 'medal', 'sword', 'stamp collection', 'stamp',
    'record album', 'vinyl record', 'sports memorabilia', 'advertising sign', 'tin sign', 'snow globe', 'clock', 'mantel clock', 'mantle clock',
    'wall clock', 'geode', 'fossil', 'ammonite', 'mineral specimen', 'meteorite'],
  coins_currency: ['coin', 'currency', 'banknote', 'bullion', 'morgan dollar', 'silver dollar', 'half dollar', 'proof set', 'mint set',
    'numismatic', 'gold coin', 'troy ounce', 'paper money', 'pcgs', 'ngc'],
  books_media: ['book', 'first edition', 'hardcover', 'paperback', 'manuscript', 'atlas', 'map', 'magazine', 'encyclopedia', 'bible', 'dvd',
    'cd collection', 'vhs', 'sheet music', 'poster'],
  electronics: ['television', 'tv', 'stereo', 'receiver', 'amplifier', 'speaker', 'turntable', 'record player', 'radio', 'camera', 'lens',
    'laptop', 'computer', 'monitor', 'tablet', 'ipad', 'iphone', 'cell phone', 'headphones', 'video game', 'game console', 'projector', 'tube amp', 'reel to reel'],
  tools: ['tool', 'drill', 'saw', 'table saw', 'miter saw', 'lathe', 'wrench', 'socket set', 'toolbox', 'tool chest', 'compressor', 'generator',
    'welder', 'sander', 'chisel', 'hammer', 'ladder', 'mower', 'lawn mower', 'pressure washer', 'chainsaw', 'workbench', 'vise', 'jack stand',
    'forklift', 'trailer', 'equipment', 'hand plane'],
  // Period and style words describe an item rather than name it, so they decide the category only when nothing more
  // specific does (an "antique Persian rug" is a rug; an "antique" with no other evidence is an antique).
  antiques: ['antique', 'circa', '18th century', '19th century', '18th c', '19th c', 'victorian', 'georgian', 'edwardian', 'regency',
    'federal period', 'chippendale', 'sheraton', 'hepplewhite', 'queen anne', 'louis xv', 'louis xvi', 'empire period', 'biedermeier',
    'belle epoque', 'art nouveau', 'primitive'],
};
const MODIFIER_CATEGORY = 'antiques';
// Weak words count half: they are often descriptive rather than the item itself.
const WEAK = new Set(['glass', 'brass', 'copper', 'bronze', 'zinc', 'tin', 'galvanized', 'box', 'tray', 'screen', 'canvas', 'map', 'monitor',
  'drawing', 'decorative', 'decor', 'bowl', 'plate', 'equipment', 'ring', 'suit', 'hat', 'basket', 'vest', 'trophy', 'crystal', 'pedestal',
  'relief', 'untitled', 'on paper', 'limited edition', 'runner', 'linen', 'stamp', 'lens', 'tablet', 'chest', 'saw', 'tool', 'pastel', 'bust']);
const FIELD_WEIGHT = { category: 5, title: 3, material: 2, description: 1 };
// Title words before these markers name the item; words after them describe it ("lamp WITH chinese figures").
const TITLE_TAIL = / (with|in a|in an|in the|featuring|having|depicting|on a|on an) /;

function tokens(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Every term with its plural forms, longest first, so "table lamps" is matched before "table" and "lamp".
const PHRASES = (() => {
  const out = [];
  for (const [key, terms] of Object.entries(TERMS)) {
    for (const t of terms) {
      const forms = new Set([t, t + 's', t + 'es', t.replace(/y$/, 'ies')]);
      for (const f of forms) out.push({ key, term: t, form: f, weak: WEAK.has(t), phrase: t.includes(' ') });
    }
  }
  return out.sort((a, b) => b.form.length - a.form.length);
})();

// Matches in one text, longest phrase first; matched words are consumed so their parts never count again.
function matches(text) {
  let t = ' ' + text + ' ';
  const found = [];
  for (const p of PHRASES) {
    const needle = ' ' + p.form + ' ';
    let i = t.indexOf(needle);
    let n = 0;
    while (i !== -1 && n < 5) {
      found.push({ key: p.key, weak: p.weak, phrase: p.phrase, at: i });
      t = t.slice(0, i) + ' ' + '_'.repeat(needle.length - 2) + ' ' + t.slice(i + needle.length);
      i = t.indexOf(needle); n++;
    }
  }
  return found;
}

/** Score every category from an item's fields. Pure. */
function score(fields) {
  const scores = {};
  for (const [field, weight] of Object.entries(FIELD_WEIGHT)) {
    const text = tokens(fields[field]);
    if (!text) continue;
    const tail = field === 'title' ? (' ' + text + ' ').search(TITLE_TAIL) : -1;
    const perKey = {};
    const found = matches(text);
    // In a title, the last naming word before any description ("…bronze SCULPTURE", "…framed MIRROR") is the item.
    let head = null;
    if (field === 'title') {
      for (const m of found) if (!m.weak && m.key !== MODIFIER_CATEGORY && (tail === -1 || m.at < tail) && (!head || m.at > head.at)) head = m;
    }
    for (const m of found) {
      let s = weight * (m.weak ? 0.5 : 1) * (m.phrase ? 1.5 : 1);
      if (field === 'title' && tail !== -1) s *= m.at < tail ? 2 : 0.5;
      if (m === head) s *= 1.5;
      (perKey[m.key] = perKey[m.key] || []).push(s);
    }
    // A few mentions are evidence; repeating a word is not more evidence.
    for (const [key, list] of Object.entries(perKey)) {
      const kept = list.sort((a, b) => b - a).slice(0, field === 'description' ? 3 : 2);
      scores[key] = (scores[key] || 0) + kept.reduce((a, b) => a + b, 0);
    }
  }
  // Period/style words decide only when no other category has real evidence.
  if (scores[MODIFIER_CATEGORY] && Object.entries(scores).some(([k, v]) => k !== MODIFIER_CATEGORY && v >= ASSIGN_MIN_SCORE)) delete scores[MODIFIER_CATEGORY];
  return scores;
}

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Classify one item. fields: { category, title, description, material }.
 * Returns { key, label, source, confidence, status, input }: key null with status 'pending' when unsure.
 */
function classify(fields = {}) {
  const input = fields.category != null && String(fields.category).trim() ? String(fields.category).trim().slice(0, 100) : null;
  // 2. The spreadsheet's own category, when it is a taxonomy category or a known name for one.
  if (input) {
    const direct = normalizeToCategoryKey(input);
    if (direct && VALID_KEYS.has(direct)) return { key: direct, label: LABEL[direct], source: 'spreadsheet', confidence: 1, status: 'assigned', input };
  }
  // 3. The item's own words.
  const ranked = Object.entries(score(fields)).sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((n, [, v]) => n + v, 0);
  if (ranked.length) {
    const [key, top] = ranked[0];
    const second = ranked[1] ? ranked[1][1] : 0;
    const share = top / total;
    const confidence = Math.min(0.95, share * (top >= ASSIGN_MIN_SCORE * 2 ? 1 : 0.85) + (second === 0 ? 0.1 : 0));
    if (top >= ASSIGN_MIN_SCORE && share >= ASSIGN_MIN_SHARE && confidence >= AUTO_MIN_CONFIDENCE) {
      // Evidence that came mostly from the spreadsheet's own category text is still the spreadsheet's category.
      const fromSheet = !!input && (score({ category: input })[key] || 0) >= top / 2;
      return { key, label: LABEL[key], source: fromSheet ? 'spreadsheet' : 'automatic', confidence: round(confidence), status: 'assigned', input };
    }
  }
  // 4. Not clear enough: leave it pending rather than guess.
  return { key: null, label: null, source: null, confidence: ranked.length ? round(Math.min(0.59, (ranked[0][1] / (total || 1)) * 0.6)) : 0, status: 'pending', input };
}

/** Column values for an item from a classification (import, Post to the Market, the background pass). */
function columns(c) {
  return {
    category_key: c.key, category: c.key ? c.label : null, category_source: c.source, category_confidence: c.confidence,
    category_status: c.status, category_input: c.input || null, category_updated_at: new Date(),
  };
}

/** A seller's manual choice: always a taxonomy category, always final. */
function sellerChoice(key) {
  if (!VALID_KEYS.has(key)) { const e = new Error('Choose one of the listed categories.'); e.status = 422; e.code = 'CATEGORY_INVALID'; throw e; }
  return { category_key: key, category: LABEL[key], category_source: 'seller', category_confidence: null, category_status: 'assigned', category_updated_at: new Date() };
}

/**
 * Background pass for PENDING items of one seller (bounded). Uses the Smart Catalog Tools text classifier when it is
 * configured (classifyText injected, or aiDescriptionService.classifyCategoryText). Never touches an item whose
 * category the seller chose, and never assigns below the confidence threshold. Returns { examined, assigned }.
 */
async function refinePending(sellerId, { db = require('../db'), classifyText = null, limit = 50 } = {}) {
  let fn = classifyText;
  if (!fn) { try { fn = require('./aiDescriptionService').classifyCategoryText; } catch (_) { fn = null; } }
  if (typeof fn !== 'function') return { examined: 0, assigned: 0, skipped: 'classifier_unavailable' };
  const { rows } = await db.query(
    `SELECT id, title, description, material, category_input FROM marketplace_items
      WHERE seller_id = $1 AND category_status = 'pending' AND category_source IS DISTINCT FROM 'seller' AND status IN ('draft','active','paused')
      ORDER BY created_at LIMIT $2`, [sellerId, limit]);
  let assigned = 0;
  for (const r of rows) {
    let out = null;
    try { out = await fn({ title: r.title, description: r.description, material: r.material, category: r.category_input, categories: CATEGORIES }); } catch (_) { out = null; }
    if (!out || !VALID_KEYS.has(out.key) || !(Number(out.confidence) >= AUTO_MIN_CONFIDENCE)) continue;
    // The WHERE clause keeps a seller's choice made in the meantime.
    const u = await db.query(
      `UPDATE marketplace_items SET category_key = $2, category = $3, category_source = 'automatic', category_confidence = $4, category_status = 'assigned',
              category_updated_at = now(), updated_at = now()
        WHERE id = $1 AND category_status = 'pending' AND category_source IS DISTINCT FROM 'seller'`,
      [r.id, out.key, LABEL[out.key], round(Math.min(0.95, Number(out.confidence)))]);
    if (u.rowCount) assigned++;
  }
  return { examined: rows.length, assigned };
}

module.exports = { classify, score, columns, sellerChoice, refinePending, LABEL, TERMS, ASSIGN_MIN_SCORE, AUTO_MIN_CONFIDENCE, CATEGORIES };

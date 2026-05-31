'use strict';

/**
 * AI Catalog Assistant — Clarification Registry (Phase 2A.1).
 *
 * Single source of truth for the button-driven Seller Verification Layer:
 *   - which verification GROUPS exist, and the multi-select OPTIONS in each,
 *   - which groups appear for a given AI-detected item category,
 *   - which option selections may (later) populate existing lot metadata
 *     fields (condition / material / era / maker_artist) — but ONLY where the
 *     mapping is obvious and unambiguous.
 *
 * Code-owned (like permissionRegistry / sellerTypes) — not DB config — so the
 * valid set is version-controlled, testable, and cannot drift via data.
 *
 * SCOPE (Phase 2A.1): this module only DECLARES the schema and provides pure
 * helpers. It is NOT wired into any route, the AI refine endpoint, the seller
 * UI, the admin UI, or audit integration — those are post-checkpoint phases.
 *
 * Design rules locked by the approved UX:
 *   - Multi-select only; no free text.
 *   - "Not Sure" is available only where appropriate (group.notSure === true)
 *     and must make the AI MORE conservative downstream (enforced in the refine
 *     prompt in a later phase — here we only record that it was selected).
 *   - Seller-entered values always take precedence and must never be
 *     overwritten automatically (enforced by the CONSUMER of
 *     metadataFromSelections — see its doc).
 */

const NOT_SURE = { key: 'not_sure', label: 'Not Sure' };

// Append NOT_SURE to a group's options when appropriate.
function withNotSure(options) {
  return options.concat([NOT_SURE]);
}

/**
 * GROUPS — every verification group, keyed. Each option may carry an optional
 * `metadata: { field, value }` mapping to a lot column. A mapping is applied
 * downstream ONLY when its group has exactly one mapped option selected and
 * "Not Sure" is not selected in that group (see metadataFromSelections).
 *
 * Mapped lot fields (migration 037): condition, material, era, maker_artist.
 * `artist`, `gemstone`, `working_status`, `authenticity` are signal-only —
 * a button cannot reliably supply a free-text name/material, so they do NOT
 * auto-populate lot fields (kept for verification signal + AI refinement).
 */
const GROUPS = {
  // ── Artwork ────────────────────────────────────────────────────────────
  medium: {
    key: 'medium', label: 'Medium', multiSelect: true, notSure: true,
    options: withNotSure([
      { key: 'original_painting', label: 'Original Painting' },
      { key: 'print',            label: 'Print' },
      { key: 'lithograph',       label: 'Lithograph' },
      { key: 'photograph',       label: 'Photograph' },
      { key: 'drawing',          label: 'Drawing' },
      { key: 'sculpture',        label: 'Sculpture' },
      { key: 'mixed_media',      label: 'Mixed Media' },
    ]),
  },
  authenticity: {
    key: 'authenticity', label: 'Authenticity', multiSelect: true, notSure: true,
    options: withNotSure([
      { key: 'signed',     label: 'Signed' },
      { key: 'unsigned',   label: 'Unsigned' },
      { key: 'numbered',   label: 'Numbered' },
      { key: 'coa',        label: 'Certificate of Authenticity' },
    ]),
  },
  artist: {
    key: 'artist', label: 'Artist', multiSelect: true, notSure: true,
    options: withNotSure([
      { key: 'artist_identified', label: 'Artist Identified' },
      { key: 'attributed',        label: 'Attributed' },
      { key: 'unknown_artist',    label: 'Unknown Artist' },
    ]),
  },

  // ── Age (maps to era where unambiguous) ──────────────────────────────────
  age: {
    key: 'age', label: 'Age', multiSelect: true, notSure: true,
    options: withNotSure([
      { key: 'antique',      label: 'Antique (100+ yrs)', metadata: { field: 'era', value: 'Antique' } },
      { key: 'vintage',      label: 'Vintage',            metadata: { field: 'era', value: 'Vintage' } },
      { key: 'contemporary', label: 'Contemporary',       metadata: { field: 'era', value: 'Contemporary' } },
    ]),
  },

  // ── Condition — UNIVERSAL GRADE (maps to condition). Comparable across every
  // category, so it stays a fixed 5-option grade. Category-specific condition
  // facets (e.g. Working Status for electronics/mechanical) live in their own
  // groups, NOT here. 'Untested' is a functional concept and lives only in
  // working_status — never in the universal grade (a painting is not "untested").
  condition: {
    key: 'condition', label: 'Condition', multiSelect: true, notSure: true,
    options: withNotSure([
      { key: 'excellent', label: 'Excellent', metadata: { field: 'condition', value: 'Excellent' } },
      { key: 'good',      label: 'Good',      metadata: { field: 'condition', value: 'Good' } },
      { key: 'fair',      label: 'Fair',      metadata: { field: 'condition', value: 'Fair' } },
      { key: 'poor',      label: 'Poor',      metadata: { field: 'condition', value: 'Poor' } },
    ]),
  },

  // ── Jewelry: Metal (maps to material) ────────────────────────────────────
  metal: {
    key: 'metal', label: 'Metal', multiSelect: true, notSure: true,
    options: withNotSure([
      { key: 'sterling_silver', label: 'Sterling Silver', metadata: { field: 'material', value: 'Sterling Silver' } },
      { key: 'gold',            label: 'Gold',            metadata: { field: 'material', value: 'Gold' } },
      { key: 'gold_plated',     label: 'Gold-Plated',     metadata: { field: 'material', value: 'Gold-Plated' } },
      { key: 'platinum',        label: 'Platinum',        metadata: { field: 'material', value: 'Platinum' } },
      { key: 'costume',         label: 'Costume / Base Metal', metadata: { field: 'material', value: 'Costume / Base Metal' } },
    ]),
  },
  gemstone: {
    key: 'gemstone', label: 'Gemstone', multiSelect: true, notSure: true,
    options: withNotSure([
      { key: 'diamond',        label: 'Diamond' },
      { key: 'precious',       label: 'Precious Gemstone' },
      { key: 'semi_precious',  label: 'Semi-Precious' },
      { key: 'simulated',      label: 'Simulated / Glass' },
      { key: 'no_stone',       label: 'No Stone' },
    ]),
  },

  // ── Furniture: Material (maps to material) ───────────────────────────────
  material: {
    key: 'material', label: 'Material', multiSelect: true, notSure: true,
    options: withNotSure([
      { key: 'solid_wood',  label: 'Solid Wood',   metadata: { field: 'material', value: 'Solid Wood' } },
      { key: 'wood_veneer', label: 'Wood Veneer',  metadata: { field: 'material', value: 'Wood Veneer' } },
      { key: 'metal',       label: 'Metal',        metadata: { field: 'material', value: 'Metal' } },
      { key: 'glass',       label: 'Glass',        metadata: { field: 'material', value: 'Glass' } },
      { key: 'upholstered', label: 'Upholstered',  metadata: { field: 'material', value: 'Upholstered' } },
      { key: 'mixed',       label: 'Mixed Materials' },
    ]),
  },

  // ── Electronics / mechanical: Working Status (signal-only) ───────────────
  working_status: {
    key: 'working_status', label: 'Working Status', multiSelect: true, notSure: true,
    options: withNotSure([
      { key: 'working',     label: 'Working' },
      { key: 'not_working', label: 'Not Working' },
      { key: 'untested',    label: 'Untested' },
    ]),
  },
};

/**
 * CATEGORY_CLARIFICATIONS — AI-detected category (the rich category string the
 * generate endpoint returns, e.g. 'Fine Art') → ordered list of group keys.
 * `_default` is the fallback for any unmapped/unknown category.
 *
 * Only relevant groups appear (requirement #2). Keys MUST exist in GROUPS.
 */
const CATEGORY_CLARIFICATIONS = {
  'Fine Art':             ['medium', 'authenticity', 'artist', 'age', 'condition'],
  'Jewelry':              ['metal', 'gemstone', 'authenticity', 'age', 'condition'],
  'Furniture':            ['material', 'age', 'condition'],
  'Antiques':             ['material', 'age', 'condition'],
  'Home Decor':           ['material', 'age', 'condition'],
  'Pottery & Ceramics':   ['age', 'condition'],
  'Clocks & Timepieces':  ['working_status', 'age', 'condition'],
  'Tools':                ['working_status', 'material', 'condition'],
  'Electronics':          ['working_status', 'condition'],
  'General':              ['condition'],
  '_default':             ['condition'],
};

// Lot metadata fields an option mapping is allowed to target (migration 037).
const MAPPABLE_LOT_FIELDS = ['condition', 'material', 'era', 'maker_artist'];

/**
 * schemaForCategory(aiCategory) → the ordered array of full group objects to
 * present for a detected category. Falls back to `_default` (condition only)
 * for unknown categories so a seller is never left with zero groups.
 */
function schemaForCategory(aiCategory) {
  const groupKeys = CATEGORY_CLARIFICATIONS[aiCategory] || CATEGORY_CLARIFICATIONS._default;
  return groupKeys.map((k) => GROUPS[k]).filter(Boolean);
}

/**
 * isValidSelection(selections) → true if every group key exists, every option
 * key belongs to that group, and 'not_sure' is only used where the group
 * allows it. Used server-side (later phase) to reject forged/garbage payloads
 * before storing. Pure; no DB.
 *
 * selections shape: { [groupKey]: [optionKey, ...] }
 *   "Not Sure" is represented as the option key 'not_sure' within its group.
 */
function isValidSelection(selections) {
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) return false;
  for (const [groupKey, picked] of Object.entries(selections)) {
    const group = GROUPS[groupKey];
    if (!group) return false;
    if (!Array.isArray(picked)) return false;
    const valid = new Set(group.options.map((o) => o.key));
    for (const optKey of picked) {
      if (!valid.has(optKey)) return false;
      if (optKey === 'not_sure' && !group.notSure) return false;
    }
  }
  return true;
}

/**
 * metadataFromSelections(selections) → a partial { condition?, material?, era?,
 * maker_artist? } derived ONLY where the mapping is obvious and unambiguous:
 *   - the group has option(s) carrying a metadata mapping,
 *   - exactly ONE mapped option is selected in that group,
 *   - 'not_sure' is NOT selected in that group,
 *   - the resulting field is one of MAPPABLE_LOT_FIELDS.
 * Ambiguous selections (e.g. two materials, or a material + Not Sure) yield
 * NO value for that field — never guess.
 *
 * CONSUMER CONTRACT (enforced by the caller, a later phase — NOT here):
 *   - Seller-entered values ALWAYS take precedence. The caller MUST skip any
 *     field the seller has already filled; this helper only proposes values
 *     for blank fields. It NEVER instructs an overwrite.
 *
 * Pure; no DB; unwired in Phase 2A.1.
 */
function metadataFromSelections(selections) {
  const out = {};
  if (!isValidSelection(selections)) return out;
  for (const [groupKey, picked] of Object.entries(selections)) {
    if (picked.includes('not_sure')) continue;               // declined → never populate
    const group = GROUPS[groupKey];
    const mapped = group.options.filter((o) => o.metadata && picked.includes(o.key));
    if (mapped.length !== 1) continue;                        // 0 or ambiguous → skip
    const { field, value } = mapped[0].metadata;
    if (!MAPPABLE_LOT_FIELDS.includes(field)) continue;
    // If two different groups map to the same field with different values,
    // the later group would clobber — guard against that by only setting once.
    if (out[field] === undefined) out[field] = value;
    else if (out[field] !== value) delete out[field];        // conflict → unset, never guess
  }
  return out;
}

/**
 * describeSelections(selections) → human-readable breakdown, used by BOTH the
 * AI refine prompt and the admin verification view. Pure; no DB.
 * Returns: [ { groupKey, groupLabel, optionLabels: [..], notSure: bool } ]
 * (only groups the seller actually touched). Unknown keys are skipped.
 */
function describeSelections(selections) {
  const out = [];
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) return out;
  for (const [groupKey, picked] of Object.entries(selections)) {
    const group = GROUPS[groupKey];
    if (!group || !Array.isArray(picked) || picked.length === 0) continue;
    const labelOf = (k) => (group.options.find((o) => o.key === k) || {}).label || k;
    const notSure = picked.includes('not_sure');
    const optionLabels = picked.filter((k) => k !== 'not_sure').map(labelOf);
    out.push({ groupKey, groupLabel: group.label, optionLabels, notSure });
  }
  return out;
}

module.exports = {
  NOT_SURE,
  GROUPS,
  CATEGORY_CLARIFICATIONS,
  MAPPABLE_LOT_FIELDS,
  schemaForCategory,
  isValidSelection,
  metadataFromSelections,
  describeSelections,
};

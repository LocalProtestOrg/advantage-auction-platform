'use strict';

/**
 * creativeReference/library — constants, sidecar validation + lint, image identity (sha256 + dimensions) for the
 * Owner-approved creative reference library (Phase 3P). The library folder is the Owner's; the Owner never edits
 * JSON — everything here is machine-owned. Reference IMAGES are read only for hashing/dimensions/signatures; they are
 * never handed to a generator.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIBRARY_ROOT = path.join(__dirname, '..', '..', '..', 'docs', 'marketing', 'approved-creative-examples');
const CATEGORY_FOLDERS = ['auction', 'estate-sale', 'notable-lot', 'geographic-event', 'individual-seller', 'professional-seller', 'buyer-growth', 'closing-soon', 'brand'];
const FOLDER_CLASS = {
  'auction': 'auction', 'estate-sale': 'estate_sale', 'notable-lot': 'notable_lot', 'geographic-event': 'geographic_event_promotion',
  'individual-seller': 'individual_seller_acquisition', 'professional-seller': 'professional_seller_acquisition',
  'buyer-growth': 'buyer_platform_growth', 'closing-soon': 'closing_soon', 'brand': 'general_brand',
};
const CAMPAIGN_CLASSES = ['estate_sale', 'auction', 'professional_seller_acquisition', 'individual_seller_acquisition', 'buyer_platform_growth', 'notable_lot', 'closing_soon', 'geographic_event_promotion', 'general_brand'];
const STATUSES = ['OWNER_APPROVED', 'OWNER_GOLD_STANDARD', 'OWNER_DO_NOT_USE', 'RETIRED'];
const STATUS_SOURCES = ['folder_placement_by_owner', 'owner_statement_via_desktop_marketing', 'owner_folder_move', 'admin_ui_button', 'owner_review_of_generated_creative'];
const DEFAULT_WEIGHTS = { OWNER_APPROVED: 1.0, OWNER_GOLD_STANDARD: 2.0, OWNER_DO_NOT_USE: -1.0, RETIRED: 0 };
const IMAGE_EXT = /\.(jpe?g|jfif|png|webp)$/i;
const SIDECAR_SUFFIX = '.reference.json';
// Seller marks that must never appear in a non-cobranded render (seeded; extended from every seller in the library).
const KNOWN_SELLER_MARKS = ['Lewis & Maese', 'Lewis and Maese', 'LMAuctionCo', 'lmauctionco.com', 'L&M', 'fleur-de-lis'];
// Bundled typeface names must never leak into principles as instructions either (lint for coordinate-like content).
const FONT_NAMES = ['Playfair', 'Quicksand', 'Jost', 'Lato', 'Cormorant', 'Italiana', 'Pinyon', 'Petit Formal', 'Helvetica', 'Arial', 'Garamond', 'Baskerville', 'Bodoni', 'Didot', 'Futura', 'Gotham', 'Montserrat', 'Times'];

function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function sha256Text(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

/** Minimal image dimension parser (JPEG/JFIF, PNG, WebP) — no image library needed for identity. */
function imageDims(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}
function formatClass(w, h) { const r = w / h; return r > 1.15 ? 'landscape' : (r < 0.87 ? 'portrait' : 'square'); }

// ── Focused JSON-Schema validator for reference.schema.json (draft 2020-12 subset incl. local $defs) ──
let _schema = null;
function schema() { if (!_schema) _schema = JSON.parse(fs.readFileSync(path.join(LIBRARY_ROOT, 'reference.schema.json'), 'utf8')); return _schema; }
function resolveRef(ref, root) { const m = /#\/\$defs\/([A-Za-z]+)$/.exec(ref || ''); return m && root.$defs ? root.$defs[m[1]] : null; }
function typeOk(t, v) {
  if (Array.isArray(t)) return t.some((x) => typeOk(x, v));
  switch (t) {
    case 'string': return typeof v === 'string'; case 'integer': return Number.isInteger(v); case 'number': return typeof v === 'number';
    case 'boolean': return typeof v === 'boolean'; case 'object': return v && typeof v === 'object' && !Array.isArray(v); case 'array': return Array.isArray(v);
    case 'null': return v === null; default: return true;
  }
}
function validateNode(node, obj, p, errors, root) {
  if (!node || typeof node !== 'object') return errors;
  if (node.$ref) { const r = resolveRef(node.$ref, root); return r ? validateNode(r, obj, p, errors, root) : errors; }
  if (node.const !== undefined && obj !== node.const) errors.push(`${p} must equal ${JSON.stringify(node.const)}`);
  if (node.enum && node.enum.indexOf(obj) === -1) errors.push(`${p} not in enum`);
  if (node.type && !typeOk(node.type, obj)) { errors.push(`${p} wrong type (want ${node.type})`); return errors; }
  if (typeof obj === 'string') {
    if (node.pattern && !new RegExp(node.pattern).test(obj)) errors.push(`${p} does not match pattern`);
    if (node.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(obj)) errors.push(`${p} must be a date`);
  }
  if (typeof obj === 'number' && node.minimum !== undefined && obj < node.minimum) errors.push(`${p} below minimum`);
  if (Array.isArray(obj)) {
    if (node.minItems !== undefined && obj.length < node.minItems) errors.push(`${p} needs at least ${node.minItems} items`);
    if (node.maxItems !== undefined && obj.length > node.maxItems) errors.push(`${p} has more than ${node.maxItems} items`);
    if (node.items) obj.forEach((it, i) => validateNode(node.items, it, `${p}[${i}]`, errors, root));
  }
  if (typeOk('object', obj) && (node.properties || node.required || node.additionalProperties === false)) {
    for (const r of (node.required || [])) if (!(r in obj)) errors.push(`${p}.${r} is required`);
    if (node.additionalProperties === false && node.properties) for (const k of Object.keys(obj)) if (!(k in node.properties)) errors.push(`${p}.${k} not allowed`);
    for (const k of Object.keys(node.properties || {})) if (k in obj) validateNode(node.properties[k], obj[k], `${p}.${k}`, errors, root);
  }
  return errors;
}
function validateSidecar(sidecar) { const s = schema(); const errors = validateNode(s, sidecar, 'sidecar', [], s); return { valid: errors.length === 0, errors }; }

/** Lint for coordinate-like content: principles must be ranges/qualities, never coordinates, colours or typefaces. */
const HEX_RE = /#[0-9a-f]{3,8}\b/i; const PX_RE = /\b\d+(\.\d+)?\s*px\b/i; const PCT_RE = /\b\d+(\.\d+)?\s*%/;
function lintSidecar(sidecar) {
  const problems = []; const warnings = [];
  for (const s of (sidecar.transferable_lessons || [])) {
    if (HEX_RE.test(s)) problems.push('transferable_lessons: hex colour: ' + s.slice(0, 60));
    if (PX_RE.test(s)) problems.push('transferable_lessons: pixel value: ' + s.slice(0, 60));
    if (PCT_RE.test(s)) warnings.push('transferable_lessons: percentage (a range, tolerated; not a coordinate): ' + s.slice(0, 60));
    for (const f of FONT_NAMES) if (new RegExp('\\b' + f + '\\b', 'i').test(s)) problems.push('transferable_lessons: typeface name: ' + f);
    for (const m of KNOWN_SELLER_MARKS) if (s.toLowerCase().includes(m.toLowerCase())) problems.push('transferable_lessons: seller mark: ' + m);
  }
  for (const s of (sidecar.do_not_generalize || [])) {
    if (HEX_RE.test(s)) problems.push('do_not_generalize: hex colour: ' + s.slice(0, 60));
    if (PX_RE.test(s)) problems.push('do_not_generalize: pixel value: ' + s.slice(0, 60));
  }
  return { clean: problems.length === 0, problems, warnings };
}
function weightFor(status, weights) { const w = Object.assign({}, DEFAULT_WEIGHTS, weights || {}); return w[status] != null ? w[status] : 0; }

/** Walk the library: images (with folder classification) and sidecars (by sha256). Foreign files are reported. */
function listLibrary(root) {
  root = root || LIBRARY_ROOT;
  const images = [], sidecars = [], foreign = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name); const r = rel ? rel + '/' + name : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) { walk(full, r); continue; }
      if (name.endsWith(SIDECAR_SUFFIX)) { try { sidecars.push({ path: full, rel: r, json: JSON.parse(fs.readFileSync(full, 'utf8')) }); } catch (e) { foreign.push({ rel: r, reason: 'unreadable sidecar: ' + e.message }); } continue; }
      if (!IMAGE_EXT.test(name)) continue;
      const parts = r.split('/');
      const category = parts[0]; const sub = parts.length > 2 ? parts[1] : null;
      if (!CATEGORY_FOLDERS.includes(category) || (sub && !['gold-standard', 'do-not-use'].includes(sub)) || parts.length > 3) { foreign.push({ rel: r, reason: 'image outside a category folder (not indexed)' }); continue; }
      images.push({ path: full, rel: r, category, subfolder: sub, filename: name });
    }
  };
  walk(root, '');
  return { images, sidecars, foreign };
}

/** Seller marks: constants + every seller named in the library + quoted wording from do_not_generalize. */
function sellerMarksFrom(sidecars) {
  const marks = new Set(KNOWN_SELLER_MARKS);
  const wording = new Set();
  for (const sc of sidecars) {
    const j = sc.json || sc;
    if (j.source && j.source.seller && j.source.seller !== 'Advantage.Bid') marks.add(j.source.seller);
    // Quoted seller wording (taglines) only: straight double quotes or single quotes not opened/closed inside a word
    // (so "Houston's" never yields "Houston"); at least two words, so a place name alone is never a mark.
    for (const s of (j.do_not_generalize || [])) {
      const found = [];
      for (const m of s.matchAll(/"([^"]{4,80})"/g)) found.push(m[1]);
      for (const m of s.matchAll(/(?:^|[\s(])'([^']{4,80}?)'(?=[\s,.;:)]|$)/g)) found.push(m[1]);
      for (const q of found) if (q.trim().split(/\s+/).length >= 2) wording.add(q.trim());
    }
  }
  return { seller_marks: [...marks], wording: [...wording] };
}

module.exports = { LIBRARY_ROOT, CATEGORY_FOLDERS, FOLDER_CLASS, CAMPAIGN_CLASSES, STATUSES, STATUS_SOURCES, DEFAULT_WEIGHTS, IMAGE_EXT, SIDECAR_SUFFIX,
  KNOWN_SELLER_MARKS, FONT_NAMES, sha256File, sha256Text, imageDims, formatClass, validateSidecar, lintSidecar, weightFor, listLibrary, sellerMarksFrom, schema };

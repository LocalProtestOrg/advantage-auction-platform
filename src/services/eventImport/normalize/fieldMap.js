'use strict';

/**
 * fieldMap — declarative source-field → canonical-field mapping (§8 of the plan). A connector supplies
 * a map so a new source needs no pipeline change. Pure; no DB.
 *
 * Map shape: { canonicalField: spec } where spec is either
 *   - a dot-path string        e.g. 'event.title'  or 'venue.address.city'
 *   - { path, transform?, default? }   transform(value, payload) runs after extraction
 *   - { const }                a fixed value (e.g. sale_type: { const: 'estate_sale' })
 * Missing paths yield `undefined` (the field is simply omitted; the sanitizer nulls it).
 */

function getPath(obj, path) {
  if (obj == null || !path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function applyFieldMap(payload, map) {
  const out = {};
  for (const [field, spec] of Object.entries(map || {})) {
    if (spec == null) continue;
    let val;
    if (typeof spec === 'string') {
      val = getPath(payload, spec);
    } else if (typeof spec === 'object') {
      if (Object.prototype.hasOwnProperty.call(spec, 'const')) val = spec.const;
      else val = getPath(payload, spec.path);
      if (val === undefined && 'default' in spec) val = spec.default;
      if (typeof spec.transform === 'function') { try { val = spec.transform(val, payload); } catch (e) { val = undefined; } }
    }
    if (val !== undefined) out[field] = val;
  }
  return out;
}

module.exports = { applyFieldMap, getPath };

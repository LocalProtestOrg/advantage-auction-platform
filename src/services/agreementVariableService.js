'use strict';

/**
 * Agreement variable resolver — PURE (no DB). The heart of Phase A.
 *
 * Resolves the variables declared by a template version against three layers,
 * highest precedence first:
 *   1. send-time admin overrides
 *   2. the seller's data  (seller_terms for source:'terms', seller_identity for source:'identity')
 *   3. the template version's effective_terms_defaults
 *
 * variable_schema is an array of:
 *   { key, label?, type?, required?, source? }
 *     type   : 'string' | 'number' | 'percent' | 'currency_cents' | 'date'  (default 'string')
 *     source : 'terms' | 'identity' | 'manual'                              (default 'manual')
 *     required: boolean (default false)
 *
 * Callers (routes/services) fetch the rows and pass plain objects in; this
 * module never touches the database, so it is fully unit-testable.
 */

function isPresent(v) {
  return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
}

// Pick the raw (unformatted) value for one declared variable, honoring precedence.
function pickValue(def, ctx) {
  const key = def.key;
  const source = def.source || 'manual';
  const { overrides = {}, sellerTerms = {}, sellerIdentity = {}, termsDefaults = {} } = ctx;

  if (isPresent(overrides[key])) return overrides[key];
  if (source === 'terms' && isPresent(sellerTerms[key])) return sellerTerms[key];
  if (source === 'identity' && isPresent(sellerIdentity[key])) return sellerIdentity[key];
  if (isPresent(termsDefaults[key])) return termsDefaults[key];
  return undefined;
}

// Human-facing formatting used when rendering the body. Raw resolved values are
// preserved separately so the signed record keeps machine-readable terms.
function formatValue(value, type) {
  if (!isPresent(value)) return '';
  switch (type) {
    case 'percent': {
      const n = Number(value);
      return Number.isFinite(n) ? `${n}%` : String(value);
    }
    case 'currency_cents': {
      const n = Number(value);
      return Number.isFinite(n) ? `$${(n / 100).toFixed(2)}` : String(value);
    }
    case 'date': {
      const d = new Date(value);
      return isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    }
    default:
      return String(value);
  }
}

/**
 * Resolve all declared variables.
 * @returns {{ resolved: Object, formatted: Object, missingRequired: string[] }}
 *   resolved   — raw values keyed by variable key (machine-readable; for storage)
 *   formatted  — display strings keyed by variable key (for rendering)
 *   missingRequired — keys that are required but unresolved (blocks a real send)
 */
function resolveVariables({ variableSchema = [], termsDefaults = {}, sellerTerms = {}, sellerIdentity = {}, overrides = {} } = {}) {
  const resolved = {};
  const formatted = {};
  const missingRequired = [];
  const ctx = { overrides, sellerTerms, sellerIdentity, termsDefaults };

  for (const def of Array.isArray(variableSchema) ? variableSchema : []) {
    if (!def || !def.key) continue;
    const value = pickValue(def, ctx);
    if (isPresent(value)) {
      resolved[def.key] = value;
      formatted[def.key] = formatValue(value, def.type);
    } else if (def.required) {
      missingRequired.push(def.key);
    }
  }
  return { resolved, formatted, missingRequired };
}

/**
 * Replace {{key}} placeholders in the body with formatted values.
 * Unknown / unresolved placeholders are left intact ({{key}}) so previews show
 * the gaps; a real send is gated separately on missingRequired.
 */
function renderBody(bodyMarkdown, formatted = {}) {
  if (typeof bodyMarkdown !== 'string') return '';
  return bodyMarkdown.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(formatted, key) && isPresent(formatted[key])
      ? formatted[key]
      : match;
  });
}

/**
 * Convenience: resolve + render in one call.
 * @returns {{ resolved, formatted, missingRequired, renderedBody }}
 */
function resolveAndRender({ bodyMarkdown = '', variableSchema = [], termsDefaults = {}, sellerTerms = {}, sellerIdentity = {}, overrides = {} } = {}) {
  const r = resolveVariables({ variableSchema, termsDefaults, sellerTerms, sellerIdentity, overrides });
  return { ...r, renderedBody: renderBody(bodyMarkdown, r.formatted) };
}

module.exports = { resolveVariables, renderBody, formatValue, resolveAndRender, isPresent };

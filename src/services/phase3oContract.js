'use strict';

/**
 * phase3oContract — loads the Phase 3O schema pack (the authoritative artifact under
 * docs/marketing/phase3o/schemas) and provides a FOCUSED JSON-Schema validator (draft-2020-12 subset:
 * required, type, enum, const, additionalProperties:false, oneOf/$ref-to-enums, array items). It is not a
 * full draft-2020-12 implementation — it deliberately covers exactly the message/record contracts this
 * runtime produces/consumes so the interface can be validated and negative cases rejected. The pack ZIP/JSON
 * remains the single source of truth; nothing here duplicates it into the DB.
 */

const fs = require('fs');
const path = require('path');

const PACK_DIR = path.join(__dirname, '..', '..', 'docs', 'marketing', 'phase3o', 'schemas');
const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  const p = path.join(PACK_DIR, name);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  cache[name] = j; return j;
}

// Data packs (authoritative catalogues).
function features() { const f = load('features.json'); return (f.features || f); }
function recipes() { const r = load('recipes.json'); return (r.recipes || r); }
function ladders() { const l = load('ladders.json'); return (l.ladders || l); }
function configSeeds() { const c = load('config_seeds.json'); return (c.config_seeds || c); }
function enums() { const e = load('enums.schema.json'); return e['$defs'] || {}; }
function featureByKey(key) { return features().find((f) => f.feature_key === key) || null; }

const SCHEMA_FILES = {
  interface_message: 'interface_message.schema.json',
  seller_payload: 'seller_payload.schema.json',
  purchase_snapshot: 'purchase_snapshot.schema.json',
  director_decision: 'director_decision.schema.json',
  obligation: 'obligation.schema.json',
  readiness: 'readiness.schema.json',
  evidence: 'evidence.schema.json',
  creative_brief: 'creative_brief.schema.json',
  creative_result: 'creative_result.schema.json',
  escalation_packet: 'escalation_packet.schema.json',
  owner_resolution: 'owner_resolution.schema.json',
  audience_specification: 'audience_specification.schema.json',
  dedicated_send_job: 'dedicated_send_job.schema.json',
  shared_edition_job: 'shared_edition_job.schema.json',
  package_recipe: 'package_recipe.schema.json',
};

// Resolve an enum $ref like ".../enums.schema.json#/$defs/DirectorDecision" → the enum array.
function resolveEnumRef(ref) {
  const m = /#\/\$defs\/([A-Za-z]+)$/.exec(String(ref || ''));
  if (!m) return null;
  const def = enums()[m[1]];
  return def && def.enum ? def.enum : null;
}

function typeOk(type, v) {
  if (Array.isArray(type)) return type.some((t) => typeOk(t, v));
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number';
    case 'boolean': return typeof v === 'boolean';
    case 'object': return v && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'null': return v === null;
    default: return true;
  }
}

// Validate `obj` against a (sub)schema node. Returns array of error strings ([] = valid).
function validateNode(schema, obj, pathStr, errors) {
  if (!schema || typeof schema !== 'object') return errors;
  if (schema['$ref']) { const en = resolveEnumRef(schema['$ref']); if (en && en.indexOf(obj) === -1) errors.push(pathStr + ' not in enum'); return errors; }
  if (schema.oneOf) { const ok = schema.oneOf.some((s) => validateNode(s, obj, pathStr, []).length === 0); if (!ok) errors.push(pathStr + ' matched none of oneOf'); return errors; }
  if (schema.const !== undefined && obj !== schema.const) errors.push(pathStr + ' must equal const ' + JSON.stringify(schema.const));
  if (schema.enum && schema.enum.indexOf(obj) === -1) errors.push(pathStr + ' not in enum');
  if (schema.type && !typeOk(schema.type, obj)) { errors.push(pathStr + ' wrong type (want ' + schema.type + ')'); return errors; }
  if (typeOk('object', obj) && (schema.properties || schema.required || schema.additionalProperties === false)) {
    for (const req of (schema.required || [])) if (!(req in obj)) errors.push(pathStr + '.' + req + ' is required');
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(obj)) if (!(k in schema.properties)) errors.push(pathStr + '.' + k + ' is not allowed (additionalProperties:false)');
    }
    for (const k of Object.keys(schema.properties || {})) if (k in obj) validateNode(schema.properties[k], obj[k], pathStr + '.' + k, errors);
  }
  if (typeOk('array', obj) && schema.items) obj.forEach((it, i) => validateNode(schema.items, it, pathStr + '[' + i + ']', errors));
  return errors;
}

function validate(schemaName, obj) {
  const file = SCHEMA_FILES[schemaName];
  if (!file) return { valid: false, errors: ['unknown schema: ' + schemaName] };
  const schema = load(file);
  const errors = validateNode(schema, obj, schemaName, []);
  return { valid: errors.length === 0, errors };
}

module.exports = { PACK_DIR, load, features, recipes, ladders, configSeeds, enums, featureByKey, validate, SCHEMA_FILES };

'use strict';

/**
 * creativeReference/variation — Phase 3P.2 anti-averaging (config: docs/marketing/phase3p2/config/variation-requirements.json)
 *   structure vocabulary on the brief · rotation (consecutive creatives for one objective never reuse a structure when the
 *   class shows ≥ 2) · prop-checklist ban (template_echo: ≥ 3 collaborator props together → regenerate) · G11 unchanged
 *   with Golds inside the reference distance set.
 */
const V = require('../../../docs/marketing/phase3p2/config/variation-requirements.json');

const STRUCTURES = ['LEFT_COPY', 'CENTERED', 'RIGHT_COPY', 'TOP_COPY_BOTTOM_SCENE', 'ENVIRONMENTAL_FULL_BLEED', 'HERO_OBJECT', 'ASYMMETRIC'];
// Collaborator props (do_not_generalize) → how an object in a plan would be recognised as one.
const PROP_RULES = [
  { prop: 'bronze horse', match: (o) => /horse/i.test(o.title || '') && /bronze/i.test(o.title || '') },
  { prop: 'blue-and-white vase', match: (o) => /(blue[- ]and[- ]white|blue & white|delft|canton)/i.test(o.title || '') && /vase|jar/i.test(o.title || '') },
  { prop: 'category-spine books', match: (o) => o.semantic_class === 'book_stack' },
  { prop: 'laptop with logo', match: (o) => /laptop|screen|screenshot/i.test(o.title || o.kind || '') },
  { prop: 'script mug/board/box', match: (o) => /\b(mug|chalkboard|script box)\b/i.test(o.title || '') },
];

function templateEcho(objects = []) {
  const hits = PROP_RULES.filter((r) => objects.some((o) => r.match(o))).map((r) => r.prop);
  return { flagged: hits.length >= 3, props: hits, rule: V.rules.prop_checklist_ban };
}

/** history: structures of the previous creatives for this objective (most recent last). */
function rotation(structure, history = [], classStructures = []) {
  if (!STRUCTURES.includes(structure)) return { pass: false, reason: 'unknown structure ' + structure };
  const last = history[history.length - 1];
  if (classStructures.length >= 2 && last && last === structure) return { pass: false, reason: 'consecutive creatives for the same objective reuse ' + structure };
  return { pass: true };
}

module.exports = { STRUCTURES, PROP_RULES, templateEcho, rotation, V };

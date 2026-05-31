'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { schemaForCategory, describeSelections, isValidSelection } = require('../constants/clarificationCategories');

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Provenance stamps for the Seller Verification Layer (Phase 2A). Bump
// PROMPT_VERSION whenever the prompt or the clarification registry changes, so
// stored verifications remain segmentable for learning/dispute analysis.
const AI_MODEL       = 'claude-haiku-4-5-20251001';
const PROMPT_VERSION = 'p2a-2026-05-31';

// ── Fallback samples (used when API key absent or call fails) ─────────────────
const SAMPLES = [
  { title: 'Vintage Brass Table Lamp with Fabric Shade',         description: 'A vintage brass table lamp featuring a tapered base and original fabric shade. Shows light wear consistent with age. Tested and functional at time of cataloging.',           category: 'Home Decor' },
  { title: 'Solid Oak Roll-Top Desk',                            description: 'A solid oak roll-top desk with tambour closure, fitted interior with pigeonholes and small drawers. Some surface scratching to the writing area. Hardware appears original.',          category: 'Furniture' },
  { title: 'Oil on Canvas Landscape Painting, Unsigned',         description: 'An oil on canvas landscape depicting a rural field scene. Housed in a gilt wood frame with minor losses to molding. Canvas shows light craquelure. Unsigned.',                       category: 'Fine Art' },
  { title: 'Sterling Silver Charm Bracelet with Assorted Charms',description: 'A sterling silver link bracelet with twelve assorted charms including travel motifs and animals. Marked 925. Clasp functions correctly. Light surface wear throughout.',            category: 'Jewelry' },
  { title: 'Cast Iron Hand Plane, Stanley No. 4',                description: 'A cast iron bench hand plane with intact blade and adjustment mechanism. Tote and knob are intact with minor chips. Blade shows prior sharpening. Ready for use or display.',        category: 'Tools' },
  { title: 'Ceramic Stoneware Crock with Lid',                   description: 'A salt-glazed stoneware crock with fitted lid and applied handles. Blue cobalt floral decoration to front. Small hairline to base, does not affect structural integrity.',            category: 'Pottery & Ceramics' },
  { title: 'Mahogany Claw-Foot Side Table',                      description: 'A mahogany side table with single drawer and claw-and-ball feet. Drawer operates smoothly with original brass pull. Surface shows light ring marks and patina consistent with age.',   category: 'Furniture' },
  { title: 'Gilt Bronze Mantel Clock',                           description: 'A gilt bronze mantel clock with enamel dial and roman numerals. Movement not tested. Glass bezel intact. Minor tarnishing to gilt surfaces. Key not included.',                        category: 'Clocks & Timepieces' },
  { title: 'Watercolor on Paper, Coastal Scene',                 description: 'A watercolor on paper depicting a coastal harbor scene with boats. Matted and framed under glass. Some light foxing to margins outside the mat. Unsigned lower right.',                 category: 'Fine Art' },
  { title: 'Vintage Leather-Top Writing Box',                    description: 'A Victorian-era leather-topped writing box with hinged lid opening to a fitted interior with inkwell compartment. Brass fittings show patina. Leather surface with light cracking.',    category: 'Antiques' },
];

const PICKUP_CATEGORY = {
  'Furniture': 'C', 'Fine Art': 'C', 'Clocks & Timepieces': 'B',
  'Home Decor': 'B', 'Tools': 'B', 'Pottery & Ceramics': 'B',
  'Antiques': 'B', 'Jewelry': 'A',
};

const CONDITION_NOTES = [
  'No issues noted beyond normal age-related wear.',
  'Sold as-is. Condition consistent with stated age.',
  'Surface wear noted; no structural damage observed.',
  'Appears complete. Not tested beyond visual inspection.',
  'Minor blemishes consistent with use and storage.',
];

const PROMPT = `You are an auction house catalog writer. Analyze this item image and respond with ONLY valid JSON — no markdown, no explanation — in exactly this format:
{"title":"concise descriptive title in 5-8 words","description":"2-3 factual sentences covering what the item is and any visible condition details","category":"one of: Furniture, Fine Art, Jewelry, Home Decor, Tools, Pottery & Ceramics, Clocks & Timepieces, Antiques, General","pickup_category":"A or B or C where A=small carry by hand B=medium needs two people C=large needs truck or dolly"}`;

function fallback() {
  const sample = SAMPLES[Math.floor(Math.random() * SAMPLES.length)];
  const note   = CONDITION_NOTES[Math.floor(Math.random() * CONDITION_NOTES.length)];
  return {
    title:           sample.title,
    description:     `${sample.description} ${note}`,
    category:        sample.category,
    pickup_category: PICKUP_CATEGORY[sample.category] || 'B',
  };
}

/* Custom error so the HTTP route can distinguish "AI is structurally
   unavailable" (no key, bad image URL) from generic 500s and respond with
   503 + a truthful message. The frontend already surfaces fetch errors
   visibly (lots.html generateAiDescription catch), so the seller sees an
   explicit "AI unavailable" instead of being silently fed a random sample. */
class AIUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name  = 'AIUnavailableError';
    this.cause = cause;
  }
}

async function generateDescriptionFromImage(imageUrl) {
  if (!client) {
    throw new AIUnavailableError('ANTHROPIC_API_KEY not configured on server');
  }
  if (!imageUrl || imageUrl.startsWith('blob:')) {
    throw new AIUnavailableError('imageUrl must be a publicly-reachable URL (not a blob)');
  }

  let message;
  try {
    message = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role:    'user',
        content: [
          { type: 'image', source: { type: 'url', url: imageUrl } },
          { type: 'text',  text: PROMPT },
        ],
      }],
    });
  } catch (err) {
    console.error('[ai] Claude API call failed:', err && err.message);
    throw new AIUnavailableError('AI provider call failed', err);
  }

  let parsed;
  try {
    const raw = message.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    parsed    = JSON.parse(raw);
  } catch (err) {
    console.error('[ai] Could not parse Claude response as JSON:', err && err.message);
    throw new AIUnavailableError('AI response could not be parsed', err);
  }

  const category = parsed.category || 'General';
  return {
    title:           parsed.title           || 'Untitled Item',
    description:     parsed.description     || '',
    category:        category,
    pickup_category: parsed.pickup_category || 'B',
    // Phase 2A: the relevant verification button groups for this detected
    // item, so the seller UI can render only relevant groups. Additive — older
    // callers that ignore this field are unaffected.
    clarification_schema: schemaForCategory(category),
  };
}

// ── Phase 2A: refine an existing description using the seller's button
// confirmations. Stateless (no DB); the route persists the provenance. The
// seller never types — `selections` is the multi-select button payload,
// validated against the clarification registry before we prompt.
//
// Conservative rule (hard requirement): for any group the seller marked
// "Not Sure", the AI must become MORE conservative — it must NOT assert that
// attribute (hedge or omit), never more specific. Seller confirmations win
// over the original AI guess on conflict.
function buildConfirmationLines(selections) {
  const described = describeSelections(selections);
  if (!described.length) return '(no confirmations selected)';
  return described.map((d) => {
    if (d.notSure) {
      const extra = d.optionLabels.length ? ` (also noted: ${d.optionLabels.join(', ')})` : '';
      return `- ${d.groupLabel}: NOT SURE — do not assert this attribute; hedge or omit it${extra}`;
    }
    return `- ${d.groupLabel}: ${d.optionLabels.join(', ')}`;
  }).join('\n');
}

const REFINE_PROMPT_HEADER = `You are an auction house catalog writer revising an item description using the seller's confirmed details. The seller selected buttons (no free text); treat their confirmations as authoritative.`;

const REFINE_PROMPT_RULES = `Rules:
- Incorporate the seller's confirmed facts. If a confirmation conflicts with the original description, the SELLER WINS (e.g., if they confirmed "Print", do not call it an original painting).
- For any attribute marked NOT SURE, be MORE CONSERVATIVE: do not assert that attribute — hedge ("appears to be", "presented as") or omit it entirely. Never make a stronger or more specific claim about an uncertain attribute.
- Do not invent facts the seller did not confirm and the image does not clearly show.
- Stay factual; 2-3 sentences.
Respond with ONLY valid JSON — no markdown — in exactly this format:
{"title":"concise 5-8 word title","description":"2-3 factual sentences","category":"the item category","pickup_category":"A or B or C"}`;

async function refineDescriptionFromImage({ imageUrl, base, selections }) {
  if (!client) {
    throw new AIUnavailableError('ANTHROPIC_API_KEY not configured on server');
  }
  if (!imageUrl || imageUrl.startsWith('blob:')) {
    throw new AIUnavailableError('imageUrl must be a publicly-reachable URL (not a blob)');
  }
  if (!isValidSelection(selections)) {
    throw new AIUnavailableError('selections failed clarification-registry validation');
  }
  const baseDesc = (base && base.description) || '';
  const baseCat  = (base && base.category) || 'General';

  const prompt = [
    REFINE_PROMPT_HEADER,
    '',
    `Original AI description:\n"${baseDesc}"`,
    `Detected category: ${baseCat}`,
    '',
    'Seller confirmations (button selections):',
    buildConfirmationLines(selections),
    '',
    REFINE_PROMPT_RULES,
  ].join('\n');

  let message;
  try {
    message = await client.messages.create({
      model:      AI_MODEL,
      max_tokens: 400,
      messages: [{
        role:    'user',
        content: [
          { type: 'image', source: { type: 'url', url: imageUrl } },
          { type: 'text',  text: prompt },
        ],
      }],
    });
  } catch (err) {
    console.error('[ai] Claude refine call failed:', err && err.message);
    throw new AIUnavailableError('AI provider call failed', err);
  }

  let parsed;
  try {
    const raw = message.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    parsed    = JSON.parse(raw);
  } catch (err) {
    console.error('[ai] Could not parse Claude refine response as JSON:', err && err.message);
    throw new AIUnavailableError('AI response could not be parsed', err);
  }

  return {
    title:           parsed.title           || (base && base.title) || 'Untitled Item',
    description:     parsed.description     || baseDesc,
    category:        parsed.category        || baseCat,
    pickup_category: parsed.pickup_category || (base && base.pickup_category) || 'B',
  };
}

/* NOTE: SAMPLES / fallback() / PICKUP_CATEGORY / CONDITION_NOTES above are
   intentionally left in source. They are no longer wired into the live AI
   endpoint because returning random samples masquerading as AI output caused
   real operator confusion on 2026-05-26 (a painting was labeled "Gilt Bronze
   Mantel Clock"). Any future use must be explicit, scoped to dev/test, and
   visibly distinguishable from real AI output. */

module.exports = {
  generateDescriptionFromImage,
  refineDescriptionFromImage,
  AIUnavailableError,
  AI_MODEL,
  PROMPT_VERSION,
  // Exported for unit-testing the conservative "Not Sure" prompt construction
  // without calling the live AI provider.
  buildConfirmationLines,
};

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

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

  return {
    title:           parsed.title           || 'Untitled Item',
    description:     parsed.description     || '',
    category:        parsed.category        || 'General',
    pickup_category: parsed.pickup_category || 'B',
  };
}

/* NOTE: SAMPLES / fallback() / PICKUP_CATEGORY / CONDITION_NOTES above are
   intentionally left in source. They are no longer wired into the live AI
   endpoint because returning random samples masquerading as AI output caused
   real operator confusion on 2026-05-26 (a painting was labeled "Gilt Bronze
   Mantel Clock"). Any future use must be explicit, scoped to dev/test, and
   visibly distinguishable from real AI output. */

module.exports = { generateDescriptionFromImage, AIUnavailableError };

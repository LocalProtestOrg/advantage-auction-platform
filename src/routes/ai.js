const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');
const { isValidSelection, metadataFromSelections, MAPPABLE_LOT_FIELDS } = require('../constants/clarificationCategories');
const {
  generateDescriptionFromImage,
  refineDescriptionFromImage,
  AIUnavailableError,
  AI_MODEL,
  PROMPT_VERSION,
} = require('../services/aiDescriptionService');
const { recordVerificationEvent, getLatestVerification } = require('../services/lotAiVerificationService');

function handleAiError(err, res, next) {
  // Truthful 503 for "AI structurally unavailable" (no key, bad image, parse,
  // provider error, or registry-invalid selections) so the UI shows the real
  // reason instead of a silent fabrication (see Defect 4 history).
  if (err instanceof AIUnavailableError) {
    return res.status(503).json({ success: false, message: 'AI description service unavailable: ' + err.message });
  }
  return next(err);
}

// POST /api/ai/generate-description
// Phase 2A: returns the v1 AI output PLUS the clarification_schema (relevant
// verification button groups for the detected item) and provenance stamps +
// a server-generated draft_correlation the client carries through refine/save.
router.post('/generate-description', auth, role(['seller', 'admin']), async (req, res, next) => {
  const { imageUrl } = req.body;
  if (!imageUrl) {
    return res.status(400).json({ success: false, message: 'imageUrl is required' });
  }
  try {
    const result = await generateDescriptionFromImage(imageUrl);
    return res.json({
      success: true,
      data: {
        ...result,                              // title, description, category, pickup_category, clarification_schema
        ai_model:          AI_MODEL,
        prompt_version:    PROMPT_VERSION,
        draft_correlation: crypto.randomUUID(),
      },
    });
  } catch (err) {
    return handleAiError(err, res, next);
  }
});

// POST /api/ai/refine-description
// Phase 2A: regenerate a description using the seller's button confirmations.
// Stateless (no DB write here — provenance is persisted at save via
// POST /verifications). Body: { imageUrl, base:{description,category,...}, selections }.
router.post('/refine-description', auth, role(['seller', 'admin']), async (req, res, next) => {
  const { imageUrl, base, selections } = req.body;
  if (!imageUrl) {
    return res.status(400).json({ success: false, message: 'imageUrl is required' });
  }
  if (!isValidSelection(selections || {})) {
    return res.status(400).json({ success: false, message: 'selections failed clarification-registry validation' });
  }
  try {
    const result = await refineDescriptionFromImage({ imageUrl, base: base || {}, selections: selections || {} });
    return res.json({
      success: true,
      data: { ...result, ai_model: AI_MODEL, prompt_version: PROMPT_VERSION },
    });
  } catch (err) {
    return handleAiError(err, res, next);
  }
});

// POST /api/ai/verifications
// Phase 2A: persist the verification provenance bundle AT SAVE TIME (append-
// only). The lot must already exist (real lot_id). ai_model / prompt_version
// are stamped server-side for integrity; the seller's own listing text is
// carried by the client (this is a seller self-service authoring tool, admin-
// overridable and audited). Writes one 'generate' row, an optional 'refine'
// row, and one 'final' row in a single transaction, then an audit event.
//
// Body: {
//   lot_id, draft_correlation, image_url,
//   generate: { ai_title, ai_description, ai_category, clarification_schema },
//   refine?:  { ai_description, seller_selections },
//   final:    { final_description, seller_selections }
// }
router.post('/verifications', auth, role(['seller', 'admin']), async (req, res, next) => {
  const b = req.body || {};
  if (!b.lot_id)    return res.status(400).json({ success: false, message: 'lot_id is required' });
  if (!b.image_url) return res.status(400).json({ success: false, message: 'image_url is required' });
  if (!b.generate || !b.final) {
    return res.status(400).json({ success: false, message: 'generate and final events are required' });
  }
  // Validate any selections up front for a clean 400 (service re-validates too).
  for (const sel of [b.refine && b.refine.seller_selections, b.final && b.final.seller_selections]) {
    if (sel != null && !isValidSelection(sel)) {
      return res.status(400).json({ success: false, message: 'seller_selections failed clarification-registry validation' });
    }
  }

  const cClient = await db.connect();
  try {
    // Ownership + auction_id lookup. Admin bypasses ownership.
    const lotRes = await cClient.query(
      `SELECT l.id, l.auction_id, sp.user_id AS owner_user_id
         FROM lots l
         JOIN auctions a        ON a.id  = l.auction_id
         JOIN seller_profiles sp ON sp.id = a.seller_id
        WHERE l.id = $1`,
      [b.lot_id]
    );
    const lot = lotRes.rows[0];
    if (!lot) {
      cClient.release();
      return res.status(404).json({ success: false, message: 'Lot not found' });
    }
    if (req.user.role !== 'admin' && lot.owner_user_id !== req.user.id) {
      cClient.release();
      return res.status(403).json({ success: false, message: 'Not authorized for this lot' });
    }

    const common = {
      lot_id:            b.lot_id,
      draft_correlation: b.draft_correlation || null,
      seller_user_id:    req.user.id,
      image_url:         b.image_url,
      ai_model:          AI_MODEL,        // server-stamped
      prompt_version:    PROMPT_VERSION,  // server-stamped
    };

    await cClient.query('BEGIN');

    // 1. Original AI output — written FIRST and never mutated (hard requirement).
    await recordVerificationEvent({
      ...common,
      event_type:           'generate',
      ai_title:             b.generate.ai_title,
      ai_description:       b.generate.ai_description,
      ai_category:          b.generate.ai_category,
      clarification_schema: b.generate.clarification_schema,
    }, cClient);

    // 2. Refined AI output (optional — only if the seller ran Update Description).
    if (b.refine && (b.refine.ai_description || b.refine.seller_selections)) {
      await recordVerificationEvent({
        ...common,
        event_type:        'refine',
        ai_description:    b.refine.ai_description,
        seller_selections: b.refine.seller_selections || null,
      }, cClient);
    }

    // 3. Final accepted description.
    await recordVerificationEvent({
      ...common,
      event_type:        'final',
      final_description: b.final.final_description,
      seller_selections: b.final.seller_selections || null,
    }, cClient);

    // Best-effort, ADDITIVE metadata population (requirements 8-9): fill blank
    // lot metadata fields (condition/material/era/maker_artist) ONLY when the
    // final selection maps unambiguously. NEVER overwrites a seller-entered
    // value — the WHERE guard only touches NULL/empty columns. Server-side so
    // the registry mapping and the "seller precedence" rule are authoritative.
    const meta = metadataFromSelections((b.final && b.final.seller_selections) || {});
    for (const field of Object.keys(meta)) {
      if (!MAPPABLE_LOT_FIELDS.includes(field)) continue;   // whitelist guard (no SQL injection via keys)
      await cClient.query(
        `UPDATE lots SET ${field} = $1
          WHERE id = $2 AND (${field} IS NULL OR ${field} = '')`,
        [meta[field], b.lot_id]
      );
    }

    await cClient.query('COMMIT');

    // Audit (non-blocking by design). Carries auction_id so it appears in the
    // Tier 1 auction History timeline alongside other lot/auction events.
    writeAuditLog({
      event_type:  'lot_ai_verification_recorded',
      entity_type: 'lot',
      entity_id:   b.lot_id,
      auction_id:  lot.auction_id,
      lot_id:      b.lot_id,
      actor_id:    req.user.id,
      metadata: {
        refined:           !!(b.refine && b.refine.ai_description),
        final_description: b.final.final_description || null,
        selections:        (b.final && b.final.seller_selections) || null,
      },
    });

    const latest = await getLatestVerification(b.lot_id);
    return res.json({ success: true, data: latest });
  } catch (err) {
    try { await cClient.query('ROLLBACK'); } catch (_) { /* ignore */ }
    return next(err);
  } finally {
    cClient.release();
  }
});

module.exports = router;

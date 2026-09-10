'use strict';

/**
 * GET /api/public/measurement-config — what the consent-gated browser measurement loader may do (Phase 3P.2).
 * Returns a provider id ONLY when that channel's Owner gate is ON and the asset's identity is verified as
 * Advantage.Bid (assetIdentityGuard — never a client's asset, never an invented id). While the gates are OFF the answer
 * is { enabled:false } for every provider and the loader does nothing. No secret is ever part of this response.
 */
const express = require('express');
const router = express.Router();
const guard = require('../services/measurement/assetIdentityGuard');
const configService = require('../services/configService');

const get = async (k) => { try { return await configService.get(null, k); } catch (_) { return null; } };
const on = (v) => v === true || v === 'true';

router.get('/', async (req, res, next) => {
  try {
    const out = { meta_pixel: { enabled: false }, google_tag: { enabled: false }, consent_category: 'advertising' };
    if (on(await get('marketing.measurement.meta_pixel_enabled'))) {
      const id = await get('marketing.measurement.meta_dataset_id');
      const chk = guard.check('meta_dataset', id, await get('marketing.measurement.meta_dataset_identity'));
      if (chk.ok) out.meta_pixel = { enabled: true, dataset_id: String(id) };
    }
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;

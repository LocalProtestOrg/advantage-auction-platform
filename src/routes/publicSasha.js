'use strict';

/**
 * GET /api/public/sasha/config?site=bid|www — whether the Sasha help button should appear on that site.
 * Public (the loader runs on www.advantage.bid too; /api/public/* already carries the public CORS policy).
 * Returns only an on/off flag: no settings, counts or internal state.
 */

const express = require('express');
const settings = require('../services/sasha/settings');

const router = express.Router();

router.get('/config', async (req, res) => {
  try {
    const s = await settings.effective();
    const enabled = req.query.site === 'www' ? s.chat_www : s.chat_bid;
    res.set('Cache-Control', 'public, max-age=60');
    return res.json({ enabled: !!enabled });
  } catch (_e) {
    return res.json({ enabled: false });
  }
});

module.exports = router;

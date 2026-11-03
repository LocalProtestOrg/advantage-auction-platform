'use strict';

/**
 * GET /embed/storefront.html — the Professional Seller website widget page (public/embed/storefront.html).
 *
 * When the BROWSER reports that it is loading this page as a frame on another website (Fetch Metadata, see
 * storefrontChannelService.framedByOutsideSite), the server signs a website pass for the seller named in ?seller= and
 * places it in the page (<meta name="adv-website-pass">). Buy Now hands it to checkout, where the server verifies it and
 * records the 5% website commission (owner decision 2026-11-03). Otherwise the page is served unchanged (no pass: every
 * order is a marketplace sale). Never cached, since each load is its own. Tags are added with src/lib/htmlInjection.js.
 */
const fs = require('fs');
const path = require('path');
const channels = require('../services/storefrontChannelService');
const { afterHeadOpen } = require('../lib/htmlInjection');

const FILE = path.join(__dirname, '..', '..', 'public', 'embed', 'storefront.html');
let cached = null;

function embedStorefrontPage(req, res, next) {
  try {
    if (cached == null) cached = fs.readFileSync(FILE, 'utf8');
    const pass = channels.passForRequest(req, String((req.query && req.query.seller) || ''));
    // The pass is base64url text joined by dots: safe inside an attribute as is.
    const html = pass && /^[A-Za-z0-9._-]+$/.test(pass) ? afterHeadOpen(cached, '<meta name="adv-website-pass" content="' + pass + '">') : null;
    res.set('Cache-Control', 'no-store');
    return res.type('html').send(html || cached);
  } catch (e) { return next(); }   // falls through to the static file (no pass: marketplace rate)
}

module.exports = embedStorefrontPage;

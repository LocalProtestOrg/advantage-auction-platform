'use strict';

/**
 * /api/storefront-messages — item questions between signed-in buyers and Professional Seller companies (milestone Q,
 * migration 205). OFF unless STOREFRONT_MESSAGING_ENABLED=true: while off every route answers 404 MESSAGING_OFF.
 *
 * Buyer:  ask about an item, list and read own conversations, reply.
 * Seller: list and read the company's conversations, reply (company from the session — requireSellerPermission).
 * Sender: withdraw a message waiting for review; appeal a declined message once.
 * Advantage.Bid review lives under /api/admin/storefront/messages (marketplace.moderate).
 */
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const seller = require('../middleware/requireSellerPermission');
const messaging = require('../services/storefrontMessagingService');
const { storefrontMessagingEnabled } = require('../lib/launchGuards');

router.use((req, res, next) => (storefrontMessagingEnabled()
  ? next() : res.status(404).json({ success: false, code: 'MESSAGING_OFF', message: 'Item questions are not available yet.' })));
router.use(authMiddleware);

const fail = (res, e, next) => (e && e.status ? res.status(e.status).json({ success: false, code: e.code, message: e.message }) : next(e));
// req.ip honours the app's 'trust proxy' setting (the address the platform proxy saw), so a client cannot rotate it.
const clientIp = (req) => req.ip || '';
const notFound = (res) => res.status(404).json({ success: false, code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found.' });

// ── Buyer ─────────────────────────────────────────────────────────────────────────────────────────────
router.post('/items/:itemId/ask', async (req, res, next) => {
  try { return res.status(201).json({ success: true, data: await messaging.askAboutItem(req.params.itemId, req.user.id, { body: (req.body || {}).body, ip: clientIp(req) }) }); }
  catch (e) { return fail(res, e, next); }
});
router.get('/mine', async (req, res, next) => {
  try { return res.json({ success: true, data: await messaging.listForBuyer(req.user.id) }); }
  catch (e) { return fail(res, e, next); }
});
router.get('/mine/:id', async (req, res, next) => {
  try { const c = await messaging.getForBuyer(req.params.id, req.user.id); return c ? res.json({ success: true, data: c }) : notFound(res); }
  catch (e) { return fail(res, e, next); }
});
router.post('/mine/:id/messages', async (req, res, next) => {
  try { return res.status(201).json({ success: true, data: await messaging.replyAsBuyer(req.params.id, req.user.id, { body: (req.body || {}).body, ip: clientIp(req) }) }); }
  catch (e) { return fail(res, e, next); }
});

// ── Seller company ────────────────────────────────────────────────────────────────────────────────────
router.get('/seller', seller('company.messages.view'), async (req, res, next) => {
  try { return res.json({ success: true, data: await messaging.listForSeller(req.sellerCtx) }); }
  catch (e) { return fail(res, e, next); }
});
router.get('/seller/:id', seller('company.messages.view'), async (req, res, next) => {
  try { const c = await messaging.getForSeller(req.params.id, req.sellerCtx); return c ? res.json({ success: true, data: c }) : notFound(res); }
  catch (e) { return fail(res, e, next); }
});
router.post('/seller/:id/messages', seller('company.messages.respond'), async (req, res, next) => {
  try { return res.status(201).json({ success: true, data: await messaging.replyAsSeller(req.params.id, req.sellerCtx, { body: (req.body || {}).body, ip: clientIp(req) }) }); }
  catch (e) { return fail(res, e, next); }
});

// ── The sender of a message (buyer or seller) ─────────────────────────────────────────────────────────
router.post('/messages/:id/withdraw', async (req, res, next) => {
  try { return res.json({ success: true, data: await messaging.withdraw(req.params.id, req.user.id) }); }
  catch (e) { return fail(res, e, next); }
});
router.post('/messages/:id/appeal', async (req, res, next) => {
  try { return res.json({ success: true, data: await messaging.appeal(req.params.id, req.user.id, { note: (req.body || {}).note }) }); }
  catch (e) { return fail(res, e, next); }
});

module.exports = router;

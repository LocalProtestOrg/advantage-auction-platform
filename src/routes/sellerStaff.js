'use strict';

/**
 * /api/seller-staff — Professional Seller staff accounts (migration 199). Off unless SELLER_STAFF_ENABLED=true.
 *
 * Owner:   GET /team · POST /step-up/start · POST /step-up/confirm
 *          POST /invitations · POST /members/:id/revoke · POST /members/:id/role · POST /members/:id/{suspend,reinstate,remove}
 *          (every change needs company.staff.manage AND a fresh step-up: password + phone code, this session, 10 minutes)
 * Invitee: POST /invitations/preview · POST /invitations/accept (the invitation code is sent in the body, never a URL)
 * Anyone signed in: GET /me (which company and role they act for, if any)
 * The company always comes from the session (seller checkpoint), never from the request.
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const seller = require('../middleware/requireSellerPermission');
const { resolveSellerContext } = require('../middleware/requireSellerPermission');
const staff = require('../services/sellerStaffService');
const stepUp = require('../services/sellerStepUpService');
const { sellerStaffEnabled } = require('../lib/launchGuards');

router.use(auth);
const fail = (res, e, next) => {
  if (e.status) return res.status(e.status).json({ success: false, code: e.code, message: e.message, attempts_left: e.attempts_left });
  return next(e);
};
const sid = (req) => (req.session && req.session.sid) || null;
const h = (fn) => async (req, res, next) => { try { return await fn(req, res); } catch (e) { return fail(res, e, next); } };

router.get('/me', h(async (req, res) => {
  const ctx = await resolveSellerContext(req.user.id);
  return res.json({ success: true, data: {
    enabled: sellerStaffEnabled(),
    role: ctx ? ctx.role : null, staff: !!(ctx && ctx.staff),
    membership: await staff.myMembership(req.user.id),
  } });
}));

// Everything below is unavailable while staff accounts are switched off.
router.use((req, res, next) => (sellerStaffEnabled() ? next()
  : res.status(404).json({ success: false, code: 'STAFF_NOT_AVAILABLE', message: 'Staff accounts are not available yet.' })));

// ── Owner ──
const manage = seller('company.staff.manage');
router.get('/team', manage, h(async (req, res) => res.json({ success: true, data: await staff.listTeam(req.sellerCtx) })));
router.post('/step-up/start', manage, h(async (req, res) => res.json({ success: true, data: await stepUp.start(req.sellerCtx, { password: (req.body || {}).password }, { sid: sid(req) }) })));
router.post('/step-up/confirm', manage, h(async (req, res) => res.json({ success: true, data: await stepUp.confirm(req.sellerCtx, { code: (req.body || {}).code }, { sid: sid(req) }) })));

const sensitive = [manage, stepUp.requireStepUp()];
router.post('/invitations', ...sensitive, h(async (req, res) => {
  const b = req.body || {};
  return res.status(201).json({ success: true, data: await staff.invite(req.sellerCtx, { email: b.email, role: b.role }) });
}));
router.post('/members/:id/revoke', ...sensitive, h(async (req, res) => res.json({ success: true, data: await staff.revokeInvite(req.sellerCtx, req.params.id) })));
router.post('/members/:id/role', ...sensitive, h(async (req, res) => res.json({ success: true, data: await staff.changeRole(req.sellerCtx, req.params.id, { role: (req.body || {}).role }) })));
for (const action of ['suspend', 'reinstate', 'remove']) {
  router.post(`/members/:id/${action}`, ...sensitive, h(async (req, res) => res.json({ success: true, data: await staff.setStatus(req.sellerCtx, req.params.id, action) })));
}

// ── Invitee ──
// POST (not GET) so the invitation code never appears in a URL or an access log.
router.post('/invitations/preview', h(async (req, res) => res.json({ success: true, data: await staff.previewInvite(req.user.id, (req.body || {}).token) })));
router.post('/invitations/accept', h(async (req, res) => res.json({ success: true, data: await staff.acceptInvite(req.user.id, (req.body || {}).token) })));

module.exports = router;

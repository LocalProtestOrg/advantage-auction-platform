'use strict';

/**
 * /api/admin/event-discovery — administrators run and review provider-neutral event discovery. Admin-only.
 *   GET    /                         every authorized company: channels, last check, sending keys
 *   GET    /:authId                  one company: probes (with refusal evidence), channels with previews, keys
 *   POST   /:authId/probe            run a dry-run discovery check now
 *   POST   /:authId/preview-sync     dry-run the company's source (what the next sync would import; writes nothing)
 *   POST   /:authId/activate         re-evaluate activation (after the platform collection gate changes)
 *   POST   /channels/:id/confirm     confirm a previewed channel { sale_type?, timezone?, profile? }
 *   POST   /channels/:id/pause|retire { reason }
 *   POST   /:authId/sending-keys     create a sending key for the company (shown once); DELETE /:authId/sending-keys/:keyId
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const { asyncRoute, svcErr } = require('../utils/apiError');
const db = require('../db');
const discovery = require('../services/eventDiscovery/discoveryService');
const store = require('../services/eventDiscovery/channelStore');
const intake = require('../services/eventDiscovery/intakeService');

router.use(authMiddleware, roleMiddleware(['admin']), express.json({ limit: '256kb' }));

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
function uuidParam(req, name) { if (!isUuid(req.params[name])) throw svcErr(400, 'BAD_ID', 'Invalid id.'); return req.params[name]; }

router.get('/', asyncRoute(async (req, res) => {
  const rows = (await db.query(
    `SELECT a.id, a.organization_id, a.company_name, a.authorized_domain, a.status, a.authorization_method, a.authorized_at,
            a.authorization_statement_version, a.events_page_url, s.key AS source_key, s.status AS source_status,
            (SELECT count(*)::int FROM event_collection_channels c WHERE c.authorization_id = a.id AND c.status = 'active') AS active_channels,
            (SELECT count(*)::int FROM event_collection_channels c WHERE c.authorization_id = a.id AND c.status = 'previewed') AS awaiting_confirmation,
            (SELECT count(*)::int FROM partner_intake_keys k WHERE k.authorization_id = a.id AND k.revoked_at IS NULL) AS sending_keys,
            p.outcome AS last_outcome, p.started_at AS last_checked_at, p.blocks AS last_blocks
       FROM authorized_event_sources a
       LEFT JOIN import_sources s ON s.id = a.import_source_id
       LEFT JOIN LATERAL (SELECT outcome, started_at, blocks FROM event_discovery_probes x WHERE x.authorization_id = a.id ORDER BY started_at DESC LIMIT 1) p ON true
      WHERE a.status = ANY($1) OR (a.status = 'prospective' AND a.authorization_method = 'member_account') ORDER BY a.company_name`, [discovery.LIVE])).rows;
  res.json({ success: true, data: { discovery_enabled: discovery.discoveryOn(), intake_enabled: intake.intakeOn(), collection_enabled: await discovery.collectionEnabled(), companies: rows } });
}));

router.get('/:authId', asyncRoute(async (req, res) => {
  const id = uuidParam(req, 'authId');
  const auth = (await db.query(`SELECT * FROM authorized_event_sources WHERE id = $1`, [id])).rows[0];
  if (!auth) throw svcErr(404, 'NOT_FOUND', 'Authorization not found.');
  const probes = (await db.query(`SELECT * FROM event_discovery_probes WHERE authorization_id = $1 ORDER BY started_at DESC LIMIT 10`, [id])).rows;
  res.json({ success: true, data: { authorization: auth, channels: await store.listForAuthorization(db, id), probes, sending_keys: await intake.listKeys(db, id),
    seller_view: await discovery.sellerStatus(db, auth.organization_id) } });
}));

router.post('/:authId/probe', asyncRoute(async (req, res) => {
  const out = await discovery.runProbe(db, uuidParam(req, 'authId'), { trigger: 'admin', actorId: req.user.id });
  res.json({ success: true, data: { probe: out.probe, channels: out.channels } });
}));

router.post('/:authId/preview-sync', asyncRoute(async (req, res) => {
  const id = uuidParam(req, 'authId');
  const auth = (await db.query(`SELECT * FROM authorized_event_sources WHERE id = $1`, [id])).rows[0];
  if (!auth || !auth.import_source_id) throw svcErr(409, 'NO_SOURCE', 'Run a discovery check first.');
  const src = (await db.query(`SELECT key FROM import_sources WHERE id = $1`, [auth.import_source_id])).rows[0];
  const r = await require('../services/eventImport').runImport({ sourceKey: src.key, apply: false, db });
  res.json({ success: true, data: { applied: false, counters: r.counters, reasons: r.reasons, partners: r.partners, zero_reason: r.zero_reason,
    items: r.items.slice(0, 50).map((x) => ({ sourceEventId: x.sourceEventId, outcome: x.outcome, reason: x.reason })) } });
}));

// POST /:authId/approve-domain { evidence } — confirm a pending member's website belongs to it (trust-ladder Path D).
router.post('/:authId/approve-domain', asyncRoute(async (req, res) => {
  const out = await discovery.approveDomain(db, uuidParam(req, 'authId'), { actorId: req.user.id, evidence: (req.body || {}).evidence });
  res.json({ success: true, data: out });
}));

router.post('/:authId/activate', asyncRoute(async (req, res) => {
  res.json({ success: true, data: await discovery.syncActivation(db, uuidParam(req, 'authId'), { actorId: req.user.id }) });
}));

router.post('/channels/:id/confirm', asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (b.sale_type && !['auction', 'estate_sale'].includes(b.sale_type)) throw svcErr(400, 'BAD_SALE_TYPE', 'sale_type must be auction or estate_sale.');
  res.json({ success: true, data: await discovery.confirmChannel(db, uuidParam(req, 'id'), { actorId: req.user.id, saleTypeHint: b.sale_type || null,
    timezone: b.timezone || null, profile: b.profile || null }) });
}));

for (const action of ['pause', 'retire']) {
  router.post('/channels/:id/' + action, asyncRoute(async (req, res) => {
    res.json({ success: true, data: await discovery.setChannelStatus(db, uuidParam(req, 'id'), action === 'pause' ? 'paused' : 'retired',
      { actorId: req.user.id, reason: (req.body || {}).reason || null }) });
  }));
}

router.post('/:authId/sending-keys', asyncRoute(async (req, res) => {
  res.json({ success: true, data: await intake.createKey(db, uuidParam(req, 'authId'), { actorId: req.user.id, label: (req.body || {}).label }) });
}));
router.delete('/:authId/sending-keys/:keyId', asyncRoute(async (req, res) => {
  res.json({ success: true, data: await intake.revokeKey(db, uuidParam(req, 'authId'), uuidParam(req, 'keyId'), { actorId: req.user.id }) });
}));

module.exports = router;

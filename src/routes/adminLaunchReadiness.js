'use strict';

/**
 * /api/admin/launch-readiness — read-only launch-readiness aggregation (admin only).
 * Reports Phase 3 operational-launch signals across foundation, content, legal, BD, and
 * marketplace. Purely diagnostic (no writes). Each query is isolated so one failure never
 * breaks the report. Statuses: 'ok' | 'warn' | 'todo'.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const db = require('../db');

router.use(authMiddleware, roleMiddleware(['admin']));

async function scalar(sql, params, fallback = null) {
  try { const { rows } = await db.query(sql, params || []); return rows[0] ? Object.values(rows[0])[0] : fallback; }
  catch { return fallback; }
}
const EVENT_TARGET = 10; // published events per market for launch

router.get('/', async (req, res) => {
  const [migration, orgs, platformCaps, planCaps, brandingKeys, markets, categories,
    partners, evHouston, evNyc, auctions] = await Promise.all([
    scalar("SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1", [], 'unknown'),
    scalar("SELECT count(*)::int FROM organizations", []),
    scalar("SELECT count(*)::int FROM organization_capabilities oc JOIN organizations o ON o.id=oc.organization_id WHERE o.is_platform_tenant=true AND oc.enabled=true", []),
    scalar("SELECT count(*)::int FROM plan_capabilities", []),
    scalar("SELECT count(*)::int FROM platform_config WHERE category='branding'", []),
    scalar("SELECT count(*)::int FROM event_markets WHERE is_active=true", []),
    scalar("SELECT count(*)::int FROM event_categories WHERE is_active=true", []),
    scalar("SELECT count(*)::int FROM organizations WHERE is_platform_tenant=false", []),
    scalar("SELECT count(*)::int FROM events WHERE status='published' AND market_slug='houston' AND (end_at IS NULL OR end_at>=now())", []),
    scalar("SELECT count(*)::int FROM events WHERE status='published' AND market_slug='nyc_tristate' AND (end_at IS NULL OR end_at>=now())", []),
    scalar("SELECT count(*)::int FROM auctions WHERE state IN ('published','active') AND is_archived IS NOT TRUE AND marketplace_status='syndicated'", []),
  ]);

  // Legal: which platform doc types have a published version
  const DOC_TYPES = ['buyer_terms', 'seller_agreement', 'privacy_policy', 'refund_policy', 'pickup_policy'];
  let publishedTypes = [];
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT d.doc_type FROM legal_documents d JOIN legal_document_versions v ON v.document_id=d.id
        WHERE d.organization_id IS NULL AND v.is_published=true`);
    publishedTypes = rows.map((r) => r.doc_type);
  } catch { /* table may be absent pre-078 */ }

  const evStatus = (n) => (n >= EVENT_TARGET ? 'ok' : n > 0 ? 'warn' : 'todo');
  const sections = [
    { key: 'foundation', title: 'Platform Foundation', items: [
      { label: 'Latest migration', status: /07[78]/.test(migration) ? 'ok' : 'warn', detail: migration },
      { label: 'Platform tenant capabilities', status: platformCaps >= 12 ? 'ok' : 'todo', detail: platformCaps + '/12' },
      { label: 'Plan→capability mapping', status: planCaps >= 17 ? 'ok' : 'todo', detail: planCaps },
      { label: 'Branding config', status: brandingKeys >= 5 ? 'ok' : 'todo', detail: brandingKeys + ' keys' },
    ] },
    { key: 'content', title: 'Marketplace Content', items: [
      { label: 'Event markets', status: markets >= 2 ? 'ok' : 'todo', detail: markets },
      { label: 'Event categories', status: categories >= 8 ? 'ok' : 'todo', detail: categories },
      { label: 'Partner organizations', status: partners >= 1 ? 'ok' : 'todo', detail: partners },
      { label: 'Published events — Houston', status: evStatus(evHouston), detail: evHouston + '/' + EVENT_TARGET },
      { label: 'Published events — NYC/Tri-State', status: evStatus(evNyc), detail: evNyc + '/' + EVENT_TARGET },
      { label: 'Syndicated published auctions', status: auctions > 0 ? 'ok' : 'todo', detail: auctions },
    ] },
    { key: 'legal', title: 'Platform Legal Documents (published)', items: DOC_TYPES.map((t) => ({
      label: t, status: publishedTypes.includes(t) ? 'ok' : 'todo', detail: publishedTypes.includes(t) ? 'published' : 'not published',
    })) },
    { key: 'bd', title: 'BD Integration', items: [
      { label: 'Widget assets deployed', status: 'ok', detail: '/widgets/events.js + iframe + embed' },
      { label: 'City-page embeds (manual)', status: 'todo', detail: 'requires BD page-edit access' },
    ] },
  ];
  let ok = 0, warn = 0, todo = 0;
  sections.forEach((s) => s.items.forEach((i) => { if (i.status === 'ok') ok++; else if (i.status === 'warn') warn++; else todo++; }));
  res.json({ success: true, migration_level: migration, generated_for: 'phase-3-operational-launch', summary: { ok, warn, todo }, sections });
});

module.exports = router;

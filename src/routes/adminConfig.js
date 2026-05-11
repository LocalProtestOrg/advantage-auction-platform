'use strict';

/**
 * Admin Config API — mounted at /api/admin/config/*
 *
 * Full CRUD for marketplace configuration. All routes are role-gated to admin.
 * Reads and writes platform_settings, widget_settings, marketing_packages tables.
 *
 * Key design rules:
 *   - PLATFORM_KEY_ALLOWLIST controls what can be read/written via this API.
 *     Anything not on the list is silently ignored on write and excluded on read.
 *   - PUBLIC_KEY_ALLOWLIST is a subset of PLATFORM_KEY_ALLOWLIST — only these
 *     keys are surfaced at GET /api/public/config. Import from this module.
 *   - No Stripe keys, payment vars, or bidding logic may ever appear in these tables.
 *   - Widget settings accept only widget.* prefixed keys (safe namespace).
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const role    = require('../middleware/roleMiddleware');
const db      = require('../db');

// All routes in this file require admin authentication
router.use(auth, role(['admin']));

// ── Key allowlists ─────────────────────────────────────────────────────────────

// Full set of keys admin may read and write.
const PLATFORM_KEY_ALLOWLIST = new Set([
  'marketplace.badge.live',
  'marketplace.badge.upcoming',
  'marketplace.badge.ships',
  'marketplace.badge.ending_soon',
  'marketplace.badge.ending_soon_threshold_min',
  'marketplace.cta.headline',
  'marketplace.cta.subtext',
  'marketplace.cta.label',
  'marketplace.cta.url',
  'marketplace.card.image_height_px',
  'marketplace.card.show_seller',
  'marketplace.card.show_lot_count',
  'marketplace.card.show_bid',
  'marketplace.shipping.show_badge',
  'marketplace.homepage.featured_limit',
  'marketplace.homepage.near_you_limit',
  'marketplace.ranking.priority_weight',
  'marketplace.ranking.recency_weight',
]);

// Subset surfaced at GET /api/public/config — no pricing, no internal controls.
// Exported so public.js can import this without duplicating the list.
const PUBLIC_KEY_ALLOWLIST = new Set([
  'marketplace.badge.live',
  'marketplace.badge.upcoming',
  'marketplace.badge.ships',
  'marketplace.badge.ending_soon',
  'marketplace.badge.ending_soon_threshold_min',
  'marketplace.cta.headline',
  'marketplace.cta.subtext',
  'marketplace.cta.label',
  'marketplace.cta.url',
  'marketplace.card.image_height_px',
  'marketplace.card.show_seller',
  'marketplace.card.show_lot_count',
  'marketplace.card.show_bid',
  'marketplace.shipping.show_badge',
  'marketplace.homepage.featured_limit',
  'marketplace.homepage.near_you_limit',
]);

// Widget slugs that may be configured via this API.
const ALLOWED_WIDGET_SLUGS = new Set(['featured-lots', 'featured-near-you']);

// ── GET /api/admin/config/platform ────────────────────────────────────────────
// Returns all allowlisted platform settings with their current values,
// descriptions, and last-updated metadata.
router.get('/platform', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT key, value, description, updated_at
         FROM platform_settings
        WHERE key = ANY($1::text[])
        ORDER BY key`,
      [Array.from(PLATFORM_KEY_ALLOWLIST)]
    );

    const data = {};
    rows.forEach(r => {
      data[r.key] = { value: r.value, description: r.description, updated_at: r.updated_at };
    });

    return res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/config/platform ─────────────────────────────────────────
// Body: flat object of { key: value } pairs. Non-allowlisted keys are ignored.
// Upserts each key. Returns the list of keys that were actually written.
router.patch('/platform', async (req, res, next) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ success: false, message: 'Body must be a flat object of key/value pairs' });
    }

    const allowed = Object.keys(updates).filter(k => PLATFORM_KEY_ALLOWLIST.has(k));
    if (allowed.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid config keys provided' });
    }

    for (const key of allowed) {
      await db.query(
        `INSERT INTO platform_settings (key, value, updated_at, updated_by)
         VALUES ($1, $2::jsonb, now(), $3)
         ON CONFLICT (key) DO UPDATE
           SET value      = EXCLUDED.value,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by`,
        [key, JSON.stringify(updates[key]), req.user.id]
      );
    }

    return res.json({ success: true, updated: allowed });
  } catch (err) { next(err); }
});

// ── GET /api/admin/config/widgets ─────────────────────────────────────────────
router.get('/widgets', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT widget_slug, settings, description, updated_at
         FROM widget_settings
        ORDER BY widget_slug`
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/config/widgets/:slug ────────────────────────────────────
// Merges new widget.* settings into the existing settings JSONB for :slug.
// Only widget.* prefixed keys are accepted — all others are ignored.
router.patch('/widgets/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!ALLOWED_WIDGET_SLUGS.has(slug)) {
      return res.status(404).json({ success: false, message: 'Widget not found' });
    }

    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ success: false, message: 'Body must be a settings object' });
    }

    const safe = {};
    Object.keys(updates).forEach(k => { if (k.startsWith('widget.')) safe[k] = updates[k]; });
    if (Object.keys(safe).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid widget.* keys provided' });
    }

    const { rows } = await db.query(
      `INSERT INTO widget_settings (widget_slug, settings, updated_at, updated_by)
       VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (widget_slug) DO UPDATE
         SET settings   = widget_settings.settings || EXCLUDED.settings,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by
       RETURNING widget_slug, settings, updated_at`,
      [slug, JSON.stringify(safe), req.user.id]
    );

    return res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /api/admin/config/packages ───────────────────────────────────────────
// Returns all marketing packages (active and archived).
router.get('/packages', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, description, price_cents, features,
              is_active, display_order, created_at, updated_at
         FROM marketing_packages
        ORDER BY display_order, created_at`
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── POST /api/admin/config/packages ──────────────────────────────────────────
// Creates a new marketing package.
// Required: name (string), price_cents (non-negative integer)
// Optional: description, features (array), display_order (integer)
router.post('/packages', async (req, res, next) => {
  try {
    const { name, description, price_cents, features, display_order } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    if (typeof price_cents !== 'number' || !Number.isInteger(price_cents) || price_cents < 0) {
      return res.status(400).json({ success: false, message: 'price_cents must be a non-negative integer' });
    }

    const { rows } = await db.query(
      `INSERT INTO marketing_packages
         (name, description, price_cents, features, display_order, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING id, name, description, price_cents, features,
                 is_active, display_order, created_at, updated_at`,
      [
        name.trim(),
        typeof description === 'string' ? description : null,
        price_cents,
        JSON.stringify(Array.isArray(features) ? features : []),
        typeof display_order === 'number' ? display_order : 0,
        req.user.id,
      ]
    );

    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/config/packages/:id ─────────────────────────────────────
// Partial update of a marketing package. Accepts any subset of editable fields.
router.patch('/packages/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description, price_cents, features, is_active, display_order } = req.body;

    const setClauses = [];
    const params     = [id];

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, message: 'name must be a non-empty string' });
      }
      params.push(name.trim());
      setClauses.push(`name = $${params.length}`);
    }
    if (description !== undefined) {
      params.push(description);
      setClauses.push(`description = $${params.length}`);
    }
    if (price_cents !== undefined) {
      if (typeof price_cents !== 'number' || !Number.isInteger(price_cents) || price_cents < 0) {
        return res.status(400).json({ success: false, message: 'price_cents must be a non-negative integer' });
      }
      params.push(price_cents);
      setClauses.push(`price_cents = $${params.length}`);
    }
    if (features !== undefined) {
      params.push(JSON.stringify(Array.isArray(features) ? features : []));
      setClauses.push(`features = $${params.length}::jsonb`);
    }
    if (is_active !== undefined) {
      params.push(Boolean(is_active));
      setClauses.push(`is_active = $${params.length}`);
    }
    if (display_order !== undefined) {
      params.push(display_order);
      setClauses.push(`display_order = $${params.length}`);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    setClauses.push('updated_at = now()');

    const { rows } = await db.query(
      `UPDATE marketing_packages
          SET ${setClauses.join(', ')}
        WHERE id = $1
       RETURNING id, name, description, price_cents, features,
                 is_active, display_order, updated_at`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Package not found' });
    }
    return res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

module.exports = { router, PUBLIC_KEY_ALLOWLIST };

'use strict';

/**
 * storefrontService — the Professional Seller Storefront presentation layer over EXISTING seller/auction/
 * marketplace/follower data. Config is stored in seller_profiles.storefront (JSONB) + storefront_slug +
 * storefront_published. All seller-entered text is sanitized (plain text only — never raw HTML/JS). The
 * public aggregation reads live auctions + marketplace items + follower count; nothing is duplicated.
 */

const db = require('../db');
const marketplaceItems = require('./marketplaceItemService');
const { isProfessional } = require('../lib/sellerBranding');

const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }

// Plain-text sanitizer — strips HTML tags + control chars, collapses whitespace, caps length. No HTML survives.
function clean(v, max = 500) {
  if (v == null) return null;
  const s = String(v).replace(/<[^>]*>/g, '').replace(/[^\x20-￿]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}
function cleanMultiline(v, max = 4000) {
  if (v == null) return null;
  const s = String(v).replace(/<[^>]*>/g, '').replace(/\r\n/g, '\n').replace(/[^\n\x20-￿]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return s ? s.slice(0, max) : null;
}
function url(v) { const s = clean(v, 300); return s && /^https?:\/\//i.test(s) ? s : null; }
function slugify(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || null; }

// Sanitize the full storefront config object (whitelisted keys only).
function sanitizeConfig(input = {}) {
  const c = {};
  c.tagline = clean(input.tagline, 140);
  c.headline = clean(input.headline, 140);
  c.hero_image = url(input.hero_image);
  c.about = cleanMultiline(input.about, 4000);
  c.services = Array.isArray(input.services) ? input.services.map((s) => clean(s, 60)).filter(Boolean).slice(0, 24) : [];
  c.gallery = Array.isArray(input.gallery) ? input.gallery.map(url).filter(Boolean).slice(0, 30) : [];
  c.testimonials = Array.isArray(input.testimonials) ? input.testimonials.map((t) => ({
    text: cleanMultiline(t && t.text, 800), name: clean(t && t.name, 80), location: clean(t && t.location, 80), date: clean(t && t.date, 40),
  })).filter((t) => t.text).slice(0, 20) : [];
  c.team = Array.isArray(input.team) ? input.team.map((m) => ({
    name: clean(m && m.name, 80), title: clean(m && m.title, 80), photo: url(m && m.photo), bio: cleanMultiline(m && m.bio, 500),
  })).filter((m) => m.name).slice(0, 20) : [];
  c.service_area = clean(input.service_area, 300);
  c.states_served = Array.isArray(input.states_served) ? input.states_served.map((s) => clean(s, 2)).filter(Boolean).slice(0, 51) : [];
  c.hours = cleanMultiline(input.hours, 500);
  c.public_phone = clean(input.public_phone, 40);
  c.public_email = clean(input.public_email, 120);
  c.website = url(input.website);
  c.address = clean(input.address, 200);
  c.years_in_business = clean(input.years_in_business, 40);
  c.about_facts = Array.isArray(input.about_facts) ? input.about_facts.map((s) => clean(s, 120)).filter(Boolean).slice(0, 12) : [];
  const soc = input.socials || {};
  c.socials = {};
  for (const k of ['facebook', 'instagram', 'linkedin', 'youtube', 'tiktok']) { const u = url(soc[k]); if (u) c.socials[k] = u; }
  c.accent = /^#[0-9a-fA-F]{6}$/.test(String(input.accent || '')) ? input.accent : null;
  c.seo_description = clean(input.seo_description, 300);
  const vis = input.section_visibility || {};
  c.section_visibility = {};
  for (const k of ['about', 'services', 'events', 'auctions', 'marketplace', 'past', 'gallery', 'testimonials', 'team', 'service_area', 'contact']) {
    c.section_visibility[k] = vis[k] === false ? false : true;
  }
  return c;
}

function sellerName(sp) { return sp.display_name || (sp.metadata && (sp.metadata.display_name || sp.metadata.business_name)) || 'Professional Seller'; }
function sellerMetaVal(sp, key) { return sp.metadata && sp.metadata[key] ? sp.metadata[key] : null; }

// ── Owner (seller) config: get + update ─────────────────────────────────────────────────────────────
async function getOwnerConfig(userId) {
  const sp = (await db.query('SELECT * FROM seller_profiles WHERE user_id = $1', [userId])).rows[0];
  if (!sp) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
  return { eligible: isProfessional(sp.seller_type), seller_id: sp.id,
    slug: sp.storefront_slug, published: sp.storefront_published, is_demo: sp.is_demo,
    name: sellerName(sp), logo_url: sp.logo_url, location_label: sp.location_label,
    config: sp.storefront || {}, public_url: sp.storefront_slug ? `${APP_BASE}/pro/${sp.storefront_slug}` : null };
}

async function updateConfig(userId, body = {}) {
  const sp = (await db.query('SELECT * FROM seller_profiles WHERE user_id = $1', [userId])).rows[0];
  if (!sp) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
  if (!isProfessional(sp.seller_type)) throw err(403, 'NOT_PROFESSIONAL', 'Storefronts are for Professional Sellers.');
  const sets = []; const vals = [sp.id]; const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

  if (body.slug !== undefined) {
    const desired = slugify(body.slug) || slugify(sellerName(sp));
    if (desired) {
      const taken = (await db.query('SELECT 1 FROM seller_profiles WHERE lower(storefront_slug) = lower($1) AND id <> $2', [desired, sp.id])).rows[0];
      if (taken) throw err(409, 'SLUG_TAKEN', 'That storefront address is already taken.');
      add('storefront_slug', desired);
    }
  } else if (!sp.storefront_slug) {
    let base = slugify(sellerName(sp)) || ('seller-' + sp.id.slice(0, 8)); let candidate = base; let n = 1;
    while ((await db.query('SELECT 1 FROM seller_profiles WHERE lower(storefront_slug)=lower($1) AND id<>$2', [candidate, sp.id])).rows[0]) { candidate = `${base}-${++n}`; }
    add('storefront_slug', candidate);
  }
  if (body.published !== undefined) add('storefront_published', !!body.published);
  if (body.config !== undefined || body.tagline !== undefined || body.about !== undefined) {
    const merged = Object.assign({}, sp.storefront || {}, body.config || body);
    add('storefront', JSON.stringify(sanitizeConfig(merged)));
  }
  if (!sets.length) return getOwnerConfig(userId);
  await db.query(`UPDATE seller_profiles SET ${sets.join(', ')} WHERE id = $1`, vals);
  return getOwnerConfig(userId);
}

// ── Public storefront aggregation ───────────────────────────────────────────────────────────────────
async function resolveBySlug(slug, runner = db) {
  const { rows } = await runner.query('SELECT * FROM seller_profiles WHERE lower(storefront_slug) = lower($1)', [String(slug || '')]);
  return rows[0] || null;
}

async function getPublicData(slug) {
  const sp = await resolveBySlug(slug);
  if (!sp || !sp.storefront_published) throw err(404, 'STOREFRONT_NOT_FOUND', 'Storefront not found.');
  const cfg = sp.storefront || {};
  const [auctions, past, items, followers, events] = await Promise.all([
    db.query(`SELECT id, title, subtitle, city, address_state AS state, start_time, end_time, state AS auction_state,
                     COALESCE(cover_image_url, banner_image_url) AS image, public_auction_type
                FROM auctions WHERE seller_id = $1 AND state IN ('published','active') AND is_archived IS NOT TRUE
                ORDER BY end_time ASC NULLS LAST LIMIT 12`, [sp.id]),
    db.query(`SELECT id, title, city, address_state AS state, end_time, COALESCE(cover_image_url, banner_image_url) AS image
                FROM auctions WHERE seller_id = $1 AND state = 'closed' AND is_archived IS NOT TRUE
                ORDER BY end_time DESC NULLS LAST LIMIT 8`, [sp.id]),
    marketplaceItems.listPublicForSeller(sp.id, 24),
    db.query('SELECT count(*)::int n FROM seller_followers WHERE seller_id = $1', [sp.id]),
    // Upcoming estate sales / events — AUTHORITATIVELY the seller's own, via the admin-set org link
    // (organizations.linked_seller_profile_id → this seller_profile). No name/fuzzy matching, no
    // auto-claiming of imported orgs; only PUBLISHED, not-yet-ended events. Street address never exposed.
    db.query(`SELECT e.slug, e.title, e.city, e.state, e.start_at, e.end_at, e.sale_type, e.event_format,
                     (SELECT url FROM event_images ei WHERE ei.event_id = e.id ORDER BY is_cover DESC, position ASC LIMIT 1) AS image
                FROM events e
                JOIN organizations o ON o.id = e.organization_id
               WHERE o.linked_seller_profile_id = $1
                 AND e.status = 'published'
                 AND (e.end_at IS NULL OR e.end_at >= now())
               ORDER BY e.start_at ASC NULLS LAST LIMIT 8`, [sp.id]),
  ]);
  return {
    seller: {
      id: sp.id, name: sellerName(sp), seller_type: sp.seller_type, is_professional: isProfessional(sp.seller_type),
      logo_url: sp.logo_url, location_label: sp.location_label || sellerMetaVal(sp, 'service_area'),
      is_demo: sp.is_demo, slug: sp.storefront_slug,
    },
    config: cfg,
    contact: {
      phone: cfg.public_phone || sellerMetaVal(sp, 'public_phone'),
      email: cfg.public_email, website: cfg.website || sellerMetaVal(sp, 'website'),
      address: cfg.address, hours: cfg.hours, socials: cfg.socials || {},
      service_area: cfg.service_area || sellerMetaVal(sp, 'service_area'), states_served: cfg.states_served || [],
    },
    auctions: auctions.rows,
    past_auctions: past.rows,
    marketplace: items,
    events: events.rows.map((e) => ({
      slug: e.slug, title: e.title, city: e.city, state: e.state,
      start_at: e.start_at, end_at: e.end_at,
      sale_type: e.sale_type, event_format: e.event_format,
      image: e.image || null, url: '/event.html?slug=' + encodeURIComponent(e.slug || ''),
    })),
    follower_count: followers.rows[0].n,
    counts: { auctions: auctions.rows.length, marketplace: items.length, past: past.rows.length, events: events.rows.length },
  };
}

// SSR metadata + JSON-LD for /pro/:slug (mirrors shareMeta). Draft/demo → noindex.
async function ssrMeta(slug) {
  const sp = await resolveBySlug(slug);
  if (!sp || !sp.storefront_published) return null;
  const cfg = sp.storefront || {};
  const name = sellerName(sp);
  const loc = sp.location_label || cfg.service_area || sellerMetaVal(sp, 'service_area') || '';
  const title = `${name}${loc ? ' — ' + loc : ''} | Advantage.Bid`;
  const desc = cfg.seo_description || cfg.tagline || (cfg.about ? cfg.about.slice(0, 200) : `${name} on Advantage.Bid — estate sales, auctions, and available items.`);
  const canonical = `${APP_BASE}/pro/${sp.storefront_slug}`;
  const image = cfg.hero_image || sp.logo_url || null;
  const bizType = sp.seller_type === 'auction_house' ? 'Organization' : 'LocalBusiness';
  const jsonld = {
    '@context': 'https://schema.org', '@type': bizType, name, url: canonical,
    ...(image ? { image, logo: sp.logo_url || image } : {}),
    ...(desc ? { description: desc } : {}),
    ...(cfg.public_phone ? { telephone: cfg.public_phone } : {}),
    ...(cfg.website || Object.keys(cfg.socials || {}).length ? { sameAs: [cfg.website, ...Object.values(cfg.socials || {})].filter(Boolean) } : {}),
    ...(loc ? { areaServed: loc } : {}),
  };
  return { title, description: desc, canonical, image, jsonld, noindex: !!sp.is_demo, name, loc };
}

module.exports = { sanitizeConfig, getOwnerConfig, updateConfig, getPublicData, ssrMeta, resolveBySlug, sellerName, slugify, clean };

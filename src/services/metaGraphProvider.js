'use strict';

/**
 * metaGraphProvider — the REAL Meta Graph API organic-publishing provider that replaces the previous
 * `live_provider_not_wired` stub, implementing the existing socialAdapter provider contract
 * (publish(payload) -> { ok, post_id, permalink, published_at }).
 *
 *   Facebook Page:  POST /{page-id}/photos  (url=<public image>, caption=<message+link>)  → post_id
 *                   (or /{page-id}/feed with message+link when there is no image).
 *   Instagram:      POST /{ig-id}/media (image_url=<public image>, caption)  → creation_id
 *                   POST /{ig-id}/media_publish (creation_id)                → media_id
 *                   GET  /{media_id}?fields=permalink                        → permalink
 *
 * The Graph API version is a single configuration value (META_GRAPH_VERSION, default below) — never scattered.
 * The access token is read at publish time from the env var NAMED by the destination's credential_ref and is
 * NEVER logged or returned. The HTTP client is injectable so tests exercise request construction and the IG
 * two-step sequence WITHOUT any network call. `active` is true only when a token is actually present; a missing
 * token yields active:false so the adapter routes to readiness/resilience (never a false completion).
 *
 * NOTHING here publishes while the gates are off — socialAdapter only selects this provider when
 * marketing.destinations.meta_enabled is true AND a ready destination exists; both remain OFF during the build.
 */

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const GRAPH_BASE = 'https://graph.facebook.com';

function graphVersion() { return process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION; }

// Compose the caption/message: factual headline + clean canonical link (no query string).
function composeMessage(copy) {
  const parts = [];
  if (copy && copy.headline) parts.push(copy.headline);
  const title = copy && (copy.factual_manifest || []).find((c) => c.claim === 'title');
  if (title) parts.push(String(title.value));
  if (copy && copy.url) parts.push(copy.url);
  return parts.join('\n');
}

async function defaultHttp(url, { method = 'GET', body = null } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch (_) { json = null; }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Build a provider bound to a resolved destination. `http` is injectable (defaults to fetch). Reads the token
 * from process.env[destination.credential_ref] at publish time.
 */
function buildProvider(destination, { http = defaultHttp, version = null } = {}) {
  const ver = version || graphVersion();
  const platform = destination.platform;
  const token = process.env[destination.credential_ref];
  const accountId = destination.provider_account_id;
  const active = !!(token && accountId);

  async function publishFacebook(payload) {
    const message = composeMessage(payload.copy);
    const image = payload.image_url || null;
    const base = `${GRAPH_BASE}/${ver}/${accountId}`;
    const endpoint = image ? `${base}/photos` : `${base}/feed`;
    const body = image ? { url: image, caption: message, access_token: token } : { message, access_token: token };
    const r = await http(endpoint, { method: 'POST', body });
    if (!r.ok || !r.json || (!r.json.id && !r.json.post_id)) return { ok: false, error: (r.json && r.json.error && r.json.error.message) || `graph_error_${r.status}` };
    const postId = r.json.post_id || r.json.id;
    return { ok: true, provider: 'facebook', post_id: postId, permalink: `https://www.facebook.com/${postId}`, published_at: payload.reference_at || null, shadow: false };
  }

  async function publishInstagram(payload) {
    const image = payload.image_url;
    if (!image) return { ok: false, error: 'instagram_requires_public_image' };
    const caption = composeMessage(payload.copy);
    const base = `${GRAPH_BASE}/${ver}/${accountId}`;
    // Step 1: create the media container.
    const create = await http(`${base}/media`, { method: 'POST', body: { image_url: image, caption, access_token: token } });
    if (!create.ok || !create.json || !create.json.id) return { ok: false, error: (create.json && create.json.error && create.json.error.message) || `ig_container_error_${create.status}` };
    const creationId = create.json.id;
    // Step 2: publish the container.
    const pub = await http(`${base}/media_publish`, { method: 'POST', body: { creation_id: creationId, access_token: token } });
    if (!pub.ok || !pub.json || !pub.json.id) return { ok: false, error: (pub.json && pub.json.error && pub.json.error.message) || `ig_publish_error_${pub.status}` };
    const mediaId = pub.json.id;
    // Step 3: fetch the permalink (best-effort; failure does not undo the publish).
    let permalink = null;
    try { const pl = await http(`${GRAPH_BASE}/${ver}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`, { method: 'GET' }); permalink = pl.json && pl.json.permalink || null; } catch (_) { /* keep null */ }
    return { ok: true, provider: 'instagram', post_id: mediaId, permalink, published_at: payload.reference_at || null, shadow: false };
  }

  return {
    name: 'meta', platform, active, shadow: false,
    reason: active ? null : (!token ? 'missing_credential' : 'missing_account_id'),
    async publish(payload) {
      if (!active) return { ok: false, error: this.reason || 'provider_inactive' };
      return platform === 'instagram' ? publishInstagram(payload) : publishFacebook(payload);
    },
  };
}

module.exports = { buildProvider, composeMessage, graphVersion, DEFAULT_GRAPH_VERSION };

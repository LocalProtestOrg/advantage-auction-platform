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

const { dig, reduceValue } = require('../lib/socialMetricCatalog');

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const GRAPH_BASE = 'https://graph.facebook.com';

function graphVersion() { return process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION; }

// Compose the caption/message: factual headline + clean canonical link (no query string).
function composeMessage(copy) {
  if (copy && typeof copy.message === 'string' && copy.message.trim()) return copy.message.trim(); // pre-composed (event copy)
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

  // Facebook PAGE-scoped endpoints (/{page}/photos, /{page}/feed, /{page}/insights, /{page}/posts, post
  // insights/comments) must be called with a PAGE access token, not the System User token itself. It is derived
  // lazily and held in-process only (GET /{page}?fields=access_token, which never enumerates /me/accounts), then
  // reused for this provider instance. Instagram endpoints accept the System User token directly. If derivation
  // fails the System User token is used and Meta's error is reported honestly (never a false completion).
  let pageToken = null; let pageTokenTried = false;
  async function effectiveToken() {
    if (platform !== 'facebook' || !active) return token;
    if (pageToken) return pageToken;
    if (pageTokenTried) return token;
    pageTokenTried = true;
    try {
      const r = await http(`${GRAPH_BASE}/${ver}/${accountId}?fields=access_token&access_token=${encodeURIComponent(token)}`, { method: 'GET' });
      if (r && r.ok && r.json && typeof r.json.access_token === 'string' && r.json.access_token) pageToken = r.json.access_token;
    } catch (_) { pageToken = null; }
    return pageToken || token;
  }

  async function publishFacebook(payload) {
    const message = composeMessage(payload.copy);
    const image = payload.image_url || null;
    const base = `${GRAPH_BASE}/${ver}/${accountId}`;
    const endpoint = image ? `${base}/photos` : `${base}/feed`;
    const pt = await effectiveToken();
    const body = image ? { url: image, caption: message, access_token: pt } : { message, access_token: pt };
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

  // ── READ-ONLY intelligence surface (read_insights / pages_read_engagement / instagram_basic /
  //    instagram_manage_insights / instagram_manage_comments). Every call is a GET; nothing here writes to
  //    Meta. Errors are sanitized (token never echoed); metric availability is explicit — never fabricated.
  function redact(msg) {
    let out = String(msg || '');
    for (const t of [token, pageToken]) if (t) out = out.split(t).join('[redacted]');
    return out;
  }
  async function graphGet(pathWithQuery) {
    const sep = pathWithQuery.indexOf('?') === -1 ? '?' : '&';
    const url = `${GRAPH_BASE}/${ver}/${pathWithQuery}${sep}access_token=${encodeURIComponent(await effectiveToken())}`;
    let r;
    try { r = await http(url, { method: 'GET' }); }
    catch (e) { return { ok: false, code: 'network', message: redact(e && e.message) }; }
    if (!r || !r.ok || !r.json || r.json.error) {
      const err = (r && r.json && r.json.error) || {};
      return { ok: false, code: err.code != null ? String(err.code) : `http_${r && r.status}`, subcode: err.error_subcode || null,
               message: redact(err.message || `graph_error_${r && r.status}`), status: r && r.status };
    }
    return { ok: true, json: r.json };
  }
  const notSupportedCode = (res) => res && (String(res.code) === '100' || String(res.code) === '3001' || String(res.code) === '80001');
  const permissionCode = (res) => res && (String(res.code) === '10' || String(res.code) === '200' || String(res.code) === '190');

  /**
   * Read insights + object-field metrics for ONE published post/media. Returns
   * { ok, metrics: { key: { value, availability, provider_metric } }, provider_status, error }.
   * Unsupported metrics are retried INDIVIDUALLY so one deprecated metric never blanks the others.
   */
  async function fetchPostMetrics(postId, cat) {
    if (!active) return { ok: false, metrics: {}, provider_status: 'error', error: 'provider_inactive' };
    const metrics = {};
    const setM = (spec, value, availability) => { metrics[spec.key] = { value: value == null ? null : Number(value), availability, provider_metric: spec.metric }; };
    let anyError = false; let anyOk = false; let firstError = null;

    // Insights (combined, then per-metric fallback for unsupported ones).
    const names = cat.insights.map((s) => s.metric).join(',');
    const combined = await graphGet(`${encodeURIComponent(postId)}/insights?metric=${names}`);
    if (combined.ok) {
      const data = Array.isArray(combined.json.data) ? combined.json.data : [];
      for (const spec of cat.insights) {
        const entry = data.find((d) => d.name === spec.metric);
        const v = reduceValue(entry, spec);
        if (entry && v != null) { setM(spec, v, 'available'); anyOk = true; } else setM(spec, null, 'unavailable');
      }
    } else if (notSupportedCode(combined)) {
      for (const spec of cat.insights) {
        const one = await graphGet(`${encodeURIComponent(postId)}/insights?metric=${spec.metric}`);
        if (one.ok) {
          const entry = (one.json.data || []).find((d) => d.name === spec.metric); const v = reduceValue(entry, spec);
          if (entry && v != null) { setM(spec, v, 'available'); anyOk = true; } else setM(spec, null, 'unavailable');
        } else if (notSupportedCode(one)) setM(spec, null, 'not_supported');
        else { setM(spec, null, 'error'); anyError = true; firstError = firstError || one.message; }
      }
    } else {
      anyError = true; firstError = combined.message;
      for (const spec of cat.insights) setM(spec, null, permissionCode(combined) ? 'unavailable' : 'error');
    }

    // Object fields (comments/shares/likes summaries).
    const fields = await graphGet(`${encodeURIComponent(postId)}?fields=${encodeURIComponent(cat.fields)}`);
    if (fields.ok) {
      for (const fm of cat.fieldMap) {
        const v = dig(fields.json, fm.path);
        if (fm.fallbackOnly && metrics[fm.key] && metrics[fm.key].availability === 'available') continue;
        if (typeof v === 'number') { metrics[fm.key] = { value: v, availability: 'available', provider_metric: fm.path.join('.') }; anyOk = true; }
        else if (!metrics[fm.key]) metrics[fm.key] = { value: null, availability: 'unavailable', provider_metric: fm.path.join('.') };
      }
    } else { anyError = true; firstError = firstError || fields.message; }

    const provider_status = anyError ? (anyOk ? 'partial' : 'error') : 'ok';
    return { ok: anyOk || !anyError, metrics, provider_status, error: anyError ? firstError : null };
  }

  /** Account-level daily facts (followers etc.). Aggregate only. */
  async function fetchAccountMetrics(catalog) {
    if (!active) return { ok: false, metrics: {}, provider_status: 'error', error: 'provider_inactive' };
    const metrics = {}; let anyError = false; let anyOk = false; let firstError = null;
    const f = await graphGet(`${encodeURIComponent(accountId)}?fields=${encodeURIComponent(catalog.fields)}`);
    if (f.ok) {
      for (const fm of catalog.fieldMap) {
        const v = dig(f.json, fm.path);
        if (typeof v === 'number') { metrics[fm.key] = { value: v, availability: 'available', provider_metric: fm.path.join('.') }; anyOk = true; }
        else metrics[fm.key] = { value: null, availability: 'unavailable', provider_metric: fm.path.join('.') };
      }
    } else { anyError = true; firstError = f.message; }
    for (const spec of catalog.insights || []) {
      const extra = platform === 'instagram' ? '&metric_type=total_value' : '';
      const one = await graphGet(`${encodeURIComponent(accountId)}/insights?metric=${spec.metric}&period=${spec.period || 'day'}${extra}`);
      if (one.ok) {
        const entry = (one.json.data || []).find((d) => d.name === spec.metric);
        const v = entry && entry.total_value && typeof entry.total_value.value === 'number' ? entry.total_value.value : reduceValue(entry, spec);
        metrics[spec.key] = { value: v == null ? null : Number(v), availability: v == null ? 'unavailable' : 'available', provider_metric: spec.metric };
        if (v != null) anyOk = true;
      } else if (notSupportedCode(one)) metrics[spec.key] = { value: null, availability: 'not_supported', provider_metric: spec.metric };
      else { metrics[spec.key] = { value: null, availability: 'error', provider_metric: spec.metric }; anyError = true; firstError = firstError || one.message; }
    }
    return { ok: anyOk || !anyError, metrics, provider_status: anyError ? (anyOk ? 'partial' : 'error') : 'ok', error: anyError ? firstError : null };
  }

  /**
   * Read comments on ONE of our posts (bounded page; NO author fields requested — data minimization).
   * Facebook user comments additionally require pages_read_user_content; a permission error is reported as
   * { ok:false, availability:'unavailable' } — never treated as "no comments".
   */
  async function fetchComments(postId, { limit = 50 } = {}) {
    if (!active) return { ok: false, comments: [], availability: 'error', error: 'provider_inactive' };
    const fields = platform === 'instagram' ? 'id,text,timestamp' : 'id,message,created_time';
    const r = await graphGet(`${encodeURIComponent(postId)}/comments?fields=${fields}&limit=${Math.min(100, Math.max(1, limit))}`);
    if (!r.ok) return { ok: false, comments: [], availability: permissionCode(r) ? 'unavailable' : 'error', error: r.message };
    const list = Array.isArray(r.json.data) ? r.json.data : [];
    return { ok: true, availability: 'available', comments: list.map((c) => ({
      id: c.id, text: c.text != null ? c.text : c.message, occurred_at: c.timestamp || c.created_time || null })) };
  }

  /** Read-only identity check: does the configured token resolve the configured account id? (Never enumerates /me/accounts.) */
  async function verifyIdentity() {
    if (!active) return { ok: false, error: reasonInactive() };
    const fields = platform === 'instagram' ? 'id,username' : 'id,name,instagram_business_account';
    const r = await graphGet(`${encodeURIComponent(accountId)}?fields=${fields}`);
    if (!r.ok) return { ok: false, error: r.message, code: r.code };
    const j = r.json;
    return { ok: String(j.id) === String(accountId), resolved_id: j.id, name: j.name || j.username || null,
             linked_instagram_business_account_id: j.instagram_business_account ? j.instagram_business_account.id : null };
  }
  function reasonInactive() { return !token ? 'missing_credential' : 'missing_account_id'; }

  return {
    name: 'meta', platform, active, shadow: false,
    reason: active ? null : reasonInactive(),
    async publish(payload) {
      if (!active) return { ok: false, error: this.reason || 'provider_inactive' };
      return platform === 'instagram' ? publishInstagram(payload) : publishFacebook(payload);
    },
    fetchPostMetrics, fetchAccountMetrics, fetchComments, verifyIdentity,
  };
}

module.exports = { buildProvider, composeMessage, graphVersion, DEFAULT_GRAPH_VERSION };

'use strict';

/**
 * discoveryConnector — the ONE generic connector for every authorized company (provider-neutral discovery,
 * 2026-10-29). A company's import source carries no company-specific code: this connector reads that company's
 * ACTIVE collection channels (event_collection_channels, confirmed by a person after a dry-run preview) through
 * eventDiscovery/collect (robots first, honest identity, public addresses, same-site, paced, budgeted).
 *
 * Each item:
 *   • sourceEventId = the event's own canonical page URL when it has one, so the same event seen through two
 *     channels (an iCal and its JSON-LD) is one event, updated in place on every sync;
 *   • memberOrganizationId = the company (verified host, 'authorized_source');
 *   • channelId = its channel (provenance + per-channel health);
 *   • sale_type from what the item says, else the channel's hint, else none (held by the normal rules);
 *   • holdForReview while an HTML-extraction channel has not yet earned trust (TRUST_AFTER reviewed events).
 *
 * Per-channel results go to diag.partner(...) (oversight) and, on a real run, to the channel's health.
 * An HTML channel whose pages drift from its confirmed profile is suspended automatically (never guessed around).
 * Push channels are not read here: pushed events arrive through the intake service.
 */

const { IDENTITY_FIELD_MAP } = require('../normalize/identityFieldMap');
const collect = require('../../eventDiscovery/collect');
const store = require('../../eventDiscovery/channelStore');
const feed = require('./feedConnector');

const TRUST_AFTER = 10;

function outcomeOf(res) {
  if (res.blocks && res.blocks.length && !res.items.length) {
    const b = res.blocks[0];
    if (b.class === 'rate_limited') return 'rate_limited';
    if (b.class === 'unreachable') return 'unreachable';
    if (b.class === 'not_found') return 'unreachable';
    return 'blocked';
  }
  if (res.error === 'format_changed' || res.error === 'no_structured_events' || res.drift) return 'parse_failure';
  return res.items.length ? 'ok' : 'empty';
}

module.exports = {
  key: 'discovery',
  kind: 'partner',
  capabilities: { incremental: false, deletions: false, images: true },
  fieldMap: IDENTITY_FIELD_MAP,
  TRUST_AFTER,
  outcomeOf,

  async *fetch({ config, limit, diag, db, source, apply, now, deps } = {}) {
    if (!db || !source) return;
    config = config || {};
    const channels = (await store.activeForSource(db, source.id)).filter((c) => c.kind !== 'push_api');
    const attribution = config.attribution || {};
    const fetchers = new Map();
    let n = 0;
    for (const ch of channels) {
      const origin = collect.originOf(ch.url);
      if (!origin) continue;
      if (!fetchers.has(origin)) fetchers.set(origin, collect.makeFetcher(origin, Object.assign({ allowedHosts: config.allowed_hosts || [] }, deps || {})));
      let res;
      try {
        res = await collect.readChannel(fetchers.get(origin), ch, { now });
        // Only upcoming events are worth a page read for their image (past ones are rejected anyway).
        if (res.items.length) await collect.enrichImages(fetchers.get(origin), collect.upcoming(res.items, now || Date.now()), { max: 10 });
      }
      catch (e) { res = { items: [], error: String(e && e.message) }; }
      const outcome = outcomeOf(res);
      const block = (res.blocks || [])[0] || null;
      if (diag) {
        if (block && block.evidence) diag.record(block.evidence.url || ch.url, block.evidence.status, block.class);
        else diag.record(ch.url, outcome === 'ok' || outcome === 'empty' ? 200 : 'parse');
        diag.partner({ organization_id: ch.organization_id, organizer_name: attribution.name || null, feed: ch.url, http: block && block.evidence ? block.evidence.status : 200,
          outcome, items: res.items.length, note: res.error || (block && block.class) || null, channel_id: ch.id, kind: ch.kind, block_class: block && block.class });
      }
      if (apply) {
        await store.recordRead(db, ch.id, { ok: outcome === 'ok' || outcome === 'empty', items: res.items.length, error: res.error || (block && block.class) || null,
          blockClass: block && block.class, blockEvidence: block && block.evidence }).catch(() => {});
        if (res.drift) {
          await store.setStatus(db, ch.id, 'paused', { auto: true, reason: 'pages no longer match the confirmed extraction profile: '
            + [...new Set(res.drift.flatMap((d) => (d.drift && d.drift.reasons) || []))].join(', ') }).catch(() => {});
          continue;
        }
      }
      let trusted = true;
      if (ch.kind === 'html_profile') trusted = (await store.reviewedPublishedCount(db, ch.id).catch(() => 0)) >= TRUST_AFTER;
      for (const it of res.items) {
        if (limit != null && n >= limit) return;
        collect.sanitizeItem(it);
        const payload = Object.assign({}, it.payload);
        // The organizer is the authorized company, always: a page cannot name someone else as host.
        if (attribution.name) payload.organizer_name = attribution.name;
        if (attribution.url) payload.organizer_website_url = attribution.url;
        const saleType = feed._parsers.classifySaleType(payload.title, it.saleHints) || ch.sale_type_hint || null;
        if (saleType) payload.sale_type = saleType;
        if (ch.timezone && !payload.timezone) payload.timezone = ch.timezone;
        if (!payload.external_url && it.url) payload.external_url = it.url;
        yield {
          sourceEventId: collect.stableId(it, ch.kind),
          sourceUrl: it.url || ch.url,
          sourceUpdatedAt: null,
          payload,
          images: payload.images || it.images || [],
          memberOrganizationId: ch.organization_id,
          channelId: ch.id,
          holdForReview: ch.kind === 'html_profile' && !trusted,
        };
        n++;
      }
    }
  },

  describe() {
    return { name: 'Event discovery (provider-neutral)', basis: 'company_authorization + per-channel host access',
      docs: 'Reads a company\'s confirmed channels: iCal, RSS with event dates, schema.org JSON-LD/microdata, linked event pages, platform endpoints, confirmed HTML profiles.' };
  },
};

'use strict';

/**
 * discoveryOversight — the Marketing Director's view of provider-neutral discovery, folded into partnerOversight
 * (one oversight service, one report, one history). For each authorized company it judges onboarding, discovery,
 * each collection channel, push, and whether what the company lists actually reaches Advantage.Bid.
 *
 * Findings use partnerOversight's vocabulary of who acts: automatic · admin_review · investigate · owner.
 * Pure assessment (assessCompany) + one read (loadCompanies). Read-only.
 */

const DAY = 24 * 3600 * 1000;
const T = Object.freeze({ staleDays: 8, failingAfter: 3, pushSilentDays: 45, dropRatio: 0.5, dropMinPrior: 4 });

function f(code, owner, message, action, extra) { return Object.assign({ code, owner, message, action: action || null }, extra || {}); }
const day = (d) => (d instanceof Date ? d.toISOString() : String(d || '')).slice(0, 10);

const BLOCK_TEXT = {
  host_firewall_refusal: 'the website\'s host refuses automated reading',
  bot_challenge: 'the website demands a browser security check, which the importer never attempts',
  robots_disallow: 'the website\'s robots rules do not allow its event pages to be read',
  terms_prohibit: 'the address given is a listing platform whose terms forbid automated collection',
  login_required: 'the event pages require a login',
  rate_limited: 'the website asked us to slow down',
  unreachable: 'the website could not be reached',
  unsafe_address: 'the website address points somewhere the importer will not connect to (not a public internet address)',
};

/**
 * One authorized company. Pure.
 *   c: { authorization, channels[], lastProbe, keys[], source, events, missed }   ctx: { now, discoveryOn, gateOn }
 */
function assessCompany(c, ctx) {
  const now = ctx.now instanceof Date ? ctx.now.getTime() : Number(ctx.now || Date.now());
  const a = c.authorization; const name = a.company_name || a.authorized_domain;
  const out = [];
  const channels = c.channels || [];
  const active = channels.filter((x) => x.status === 'active');
  const activeRead = active.filter((x) => x.kind !== 'push_api');
  const keys = (c.keys || []).filter((k) => !k.revoked_at);
  const push = active.find((x) => x.kind === 'push_api');

  if (!c.lastProbe) {
    out.push(ctx.discoveryOn
      ? f('AUTHORIZED_NOT_PROBED', 'automatic', name + ' authorized on ' + day(a.authorized_at) + '; its website check is queued.', null)
      : f('DISCOVERY_OFF', 'owner', name + ' authorized on ' + day(a.authorized_at) + ', but automatic website discovery is switched off.', 'Approve EVENT_DISCOVERY_ENABLED in production.'));
  } else if (c.lastProbe.outcome === 'blocked' && !activeRead.length) {
    const b = (c.lastProbe.blocks || [])[0] || {};
    const ev = b.evidence || {};
    out.push(f('PROBE_BLOCKED', push && keys.length ? 'investigate' : 'owner',
      name + ': ' + (BLOCK_TEXT[b.class] || 'the website refused automated reading') + ' (' + [ev.status, ev.url, ev.header].filter(Boolean).join(', ') + ').',
      push && keys.length ? 'The company sends its events directly instead; nothing more is needed unless that stops.'
        : 'The company has been offered: posting on Advantage.Bid, sending its events automatically, or asking its website provider (a ready request is in its dashboard). Automatic reading resumes only if the host allows it.',
      { block_class: b.class || null }));
  } else if (c.lastProbe.outcome === 'nothing_found' && !active.length) {
    out.push(f('NOTHING_FOUND', 'investigate', name + ': its website loads but shows no upcoming events in any readable form.',
      'The company was asked whether its events are on a separate page; it can also send them directly.'));
  } else if (c.lastProbe.outcome === 'error' && !active.length) {
    out.push(f('PROBE_FAILED', 'automatic', name + ': the last website check could not finish (' + (c.lastProbe.error || 'error') + '); it is retried automatically.', null));
  }

  const previewed = channels.filter((x) => x.status === 'previewed');
  if (previewed.length) {
    out.push(f('AWAITING_CHANNEL_CONFIRMATION', 'admin_review', name + ': ' + previewed.length + ' way' + (previewed.length === 1 ? '' : 's') + ' to collect its events found ('
      + previewed.map((x) => x.kind).join(', ') + '); confirm from the preview.', 'Review in Admin › Event Discovery.'));
  }

  for (const ch of channels.filter((x) => x.status === 'paused' && x.paused_reason && /profile|format|drift/i.test(x.paused_reason))) {
    out.push(f('CHANNEL_SUSPENDED', 'owner', name + ': collection from ' + (ch.url || ch.kind) + ' was suspended automatically: ' + ch.paused_reason + '.',
      'A new check runs automatically; confirm the new layout when it is found.', { channel_id: ch.id }));
  }

  for (const ch of activeRead) {
    const label = name + ' (' + ch.kind + ')';
    if (ch.consecutive_failures >= T.failingAfter) {
      out.push(f('CHANNEL_FAILING', 'owner', label + ': ' + ch.consecutive_failures + ' reads in a row failed (' + (ch.block_class || ch.last_error || 'error') + ').',
        ch.block_class === 'host_firewall_refusal' || ch.block_class === 'bot_challenge'
          ? 'The host now refuses us; the company is offered the supported alternatives.' : 'A fresh website check runs automatically; a technical look is needed if it persists.', { channel_id: ch.id }));
    } else if (ch.consecutive_failures > 0) {
      out.push(f('CHANNEL_RETRYING', 'automatic', label + ': the last read failed (' + (ch.block_class || ch.last_error || 'error') + '); it is retried at the next window.', null, { channel_id: ch.id }));
    }
    const lastOk = ch.last_success_at ? Date.parse(ch.last_success_at) : null;
    if (ch.confirmed_at && now - Date.parse(ch.confirmed_at) > T.staleDays * DAY && (!lastOk || now - lastOk > T.staleDays * DAY) && ch.consecutive_failures < T.failingAfter) {
      out.push(f('CHANNEL_STALE', 'owner', label + ': no successful read for more than ' + T.staleDays + ' days (last ' + (lastOk ? day(ch.last_success_at) : 'never') + ').',
        'Check that the importer schedule is running.', { channel_id: ch.id }));
    }
  }

  if (push && keys.length && !activeRead.length) {
    const used = keys.map((k) => k.last_used_at).filter(Boolean).map((d) => Date.parse(d)).sort((x, y) => y - x)[0];
    if (!used) out.push(f('PUSH_NOT_STARTED', 'investigate', name + ': a sending key exists but no events have been sent yet.', 'Help the company connect its tool (see the guide in its dashboard).'));
    else if (now - used > T.pushSilentDays * DAY) out.push(f('PUSH_SILENT', 'investigate', name + ': no events sent for ' + Math.round((now - used) / DAY) + ' days.', 'It may simply have nothing scheduled; check with the company.'));
  }

  if (activeRead.length && !ctx.gateOn) {
    out.push(f('COLLECTION_GATE_OFF', 'owner', name + ': confirmed collection is waiting for the platform collection switch.', 'Approve event_partners.collection_enabled in production.'));
  }

  if (c.missed && c.missed.length) {
    out.push(f('EVENTS_MISSED', 'investigate', name + ': ' + c.missed.length + ' upcoming event' + (c.missed.length === 1 ? '' : 's') + ' seen on its website ' + (c.missed.length === 1 ? 'is' : 'are')
      + ' not on Advantage.Bid (e.g. "' + c.missed[0].title + '").', 'Check the import run for that event (rejected, held for review or capped).'));
  }

  return out.map((x) => Object.assign(x, { partner: name, organization_id: a.organization_id }));
}

/** Read every live authorization with its channels, last probe, keys and missed-event check. */
async function loadCompanies(db, { live = ['authorized', 'source_configured', 'collecting', 'paused'] } = {}) {
  const reg = (await db.query(`SELECT to_regclass('authorized_event_sources') IS NOT NULL AS a, to_regclass('event_collection_channels') IS NOT NULL AS ok`)).rows[0];
  if (!reg.a) return [];   // a minimal database without the authorization tables has no authorized companies
  const has = reg.ok;
  const auths = (await db.query(`SELECT * FROM authorized_event_sources WHERE status = ANY($1) ORDER BY company_name`, [live])).rows;
  if (!has) return auths.map((a) => ({ authorization: a, channels: [], lastProbe: null, keys: [], legacy: true }));
  const out = [];
  for (const a of auths) {
    const channels = (await db.query(`SELECT * FROM event_collection_channels WHERE authorization_id = $1`, [a.id])).rows;
    const lastProbe = (await db.query(`SELECT * FROM event_discovery_probes WHERE authorization_id = $1 ORDER BY started_at DESC LIMIT 1`, [a.id])).rows[0] || null;
    const keys = (await db.query(`SELECT id, key_prefix, last_used_at, revoked_at FROM partner_intake_keys WHERE authorization_id = $1`, [a.id])).rows;
    const source = a.import_source_id ? (await db.query(`SELECT id, key, status FROM import_sources WHERE id = $1`, [a.import_source_id])).rows[0] || null : null;
    // Missed events: upcoming events an ACTIVE channel showed at its last check, with no imported record.
    const missed = [];
    for (const ch of channels.filter((x) => x.status === 'active' && x.last_success_at && Array.isArray(x.preview))) {
      for (const p of ch.preview) {
        if (!p.url || !p.start_at || Date.parse(p.end_at || p.start_at) < Date.now()) continue;
        const seen = (await db.query(`SELECT 1 FROM event_sources WHERE source_url = $1 OR source_event_id = $2 LIMIT 1`,
          [p.url, 'url:' + require('./collect').canonicalUrl(p.url)])).rows.length;
        if (!seen && ch.confirmed_at && Date.parse(ch.last_success_at) > Date.parse(ch.confirmed_at)) missed.push(p);
      }
    }
    out.push({ authorization: a, channels, lastProbe, keys, source, missed });
  }
  return out;
}

module.exports = { T, BLOCK_TEXT, assessCompany, loadCompanies };

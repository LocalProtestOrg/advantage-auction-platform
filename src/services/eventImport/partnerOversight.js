'use strict';

/**
 * partnerOversight — the Marketing Director's (A1) standing oversight of the approved-partner event-import
 * system (owner assignment, 2026-10-29). Approved partner events must never silently disappear.
 *
 * It covers EVERY approved source, not one company:
 *   • live import sources (government surplus, original-host listings, Member Feed Sync)
 *   • each member feed on Member Feed Sync (consent-gated, member-neutral; 2026-09-24 architecture)
 *   • each Event Partner whose authorization is recorded (authorized_event_sources)
 *
 * WHAT IT DOES (read-only): reads the run ledger, per-partner feed results, source health and the
 * partners' events, and turns them into findings. Each finding says who acts on it:
 *   automatic     the importer already handles it (bounded retry at 1h / 2h / 4h, next scheduled window)
 *   admin_review  imported events are waiting in the Admin Review Queue
 *   investigate   unusual but not necessarily a failure (e.g. a partner with nothing upcoming)
 *   owner         a person must act: consent, a firewall change on the partner's site, a technical repair
 *
 * WHAT IT MUST NOT DO. It never bypasses a source's access restriction or presents another identity, never
 * creates, edits or publishes an event or photograph, never records, widens or revokes consent, and never
 * changes code, schema, configuration or a deployment. Those stay human decisions (see MUST_NOT).
 *
 *   assess(db, { now })              the full picture (sources, partners, findings, overall state)
 *   buildReport(assessment)          a concise text report { subject, text }
 *   ownerActions(assessment)         the findings that need a person, each with a stable key
 *   recordAssessment(db, a)          the history row (audit_log 'event_import_oversight'); returns new owner actions
 */

const db0 = require('../../db');
const inventoryHealth = require('./inventoryHealthService');
const memberFeeds = require('./memberFeedService');
const { hasMemberConsent } = require('./connectors/feedConnector');
const { activeEventSql } = require('../../lib/marketplaceVisibility');

const OVERSEER = Object.freeze({ code: 'A1', name: 'Marketing Director', capability: 'oversee_event_imports' });

const MAY = Object.freeze(['read_import_history', 'run_health_checks', 'run_bounded_retries', 'record_source_health', 'report', 'alert_owner']);
const MUST_NOT = Object.freeze(['bypass_source_access', 'impersonate_browser', 'create_event', 'publish_event', 'edit_event',
  'invent_photographs', 'record_consent', 'revoke_consent', 'change_partner_permissions', 'change_configuration', 'change_code', 'deploy']);

const THRESHOLDS = Object.freeze({
  staleDays: 8,          // the schedule runs at least twice a week; 8 days without a good sync is stale
  dropRatio: 0.5,        // a feed listing under half of its recent high is an unusual drop
  dropMinPrior: 4,       // ...when it recently listed at least this many events
  failingAfter: 3,       // consecutive recoverable failures before a person is asked to look
  historyRuns: 8,        // recent runs read per source
  formerWindowDays: 180, // a partner imported through a retired source within this window must have a new path
});

// The importer's honest identity, exactly as it is sent (a partner's administrator allows this).
const IMPORTER_IDENTITY = require('./http').DEFAULT_UA;
const FEED_FORMATS = 'an iCal (.ics) calendar, an RSS feed, or schema.org Event structured data (JSON-LD)';

const DAY = 24 * 3600 * 1000;
// A date as YYYY-MM-DD whether the driver returned a Date or a string.
const day = (d) => (d instanceof Date ? d.toISOString() : String(d || '')).slice(0, 10);

function hostOf(u) { try { return new URL(String(u)).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return null; } }
function sameSite(a, b) { const x = hostOf(a), y = hostOf(b); return !!(x && y && (x === y || x.endsWith('.' + y) || y.endsWith('.' + x))); }
function finding(code, owner, message, action, extra) { return Object.assign({ code, owner, message, action: action || null }, extra || {}); }

/**
 * One member feed's findings, from its recent results (newest first) and its events. Pure.
 *   feed:    { url|site, organization_id, organizer_name, organizer_website_url, consent, revoked_at }
 *   history: [{ at, outcome, http, items }]   newest first
 *   events:  { upcoming, discoverable, awaiting_review, other_unpublished, unclassified, bad_dates, missing_link, off_site_links, duplicates }
 *   ctx:     { sourceActive, now }
 */
function assessFeed(feed, history, events, ctx) {
  const now = ctx.now instanceof Date ? ctx.now.getTime() : Number(ctx.now || Date.now());
  const name = feed.organizer_name || 'member ' + feed.organization_id;
  const where = feed.url || feed.site;
  const out = [];
  if (feed.revoked_at) return [finding('CONSENT_REVOKED', 'investigate', name + ': the member revoked its feed authorization on ' + day(feed.revoked_at) + '; it is no longer synced.', null)];
  if (!hasMemberConsent(feed)) {
    return [finding('CONSENT_MISSING', 'owner', name + ': no complete consent is recorded for ' + where + ', so it is never fetched.',
      'Record the member\'s consent (who granted it, when, and the written evidence) through Member Feed Sync onboarding.')];
  }
  if (!ctx.sourceActive) {
    out.push(finding('SYNC_PAUSED', 'owner', name + ': Member Feed Sync is not active, so this consented feed is not being synced.',
      'Approve activation of Member Feed Sync in production.'));
  }
  const last = history[0];
  if (!last) {
    if (ctx.sourceActive) out.push(finding('NEVER_SYNCED', 'investigate', name + ': consented but no sync of ' + where + ' has run yet.', 'Wait for the next scheduled window, or run a dry-run sync.'));
  } else {
    const recoverable = (o) => o === 'rate_limited' || o === 'unreachable';
    let streak = 0; for (const h of history) { if (recoverable(h.outcome)) streak++; else break; }
    if (last.outcome === 'blocked') {
      out.push(finding('BLOCKED', 'owner', name + ': ' + where + ' refuses automated access (HTTP ' + last.http + '). The importer does not get around a refusal.',
        'Ask ' + name + '\'s website administrator to allow requests identifying as "' + IMPORTER_IDENTITY + '" to the feed address, or to provide '
        + FEED_FORMATS + ' at an address that allows it.', { http: last.http }));
    } else if (last.outcome === 'no_feed_found') {
      out.push(finding('NO_FEED_FOUND', 'owner', name + ': ' + where + ' loads but publishes no event feed.',
        'Ask ' + name + ' for ' + FEED_FORMATS + ', then register that address.'));
    } else if (last.outcome === 'parse_failure') {
      out.push(finding('FORMAT_CHANGED', 'owner', name + ': ' + where + ' loads but is no longer readable as an event feed (the site or feed format changed).',
        'A technical repair is needed: confirm the new address or format with ' + name + '.'));
    } else if (recoverable(last.outcome)) {
      out.push(streak >= THRESHOLDS.failingAfter
        ? finding('FAILING', 'owner', name + ': ' + streak + ' consecutive syncs failed (' + last.outcome + ').', 'A technical check of the feed address is needed.')
        : finding('RETRYING', 'automatic', name + ': the last sync failed recoverably (' + last.outcome + '); an automatic retry is scheduled.', null));
    }
    const good = history.find((h) => h.outcome === 'ok' || h.outcome === 'empty');
    if (ctx.sourceActive && (!good || now - Date.parse(good.at) > THRESHOLDS.staleDays * DAY) && !out.some((f) => f.owner === 'owner')) {
      out.push(finding('STALE', 'owner', name + ': no successful sync for more than ' + THRESHOLDS.staleDays + ' days (last: ' + (good ? day(good.at) : 'never') + ').',
        'A technical check is needed.'));
    }
    if (last.outcome === 'ok' || last.outcome === 'empty') {
      const prior = Math.max(0, ...history.slice(1).map((h) => Number(h.items) || 0));
      if (prior >= THRESHOLDS.dropMinPrior && (Number(last.items) || 0) < prior * THRESHOLDS.dropRatio) {
        out.push(finding('COUNT_DROP', 'investigate', name + ': the feed now lists ' + (last.items || 0) + ' events, down from ' + prior + ' recently.',
          'Check the partner\'s calendar: a quiet period is normal, a missing section is not.'));
      }
    }
  }
  out.push(...assessEvents(name, feed.organizer_website_url || feed.site || feed.url, events, { synced: !!(last && (last.outcome === 'ok' || last.outcome === 'empty')) }));
  return out;
}

/** Findings about a partner's imported events (dates, classification, links, duplicates, visibility). Pure. */
function assessEvents(name, site, ev, { synced }) {
  ev = ev || {};
  const out = [];
  if (synced && !(ev.upcoming > 0)) {
    out.push(finding('NO_UPCOMING', 'investigate', name + ': syncing normally but has no upcoming events on Advantage.Bid.',
      'Check the partner\'s own calendar before treating this as a failure; a partner may simply have nothing scheduled.'));
  }
  if (ev.awaiting_review > 0) out.push(finding('AWAITING_REVIEW', 'admin_review', name + ': ' + ev.awaiting_review + ' upcoming imported event(s) wait in the Admin Review Queue and are not public yet.', 'Review them in the Admin Review Queue.'));
  if (ev.other_unpublished > 0) out.push(finding('NOT_DISCOVERABLE', 'investigate', name + ': ' + ev.other_unpublished + ' upcoming event(s) are imported but rejected or archived, so they are not discoverable.', 'Confirm each was intentionally withheld.'));
  if (ev.unclassified > 0) out.push(finding('UNCLASSIFIED', 'investigate', name + ': ' + ev.unclassified + ' upcoming event(s) do not say whether they are an auction or an estate sale.', 'Set the feed\'s declared sale type, or correct the events.'));
  if (ev.bad_dates > 0) out.push(finding('BAD_DATES', 'investigate', name + ': ' + ev.bad_dates + ' upcoming event(s) end before they start.', 'Check the source dates and time zone.'));
  if (ev.missing_link > 0) out.push(finding('MISSING_LINK', 'investigate', name + ': ' + ev.missing_link + ' upcoming event(s) have no https link to the partner\'s own page.', 'Check the feed\'s event links.'));
  if (ev.off_site_links > 0) out.push(finding('OFF_SITE_LINKS', 'investigate', name + ': ' + ev.off_site_links + ' upcoming event(s) link somewhere other than ' + (hostOf(site) || 'the partner\'s site') + '.', 'Confirm the links are the partner\'s own pages.'));
  if (ev.duplicates > 0) out.push(finding('DUPLICATES', 'investigate', name + ': ' + ev.duplicates + ' upcoming event(s) share a title and start date with another of its events.', 'Check for a duplicate import.'));
  return out;
}

/** A live import source's findings, from its persisted health and recent run counts (newest first). Pure. */
function assessSource(s, recent, now) {
  const t = now instanceof Date ? now.getTime() : Number(now || Date.now());
  const out = [];
  if (!s.live) return out;
  const label = s.name || s.key;
  if (s.health_state === 'BLOCKED_BY_SOURCE') out.push(finding('SOURCE_BLOCKED', 'owner', label + ' refuses automated access: ' + s.health_reason, 'The source\'s permission or an authorized feed is needed.', { source: s.key }));
  else if (s.health_state === 'BROKEN') out.push(finding('SOURCE_BROKEN', 'owner', label + ' is failing: ' + s.health_reason, 'A technical repair is needed.', { source: s.key }));
  else if (s.health_state === 'NEEDS_REVIEW') out.push(finding('SOURCE_NEEDS_REVIEW', 'owner', label + ': ' + s.health_reason, 'An owner decision or configuration is needed.', { source: s.key }));
  else if (s.health_state === 'DEGRADED') {
    out.push(s.next_retry_at
      ? finding('SOURCE_RETRYING', 'automatic', label + ': ' + s.health_reason, null, { source: s.key })
      : finding('SOURCE_DEGRADED', 'investigate', label + ': ' + s.health_reason, 'Watch the next scheduled run.', { source: s.key }));
  }
  if (!s.last_success_at || t - Date.parse(s.last_success_at) > THRESHOLDS.staleDays * DAY) {
    if (!out.some((f) => f.owner === 'owner')) out.push(finding('SOURCE_STALE', 'owner', label + ': no successful run for more than ' + THRESHOLDS.staleDays + ' days.', 'Check the importer schedule and the source.', { source: s.key }));
  }
  const fetched = (recent || []).filter((r) => r.status !== 'failed').map((r) => Number(r.fetched) || 0);
  if (fetched.length >= 2) {
    const prior = Math.max(...fetched.slice(1));
    if (prior >= THRESHOLDS.dropMinPrior && fetched[0] < prior * THRESHOLDS.dropRatio) {
      out.push(finding('SOURCE_COUNT_DROP', 'investigate', label + ': the last run fetched ' + fetched[0] + ' events, down from ' + prior + ' recently.', 'Check whether the source changed its listing.', { source: s.key }));
    }
  }
  return out;
}

const norm = (x) => String(x || '').toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '');

/**
 * Partners whose events USED to arrive through a source that has since been retired, and that have no
 * current path (a consented feed, an Event Partner source, or events they publish themselves). Without
 * this check such a partner simply goes quiet: nothing fails, so nothing is reported. Pure.
 *   rows:    [{ source_name, retired_at, organizer_name, host_organization_id, last_event }]
 *   covered: { orgIds: Set, names: [normalized names] }
 */
function assessFormerPartners(rows, covered, now) {
  const t = now instanceof Date ? now.getTime() : Number(now || Date.now());
  const out = [];
  for (const r of rows || []) {
    if (!r.last_event || t - Date.parse(r.last_event) > THRESHOLDS.formerWindowDays * DAY) continue;
    const n = norm(r.organizer_name);
    const isCovered = (r.host_organization_id && covered.orgIds.has(r.host_organization_id))
      || (n && covered.names.some((c) => c && (c.includes(n) || n.includes(c))));
    if (isCovered) continue;
    const name = r.organizer_name || 'a partner';
    out.push(finding('FORMER_SOURCE_PARTNER', 'owner',
      name + ': events arrived through ' + (r.source_name || 'a source') + ' until ' + day(r.last_event)
        + ', which was retired' + (r.retired_at ? ' on ' + day(r.retired_at) : '') + '. No consented feed or member publishing has replaced it, so new events cannot appear.',
      'Onboard ' + name + ' through Member Feed Sync with its recorded consent, or have it publish through its member account.',
      { partner: name, organization_id: r.host_organization_id || null }));
  }
  return out;
}

function overallOf(findings) {
  if (findings.some((f) => f.owner === 'owner')) return 'ACTION_REQUIRED';
  if (findings.some((f) => f.owner === 'investigate' || f.owner === 'admin_review')) return 'ATTENTION';
  return 'OK';
}

// ── reads ────────────────────────────────────────────────────────────────────────

const EVENT_STATS_SQL = (where) => `
  SELECT count(*)::int AS upcoming,
         count(*) FILTER (WHERE ${activeEventSql('e')})::int AS discoverable,
         count(*) FILTER (WHERE e.status IN ('draft','submitted'))::int AS awaiting_review,
         count(*) FILTER (WHERE e.status IN ('rejected','archived'))::int AS other_unpublished,
         count(*) FILTER (WHERE e.sale_type IS NULL)::int AS unclassified,
         count(*) FILTER (WHERE e.end_at IS NOT NULL AND e.start_at IS NOT NULL AND e.end_at < e.start_at)::int AS bad_dates,
         count(*) FILTER (WHERE e.external_url IS NULL OR e.external_url !~ '^https://')::int AS missing_link,
         array_remove(array_agg(DISTINCT e.external_url), NULL) AS links,
         (SELECT COALESCE(sum(n - 1), 0)::int FROM (SELECT count(*) n FROM events d WHERE ${where.replace(/\be\./g, 'd.')}
             AND COALESCE(d.end_at, d.start_at) >= now() GROUP BY lower(d.title), (d.start_at)::date HAVING count(*) > 1) x) AS duplicates
    FROM events e
   WHERE ${where} AND COALESCE(e.end_at, e.start_at) >= now()`;

async function partnerEventStats(db, organizationId, site) {
  const r = (await db.query(EVENT_STATS_SQL('e.host_organization_id = $1'), [organizationId])).rows[0] || {};
  const links = r.links || []; delete r.links;
  r.off_site_links = site ? links.filter((u) => /^https:\/\//.test(u) && !sameSite(u, site)).length : 0;
  return r;
}

// Each member feed's results across recent Member Feed Sync runs, newest first.
async function feedHistory(db, sourceKey) {
  const rows = (await db.query(
    `SELECT r.started_at, r.stats FROM import_runs r JOIN import_sources s ON s.id = r.source_id
      WHERE s.key = $1 ORDER BY r.started_at DESC LIMIT $2`, [sourceKey, THRESHOLDS.historyRuns])).rows;
  const by = {};
  for (const row of rows) {
    for (const p of ((row.stats || {}).partners || [])) {
      const k = p.organization_id + '|' + p.feed;
      (by[k] = by[k] || []).push({ at: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at, outcome: p.outcome, http: p.http, items: p.items });
    }
  }
  return by;
}

async function recentRuns(db) {
  const rows = (await db.query(
    `SELECT s.key, r.status, r.fetched, r.started_at FROM import_sources s
       JOIN LATERAL (SELECT status, fetched, started_at FROM import_runs x WHERE x.source_id = s.id ORDER BY started_at DESC LIMIT $1) r ON true
      ORDER BY s.key, r.started_at DESC`, [THRESHOLDS.historyRuns])).rows;
  return rows.reduce((m, r) => { (m[r.key] = m[r.key] || []).push(r); return m; }, {});
}

async function formerSourceRows(db) {
  return (await db.query(
    `SELECT s.name AS source_name, s.config->>'retired_at' AS retired_at, e.organizer_name, e.host_organization_id,
            max(COALESCE(e.end_at, e.start_at)) AS last_event
       FROM events e JOIN event_sources es ON es.event_id = e.id JOIN import_sources s ON s.id = es.source_id
      WHERE s.config ? 'retired_reason'
      GROUP BY 1, 2, 3, 4`)).rows;
}

// Organizations that publish upcoming events themselves (their member account) have a current path.
async function selfPublishingOrgs(db) {
  return (await db.query(
    `SELECT DISTINCT e.organization_id AS id, o.name FROM events e JOIN organizations o ON o.id = e.organization_id
      WHERE e.source = 'organization' AND ${activeEventSql('e')}`)).rows;
}

async function authorizedPartners(db) {
  try {
    return (await db.query(
      `SELECT a.organization_id, a.company_name, a.authorized_domain, a.status, s.key AS source_key, s.status AS source_status
         FROM authorized_event_sources a LEFT JOIN import_sources s ON s.id = a.import_source_id
        WHERE a.status IN ('authorized','source_configured','collecting','paused') ORDER BY a.company_name`)).rows;
  } catch (_) { return []; }   // the Event Partner tables may be absent in a minimal database
}

/** The full oversight picture. Read-only; a failing part is reported, never thrown. */
async function assess(db = db0, { now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const errors = [];
  const safe = async (label, fn, fallback) => { try { return await fn(); } catch (e) { errors.push(label + ': ' + (e && e.message)); return fallback; } };

  const sources = await safe('sources', () => inventoryHealth.sourceHealthView(db), []);
  const runs = await safe('runs', () => recentRuns(db), {});
  const feedsView = await safe('member feeds', () => memberFeeds.listFeeds({ db }), { source_status: null, feeds: [] });
  const rawFeeds = await safe('member feed config', async () => {
    const r = (await db.query(`SELECT config FROM import_sources WHERE key = $1`, [memberFeeds.SOURCE_KEY])).rows[0];
    return (r && r.config && Array.isArray(r.config.feeds)) ? r.config.feeds : [];
  }, []);
  const history = await safe('feed history', () => feedHistory(db, memberFeeds.SOURCE_KEY), {});

  const findings = [];
  const sourceRows = sources.filter((s) => s.health_state !== 'RETIRED').map((s) => {
    const f = assessSource(s, runs[s.key] || [], at);
    findings.push(...f);
    return { key: s.key, name: s.name, status: s.status, live: s.live, health_state: s.health_state, health_reason: s.health_reason,
      last_success_at: s.last_success_at, next_retry_at: s.next_retry_at, last_fetched: s.last_run ? s.last_run.fetched : null, findings: f.map((x) => x.code) };
  });

  const partners = [];
  for (const feed of rawFeeds) {
    const where = feed.url || feed.site;
    const events = await safe('events ' + feed.organization_id, () => partnerEventStats(db, feed.organization_id, feed.organizer_website_url || where), {});
    const hist = history[feed.organization_id + '|' + where] || [];
    const f = assessFeed(feed, hist, events, { sourceActive: feedsView.source_status === 'active', now: at })
      .map((x) => Object.assign(x, { partner: feed.organizer_name || feed.organization_id, organization_id: feed.organization_id }));
    findings.push(...f);
    partners.push({ kind: 'member_feed', organization_id: feed.organization_id, name: feed.organizer_name || null, feed: where,
      consent: feed.revoked_at ? 'revoked' : (hasMemberConsent(feed) ? 'recorded' : 'missing'), last_sync: hist[0] || null, events, findings: f.map((x) => x.code) });
  }
  for (const p of await safe('event partners', () => authorizedPartners(db), [])) {
    const events = await safe('events ' + p.organization_id, () => partnerEventStats(db, p.organization_id, 'https://' + p.authorized_domain), {});
    const synced = !!(p.source_key && (sources.find((s) => s.key === p.source_key) || {}).last_success_at);
    const f = [];
    if (!p.source_key) f.push(finding('PARTNER_SOURCE_MISSING', 'owner', p.company_name + ' is authorized but no import source is configured for it.', 'Configure its source (an owner-approved production change).'));
    f.push(...assessEvents(p.company_name, 'https://' + p.authorized_domain, events, { synced }));
    f.forEach((x) => Object.assign(x, { partner: p.company_name, organization_id: p.organization_id }));
    findings.push(...f);
    partners.push({ kind: 'event_partner', organization_id: p.organization_id, name: p.company_name, feed: p.source_key || null,
      consent: p.status, events, findings: f.map((x) => x.code) });
  }

  const selfPublishing = await safe('member publishing', () => selfPublishingOrgs(db), []);
  const covered = {
    orgIds: new Set([...partners.map((p) => p.organization_id), ...selfPublishing.map((o) => o.id)].filter(Boolean)),
    names: [...partners.map((p) => norm(p.name)), ...selfPublishing.map((o) => norm(o.name))].filter(Boolean),
  };
  findings.push(...assessFormerPartners(await safe('retired sources', () => formerSourceRows(db), []), covered, at));

  if (errors.length) findings.push(finding('OVERSIGHT_INCOMPLETE', 'investigate', 'Part of the oversight check could not run: ' + errors.join('; '), 'Look at the worker log.'));
  return { overseer: OVERSEER, generated_at: at.toISOString(), overall: overallOf(findings), sources: sourceRows, partners, findings };
}

/** The findings that need a person, each with a stable key (so the same problem is alerted once). Pure. */
function ownerActions(a) {
  return ((a && a.findings) || []).filter((f) => f.owner === 'owner')
    .map((f) => Object.assign({ key: f.code + ':' + (f.organization_id || f.source || '-') }, f));
}

/** A concise periodic report. Pure. */
function buildReport(a) {
  const lines = [];
  const actions = ownerActions(a);
  const by = (o) => (a.findings || []).filter((f) => f.owner === o);
  lines.push('Event import oversight (Marketing Director) - ' + String(a.generated_at).slice(0, 16).replace('T', ' ') + ' UTC');
  lines.push('Overall: ' + a.overall);
  lines.push('');
  lines.push('Sources:');
  for (const s of a.sources || []) {
    if (s.status === 'active' || s.key === memberFeeds.SOURCE_KEY) {
      lines.push('- ' + (s.name || s.key) + ': ' + (s.status === 'active' ? s.health_state : s.status) + (s.last_fetched != null && s.status === 'active' ? ' (last run ' + s.last_fetched + ' events)' : ''));
    }
  }
  lines.push('');
  lines.push('Approved partners: ' + (a.partners || []).length);
  for (const p of a.partners || []) {
    const ev = p.events || {};
    lines.push('- ' + (p.name || p.organization_id) + ': ' + (ev.upcoming || 0) + ' upcoming, ' + (ev.discoverable || 0) + ' public'
      + (p.last_sync ? '; last sync ' + p.last_sync.outcome + ' on ' + day(p.last_sync.at) : '; not synced yet')
      + (p.consent && p.consent !== 'recorded' ? '; consent ' + p.consent : ''));
  }
  const section = (title, list) => { if (!list.length) return; lines.push(''); lines.push(title); list.forEach((f) => lines.push('- ' + f.message + (f.action ? ' Next step: ' + f.action : ''))); };
  section('Needs you:', actions);
  section('Waiting for admin review:', by('admin_review'));
  section('Worth a look:', by('investigate'));
  section('Handled automatically:', by('automatic'));
  if (!(a.findings || []).length) { lines.push(''); lines.push('No issues found.'); }
  const subject = 'Advantage.Bid event import oversight: ' + (actions.length ? actions.length + ' need' + (actions.length === 1 ? 's' : '') + ' you' : a.overall === 'OK' ? 'all clear' : 'attention');
  return { subject, text: lines.join('\n') };
}

const AUDIT_ENTITY_ID = '00000000-0000-4000-8000-0000000000e1';   // the event import scheduler's audit entity

/**
 * Record this assessment in the history (audit_log) and return the owner actions that are NEW since the
 * previous recorded assessment, so a standing problem is alerted once, not every hour. Never throws.
 */
async function recordAssessment(db = db0, a) {
  const actions = ownerActions(a);
  let previous = [];
  try {
    const row = (await db.query(
      `SELECT metadata FROM audit_log WHERE event_type = 'event_import_oversight' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    previous = (row && row.metadata && row.metadata.action_keys) || [];
  } catch (_) { previous = []; }
  try {
    await db.query(
      `INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ('event_import_oversight', 'event_import_scheduler', $1, NULL, $2::jsonb)`,
      [AUDIT_ENTITY_ID, JSON.stringify({ overseer: OVERSEER.code, overall: a.overall, action_keys: actions.map((x) => x.key),
        findings: (a.findings || []).map((f) => ({ code: f.code, owner: f.owner, partner: f.partner || null, source: f.source || null })),
        partners: (a.partners || []).map((p) => ({ name: p.name, upcoming: (p.events || {}).upcoming || 0, discoverable: (p.events || {}).discoverable || 0,
          last_sync: p.last_sync ? p.last_sync.outcome : null })) })]);
  } catch (_) { /* history is best-effort; oversight never breaks the importer */ }
  return actions.filter((x) => !previous.includes(x.key));
}

module.exports = { OVERSEER, MAY, MUST_NOT, THRESHOLDS, IMPORTER_IDENTITY, assess, assessFeed, assessEvents, assessSource, assessFormerPartners, overallOf,
  ownerActions, buildReport, recordAssessment, _sql: { EVENT_STATS_SQL } };

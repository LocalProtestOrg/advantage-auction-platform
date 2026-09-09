'use strict';

/**
 * marketingMemRunner — a focused in-memory fake `runner` for the Wave 2 channel executors, following the repo's
 * established regex-over-store test pattern. It understands exactly the SQL statements the executors issue
 * against the Wave 2 tables (placement reservations/evidence, email editions/cards, dedicated sends, social
 * jobs, performance facts) plus the suppression/deliverability reads used by eligibility. Deterministic; no
 * clock, no Postgres. Seed via `store` before a test and assert on `store` after.
 */

function makeStore() {
  return {
    reservations: [], placementEvidence: [], editions: [], cards: [], dedicated: [], social: [], socialSnapshots: [], perfFacts: [],
    obs: [], events: [], allocations: [], allocEntries: [],
    purchases: {}, promotions: {}, readiness: [],
    suppressions: [], deliverability: {}, _seq: 0,
  };
}

const TERMINAL_OK = ['completed', 'substituted', 'made_good'];

// Column extractor for `INSERT INTO t (a,b,c) VALUES (...) ... RETURNING *`.
function insertColumns(sql) {
  const m = /INSERT INTO \w+\s*\(([^)]*)\)/i.exec(sql);
  return m ? m[1].split(',').map((c) => c.trim()) : [];
}
// Extract the first VALUES(...) tuple's tokens (top-level comma split; no nested parens in our SQL).
function valueTokens(sql) {
  const m = /VALUES\s*\(([^)]*)\)/i.exec(sql);
  return m ? m[1].split(',').map((t) => t.trim()) : [];
}
// Map columns to values by ALIGNING with the VALUES tokens, so inline literals ('shared', 1, false) and
// casts ($4::jsonb) map correctly rather than shifting positional params.
function rowFromInsert(sql, params, store, defaults = {}) {
  const cols = insertColumns(sql);
  const toks = valueTokens(sql);
  const row = { id: 'row_' + (++store._seq), _o: store._seq, ...defaults };
  cols.forEach((c, i) => {
    const tok = toks[i];
    if (tok === undefined) return;
    const pm = /^\$(\d+)/.exec(tok);
    if (pm) { row[c] = params[Number(pm[1]) - 1]; return; }
    let lit = tok.replace(/::[a-z]+/i, '');
    if (lit === 'true') row[c] = true; else if (lit === 'false') row[c] = false;
    else if (/^'.*'$/.test(lit)) row[c] = lit.slice(1, -1);
    else if (/^\d+$/.test(lit)) row[c] = Number(lit);
    else row[c] = lit;
  });
  return row;
}

function makeRunner(store) {
  return {
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();

      // ── Owned placement ──
      if (/SELECT slot_index FROM marketing_placement_reservations/.test(s)) {
        const [feature, startAt, endAt, exclude] = params;
        const rows = store.reservations.filter((r) =>
          r.feature_key === feature && ['reserved', 'active'].includes(r.status) &&
          (!exclude || r.id !== exclude) &&
          new Date(r.start_at) < new Date(endAt) && (!r.end_at || new Date(r.end_at) > new Date(startAt)))
          .map((r) => ({ slot_index: r.slot_index }));
        return { rows };
      }
      if (/INSERT INTO marketing_placement_reservations/.test(s)) {
        const row = rowFromInsert(s, params, store, { status: 'reserved' });
        store.reservations.push(row); return { rows: [row] };
      }
      if (/UPDATE marketing_placement_reservations SET status='active'/.test(s)) {
        const r = store.reservations.find((x) => x.id === params[0] && x.status === 'reserved');
        if (r) { r.status = 'active'; r.activated_at = params[1]; }
        return { rows: r ? [r] : [] };
      }
      if (/INSERT INTO marketing_placement_evidence/.test(s)) {
        const row = rowFromInsert(s, params, store, { impressions: 0, clicks: 0 });
        store.placementEvidence.push(row); return { rows: [row] };
      }
      if (/UPDATE marketing_placement_evidence SET impressions/.test(s)) {
        const ev = store.placementEvidence.filter((e) => e.reservation_id === params[0]);
        ev.forEach((e) => { e.impressions = (e.impressions || 0) + params[1]; e.clicks = (e.clicks || 0) + params[2];
          e.last_seen_at = params[3]; const days = Math.ceil((new Date(params[3]) - new Date(e.first_seen_at)) / 86400000);
          e.days = Math.max(e.days || 0, days); });
        return { rows: [] };
      }
      if (/SELECT reservation_id, first_seen_at.*FROM marketing_placement_evidence/.test(s)) {
        const rows = store.placementEvidence.filter((e) => e.obligation_id === params[0] && e.shadow === false)
          .sort((a, b) => (b._o || 0) - (a._o || 0));
        return { rows: rows.slice(0, 1) };
      }
      if (/SUM\(impressions\).*FROM marketing_placement_evidence WHERE obligation_id=\$1 AND shadow=false/.test(s)) {
        const ev = store.placementEvidence.filter((e) => e.obligation_id === params[0] && e.shadow === false);
        return { rows: [{ imp: ev.reduce((a, e) => a + (e.impressions || 0), 0), clk: ev.reduce((a, e) => a + (e.clicks || 0), 0), seen: ev.some((e) => e.first_seen_at) }] };
      }

      // ── Shared email ──
      if (/count\(\*\)::int AS n FROM marketing_email_editions WHERE kind='shared'/.test(s)) {
        const n = store.editions.filter((e) => e.kind === 'shared' && e.market === params[0] && e.week_key === params[1]).length;
        return { rows: [{ n }] };
      }
      if (/INSERT INTO marketing_email_editions/.test(s)) {
        const existing = store.editions.find((e) => e.edition_id === params[0]);
        if (existing) { existing.status = params[3]; return { rows: [existing] }; }
        const row = rowFromInsert(s, params, store, { delivered_count: 0 });
        store.editions.push(row); return { rows: [row] };
      }
      if (/INSERT INTO marketing_email_edition_cards/.test(s)) {
        const dup = store.cards.find((c) => c.edition_id === params[0] && c.auction_id === params[2]);
        if (dup) return { rows: [dup] };
        const row = rowFromInsert(s, params, store, { delivered: 0, clicks: 0 });
        store.cards.push(row); return { rows: [row] };
      }
      if (/UPDATE marketing_email_editions SET status=\$2, delivered_count/.test(s)) {
        const e = store.editions.find((x) => x.edition_id === params[0]);
        if (e) { e.status = params[1]; e.delivered_count = params[2]; e.sent_at = params[3]; }
        return { rows: [] };
      }
      if (/UPDATE marketing_email_edition_cards SET delivered=\$3/.test(s)) {
        const c = store.cards.find((x) => x.edition_id === params[0] && x.auction_id === params[1]);
        if (c) c.delivered = params[2]; return { rows: [] };
      }
      if (/SELECT \* FROM marketing_email_editions WHERE edition_id=\$1/.test(s)) {
        const e = store.editions.find((x) => x.edition_id === params[0]); return { rows: e ? [e] : [] };
      }
      if (/UPDATE marketing_email_editions SET status='reconciled'/.test(s)) {
        const e = store.editions.find((x) => x.edition_id === params[0]); if (e) e.status = 'reconciled'; return { rows: [] };
      }
      if (/FROM marketing_email_edition_cards c JOIN marketing_email_editions e/.test(s)) {
        const c = store.cards.filter((x) => x.obligation_id === params[0]).slice(-1)[0];
        if (!c) return { rows: [] };
        const e = store.editions.find((x) => x.edition_id === c.edition_id) || {};
        return { rows: [{ delivered: c.delivered, clicks: c.clicks, shadow: e.shadow }] };
      }

      // ── Dedicated email ──
      if (/count\(\*\)::int n FROM marketing_dedicated_sends WHERE sent_at/.test(s)) {
        const since = params[0];
        const n = store.dedicated.filter((d) => d.sent_at && new Date(d.sent_at) >= new Date(since) && ['sent_shadow', 'queued_shadow', 'reconciled'].includes(d.status)).length;
        return { rows: [{ n }] };
      }
      if (/count\(\*\)::int n FROM marketing_dedicated_sends d JOIN marketing_obligations o/.test(s)) {
        const since = params[0];
        const n = store.dedicated.filter((d) => d.sent_at && new Date(d.sent_at) >= new Date(since) && ['sent_shadow', 'queued_shadow', 'reconciled'].includes(d.status)).length;
        return { rows: [{ n }] };
      }
      if (/INSERT INTO marketing_dedicated_sends/.test(s)) {
        const row = rowFromInsert(s, params, store); store.dedicated.push(row); return { rows: [row] };
      }

      // ── Social ──
      if (/SELECT \* FROM marketing_social_jobs WHERE \(\(\$1::uuid IS NOT NULL AND obligation_id=\$1::uuid\)/.test(s)) {
        // replay guard: (obligation | null-obligation + subject id) + wave + platform (NULL platform = legacy match)
        const [obId, wave, platform, subjectId] = params;
        const rows = store.social.filter((j) => (obId != null ? j.obligation_id === obId : (j.obligation_id == null && String(j.auction_id) === String(subjectId)))
          && j.wave === wave && (j.platform === platform || j.platform == null));
        return { rows: rows.slice(-1) };
      }
      if (/INSERT INTO marketing_social_jobs/.test(s)) {
        const row = rowFromInsert(s, params, store, { attempts: 1 }); store.social.push(row); return { rows: [row] };
      }
      if (/UPDATE marketing_social_jobs SET status='blocked'/.test(s)) {
        const j = store.social.find((x) => x.id === params[0]); if (j) j.status = 'blocked'; return { rows: [] };
      }
      if (/UPDATE marketing_social_jobs SET status='failed'/.test(s)) {
        const j = store.social.find((x) => x.id === params[0]); if (j) j.status = 'failed'; return { rows: [] };
      }
      if (/UPDATE marketing_social_jobs SET status=\$6/.test(s)) { // parameterized published/published_shadow
        const j = store.social.find((x) => x.id === params[0]);
        if (j) { j.status = params[5]; j.post_id = params[1]; j.permalink = params[2]; j.published_at = params[3]; j.proof = params[4]; j.shadow = params[6]; }
        return { rows: j ? [j] : [] };
      }
      if (/UPDATE marketing_social_jobs SET status='published_shadow'/.test(s)) { // legacy literal form
        const j = store.social.find((x) => x.id === params[0]);
        if (j) { j.status = 'published_shadow'; j.post_id = params[1]; j.permalink = params[2]; j.published_at = params[3]; j.proof = params[4]; }
        return { rows: j ? [j] : [] };
      }
      if (/count\(\*\) FILTER .*FROM marketing_social_jobs WHERE obligation_id=\$1/.test(s)) {
        const jobs = store.social.filter((j) => j.obligation_id === params[0]);
        return { rows: [{ real_pub: jobs.filter((j) => j.status === 'published' && j.shadow === false).length,
                          any_pub: jobs.filter((j) => j.status === 'published_shadow' || j.status === 'published').length }] };
      }
      if (/SELECT ms\.metrics FROM marketing_social_metric_snapshots ms JOIN marketing_social_jobs j/.test(s)) {
        const ids = store.social.filter((j) => j.obligation_id === params[0] && j.shadow === false).map((j) => j.id);
        return { rows: (store.socialSnapshots || []).filter((x) => ids.includes(x.social_job_id)).map((x) => ({ metrics: x.metrics })) };
      }

      // ── Performance facts ──
      if (/INSERT INTO marketing_performance_facts/.test(s)) {
        const row = rowFromInsert(s, params, store); store.perfFacts.push(row); return { rows: [row] };
      }
      if (/FROM marketing_dedicated_sends WHERE obligation_id=\$1/.test(s)) {
        const d = store.dedicated.filter((x) => x.obligation_id === params[0]).slice(-1);
        return { rows: d };
      }

      // ── Obligations (marketingObligationEngine) ──
      if (/INSERT INTO marketing_obligations \(purchase_kind, purchase_id, auction_id, obligation_key, feature_key/.test(s)) {
        const [pk, pid, aid, okey, fkey, label, category, channel, ladder, wave] = params;
        if (store.obs.find((o) => o.purchase_kind === pk && o.purchase_id === pid && o.obligation_key === okey)) return { rows: [] };
        const row = { id: 'ob_' + (++store._seq), purchase_kind: pk, purchase_id: pid, auction_id: aid, obligation_key: okey,
          feature_key: fkey, label, category, channel, ladder_id: ladder, wave, state: 'planned', attempts: 0 };
        store.obs.push(row); return { rows: [row] };
      }
      if (/SELECT \* FROM marketing_obligations WHERE purchase_kind = \$1 AND purchase_id = \$2/.test(s)) {
        const rows = store.obs.filter((o) => o.purchase_kind === params[0] && o.purchase_id === params[1])
          .sort((a, b) => (a.category + a.obligation_key).localeCompare(b.category + b.obligation_key));
        return { rows };
      }
      if (/SELECT state, auction_id, purchase_id, purchase_kind FROM marketing_obligations WHERE id=\$1/.test(s)) {
        const o = store.obs.find((x) => x.id === params[0]); return { rows: o ? [o] : [] };
      }
      if (/SELECT state FROM marketing_obligations WHERE id ?= ?\$1/.test(s)) {
        const o = store.obs.find((x) => x.id === params[0]); return { rows: o ? [{ state: o.state }] : [] };
      }
      if (/SELECT \* FROM marketing_obligations WHERE id = \$1/.test(s)) {
        const o = store.obs.find((x) => x.id === params[0]); return { rows: o ? [o] : [] };
      }
      if (/UPDATE marketing_obligations SET state = \$2, previous_state = state/.test(s)) { // transition
        const o = store.obs.find((x) => x.id === params[0]); if (!o) return { rows: [] };
        o.previous_state = o.state; o.state = params[1];
        if (params[2]) o.proof = params[2]; if (params[3]) o.notes = params[3]; if (params[4]) o.campaign_id = params[4];
        if (params[5]) o.terminal_at = '2026-09-07T00:00:00Z';
        return { rows: [o] };
      }
      if (/UPDATE marketing_obligations SET state='blocked'/.test(s)) {
        const o = store.obs.find((x) => x.id === params[0]); if (!o) return { rows: [] };
        o.previous_state = o.state; o.state = 'blocked'; o.blocked_reason = params[1]; o.retry_after = params[2]; o.attempts = (o.attempts || 0) + 1;
        return { rows: [o] };
      }
      if (/UPDATE marketing_obligations SET state='needs_owner'/.test(s)) {
        const o = store.obs.find((x) => x.id === params[0]); if (!o) return { rows: [] };
        o.previous_state = o.state; o.state = 'needs_owner'; o.needs_owner_reason = params[1]; o.needs_owner_options = params[2];
        return { rows: [o] };
      }
      if (/UPDATE marketing_obligations SET state='substituted'/.test(s)) {
        const o = store.obs.find((x) => x.id === params[0]); if (o) { o.state = 'substituted'; o.notes = params[1] || o.notes; } return { rows: o ? [o] : [] };
      }
      if (/INSERT INTO marketing_obligations \(purchase_kind, purchase_id, auction_id, obligation_key, label, category, channel, state, substitution_of/.test(s)) {
        const row = { id: 'ob_' + (++store._seq), purchase_kind: params[0], purchase_id: params[1], auction_id: params[2],
          obligation_key: params[3], label: params[4], category: params[5], channel: params[6], state: 'planned', substitution_of: params[7] };
        store.obs.push(row); return { rows: [row] };
      }
      if (/INSERT INTO marketing_obligation_events/.test(s)) {
        store.events.push({ obligation_id: params[0], from_state: params[1], to_state: params[2] }); return { rows: [] };
      }

      // ── Paid allocation ledger ──
      if (/FROM marketing_package_purchases WHERE id=\$1/.test(s)) {
        const p = store.purchases[params[0]]; return { rows: p ? [p] : [] };
      }
      if (/FROM marketing_additional_promotions WHERE id=\$1/.test(s)) {
        const p = store.promotions[params[0]]; return { rows: p ? [p] : [] };
      }
      if (/INSERT INTO marketing_paid_allocations/.test(s)) {
        const [pk, pid, ceiling, pv] = params;
        if (!store.allocations.find((a) => a.purchase_kind === pk && a.purchase_id === pid))
          store.allocations.push({ id: 'al_' + (++store._seq), purchase_kind: pk, purchase_id: pid, ceiling_cents: ceiling, policy_version: pv, reserved_cents: 0, spent_cents: 0, released_cents: 0 });
        return { rows: [] };
      }
      if (/SELECT \* FROM marketing_paid_allocations WHERE purchase_id=\$1/.test(s)) {
        const a = store.allocations.find((x) => x.purchase_id === params[0]); return { rows: a ? [a] : [] };
      }
      if (/INSERT INTO marketing_paid_allocation_entries/.test(s)) {
        const idem = params[params.length - 1];
        if (store.allocEntries.find((e) => e.idempotency_key === idem)) return { rows: [] }; // ON CONFLICT DO NOTHING
        const et = (/'(RESERVE|SPEND|RELEASE)'/.exec(s) || [])[1] || null; // entry_type is an inline literal
        const entry = { id: 'en_' + (++store._seq), purchase_id: params[1], entry_type: et, amount_cents: params[2], idempotency_key: idem };
        store.allocEntries.push(entry); return { rows: [{ id: entry.id }] };
      }
      if (/UPDATE marketing_paid_allocations SET reserved_cents = reserved_cents \+ \$2/.test(s)) { // reserve (ceiling-guarded)
        const a = store.allocations.find((x) => x.purchase_kind === params[0] && x.purchase_id === params[2]);
        if (!a) return { rows: [] };
        if (a.reserved_cents + a.spent_cents + params[1] > a.ceiling_cents) return { rows: [] }; // ceiling race → no row
        a.reserved_cents += params[1]; return { rows: [a] };
      }
      if (/spent_cents = spent_cents \+ \$2/.test(s)) { // spend
        const a = store.allocations.find((x) => x.purchase_kind === params[0] && x.purchase_id === params[2]);
        if (!a) return { rows: [] };
        a.reserved_cents = Math.max(0, a.reserved_cents - params[1]); a.spent_cents += params[1]; return { rows: [a] };
      }
      if (/released_cents = released_cents \+ \$2/.test(s)) { // release
        const a = store.allocations.find((x) => x.purchase_kind === params[0] && x.purchase_id === params[2]);
        if (!a) return { rows: [] };
        a.reserved_cents = Math.max(0, a.reserved_cents - params[1]); a.released_cents += params[1]; return { rows: [a] };
      }
      if (/SELECT entry_type, COALESCE\(SUM\(amount_cents\)/.test(s)) {
        const by = {}; store.allocEntries.filter((e) => e.purchase_id === params[0]).forEach((e) => { by[e.entry_type] = (by[e.entry_type] || 0) + e.amount_cents; });
        return { rows: Object.entries(by).map(([entry_type, s2]) => ({ entry_type, s: s2 })) };
      }

      // ── Desktop bridge aggregates (runtime export) ──
      if (/SELECT state, count\(\*\)::int n FROM marketing_obligations GROUP BY state/.test(s)) {
        const by = {}; store.obs.forEach((o) => { by[o.state] = (by[o.state] || 0) + 1; });
        return { rows: Object.entries(by).map(([state, n]) => ({ state, n })) };
      }
      if (/AVG\(attempts\).*FROM marketing_obligations/.test(s)) {
        const at = store.obs.map((o) => o.attempts || 0);
        return { rows: [{ avg_attempts: at.length ? at.reduce((a, b) => a + b, 0) / at.length : 0, max_attempts: at.length ? Math.max(...at) : 0 }] };
      }
      if (/FROM marketing_obligation_events WHERE rung IS NOT NULL GROUP BY rung/.test(s)) {
        return { rows: [] };
      }
      if (/count\(\*\)::int n FROM marketing_obligations WHERE state='substituted'/.test(s)) {
        return { rows: [{ n: store.obs.filter((o) => o.state === 'substituted').length }] };
      }
      if (/SELECT channel_key, state FROM marketing_channel_readiness/.test(s)) {
        return { rows: store.readiness.map((x) => ({ channel_key: x.channel_key, state: x.state })) };
      }
      if (/INSERT INTO marketing_runtime_exports/.test(s)) { return { rows: [] }; }
      if (/INSERT INTO marketing_desktop_messages/.test(s)) { return { rows: [{ id: 'dm_' + (++store._seq) }] }; }

      // ── Channel readiness ──
      if (/SELECT state FROM marketing_channel_readiness WHERE channel_key=\$1/.test(s)) {
        const rr = store.readiness.find((x) => x.channel_key === params[0]); return { rows: rr ? [{ state: rr.state }] : [] };
      }
      if (/SELECT channel_key, state, owner_action_required, fallback_ladder FROM marketing_channel_readiness/.test(s)) {
        return { rows: store.readiness };
      }

      // ── Suppression / deliverability (eligibility authority) ──
      if (/SELECT reason FROM email_suppressions WHERE normalized_email/.test(s)) {
        const sup = store.suppressions.find((x) => x.normalized_email === params[0]);
        return { rows: sup ? [{ reason: sup.reason }] : [], rowCount: sup ? 1 : 0 };
      }
      if (/FROM email_deliverability/.test(s)) {
        const d = store.deliverability[params[0]];
        return { rows: d ? [d] : [] };
      }

      return { rows: [] };
    },
  };
}

module.exports = { makeStore, makeRunner };

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
    reservations: [], placementEvidence: [], editions: [], cards: [], dedicated: [], social: [], perfFacts: [],
    obligations: {}, suppressions: [], deliverability: {}, _seq: 0,
  };
}

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
      if (/SELECT \* FROM marketing_social_jobs WHERE obligation_id=\$1 AND wave=\$2/.test(s)) {
        const rows = store.social.filter((j) => j.obligation_id === params[0] && j.wave === params[1]);
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
      if (/UPDATE marketing_social_jobs SET status='published_shadow'/.test(s)) {
        const j = store.social.find((x) => x.id === params[0]);
        if (j) { j.status = 'published_shadow'; j.post_id = params[1]; j.permalink = params[2]; j.published_at = params[3]; j.proof = params[4]; }
        return { rows: j ? [j] : [] };
      }
      if (/count\(\*\) FILTER .*FROM marketing_social_jobs WHERE obligation_id=\$1/.test(s)) {
        const jobs = store.social.filter((j) => j.obligation_id === params[0]);
        return { rows: [{ real_pub: jobs.filter((j) => j.status === 'published_shadow' && j.shadow === false).length,
                          any_pub: jobs.filter((j) => j.status === 'published_shadow').length }] };
      }

      // ── Performance facts ──
      if (/INSERT INTO marketing_performance_facts/.test(s)) {
        const row = rowFromInsert(s, params, store); store.perfFacts.push(row); return { rows: [row] };
      }
      if (/FROM marketing_dedicated_sends WHERE obligation_id=\$1/.test(s)) {
        const d = store.dedicated.filter((x) => x.obligation_id === params[0]).slice(-1);
        return { rows: d };
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

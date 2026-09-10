'use strict';

/**
 * creativeReference/packet2 — the Owner review page for the Phase 3P.1 + 3P.2 proving grounds (one page, no publishing).
 * Per class: the new candidates first (structure + copy profile named), the previous creatives beside them, then the
 * numbers the Owner's feedback was about — logo box + feed-proxy measures, co-brand weight, event-type ratio, coverage and
 * void, physical audit, red elements, copy blocks, distances to every reference (Golds marked) and to the Owner's
 * negative signatures, the media trail, the claim checks. His words go back through the feedback record model.
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rel = (dir, p) => (p ? path.relative(dir, p).replace(/\\/g, '/') : '');

function card(dir, r) {
  const m = r.metrics || {}; const pr = (m.prominence || {}).checks || {}; const et = (m.event_type || {}).checks || {}; const cov = m.coverage || {};
  const nearest = r.similarity && r.similarity.max_reference; const neg = r.negative_signature_check && r.negative_signature_check.nearest;
  const status = r.extreme ? 'CALIBRATION EXTREME — NOT FOR PUBLICATION' : 'HELD FOR OWNER REVIEW';
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
  return `<div class="card ${r.extreme ? 'extreme' : ''}">
  <div class="img"><a href="${esc(rel(dir, r.png))}"><img src="${esc(rel(dir, r.png))}" alt="${esc(r.key + ' ' + r.format)}"></a></div>
  <div class="meta"><div class="tag">${esc(r.key)} · ${esc(r.format)} · ${esc(r.structure || '')} · ${esc(r.profile || '')}</div>
  <div class="status">${esc(status)}</div>
  <table>
  ${row('Decision / score', `<b>${esc(r.decision)}</b> · ${esc(r.score)} (bar ${esc(r.bar)}) · ${esc(r.score_basis || '')}`)}
  ${r.hard_failures && r.hard_failures.length ? row('Blocking', esc(r.hard_failures.map((h) => h.gate).join(', '))) : ''}
  ${r.regenerate_violations && r.regenerate_violations.length ? row('Regenerate', esc(r.regenerate_violations.map((h) => h.gate).join(', '))) : ''}
  ${row('Logo', `${esc(pr.logo_width_pct != null ? pr.logo_width_pct + '% of width' : '')} ${pr.logo_height_feed_px != null ? '· ' + esc(pr.logo_height_feed_px) + 'px at 240px feed' : ''} ${pr.weight_ratio != null ? '· co-brand weight ' + esc(pr.weight_ratio) : ''} · source ${r.logo_qa && r.logo_qa.logo_source && r.logo_qa.logo_source.pass_ ? 'official asset ✓' : '✗'} · elsewhere ${r.logo_qa && r.logo_qa.rendered_logo_elsewhere && r.logo_qa.rendered_logo_elsewhere.pass_ ? 'none ✓' : '✗'}`)}
  ${row('Band wordmark', esc(pr.band_wordmark_cap_pct != null ? pr.band_wordmark_cap_pct + '% cap height · feed legible ' + pr.feed_proxy_wordmark_ocr : ''))}
  ${et.ratio_to_largest != null ? row('Event type', esc(`${et.ratio_to_largest}× largest text · ${et.pct_of_canvas}% of canvas height`)) : ''}
  ${row('Coverage / void', esc(`${cov.coverage_pct}% of field · void ${cov.largest_accidental_void_pct}%`))}
  ${row('Physical audit', esc(((m.physical_violations || []).length ? (m.physical_violations || []).map((v) => v.kind).join(', ') : (r.plan ? '0 violations' : 'n/a (photograph)'))))}
  ${row('Colour', esc(`${(m.colour || {}).red_elements} red elements · light ${(m.colour || {}).canvas_luminance}`))}
  ${row('Copy blocks', esc(`${(r.density || {}).blocks} / ${(r.density || {}).ceiling} (${r.profile})`))}
  ${row('Nearest reference', esc(nearest ? nearest.id + ' at ' + nearest.distance : 'n/a'))}
  ${row('Nearest negative', esc(neg ? neg.id + ' at ' + neg.distance : 'none for this class'))}
  ${r.judge && r.judge.available ? row('Judge v2', esc(`${r.judge.points}/40 · through=${r.judge.physical_yes.through ? 'YES' : 'no'} · wrong size=${r.judge.physical_yes.wrong_size ? 'YES' : 'no'} · platform=${r.judge.comprehension.platform_ok ? 'named' : 'not named'}`)) : row('Judge v2', esc((r.judge && r.judge.reason) || 'unavailable'))}
  ${r.notes ? row('Note', esc(r.notes)) : ''}
  </table></div></div>`;
}

function writeReview(dir, packets, extra = {}) {
  const sections = packets.map((pk) => {
    const prev = (pk.previous || []).map((p) => `<figure><img src="${esc(rel(dir, p.png))}"><figcaption>${esc(p.label)}</figcaption></figure>`).join('');
    const md = pk.media_decision;
    const media = md ? `<details open><summary>Media trail — tier ${esc(md.tier_selected)} · ${esc(md.collage_reason)}</summary><table class="trail"><tr><th>Asset</th><th>Tier</th><th>Ready</th><th>Score</th><th>Gates</th><th>Judge (clutter / invitation)</th></tr>
      ${(md.candidates || []).map((c) => `<tr><td>${esc(c.asset)}</td><td>${esc(c.tier)}</td><td>${c.ready ? 'yes' : 'no'}</td><td>${esc(c.score)}</td><td>${esc(Object.entries(c.gates || {}).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'all pass')}</td><td>${esc(c.judged && c.judged.clutter_items != null ? c.judged.clutter_items + ' / ' + c.judged.invitation : c.judged)}</td></tr>`).join('')}
      </table>${md.published_anchor ? `<p>Published anchor: ${esc(md.published_anchor.reason)} — used only to stay different from.</p>` : ''}</details>` : '';
    const blocked = (pk.blocked || []).length ? `<p class="blocked">Blocked before generation: ${esc(pk.blocked.map((b) => b.key + ' (' + b.rejections.map((r) => r.rule).join(', ') + ')').join('; '))}</p>` : '';
    const ret = pk.retrieval || {};
    return `<section><h2>${esc(pk.title)}</h2>
      <p class="sub">Class ${esc(pk.campaign_class)} · references ${esc((ret.retrieved || []).map((r) => r.reference_id + (r.owner_status === 'OWNER_GOLD_STANDARD' ? ' (Gold)' : '') + (r.imagery_only ? ' (imagery only)' : '')).join(', '))} · structures seen ${esc((ret.structures_seen || []).join(', '))} · accept bar ${esc(pk.bar)} · gates all OFF · nothing published</p>
      ${pk.deferred ? `<p class="deferred">${esc(pk.deferred)}</p>` : ''}${media}${blocked}
      <div class="grid">${(pk.results || []).filter((r) => r.ok).map((r) => card(dir, r)).join('')}</div>
      ${prev ? `<h3>Previous creatives (2026-09-09) for comparison</h3><div class="prev">${prev}</div>` : ''}
      ${(pk.omissions || []).length ? `<p class="omit">Omitted, not invented: ${esc(pk.omissions.join('; '))}</p>` : ''}</section>`;
  }).join('\n');
  const reg = extra.regression ? `<section><h2>Regression — the six 2026-09-09 renders under v2</h2><table class="trail"><tr><th>Render</th><th>Identical to stored</th><th>Outcome</th><th>Why</th></tr>
    ${extra.regression.map((r) => `<tr><td>${esc(r.key + ' ' + r.format)}</td><td>${r.identical ? 'yes' : 'NO'}</td><td>${esc(r.outcome)}</td><td>${esc(r.why)}</td></tr>`).join('')}</table></section>` : '';
  const refs = extra.references ? `<section><h2>References scored as candidates</h2><table class="trail"><tr><th>Ref</th><th>G11 (a reference is never a candidate)</th><th>Rendered logo detected</th><th>Template echo</th></tr>
    ${extra.references.map((r) => `<tr><td>${esc(r.reference_id)}</td><td>${esc(r.g11)}</td><td>${esc(r.logo)}</td><td>${esc(r.echo)}</td></tr>`).join('')}</table></section>` : '';
  const html = `<!doctype html><meta charset="utf-8"><title>Advantage.Bid — Phase 3P.1 + 3P.2 proving grounds (Owner review)</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1c2026;background:#fafaf8}h1{font-size:22px}h2{margin-top:36px;border-bottom:2px solid #182e45;padding-bottom:4px}
.sub,.omit,.deferred{color:#4a5b70}.deferred{background:#fff4d6;padding:8px 10px;border-radius:6px}.blocked{color:#b3261e}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(520px,1fr));gap:18px}.card{display:flex;gap:12px;background:#fff;border:1px solid #e3e6ea;border-radius:8px;padding:10px}
.card.extreme{border-color:#d62828}.img img{width:230px;border:1px solid #ddd}.meta{flex:1}.tag{font-weight:700}.status{color:#b3261e;font-size:12px;margin:2px 0 6px}
table{border-collapse:collapse;font-size:12px;width:100%}th{text-align:left;color:#4a5b70;font-weight:600;padding:2px 6px;vertical-align:top;width:120px}td{padding:2px 6px}
.trail td,.trail th{border-bottom:1px solid #eee}.prev{display:flex;gap:10px}.prev img{width:160px;border:1px solid #ddd}figure{margin:0}figcaption{font-size:11px;color:#4a5b70}</style>
<h1>Phase 3P.1 + 3P.2 proving grounds — Owner review</h1>
<p>Nothing here is published, sent, activated or paid for. Every candidate is held for your review; calibration extremes are marked on this page only (never on the canvas). Your words go back through the feedback ledger (GOOD / OK – needs work / NO, per attribute).</p>
${sections}${reg}${refs}`;
  const out = path.join(dir, 'review.html'); fs.writeFileSync(out, html); return out;
}

module.exports = { writeReview };

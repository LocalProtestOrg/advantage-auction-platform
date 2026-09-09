'use strict';

/**
 * creativeReference/packet — the Owner-facing review artifact (HTML + JSON) for proving grounds. Visual first:
 * A / B / C renders with thumbnails, the published graphic beside for comparison (labelled external, not generated),
 * then per-candidate facts: family, references used, principles applied, score breakdown, spatial/family audit,
 * anti-similarity, seller-mark leak, provenance, factual QA, publication status. No database ids required to read it.
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rel = (from, to) => path.relative(from, to).replace(/\\/g, '/');

function candidateCard(dir, r, packet) {
  if (!r.ok) return `<div class="card fail"><h3>${esc(r.key)} · ${esc(r.format)}</h3><p>Render failed: ${esc(r.error)}</p></div>`;
  const m = r.metrics || {};
  const judge = r.judge && r.judge.available ? `${r.judge.average} / 40 (runs ${r.judge.runs.map((x) => x.total).join(' & ')}${r.judge.flagged ? ' — disagreement flagged' : ''})` : `unavailable (${esc(r.judge && r.judge.reason)})`;
  const sim = r.similarity || {};
  const rows = [
    ['Campaign family', packet.campaign_class], ['Visual family', r.family + (r.extreme ? ' — CALIBRATION EXTREME' : '')],
    ['References used', (r.references_used || []).join(', ') || 'none (empty class — global profile at 0.25)'],
    ['Transferable principles applied', (r.principles_applied || []).map((p) => '• ' + esc(p)).join('<br>') || '—'],
    ['Calibration score', `<b>${r.score}</b> / 100 — ${esc(r.score_basis)}; measurable ${r.measurable.points}/60; judge ${judge}; bar ${r.bar}`],
    ['Measurable evidence', r.measurable.items.map((i) => `${i.key}: ${i.points == null ? 'n/a' : i.points + '/' + i.pts} (value ${typeof i.value === 'object' ? JSON.stringify(i.value) : i.value}; target ${typeof i.target === 'object' ? JSON.stringify(i.target) : i.target})`).join('<br>')],
    ['Spatial / family audit', r.audit.violations.length ? '<span class="bad">FAIL</span> ' + esc(r.audit.violations.join('; ')) : `<span class="ok">PASS</span> (${esc(r.audit.profile)} profile; merchandise ${m.merchandise_pct}%, text ${m.text_region_pct}%, ${m.text_blocks} copy blocks, largest empty ${m.largest_empty_pct}%, upper-half merchandise ${m.upper_half_merch_pct}%)`],
    ['Anti-similarity (G11)', (sim.pass ? '<span class="ok">PASS</span>' : '<span class="bad">FAIL</span>') + ` — nearest reference ${sim.max_reference ? sim.max_reference.id + ' at ' + sim.max_reference.distance : 'n/a'} (τ_ref ${sim.thresholds && sim.thresholds.tau_ref}); published anchor ${sim.published_anchor_distance == null ? 'n/a' : sim.published_anchor_distance + ' (τ_pub ' + sim.thresholds.tau_pub + ')'}; prior creatives ${sim.self_history_min ? sim.self_history_min.distance + ' (τ_self ' + sim.thresholds.tau_self + ')' : 'none yet'}`],
    ['Seller-mark leak (G12)', (r.leak.pass ? '<span class="ok">PASS</span>' : '<span class="bad">FAIL</span>') + ` — ${r.leak.hits.length} hit(s); OCR ${esc(r.leak.ocr)}; logo templates ${esc(r.leak.logo_template_match)}`],
    ['Merchandise provenance (G13)', (r.provenance.pass ? '<span class="ok">PASS</span>' : '<span class="bad">FAIL</span> ' + esc(r.provenance.reasons.join('; '))) + (r.assets && r.assets.length ? '<br>' + r.assets.map((a) => '• ' + esc(a)).join('<br>') : '')],
    ['Factual QA', (r.budget.pass ? 'text budget PASS' : '<span class="bad">text budget FAIL</span> ' + esc(r.budget.reasons.join('; '))) + '; every drawn string: ' + esc((r.drawn_text || []).join(' | '))],
    ['Decision', esc(r.decision) + (r.hard_failures.length ? ' — ' + esc(JSON.stringify(r.hard_failures)) : '')],
    ['Publication status', `<b>${esc(r.publication_status)}</b>`],
  ];
  return `<div class="card${r.extreme ? ' extreme' : ''}"><h3>${esc(r.key)} · ${esc(r.format)}${r.extreme ? ' · NOT FOR PUBLICATION' : ''}</h3>
  <a href="${esc(rel(dir, r.png))}" target="_blank"><img src="${esc(rel(dir, r.png))}" alt="${esc(r.key)}"></a>
  <table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</table></div>`;
}

function section(dir, packet) {
  const anchor = packet.anchor && packet.anchor.public_url ? `<div class="anchor"><h3>Currently published — external — not generated</h3><img src="${esc(packet.anchor.public_url)}" alt="published anchor"><p>Shown for comparison only. Never reused; scorer-only negative anchor (sha256 ${esc(String(packet.anchor.sha256 || '').slice(0, 16))}…).</p></div>` : '';
  const rt = packet.retrieval;
  return `<section><h2>${esc(packet.title)}</h2>
  <p class="meta">job ${esc(packet.job_id)} · class ${esc(packet.campaign_class)} · index ${esc(packet.index_version)} · retrieval confidence ${esc(rt.confidence)}${rt.empty_class ? ' · <b>ZERO class references — Owner review mandatory</b>' : ''} · seller concentration ${esc(rt.seller_concentration.dominant_seller)} ${Math.round(rt.seller_concentration.share * 100)}%${rt.strip_seller_identity ? ' (seller identity stripped)' : ''}</p>
  <p class="meta">Gates at run time: ${Object.entries(packet.gates).map(([k, v]) => `${esc(k.replace('marketing.', ''))}=${v}`).join(' · ')} · <b>nothing published</b></p>
  <p class="meta">References retrieved: ${rt.retrieved.map((r) => `${esc(r.reference_id)}${r.neutral ? ' (neutral, 0.25)' : ''}`).join(', ') || 'none'}${rt.excluded_by_avoid_for.length ? ' · excluded by avoid_for: ' + rt.excluded_by_avoid_for.join(', ') : ''}</p>
  ${packet.omissions && packet.omissions.length ? `<p class="meta"><b>Omitted for lack of a production fact:</b> ${packet.omissions.map(esc).join('; ')}</p>` : ''}
  <div class="grid">${packet.results.map((r) => candidateCard(dir, r, packet)).join('')}${anchor}</div></section>`;
}

function writeReview(dir, packets, { title = 'Phase 3P Proving Grounds — Owner Review' } = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#1f2937;margin:0;padding:1.2rem}h1{font-size:1.3rem}h2{font-size:1.1rem;margin-top:2rem;border-bottom:1px solid #d9dee5;padding-bottom:.3rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:1rem}.card{background:#fff;border:1px solid #e3e7ec;border-radius:8px;padding:.8rem}.card.extreme{border-color:#d62828}.card img,.anchor img{width:100%;height:auto;border:1px solid #e3e7ec;border-radius:4px}
table{width:100%;border-collapse:collapse;font-size:.78rem;margin-top:.6rem}th{text-align:left;vertical-align:top;width:34%;padding:.25rem .3rem;color:#4a5b70;border-bottom:1px solid #eef1f4}td{padding:.25rem .3rem;border-bottom:1px solid #eef1f4}
.ok{color:#166534;font-weight:600}.bad{color:#991b1b;font-weight:600}.meta{font-size:.82rem;color:#4a5b70}.anchor{background:#fff7f7;border:1px dashed #d62828;border-radius:8px;padding:.8rem}.note{background:#fff;border:1px solid #e3e7ec;border-radius:8px;padding:.8rem;font-size:.85rem}</style></head><body>
<h1>${esc(title)}</h1>
<div class="note">Every candidate below is <b>HELD FOR OWNER REVIEW</b>; calibration extremes are <b>NOT FOR PUBLICATION</b>. Nothing was published, no destination job exists, A9 and every destination gate were OFF at run time. Reference images never reached the generator — only transferable principles did. Tell Desktop Marketing or use the review action what you think in your own words ("good", "love this", "gold standard", "don't use this style", "come back 10% on the title").</div>
${packets.map((p) => section(dir, p)).join('')}
</body></html>`;
  fs.writeFileSync(path.join(dir, 'review.html'), html);
  return path.join(dir, 'review.html');
}

module.exports = { writeReview };

#!/usr/bin/env node
'use strict';
/**
 * Records the Owner decisions of the Phase 3P.1 + 3P.2 implementation mission (2026-09-11) through the append-only
 * Owner ledger (owner-decisions.jsonl) via feedbackLedger.appendDecision — the same mechanism every Owner decision uses.
 * Idempotent: a decision already present (same action + subject + words) is not appended twice. The indexer applies the
 * lines exactly once (line-hash ledger). The Owner never edits a file.
 *
 *   1. REF-20 and REF-21 promoted to OWNER_GOLD_STANDARD (explicit Owner words; nothing else inferred from filenames).
 *   2. REF-17 reclassified: its buyer-facing copy belongs to buyer_platform_growth / estate_sale; for
 *      individual_seller_acquisition it is imagery/layout evidence only (copy never retrieved there).
 *   3. Assisted-service pricing rule: availability only; pricing custom after evaluation; no percentage or fixed price.
 *      The Owner's internal estimate is deliberately NOT written anywhere (Owner: never expose or advertise it).
 */
const fs = require('fs');
const path = require('path');
const lib = require('../src/services/creativeReference/library');
const feedback = require('../src/services/creativeReference/feedbackLedger');

const ROOT = lib.LIBRARY_ROOT;
const SOURCE = 'owner_directive_via_vscode_mission';
const BY = 'VS Code — Phase 3P.1 + 3P.2 production implementation (Owner mission 2026-09-11)';

function sidecarByRef(id) {
  const { sidecars } = lib.listLibrary(ROOT);
  const sc = sidecars.find((s) => s.json && s.json.reference_id === id);
  if (!sc) throw new Error('reference not found: ' + id);
  return sc.json;
}
function existing() {
  const p = path.join(ROOT, 'owner-decisions.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean) : [];
}
function already(entry) {
  return existing().some((e) => e.action === entry.action && e.source === entry.source && JSON.stringify(e.resolved || {}) === JSON.stringify(entry.resolved || {}) && e.owner_words === entry.owner_words);
}
function append(entry) {
  if (already(entry)) { console.log('SKIP (already recorded):', entry.action, JSON.stringify(entry.resolved || entry.subject || {})); return null; }
  const r = feedback.appendDecision(entry, ROOT);
  console.log('RECORDED', entry.action, (entry.resolved && entry.resolved.reference_id) || (entry.subject && entry.subject.kind), r.hash.slice(0, 12));
  return r;
}

const GOLD_WORDS = 'REF-20 + REF-21 — The Owner explicitly promotes both Professional Seller references to: GOLD STANDARD. These are: REF-20, REF-21. Apply Gold Standard status through the proper immutable/reference-ledger mechanism. Do not infer Gold merely from filenames for any other file.';
for (const id of ['REF-20', 'REF-21']) {
  const j = sidecarByRef(id);
  append({ action: 'SET_STATUS', source: SOURCE, status: 'OWNER_GOLD_STANDARD', owner_words: GOLD_WORDS,
           resolved: { sha256: j.identity.sha256, reference_id: id }, recorded_by: BY });
}

const r17 = sidecarByRef('REF-17');
append({ action: 'RECLASSIFY', source: SOURCE,
         owner_words: 'REF-17 is NOT approved as Individual Seller acquisition copy. Its buyer-facing language belongs to Buyer Growth / Estate Sale promotional use. Its imagery/layout treatment may remain useful as visual evidence. Do not retrieve its buyer copy for seller-acquisition campaigns. Classify appropriately using the existing campaign-class/reference architecture.',
         resolved: { sha256: r17.identity.sha256, reference_id: 'REF-17' },
         payload: { campaign_class_primary: 'buyer_platform_growth', campaign_class_secondary: ['estate_sale', 'individual_seller_acquisition'], copy_restricted_classes: ['individual_seller_acquisition'],
                    content_reads_as: 'buyer_platform_growth / estate_sale promotional creative (Owner decision 2026-09-11): its buyer copy is never seller-acquisition copy; for individual_seller_acquisition it is imagery/layout evidence only' },
         recorded_by: BY });

append({ action: 'OWNER_RULE', schema: 'feedback-record.schema.json#1.0', source: SOURCE, subject: { kind: 'global_rule' },
         owner_words: 'Assisted service pricing: No fixed assisted-service price exists. No public percentage exists. [The Owner\'s internal estimate for some full-service arrangements is not a public price, contractual default, or marketing claim; by the Owner\'s instruction the figure is not recorded anywhere.] Production marketing may state availability only, such as: "Prefer us to run the sale? Ask about assisted service." Pricing remains custom after evaluation.',
         verdict: { overall: 'GLOBAL_RULE' }, attributes: [],
         rules: [{ rule: 'assisted_service_pricing_never_stated', scope: 'global', statement: 'Creative, landing, form, ad and report copy may state assisted-service AVAILABILITY only; any commission percentage or fixed price is rejected by the claim manifest; pricing is custom after evaluation.',
                   examples: ['Prefer us to run the sale? Ask about assisted service.', 'Hands-on help available in Houston and the NYC area'], config_ref: 'docs/marketing/phase3p2/config/paid-growth-policy.json#strategic_markets.assisted_service' }],
         recorded_by: BY });
console.log('done');

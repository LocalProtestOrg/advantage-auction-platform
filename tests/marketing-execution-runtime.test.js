'use strict';

/**
 * Phase 3O Marketing Package Execution Runtime + Desktop Marketing Operating Bridge.
 * Validates the schema pack + negative cases, the obligation state machine (append-only + terminal
 * immutability + BLOCKED/NEEDS_OWNER), the resilience ladder guard-skips, seller-payload leakage protection,
 * the anonymized Desktop bridge, QA gates G0-G9, paid-allocation ceiling, and the fulfillment monitor.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

const contract = require('../src/services/phase3oContract');
const qa = require('../src/services/marketingQaGateService');
const renderer = require('../src/services/sellerReportRenderer');
const ladders = require('../src/services/resilienceLadderService');
const alloc = require('../src/services/paidAllocationBridge');

// ── 1. Schema pack loads + validates; negative cases rejected (§24) ──
describe('Phase 3O schema pack', () => {
  test('16-schema pack loads: 32 features, 8 recipes, 11 ladders', () => {
    expect(contract.features().length).toBe(32);
    expect(contract.recipes().length).toBe(8);
    expect(Object.keys(contract.ladders()).length).toBeGreaterThanOrEqual(11);
  });
  test('valid interface_message passes', () => {
    const ok = contract.validate('interface_message', { message_id: 'm', direction: 'vs_to_desktop', type: 'RUNTIME_EXPORT', created_at: '2026-09-07T00:00:00Z', contract_version: '3O.1', body: {}, references: [], contains_production_credentials: false, contains_recipient_data: false });
    expect(ok.valid).toBe(true);
  });
  test('NEGATIVE: interface message containing credentials is rejected', () => {
    const r = contract.validate('interface_message', { message_id: 'm', direction: 'desktop_to_vs', type: 'CONFIG_PROPOSAL', created_at: '2026-09-07T00:00:00Z', contract_version: '3O.1', body: {}, references: [], contains_production_credentials: true, contains_recipient_data: false });
    expect(r.valid).toBe(false);
  });
  test('NEGATIVE: REFUND is not a permitted Director decision', () => {
    expect(contract.validate('director_decision', { decision_id: 'd', kind: 'REFUND', purchase_id: 'p', inputs_hash: 'h', authority_cents_remaining: 0, evidence_line: 'x', outputs: {}, at: '2026-09-07T00:00:00Z' }).valid).toBe(false);
    expect(contract.validate('director_decision', { decision_id: 'd', kind: 'SCHEDULE', purchase_id: 'p', inputs_hash: 'h', authority_cents_remaining: 0, evidence_line: 'x', outputs: {}, at: '2026-09-07T00:00:00Z' }).valid).toBe(true);
  });
  test('NEGATIVE: purchase snapshot without a payment_ref is rejected', () => {
    const base = { purchase_id: 'p', kind: 'package_purchase', identity: 'PREMIUM', version_id: 'v1', auction_id: 'a', amount_paid_cents: 24900, currency: 'USD', purchased_at: '2026-09-07T00:00:00Z', terms_snapshot: { non_refundable_sentence: 'Marketing packages and additional promotion are non-refundable.', seller_copy: {} }, deliverables_snapshot: [], discretionary_snapshot: [], policy_snapshot: { policy_version_id: 'v1', direct_capacity_pct: 60, growth_base_pct: 40 }, direct_authority_cents: 14940, growth_base_cents: 9960 };
    expect(contract.validate('purchase_snapshot', base).valid).toBe(false); // missing payment_ref
    expect(contract.validate('purchase_snapshot', { ...base, payment_ref: 'pi_1' }).valid).toBe(true);
  });
});

// ── 2. QA gates G0-G9 incl. non-CLEAN + confidential economics + REVIEW merchandise ──
describe('QA gates G0-G9', () => {
  test('G3 rejects non-CLEAN (REVIEW/FAILED) objects in a production brief', () => {
    expect(qa.g3_fidelity([{ fidelity: 'CLEAN' }, { fidelity: 'REVIEW' }]).pass).toBe(false);
    expect(qa.g3_fidelity([{ fidelity: 'CLEAN' }]).pass).toBe(true);
  });
  test('G1 rejects a brief without verified payment', () => {
    expect(qa.g1_payment({ status: 'pending' }).pass).toBe(false);
    expect(qa.g1_payment({ status: 'paid', stripe_payment_intent_id: 'pi_1' }).pass).toBe(true);
  });
  test('G5 rejects tracking/AI attribution in URLs; G8 rejects confidential economics; G9 rejects guarantee language', () => {
    expect(qa.g5_cleanUrls(['https://bid.advantage.bid/x?utm_source=y']).pass).toBe(false);
    expect(qa.g5_cleanUrls(['https://bid.advantage.bid/auction-view.html?auctionId=1']).pass).toBe(true);
    expect(qa.g8_sellerSafe('Your 60% direct spend ceiling and Growth Pool allocation').pass).toBe(false);
    expect(qa.g8_sellerSafe('Featured in an Advantage.Bid auction email').pass).toBe(true);
    expect(qa.g9_guarantee('We guarantee sales for your auction').pass).toBe(false);
  });
  test('G0 entitlement requires the feature to be in the snapshot', () => {
    const snap = { guaranteed_deliverables: [{ key: 'shared_email' }], discretionary_tools: [] };
    expect(qa.g0_entitlement({ feature_key: 'shared_email' }, snap).pass).toBe(true);
    expect(qa.g0_entitlement({ feature_key: 'dedicated_email' }, snap).pass).toBe(false);
  });
});

// ── 3. Resilience ladder guard-skips ──
describe('resilience ladder', () => {
  test('a rung that would violate consent/suppression/caps is SKIPPED, never forced', () => {
    const out = ladders.runLadder('L_shared_edition', { channel_active: false, suppressed: true }, { shadow: true });
    const skipped = out.trace.filter((t) => t.action === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
  });
  test('FULFILL is taken when channel is ACTIVE and guards pass', () => {
    const out = ladders.runLadder('L_placement_soft', { channel_active: true }, { shadow: false });
    expect(out.rung).toBe('FULFILL');
    expect(out.action).toBe('progress');
  });
  test('exhausted guards escalate (never the first response)', () => {
    const out = ladders.runLadder('L_dedicated', { channel_active: false, consent: false, suppressed: true, frequency_capped: true, health_budget_exhausted: true, authority_exhausted: true }, { shadow: true });
    expect(out.action).toBe('escalate');
  });
});

// ── 4. Seller payload leakage protection ──
describe('seller allowlist renderer', () => {
  const purchase = { package_key: 'premium', amount_paid_cents: 24900, purchased_at: '2026-09-07T00:00:00Z',
    guaranteed_deliverables: [{ key: 'shared_email', label: 'Featured in an Advantage.Bid auction email' }], discretionary_tools: [{ key: 'paid_local_boost', label: 'Paid local boost' }] };
  const obligations = [
    { obligation_key: 'shared_email', feature_key: 'shared_email', label: 'Featured in an Advantage.Bid auction email', category: 'guaranteed', state: 'substituted', terminal_at: '2026-09-08T00:00:00Z' },
    { obligation_key: 'paid_local_boost', feature_key: 'paid_local_boost', label: 'Paid local boost', category: 'discretionary', state: 'blocked' },
  ];
  test('never emits internal economics, substitution cause, or seller-invisible states', () => {
    const p = renderer.render(purchase, obligations);
    const json = JSON.stringify(p);
    expect(json).not.toMatch(/60%|40%|growth|ceiling|authority|margin|profit|provider|blocked|needs_owner|capacity|Director/i);
    // substituted renders as completed + a NEUTRAL note only (never the cause)
    const done = p.completed.find((c) => c.service.match(/auction email/));
    expect(done.note).toBe(renderer.SUB_NOTE);
    // discretionary is NOT a seller entitlement line
    expect(JSON.stringify(p.plan) + JSON.stringify(p.completed)).not.toMatch(/Paid local boost/);
  });
  test('renderer source uses an explicit allowlist (constructive), not a denylist', () => {
    const s = read('src', 'services', 'sellerReportRenderer.js');
    expect(s).toMatch(/ALLOWLIST/i);
    expect(s).not.toMatch(/internal_authority_cents|direct_fulfillment_bps|growth_pool/);
  });
});

// ── 5. Paid allocation ceiling ──
describe('paid allocation bridge', () => {
  test('cannot authorize spend beyond the confidential ceiling', () => {
    expect(alloc.canAuthorize(14940, 10000, 4940)).toBe(true);
    expect(alloc.canAuthorize(14940, 10000, 5000)).toBe(false);
  });
});

// ── 6. Obligation state machine: append-only + terminal immutability + NEEDS_OWNER SMS ──
describe('obligation state machine', () => {
  jest.resetModules();
  const store = { obligations: {}, events: [] };
  jest.doMock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));
  const smsSpy = jest.fn(async () => ({ sent: 2 }));
  jest.doMock('../src/services/ownerAlertService', () => ({ ALERT_TYPES: {}, notifyAdminActionRequired: smsSpy }));
  const runner = { query: async (sql, params) => {
    const s = String(sql);
    if (/SELECT state FROM marketing_obligations WHERE id/.test(s)) { const o = store.obligations[params[0]]; return { rows: o ? [{ state: o.state }] : [] }; }
    if (/SELECT state, auction_id/.test(s)) { const o = store.obligations[params[0]]; return { rows: o ? [o] : [] }; }
    if (/INSERT INTO marketing_obligation_events/.test(s)) { store.events.push({ obligation_id: params[0], to_state: params[2] }); return { rows: [] }; }
    if (/UPDATE marketing_obligations/.test(s)) { const o = store.obligations[params[0]]; if (o) { o.previous_state = o.state; o.state = /state='?([a-z_]+)/.exec(s) ? RegExp.$1 : (params[1] || o.state); if (/state = \$2/.test(s)) o.state = params[1]; } return { rows: o ? [o] : [] }; }
    return { rows: [] };
  } };
  const engine = require('../src/services/marketingObligationEngine');
  beforeEach(() => { store.obligations = { ob1: { id: 'ob1', state: 'planned', purchase_id: 'p1', purchase_kind: 'package', auction_id: 'a1', obligation_key: 'k' } }; store.events = []; smsSpy.mockClear(); });

  test('transition appends an event and records history', async () => {
    await engine.transition('ob1', 'creative_ready', {}, 'runtime', runner);
    expect(store.events.some((e) => e.to_state === 'creative_ready')).toBe(true);
  });
  test('terminal states are immutable (no transition out of completed)', async () => {
    store.obligations.ob1.state = 'completed';
    await expect(engine.transition('ob1', 'live', {}, 'runtime', runner)).rejects.toThrow(/immutable/);
  });
  test('needsOwner fires the certified Admin Action Required SMS and records the state', async () => {
    await engine.needsOwner('ob1', { reason: 'ladder exhausted', options: ['activate_channel'] }, runner);
    expect(smsSpy).toHaveBeenCalledTimes(1);
    expect(smsSpy.mock.calls[0][0].actionType).toBe('marketing_package_exception');
    expect(store.events.some((e) => e.to_state === 'needs_owner')).toBe(true);
  });
});

// ── 7. Desktop bridge: anonymized export + proposal validation/routing ──
describe('desktop bridge (source-level safety)', () => {
  test('runtime export declares no credentials/recipient data and asserts no PII', () => {
    const s = read('src', 'services', 'desktopBridgeService.js');
    expect(s).toMatch(/contains_production_credentials: false/);
    expect(s).toMatch(/contains_recipient_data: false/);
    expect(s).toMatch(/PII_RE/);
    expect(s).not.toMatch(/SELECT .*email.*FROM users/i);
  });
  test('proposals route to controlled paths only (no direct production write)', () => {
    const s = read('src', 'services', 'desktopBridgeService.js');
    expect(s).toMatch(/pull_request|admin_config_editor|admin_version_registry|fidelity_review_queue|report_only/);
    expect(s).not.toMatch(/UPDATE (auctions|marketing_package_versions|platform_config)/);
  });
});

// ── 8. Migration + gates + no L&M ──
describe('migration 141 + gate/L&M preservation', () => {
  const m = read('db', 'migrations', '141_marketing_execution_runtime_3o.sql');
  test('additive; append-only events; no DROP; gates not flipped', () => {
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS marketing_obligation_events/);
    expect(m).not.toMatch(/\bDROP\b/);
    ['google_ads_enabled', 'meta_enabled', 'a7_send_enabled'].forEach((k) => expect(m).not.toMatch(new RegExp(k + "'\\s*,\\s*'true'")));
  });
  test('external channels seed SHADOW_CERTIFIED (built, not activated); internal ACTIVE', () => {
    expect(m).toMatch(/'email',\s*'SHADOW_CERTIFIED'/);
    expect(m).toMatch(/'marketplace', 'ACTIVE'/);
  });
  test('no Lewis & Maese normalization in the runtime', () => {
    ['src/services/marketingFulfillmentWorker.js', 'src/services/paidAllocationBridge.js', 'db/migrations/141_marketing_execution_runtime_3o.sql']
      .forEach((f) => expect(read(f)).not.toMatch(/lewis|maese/i));
  });
});

'use strict';

/**
 * Phase 3O completion: bounded Director decision persistence + paid-allocation ledger (reserve/spend/
 * release/reconcile) with confidential ceiling enforcement.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const director = require('../src/services/directorDecisionService');
const alloc = require('../src/services/paidAllocationBridge');

// ── Director decisions: bounded set only; prohibited rejected; replay hash ──
describe('directorDecisionService', () => {
  test('only the Phase 3O bounded decision set is allowed', () => {
    expect(director.ALLOWED).toEqual(['PLAN', 'SELECT_DISCRETIONARY', 'SCHEDULE', 'SCOPE_AUDIENCE', 'ADJUST', 'RUNG_ADVANCE', 'UPSELL_PROMPT', 'ESCALATE']);
    expect(director.isAllowed('SCHEDULE')).toBe(true);
    expect(director.isAllowed('REFUND')).toBe(false);
  });
  test('prohibited decisions are structurally rejected (refund/reprice/hide/override/etc.)', async () => {
    for (const bad of ['REFUND', 'REPRICE', 'HIDE', 'OVERRIDE_SUPPRESSION', 'MANUFACTURE_AUDIENCE', 'MUTATE_POLICY', 'ALTER_ENTITLEMENT', 'REFUSE_CAPACITY']) {
      await expect(director.record({ kind: bad, purchaseId: 'p1', inputs: {}, evidenceLine: 'x' }, { query: async () => ({ rows: [] }) })).rejects.toMatchObject({ status: 422 });
    }
  });
  test('records a bounded decision with a replay inputs_hash', async () => {
    let captured;
    const runner = { query: async (sql, params) => { captured = params; return { rows: [{ decision_id: params[0], kind: params[1], inputs_hash: params[4] }] }; } };
    const row = await director.record({ kind: 'SCHEDULE', purchaseId: 'p1', obligationIds: ['o1'], inputs: { a: 1 }, authorityCentsRemaining: 500, evidenceLine: 'internal reason', outputs: {} }, runner);
    expect(row.kind).toBe('SCHEDULE');
    expect(row.inputs_hash).toBe(director.inputsHash({ a: 1 }));
  });
  test('inputs_hash is deterministic (replay) and evidence_line is internal (documented)', () => {
    expect(director.inputsHash({ x: 1, y: 2 })).toBe(director.inputsHash({ x: 1, y: 2 }));
    expect(read('src', 'services', 'directorDecisionService.js')).toMatch(/never seller-rendered|INTERNAL/i);
  });
});

// ── Paid allocation ledger: ceiling enforcement + idempotency ──
describe('paidAllocationBridge ledger', () => {
  function store() {
    const bal = { purchase_kind: 'package', purchase_id: 'PP1', ceiling_cents: 14940, reserved_cents: 0, spent_cents: 0, released_cents: 0, policy_version: 'v1' };
    const entries = new Set();
    return { bal, entries, query: async (sql, params) => {
      const s = String(sql);
      if (/FROM marketing_package_purchases/.test(s)) return { rows: [{ internal_authority_cents: 14940, direct_fulfillment_bps: 6000, economic_policy_version: 'v1' }] };
      if (/FROM marketing_additional_promotions/.test(s)) return { rows: [] };
      if (/INSERT INTO marketing_paid_allocations /.test(s)) return { rows: [] };
      if (/SELECT \* FROM marketing_paid_allocations/.test(s)) return { rows: [bal] };
      if (/INSERT INTO marketing_paid_allocation_entries/.test(s)) { const key = params[params.length - 1]; if (entries.has(key)) return { rows: [] }; entries.add(key); return { rows: [{ id: 'e' + entries.size }] }; }
      if (/UPDATE marketing_paid_allocations SET reserved_cents = reserved_cents \+/.test(s)) { if (bal.reserved_cents + bal.spent_cents + params[1] <= bal.ceiling_cents) { bal.reserved_cents += params[1]; return { rows: [bal] }; } return { rows: [] }; }
      if (/spent_cents = spent_cents \+/.test(s)) { bal.reserved_cents = Math.max(0, bal.reserved_cents - params[1]); bal.spent_cents += params[1]; return { rows: [bal] }; }
      if (/released_cents = released_cents \+/.test(s)) { bal.reserved_cents = Math.max(0, bal.reserved_cents - params[1]); bal.released_cents += params[1]; return { rows: [bal] }; }
      if (/GROUP BY entry_type/.test(s)) return { rows: [{ entry_type: 'SPEND', s: bal.spent_cents }, { entry_type: 'RELEASE', s: bal.released_cents }] };
      return { rows: [] };
    } };
  }
  test('canAuthorize never exceeds the confidential ceiling', () => {
    expect(alloc.canAuthorize(14940, 10000, 4940)).toBe(true);
    expect(alloc.canAuthorize(14940, 10000, 5000)).toBe(false);
  });
  test('reserve within ceiling succeeds; over ceiling is refused', async () => {
    const s = store();
    expect((await alloc.reserve('PP1', 10000, 'k1', {}, s)).ok).toBe(true);
    expect((await alloc.reserve('PP1', 5000, 'k2', {}, s)).ok).toBe(false); // 10000+5000 > 14940
  });
  test('reserve is idempotent per idempotency key (no double commit)', async () => {
    const s = store();
    await alloc.reserve('PP1', 5000, 'k1', {}, s);
    const again = await alloc.reserve('PP1', 5000, 'k1', {}, s); // same key
    expect(again.idempotent_replay).toBe(true);
    expect(s.bal.reserved_cents).toBe(5000); // not 10000
  });
  test('spend converts reservation; reconcile reports consistency', async () => {
    const s = store();
    await alloc.reserve('PP1', 6000, 'r1', {}, s);
    await alloc.spend('PP1', 6000, 's1', { providerRef: 'camp_1' }, s);
    expect(s.bal.spent_cents).toBe(6000);
    const rec = await alloc.reconcile('PP1', s);
    expect(rec.consistent).toBe(true);
  });
});

// ── Migration 142 additive + no seller identity in internal money + no gates ──
describe('migration 142', () => {
  const m = read('db', 'migrations', '142_marketing_director_ledger.sql');
  test('additive, bounded decision kinds, ceiling CHECK, no seller identity, no gate flip', () => {
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS marketing_director_decisions/);
    expect(m).toMatch(/CHECK \(kind IN \('PLAN'/);
    expect(m).not.toMatch(/'REFUND'|'REPRICE'/);
    expect(m).toMatch(/reserved_cents \+ spent_cents <= ceiling_cents/);
    expect(m).not.toMatch(/seller_user_id/);
    expect(m).not.toMatch(/\bDROP\b/);
  });
  test('confidential economics not seller-facing (bridge has no seller surface)', () => {
    const b = read('src', 'services', 'paidAllocationBridge.js');
    expect(b).toMatch(/CONFIDENTIAL/);
    expect(b).not.toMatch(/res\.json|seller_user_id/);
  });
});

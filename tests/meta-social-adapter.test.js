'use strict';

/** socialAdapter.resolveProvider — gate resolution + multi-market registry integration (real adapter). */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-social3';

const mockMeta = { on: false };
jest.mock('../src/services/marketingConfigService', () => ({ getBool: async (k, f) => (k === 'marketing.destinations.meta_enabled' ? mockMeta.on : f) }));
jest.mock('../src/services/socialDestinationService', () => ({
  resolveDestination: async ({ platform, stateCode }) => (stateCode || platform
    ? { destination: { id: 'nat', platform, provider_account_id: 'PAGE', credential_ref: 'ADAPTER_TOK' }, reason: 'national_fallback' }
    : { destination: null, reason: 'none' }),
}));
jest.mock('../src/services/metaGraphProvider', () => ({ buildProvider: (d) => ({ name: 'meta', platform: d.platform, active: true, shadow: false, publish: async () => ({ ok: true }) }) }));
jest.mock('../src/db', () => ({ query: async () => ({ rows: [] }) }));

const adapter = require('../src/services/socialAdapter');
beforeEach(() => { mockMeta.on = false; });

test('Meta gate OFF → mock (shadow) provider (never touches the network)', async () => {
  const p = await adapter.resolveProvider({ platform: 'facebook' });
  expect(p.name).toBe('mock');
  expect(p.shadow !== false).toBe(true);
});
test('Meta gate ON + ready destination → real meta provider (shadow=false), Page identity from registry', async () => {
  mockMeta.on = true;
  const p = await adapter.resolveProvider({ platform: 'facebook', stateCode: 'MI' });
  expect(p.name).toBe('meta');
  expect(p.shadow).toBe(false);
  expect(p.destination_reason).toBe('national_fallback');
});
test('Meta gate ON but NO destination → inactive provider (routes to resilience, no guess)', async () => {
  mockMeta.on = true;
  const p = await adapter.resolveProvider({ platform: '', stateCode: null });
  expect(p.name).toBe('meta'); expect(p.active).toBe(false); expect(p.reason).toBe('no_destination');
});

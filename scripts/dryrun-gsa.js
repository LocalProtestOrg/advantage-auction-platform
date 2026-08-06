'use strict';
// Live dry-run of the GSA connector: fetch the real API, normalize, report eligible/rejected + samples.
// Writes NOTHING. Usage: node scripts/dryrun-gsa.js
require('dotenv').config();
const gsa = require('../src/services/eventImport/connectors/gsaConnector');
const pipeline = require('../src/services/eventImport/pipeline');
const { evaluatePublication } = require('../src/services/eventImport/publicationGate');

(async () => {
  const nowMs = Date.now();
  let fetched = 0, eligible = 0, rejected = 0, publishable = 0;
  const rejReasons = {}, holdReasons = {}, samples = [];
  for await (const raw of gsa.fetch({ config: { apiKeyEnv: 'GSA_API_KEY' } })) {
    fetched++;
    const n = pipeline.normalizeItem(raw, { fieldMap: gsa.fieldMap, defaults: {}, now: nowMs });
    if (n.outcome !== 'eligible') { rejected++; rejReasons[n.reason] = (rejReasons[n.reason] || 0) + 1; continue; }
    eligible++;
    const c = n.canonical;
    const gate = evaluatePublication({ source: 'imported', title: c.title, start_at: c.start_at, end_at: c.end_at,
      event_format: c.event_format, city: c.city, state: c.state, lat: c.lat, lng: c.lng, organizer_name: c.organizer_name,
      bidding_url: c.bidding_url, image_count: (c.images || []).length }, { now: nowMs });
    if (gate.ready) publishable++; else gate.reasons.forEach((r) => { holdReasons[r] = (holdReasons[r] || 0) + 1; });
    if (samples.length < 3) samples.push({ title: c.title, start_at: c.start_at, end_at: c.end_at, city: c.city, state: c.state,
      organizer: c.organizer_name, format: c.event_format, images: (c.images || []).length, warnings: gate.warnings, ready: gate.ready });
  }
  console.log('GSA DRY-RUN:', JSON.stringify({ fetched, eligible, rejected, publishable, rejReasons, holdReasons }, null, 1));
  console.log('SAMPLES:', JSON.stringify(samples, null, 1));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

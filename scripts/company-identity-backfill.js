#!/usr/bin/env node
/* company-identity-backfill.js — link every organization, sales prospect, Event Partner source and
   professional seller profile to a company identity, and assign the implied acquisition journey.

   DRY RUN BY DEFAULT: reads only, writes a JSON report. Nothing is written unless BOTH --apply and
   --confirm=LINK-COMPANIES are given. Ambiguous resemblances are never merged; on apply they become
   company_identity_reviews rows for a person to decide.

   Usage:  node scripts/company-identity-backfill.js [--out=report.json]
           node scripts/company-identity-backfill.js --apply --confirm=LINK-COMPANIES */
const fs = require('fs');
const identity = require('../src/services/acquisition/companyIdentityService');
const db = require('../src/db');

const arg = (k) => { const a = process.argv.find((x) => x === '--' + k || x.startsWith('--' + k + '=')); return a ? (a.includes('=') ? a.split('=').slice(1).join('=') : true) : null; };

(async () => {
  const apply = arg('apply') === true;
  if (apply && arg('confirm') !== 'LINK-COMPANIES') {
    console.error('REFUSE: --apply requires --confirm=LINK-COMPANIES'); process.exitCode = 2; return;
  }
  const report = await identity.backfill({ apply, runner: db });
  const out = arg('out');
  if (typeof out === 'string') fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const { ambiguous, conflicts, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  console.log('ambiguous pairs (first 40):');
  for (const a of ambiguous.slice(0, 40)) console.log('  ~', a.a, '<->', a.b, a.weak.join(','));
  console.log('refused merges (first 40):');
  for (const c of conflicts.slice(0, 40)) console.log('  x', c.a, '<->', c.b, c.reason);
})().then(() => db.pool.end()).catch((e) => { console.error(e.message); process.exitCode = 1; });

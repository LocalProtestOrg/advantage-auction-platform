#!/usr/bin/env node
/* prod-record-nj-tax-setup.js - PRODUCTION-guarded record of the New Jersey sales tax registration and rule
   (owner instruction 2026-11-17). It writes exactly what Admin > Sales Tax > Registrations and Admin > Sales Tax Rules
   write, in one transaction, with the same history and audit entries:

     tax_registrations               NJ, active, effective 2026-11-17, added to the tax calculation settings (owner statement)
     marketplace_tax_jurisdictions   NJ = platform (collected at checkout; Advantage.Bid remits), effective 2026-11-17

   Nothing is invented: the filing frequency and the registration number are left EMPTY until the owner supplies them.
   It changes no other state, no setting, no order and no payment. Idempotent: it refuses when NJ already has either row.

   --check    READ-ONLY: reports what is recorded for NJ now.
   --dry-run  writes inside a transaction, verifies, then ROLLS BACK.
   (none)     writes in one transaction, verifies, commits.
   Usage: railway run node scripts/prod-record-nj-tax-setup.js [--check | --dry-run] */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const CHECK = process.argv.includes('--check');
const DRY = process.argv.includes('--dry-run');
const STATE = 'NJ';
const EFFECTIVE = '2026-11-17';
const OWNER_EMAIL = 'tylerwitt2015@gmail.com';   // the platform owner's administrator account (the actor on record)
const REG_NOTES = 'Recorded 2026-11-17 on the owner\'s instruction. Owner statement: Advantage.Bid LLC is formed in New Jersey, completed NJ-REG and holds a '
  + 'New Jersey Sales Tax Certificate of Authority; the registration was added to the tax calculation settings by the owner with collection starting '
  + '2026-11-17. Not yet supplied: filing frequency, return due dates, and whether the business start date on file with the Division of Taxation '
  + 'matches 2026-11-17 (owner to confirm).';
const LEGAL_BASIS = 'Owner instruction 2026-11-17: Advantage.Bid LLC holds a New Jersey Sales Tax Certificate of Authority and collects and remits New Jersey '
  + 'sales tax on marketplace, auction and embedded storefront sales as the seller of record and marketplace facilitator.';
const SOURCE = 'N.J. P.L. 2018, c.132 (marketplace facilitators); NJ Division of Taxation TB-83 and ANJ-3. Statewide rate 6.625%, calculated by the tax calculation provider.';
const RULE_NOTES = 'Open for the accountant: buyer\'s premium taxability on auctions; exempt categories (clothing, qualifying coins and bullion) need tax codes before such items are sold.';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const rows = async (sql, p) => (await c.query(sql, p || [])).rows;
    const state = async () => ({
      registrations: await rows(`SELECT id, state, status, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, filing_frequency, zero_filing_required,
          registration_last4, processor_registered, notes FROM tax_registrations WHERE state = $1 ORDER BY created_at`, [STATE]),
      rule: (await rows(`SELECT state, remitter, legal_basis, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, notes, source_reference, local_jurisdiction,
          to_char(last_verified_at, 'YYYY-MM-DD') AS last_verified_at, last_verified_by, updated_by, updated_at FROM marketplace_tax_jurisdictions WHERE state = $1`, [STATE]))[0] || null,
      other_rules: Number((await rows(`SELECT count(*)::int n FROM marketplace_tax_jurisdictions WHERE state <> $1`, [STATE]))[0].n),
      other_registrations: Number((await rows(`SELECT count(*)::int n FROM tax_registrations WHERE state <> $1`, [STATE]))[0].n),
      settings: await rows(`SELECT key, value FROM platform_config WHERE key IN ('tax.auction_enforcement', 'tax.reserve_guard') ORDER BY key`),
    });
    const before = await state();
    const actor = (await rows(`SELECT id, role FROM users WHERE lower(email) = $1`, [OWNER_EMAIL]))[0];
    console.log('Before:', JSON.stringify({ ...before, actor_found: !!actor, actor_role: actor && actor.role }, null, 2));
    if (CHECK) return 0;
    if (!actor || actor.role !== 'admin') { console.error('REFUSE: owner administrator account not found.'); return 1; }
    if (before.registrations.length || before.rule) { console.error('REFUSE: NJ already has a registration or a rule. Change it in Admin > Sales Tax.'); return 1; }

    await c.query('BEGIN');
    try {
      const reg = (await rows(
        `INSERT INTO tax_registrations (state, status, effective_from, effective_to, filing_frequency, zero_filing_required, registration_last4,
           processor_registered, notes, created_by, updated_by)
         VALUES ($1, 'active', $2, NULL, NULL, true, NULL, true, $3, $4, $4)
         RETURNING id, state, status, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, filing_frequency, zero_filing_required, processor_registered, notes`,
        [STATE, EFFECTIVE, REG_NOTES, actor.id]))[0];
      // The same condition the rule route enforces: an ACTIVE registration in effect today must exist before a 'platform' rule.
      const active = (await rows(`SELECT 1 AS x FROM tax_registrations WHERE state = $1 AND status = 'active'
          AND (effective_from IS NULL OR effective_from <= CURRENT_DATE) AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)`, [STATE]))[0];
      if (!active) throw new Error('the registration is not in effect today; the rule was not saved');
      await c.query(
        `INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis, effective_from, notes, source_reference, local_jurisdiction, updated_by, updated_at)
         VALUES ($1, 'platform', $2, $3, $4, $5, NULL, $6, now())`, [STATE, LEGAL_BASIS, EFFECTIVE, RULE_NOTES, SOURCE, actor.id]);
      const rule = (await state()).rule;
      await c.query(`INSERT INTO tax_jurisdiction_history (state, action, before_value, after_value, actor_user_id) VALUES ($1, 'set', NULL, $2::jsonb, $3)`,
        [STATE, JSON.stringify(rule), actor.id]);
      const via = { recorded_by: 'scripts/prod-record-nj-tax-setup.js', on_instruction_of: 'platform owner, 2026-11-17' };
      const audit = (event, type, id, metadata) => c.query(
        `INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [event, type, id, actor.id, JSON.stringify({ ...metadata, ...via })]);
      await audit('tax_registration_recorded', 'tax_registration', reg.id, { state: STATE, before: null, after: reg });
      await audit('tax_jurisdiction_rule_set', 'tax_jurisdiction', actor.id, { state: STATE, before: null, after: rule });

      const after = await state();
      const checks = {
        one_active_registration: after.registrations.length === 1 && after.registrations[0].status === 'active' && after.registrations[0].effective_from === EFFECTIVE,
        frequency_and_number_left_empty: after.registrations[0].filing_frequency === null && after.registrations[0].registration_last4 === null,
        rule_is_platform: !!after.rule && after.rule.remitter === 'platform' && after.rule.effective_from === EFFECTIVE,
        other_states_untouched: after.other_rules === before.other_rules && after.other_registrations === before.other_registrations,
        settings_untouched: JSON.stringify(after.settings) === JSON.stringify(before.settings),
        history_written: Number((await rows(`SELECT count(*)::int n FROM tax_jurisdiction_history WHERE state = $1`, [STATE]))[0].n) === 1,
      };
      console.log('After:', JSON.stringify(after, null, 2));
      console.log('Checks:', JSON.stringify(checks, null, 2));
      if (!Object.values(checks).every(Boolean)) throw new Error('verification failed');
      if (DRY) { await c.query('ROLLBACK'); console.log('RESULT: DRY RUN PASS (rolled back; nothing was changed)'); return 0; }
      await c.query('COMMIT');
      console.log('RESULT: RECORDED');
      return 0;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('ROLLED BACK: ' + e.message); return 1; }
  } finally { await c.end(); }
})().then((code) => { process.exitCode = code; }).catch((e) => { console.error('FAILED: ' + e.message); process.exitCode = 1; });

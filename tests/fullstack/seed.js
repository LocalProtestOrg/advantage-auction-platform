'use strict';

/**
 * Seed helpers for the isolated full-stack environment (stack.js). Everything is written to the in-memory test
 * database only. Passwords are clearly labelled test values.
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const ROOT = path.join(__dirname, '..', '..');
const TEST_PASSWORD = 'FullstackTest2026!';   // test-only, never a real credential
const SELLER_AGREEMENT_TEMPLATE = 'ab000000-0000-4000-8000-000000000001';

// The production Seller Agreement text (docs/seller-agreement-v1-content.md is byte-identical to production v3,
// verified 2026-10-30), extracted exactly as scripts/prod-seed-agreement-template.js and the publish script do.
function sellerAgreementBody() {
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'seller-agreement-v1-content.md'), 'utf8').replace(/\r\n/g, '\n');
  const start = md.indexOf('## Agreement body');
  let body = md.slice(md.indexOf('\n', start) + 1);
  const end = body.indexOf('### Authoring notes');
  if (end !== -1) body = body.slice(0, end);
  return body.replace(/\n+---\s*$/, '').trim();
}

const VARIABLE_SCHEMA = [
  { key: 'legal_name', type: 'string', source: 'identity', required: true },
  { key: 'signatory_name', type: 'string', source: 'identity', required: true },
  { key: 'seller_address', type: 'string', source: 'manual' },
  { key: 'seller_phone', type: 'string', source: 'manual' },
  { key: 'seller_type', type: 'string', source: 'manual', required: true },
  { key: 'effective_date', type: 'date', source: 'manual', required: true },
];
const EFFECTIVE_DEFAULTS = { seller_address: 'On file with Advantage Auction', seller_phone: 'On file with Advantage Auction' };

async function sellerAgreementTemplate(stack, { version = 3 } = {}) {
  await stack.query(`INSERT INTO agreement_templates (id, agreement_type, name, description, is_active)
    VALUES ($1, 'private', 'Seller Agreement', 'Advantage.Bid seller consignment and auction services agreement', true) ON CONFLICT (id) DO NOTHING`,
  [SELLER_AGREEMENT_TEMPLATE]);
  const v = (await stack.query(`INSERT INTO agreement_template_versions (template_id, version_int, body_markdown, variable_schema, effective_terms_defaults)
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING id`,
  [SELLER_AGREEMENT_TEMPLATE, version, sellerAgreementBody(), JSON.stringify(VARIABLE_SCHEMA), JSON.stringify(EFFECTIVE_DEFAULTS)])).rows[0];
  await stack.query('UPDATE agreement_templates SET current_version_id = $1 WHERE id = $2', [v.id, SELLER_AGREEMENT_TEMPLATE]);
  return { templateId: SELLER_AGREEMENT_TEMPLATE, versionId: v.id };
}

async function user(stack, { email, role = 'buyer', fullName = 'Test Person', password = TEST_PASSWORD }) {
  const hash = await bcrypt.hash(password, 4);
  return (await stack.query(`INSERT INTO users (email, role, full_name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, role, fullName, hash])).rows[0].id;
}

async function sellerProfile(stack, { userId, sellerType = 'auction_house', displayName = 'Test Auction House', extra = {} }) {
  const cols = ['user_id', 'seller_type', 'display_name', ...Object.keys(extra)];
  const vals = [userId, sellerType, displayName, ...Object.values(extra)];
  return (await stack.query(`INSERT INTO seller_profiles (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, vals)).rows[0].id;
}

// A signed Seller Agreement on a version with the current storefront terms (5% / 9%), the requirement for storefront
// publishing and sales (migration 216; a waiver alone does not count). Test data only, in the isolated database.
const STOREFRONT_TERMS_TEMPLATE = 'ab000000-0000-4000-8000-0000000000f4';
async function signedStorefrontAgreement(stack, sellerProfileId) {
  await stack.query(`INSERT INTO agreement_templates (id, agreement_type, name, description, is_active)
    VALUES ($1, 'private', 'Seller Agreement (test, current storefront terms)', 'test', false) ON CONFLICT (id) DO NOTHING`, [STOREFRONT_TERMS_TEMPLATE]);
  let v = (await stack.query('SELECT id FROM agreement_template_versions WHERE template_id = $1 LIMIT 1', [STOREFRONT_TERMS_TEMPLATE])).rows[0];
  if (!v) {
    v = (await stack.query(`INSERT INTO agreement_template_versions (template_id, version_int, body_markdown, variable_schema, effective_terms_defaults)
      VALUES ($1, 4, $2, '[]'::jsonb, '{}'::jsonb) RETURNING id, storefront_fee_schedule`, [STOREFRONT_TERMS_TEMPLATE, sellerAgreementBody()])).rows[0];
    if (!v.storefront_fee_schedule) throw new Error('the agreement text does not state the current storefront terms');
  }
  return (await stack.query(`INSERT INTO agreements (template_version_id, seller_profile_id, status, signed_at) VALUES ($1, $2, 'signed', now()) RETURNING id`,
    [v.id, sellerProfileId])).rows[0].id;
}

/** Log in through the API; returns the session token (Bearer). */
async function apiLogin(stack, email, password = TEST_PASSWORD) {
  const r = await fetch(stack.baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  if (!j.token) throw new Error('login failed for ' + email + ': ' + JSON.stringify(j));
  return j.token;
}

/** Log a browser page in through the real login form. */
async function browserLogin(page, stack, email, password = TEST_PASSWORD, next = '/app.html') {
  await page.goto(stack.baseUrl + '/login.html?next=' + encodeURIComponent(next));
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await Promise.all([page.waitForURL((u) => !/\/login\.html/.test(String(u)), { timeout: 20000 }), page.click('#login-btn')]);
}

module.exports = { TEST_PASSWORD, SELLER_AGREEMENT_TEMPLATE, sellerAgreementBody, sellerAgreementTemplate, signedStorefrontAgreement, user, sellerProfile, apiLogin, browserLogin };

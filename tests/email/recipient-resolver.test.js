'use strict';

/**
 * recipientService + buyer-email routing — proves every buyer transactional-email path resolves its
 * recipient through the central COALESCE(NULLIF(contact_email,''), email) expression, so a bridge
 * account's namespaced placeholder users.email is never used as an outbound recipient.
 */

const fs = require('fs');
const path = require('path');
const { recipientEmailSql, resolveUserContactEmail } = require('../../src/services/recipientService');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

describe('recipientEmailSql — single canonical expression', () => {
  test('aliased and unaliased forms', () => {
    expect(recipientEmailSql('u')).toBe("COALESCE(NULLIF(u.contact_email, ''), u.email)");
    expect(recipientEmailSql('')).toBe("COALESCE(NULLIF(contact_email, ''), email)");
  });
});

describe('resolveUserContactEmail — prefers real contact_email, falls back to email', () => {
  test('queries with the canonical expression and returns the resolved address', async () => {
    let seenSql = '';
    const fake = { query: async (sql, params) => {
      seenSql = sql; expect(params).toEqual(['u-1']);
      return { rows: [{ email: 'real@member.com' }] }; // COALESCE resolves in SQL; fake returns its output
    } };
    const to = await resolveUserContactEmail('u-1', fake);
    expect(to).toBe('real@member.com');
    expect(seenSql).toContain("COALESCE(NULLIF(contact_email, ''), email)");
  });
  test('unknown user → null (never a placeholder)', async () => {
    const fake = { query: async () => ({ rows: [] }) };
    expect(await resolveUserContactEmail('missing', fake)).toBeNull();
  });
});

describe('every buyer transactional-email path routes through the resolver', () => {
  test('notification worker resolves recipient via the central expression', () => {
    const src = read('src', 'workers', 'notificationWorker.js');
    expect(src).toMatch(/require\('\.\.\/services\/recipientService'\)/);
    expect(src).toContain('${recipientEmailSql(\'u\')} AS email');
    // the raw `u.email` recipient select is gone
    expect(src).not.toMatch(/SELECT u\.email,/);
  });
  test('invoice + combined-invoice data resolve buyer_email via the central expression (both sites)', () => {
    const src = read('src', 'services', 'invoicePdfService.js');
    expect(src).toMatch(/require\('\.\/recipientService'\)/);
    const matches = src.match(/\$\{recipientEmailSql\('u'\)\} AS buyer_email/g) || [];
    expect(matches.length).toBe(2);
    expect(src).not.toMatch(/u\.email\s+AS buyer_email/);
  });
  test('welcome/verification email resolves recipient by userId through the resolver', () => {
    const src = read('src', 'services', 'emailVerificationService.js');
    expect(src).toMatch(/resolveUserContactEmail/);
    expect(src).toMatch(/const to = \(await resolveUserContactEmail\(userId\)\) \|\| email;/);
  });
});

/**
 * Governance Regression Suite (Phase B)
 * ───────────────────────────────────────────────────────────────────────────
 * Exercises the end-to-end moderation lifecycle introduced by INT-2, GOV-RET,
 * GOV-REJ, AUD-EXP, and OPS-3. Staging-only — never run against production.
 *
 * Required env:
 *   BASE_URL                 — must point at staging (e.g.
 *                              https://advantage-staging-production.up.railway.app)
 *
 * Optional env:
 *   STAGING_DATABASE_URL     — staging Neon branch URL, used ONLY by this
 *                              suite. When set, the notifications_queue
 *                              assertions read the row directly (VERIFIED-DB).
 *                              When absent, the suite falls back to
 *                              audit_log presence (INFERRED-AUDIT — the
 *                              GOV-RET / GOV-REJ endpoints write audit_log
 *                              and notifications_queue in the same
 *                              transaction).
 *
 *                              This var is intentionally distinct from
 *                              DATABASE_URL. DATABASE_URL is populated by
 *                              dotenv from .env in most local setups and
 *                              conventionally points at production; this
 *                              suite refuses to consult it. The naming
 *                              collision risk only goes away when the
 *                              connection variable is renamed.
 *   CLEANUP_TEST_AUCTIONS    — when 'true', the rejected test auction is
 *                              DELETEd at the end. Default leaves it in
 *                              place so the operator can inspect post-run
 *                              state in /admin/moderation.html.
 *
 * Run:
 *   $env:BASE_URL = "https://advantage-staging-production.up.railway.app"
 *   npx playwright test e2e/governance-regression.spec.js --project=chromium
 *
 * Artifacts:
 *   playwright-report/        Standard Playwright HTML report (annotations
 *                             carry the per-phase pass/fail rollup).
 *   governance-summary.json   Machine-readable summary at the repo root,
 *                             with the same data shown in the stdout block.
 */

import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

test.describe.configure({ mode: 'serial' });

// ─── Config & canonical validation identities ──────────────────────────────
const BASE = process.env.BASE_URL || 'http://localhost:3000';

// Seeded by scripts/seed-validation-fixtures.js + seed-pilot-accounts.js.
// Documented in project_validation_identities.md.
const ADMIN_CREDS  = { email: 'validation-admin@advantage.bid', password: 'ValidationAdmin2025!' };
const SELLER_CREDS = { email: 'pilot-seller2@advantage.bid',    password: 'PilotTest2026!' };
const BUYER_CREDS  = { email: 'pilot-buyer1@advantage.bid',     password: 'PilotTest2026!' };

// Owned by demo-seller — used for the seller-side cross-isolation check in
// Phase 10. Confirmed in project_validation_identities.md (Estate Fine
// Jewelry & Watch Collection).
const OTHER_SELLER_AUCTION_ID = 'dd000000-0000-4000-8000-000000000010';

// Test data constants — multi-line reasons exercise pre-wrap rendering.
const AUCTION_TITLE_PREFIX = 'Governance Regression';
const RETURN_TO_DRAFT_REASON =
  'Cover photo blurry.\n' +
  'Also adjust starting bid on Lot #1.';
const REJECT_REASON =
  'Overlaps with open chargeback investigation on this seller account.';

// ─── Inline helpers (no shared helper module exists; established pattern is
//     to embed per-spec — see admin-moderation.spec.js / audit/audit-log.spec.js).

async function loginUser(request, creds) {
  const res  = await request.post('/api/auth/login', { data: creds });
  const body = await res.json();
  expect(res.status(), `Login failed for ${creds.email}: ${JSON.stringify(body)}`).toBe(200);
  expect(body.token, `No token returned for ${creds.email}`).toBeTruthy();
  return body.token;
}

// Direct pg pool used ONLY for the notifications_queue read-side check.
// Uses STAGING_DATABASE_URL exclusively — DATABASE_URL is deliberately
// NOT read here. dotenv loads .env at import time, and .env conventionally
// carries the production URL; reading DATABASE_URL would silently leak
// queries to production. STAGING_DATABASE_URL has no .env counterpart, so
// it's only set when the operator explicitly opts in. Anyone editing
// this function: keep the DATABASE_URL prohibition — see the assertion
// in the test.beforeAll block at the top of this file.
let _pool = null;
function pool() {
  if (!_pool && process.env.STAGING_DATABASE_URL) {
    _pool = new pg.Pool({
      connectionString: process.env.STAGING_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return _pool;
}
async function dbQuery(sql, params = []) {
  const p = pool();
  if (!p) return null;
  const client = await p.connect();
  try   { return (await client.query(sql, params)).rows; }
  finally { client.release(); }
}

// ─── Shared state populated by Phase 1 → consumed downstream ───────────────
let adminToken;
let sellerToken;
let buyerToken;
let adminUserId;
let sellerUserId;
let sellerProfileId;
let auctionId;
let auctionTitle;

// ─── Governance report (finalized in Phase 12) ─────────────────────────────
const report = {
  started_at: new Date().toISOString(),
  finished_at: null,
  staging_base_url: BASE,
  staging_database_url_present: !!process.env.STAGING_DATABASE_URL,
  test_seller: SELLER_CREDS.email,
  test_admin: ADMIN_CREDS.email,
  notification_verification: 'pending',
  results: {
    'INT-2 audit retrofit':          'pending',
    'GOV-RET return-to-draft':       'pending',
    'GOV-REJ reject':                'pending',
    'AUD-EXP seller audit endpoint': 'pending',
    'AUD-EXP admin audit timeline':  'pending',
    'OPS-3 suspension':              'pending',
  },
  notes: [],
  auction_id: null,
};
function mark(area, status, note) {
  report.results[area] = status;
  if (note) report.notes.push(`${area}: ${note}`);
}

// ─── Startup: announce mode + behavioral guard against DATABASE_URL use ────
test.beforeAll(() => {
  // BASE_URL safety guard — positive whitelist. This suite mutates state
  // (creates auctions, suspends/unsuspends a seller, writes audit rows) and
  // must never run against production. The staging Railway service URL
  // contains the substring 'staging' by design; any URL that does not is
  // refused. Catches three failure modes:
  //   1) BASE_URL unset / defaulting to http://localhost:3000
  //   2) BASE_URL pointed at production (e.g., https://advantage.bid)
  //   3) BASE_URL pointed at a numbered preview or unfamiliar host
  // If a future staging URL legitimately lacks 'staging', rename it or
  // update this guard — better safe than silently writing somewhere
  // unintended.
  const baseLower = (BASE || '').toLowerCase();
  if (!baseLower.includes('staging')) {
    throw new Error(
      `governance-regression.spec.js refused: BASE_URL=${BASE} does not appear to target staging. ` +
      'This suite is staging-only — it creates auctions, exercises suspension, and writes audit rows. ' +
      'Set BASE_URL to the staging Railway service URL (must contain the substring "staging") and re-run.'
    );
  }

  const stagingUrlPresent = !!process.env.STAGING_DATABASE_URL;
  const mode  = stagingUrlPresent ? 'VERIFIED-DB' : 'INFERRED-AUDIT';
  const tail  = stagingUrlPresent ? '(using STAGING_DATABASE_URL)' : '(no STAGING_DATABASE_URL provided)';
  console.log(`Notification verification mode: ${mode} ${tail}`);

  // Behavioral guard: confirm pool() respects the STAGING_DATABASE_URL-only
  // contract regardless of whether DATABASE_URL is set in the environment.
  // We assert by calling pool() and checking the returned value:
  //   - If STAGING_DATABASE_URL is unset → pool() must return null even when
  //     DATABASE_URL is present (dotenv-loaded from .env). This prevents
  //     the production-read leak we hit on the prior run.
  //   - If STAGING_DATABASE_URL is set → pool() returns a Pool instance
  //     constructed from STAGING_DATABASE_URL (not DATABASE_URL).
  if (!stagingUrlPresent) {
    const p = pool();
    if (p !== null) {
      throw new Error(
        'pool() returned a Pool when STAGING_DATABASE_URL is unset — DB guard failed. ' +
        'This suite must never connect when STAGING_DATABASE_URL is absent.'
      );
    }
    if (process.env.DATABASE_URL) {
      console.log('  (DATABASE_URL is set in this process but is being ignored — staging-only by design.)');
    }
  }
});

// ─── Cleanup ────────────────────────────────────────────────────────────────
test.afterAll(async ({ request }) => {
  // Phase 11 safety net — endpoint is idempotent so calling it on an
  // already-active seller is a no-op. Runs even if the suite aborted mid-way,
  // preventing a stranded suspension from breaking other staging tests.
  if (sellerProfileId && adminToken) {
    try {
      await request.post(`/api/admin/sellers/${sellerProfileId}/unsuspend`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    } catch (_) { /* best-effort */ }
  }

  // Optional auction cleanup. Admin DELETE bypasses canDeleteAuction's
  // draft-only rule so the rejected test auction can be removed.
  if (process.env.CLEANUP_TEST_AUCTIONS === 'true' && auctionId && adminToken) {
    try {
      await request.delete(`/api/auctions/${auctionId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    } catch (_) { /* best-effort */ }
  }

  if (_pool) await _pool.end();
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1 — Setup
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 1 — Setup', () => {
  test('login admin, seller, buyer (canonical validation identities)', async ({ request }) => {
    [adminToken, sellerToken, buyerToken] = await Promise.all([
      loginUser(request, ADMIN_CREDS),
      loginUser(request, SELLER_CREDS),
      loginUser(request, BUYER_CREDS),
    ]);
  });

  test('fetch admin user id (via /api/auth/me) for audit assertions', async ({ request }) => {
    const res  = await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${adminToken}` } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    adminUserId = body.data.id;
    expect(adminUserId, 'admin user id missing from /api/auth/me').toBeTruthy();
  });

  test('fetch seller profile + user id (via /api/sellers/me)', async ({ request }) => {
    const res  = await request.get('/api/sellers/me', { headers: { Authorization: `Bearer ${sellerToken}` } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    sellerProfileId = body.data.id;
    sellerUserId    = body.data.user_id;
    expect(sellerProfileId, 'seller profile id missing').toBeTruthy();
    expect(sellerUserId,    'seller user id missing').toBeTruthy();
  });

  test('defensive unsuspend — clear residue from any prior failed run', async ({ request }) => {
    // Endpoint is state-validating, not fully idempotent: 200 when a prior
    // suspension was reversed, 409 ("Seller is not suspended") when the
    // account is already active. Both outcomes are acceptable pre-flight
    // states — anything else is a real problem.
    const res = await request.post(`/api/admin/sellers/${sellerProfileId}/unsuspend`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect([200, 409], `Pre-flight unsuspend returned ${res.status()}`).toContain(res.status());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 — Create draft auction
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 2 — Create draft auction', () => {
  test('POST /api/auctions creates a draft auction', async ({ request }) => {
    auctionTitle = `${AUCTION_TITLE_PREFIX} ${Date.now()}`;
    const res = await request.post('/api/auctions', {
      data: { sellerProfileId, title: auctionTitle, state: 'draft' },
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    auctionId          = body.data.id;
    report.auction_id  = auctionId;
    expect(auctionId).toBeTruthy();
    expect(body.data.state).toBe('draft');
  });

  test('new auction has revision_count=0 and revision_note=null (047 columns)', async ({ request }) => {
    const res  = await request.get(`/api/admin/auctions/${auctionId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(200);
    const a = (await res.json()).data;
    expect(Number(a.revision_count), 'revision_count must default to 0').toBe(0);
    expect(a.revision_note, 'revision_note must default to null').toBeNull();
    // GOV-REJ columns also present and null on fresh draft
    expect(a.rejection_reason).toBeNull();
    expect(a.rejected_at).toBeNull();
    expect(a.rejected_by).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 — Submit for review (covers INT-2 auction_submitted audit retrofit)
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 3 — Submit for review', () => {
  test('seller PATCH state=submitted', async ({ request }) => {
    const res = await request.patch(`/api/auctions/${auctionId}`, {
      data: { state: 'submitted' },
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    expect(res.status()).toBe(200);
  });

  test('auction state is now submitted', async ({ request }) => {
    const res  = await request.get(`/api/admin/auctions/${auctionId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect((await res.json()).data.state).toBe('submitted');
  });

  test('audit_log shows auction_submitted with seller as actor', async ({ request }) => {
    const res  = await request.get(`/api/admin/audit-log?auction_id=${auctionId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const body  = await res.json();
    const found = body.data.find(e => e.event_type === 'auction_submitted');
    expect(found, `auction_submitted missing — events: ${body.data.map(e => e.event_type).join(',')}`).toBeTruthy();
    expect(found.actor_id, 'auction_submitted actor should be the seller').toBe(sellerUserId);
    mark('INT-2 audit retrofit', 'pass', 'auction_submitted recorded by seller PATCH state=submitted');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4 — Admin returns to draft
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 4 — Admin returns to draft', () => {
  test('POST /return-to-draft with multi-line reason → 200', async ({ request }) => {
    const res  = await request.post(`/api/admin/auctions/${auctionId}/return-to-draft`, {
      data: { reason: RETURN_TO_DRAFT_REASON },
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  test('auction now state=draft with revision_count=1 and revision_note set', async ({ request }) => {
    const res = await request.get(`/api/admin/auctions/${auctionId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const a = (await res.json()).data;
    expect(a.state).toBe('draft');
    expect(Number(a.revision_count)).toBe(1);
    expect(a.revision_note).toBe(RETURN_TO_DRAFT_REASON);
  });

  test('audit_log shows auction_returned_to_draft with reason + from_state', async ({ request }) => {
    const res  = await request.get(`/api/admin/audit-log?auction_id=${auctionId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const body  = await res.json();
    const found = body.data.find(e => e.event_type === 'auction_returned_to_draft');
    expect(found, 'auction_returned_to_draft missing from audit_log').toBeTruthy();
    expect(found.metadata.reason).toBe(RETURN_TO_DRAFT_REASON);
    expect(found.metadata.from_state).toBe('submitted');
    expect(found.actor_id, 'audit actor should be admin').toBe(adminUserId);
  });

  test('notifications_queue has AUCTION_RETURNED_TO_DRAFT (VERIFIED-DB or INFERRED-AUDIT)', async ({ request }) => {
    if (process.env.STAGING_DATABASE_URL) {
      const rows = await dbQuery(
        `SELECT type, payload, user_id, created_at
           FROM notifications_queue
          WHERE type = 'AUCTION_RETURNED_TO_DRAFT'
            AND user_id = $1
            AND payload->>'auction_id' = $2
          ORDER BY created_at DESC`,
        [sellerUserId, auctionId]
      );
      expect(rows, 'dbQuery returned null — STAGING_DATABASE_URL set but pool unavailable').not.toBeNull();
      expect(rows.length, 'No AUCTION_RETURNED_TO_DRAFT row found in notifications_queue').toBeGreaterThanOrEqual(1);
      const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
      expect(payload.reason).toBe(RETURN_TO_DRAFT_REASON);
      if (report.notification_verification === 'pending') {
        report.notification_verification = 'VERIFIED-DB';
      }
    } else {
      // Audit log already verified the same-transaction write; the GOV-RET
      // endpoint inserts into both audit_log and notifications_queue inside
      // the same BEGIN/COMMIT, so audit presence implies queue presence.
      const res = await request.get(`/api/admin/audit-log?auction_id=${auctionId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const found = (await res.json()).data.find(e => e.event_type === 'auction_returned_to_draft');
      expect(found, 'audit_log proof of return-to-draft missing — inference invalid').toBeTruthy();
      report.notification_verification = 'INFERRED-AUDIT';
      report.notes.push('AUCTION_RETURNED_TO_DRAFT inferred via audit_log transactional coupling — STAGING_DATABASE_URL not set');
    }
    mark('GOV-RET return-to-draft', 'pass');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5 — Seller sees returned state (browser UI)
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 5 — Seller sees returned state', () => {
  test('revision banner visible with verbatim multi-line reason', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), sellerToken);
    await page.goto(`${BASE}/seller-dashboard.html`);

    const card = page.locator(`.auction-card[data-auction-id="${auctionId}"]`);
    await expect(card, 'auction card not found on dashboard').toBeVisible({ timeout: 10_000 });

    // Banner text + first reason line + second reason line — proves pre-wrap rendering.
    await expect(card).toContainText('Revisions requested by Advantage Auction');
    await expect(card).toContainText('Cover photo blurry.');
    await expect(card).toContainText('Also adjust starting bid on Lot #1.');
  });

  test('state badge reads Draft (revision-cycle draft, not submitted)', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), sellerToken);
    await page.goto(`${BASE}/seller-dashboard.html`);
    const card = page.locator(`.auction-card[data-auction-id="${auctionId}"]`);
    await expect(card.locator('.badge-draft')).toBeVisible({ timeout: 10_000 });
  });

  test('Submit for AAC Review button is visible (edit-lock lifted)', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), sellerToken);
    await page.goto(`${BASE}/seller-dashboard.html`);
    const card = page.locator(`.auction-card[data-auction-id="${auctionId}"]`);
    await expect(card.locator(`[data-submit-auction="${auctionId}"]`)).toBeVisible({ timeout: 10_000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 6 — Seller edits and resubmits
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 6 — Seller edits and resubmits', () => {
  test('seller PATCH subtitle (proves edit allowed in revision-cycle draft)', async ({ request }) => {
    const res = await request.patch(`/api/auctions/${auctionId}`, {
      data: { subtitle: 'updated subtitle' },
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    expect(res.status()).toBe(200);
  });

  test('seller PATCH state=submitted again → state transitions back to submitted', async ({ request }) => {
    const res = await request.patch(`/api/auctions/${auctionId}`, {
      data: { state: 'submitted' },
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    expect(res.status()).toBe(200);

    const get = await request.get(`/api/admin/auctions/${auctionId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const a = (await get.json()).data;
    expect(a.state).toBe('submitted');
    expect(Number(a.revision_count), 'revision_count must NOT increment on resubmit').toBe(1);
    expect(a.revision_note, 'revision_note retained (banner hides via isEditable=false, not by clear)').toBe(RETURN_TO_DRAFT_REASON);
  });

  test('audit_log now contains both an auction_updated (subtitle) and a second auction_submitted', async ({ request }) => {
    const res  = await request.get(`/api/admin/audit-log?auction_id=${auctionId}&limit=50`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const body = await res.json();
    const submitCount = body.data.filter(e => e.event_type === 'auction_submitted').length;
    const updateCount = body.data.filter(e => e.event_type === 'auction_updated').length;
    expect(submitCount, 'expected 2 auction_submitted events (initial + resubmit)').toBeGreaterThanOrEqual(2);
    expect(updateCount, 'expected ≥1 auction_updated event (the subtitle edit)').toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 7 — Admin rejects auction
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 7 — Admin rejects auction', () => {
  test('POST /reject with reason → 200', async ({ request }) => {
    const res  = await request.post(`/api/admin/auctions/${auctionId}/reject`, {
      data: { reason: REJECT_REASON },
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  test('auction state=rejected with rejection_reason, rejected_at, rejected_by populated', async ({ request }) => {
    const res = await request.get(`/api/admin/auctions/${auctionId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const a = (await res.json()).data;
    expect(a.state).toBe('rejected');
    expect(a.rejection_reason).toBe(REJECT_REASON);
    expect(a.rejected_at, 'rejected_at must be populated').toBeTruthy();
    expect(a.rejected_by, 'rejected_by must equal admin user id').toBe(adminUserId);
  });

  test('audit_log shows auction_rejected with reason + from_state', async ({ request }) => {
    const res  = await request.get(`/api/admin/audit-log?auction_id=${auctionId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const found = (await res.json()).data.find(e => e.event_type === 'auction_rejected');
    expect(found, 'auction_rejected missing from audit_log').toBeTruthy();
    expect(found.metadata.reason).toBe(REJECT_REASON);
    expect(found.metadata.from_state).toBe('submitted');
    expect(found.actor_id).toBe(adminUserId);
  });

  test('notifications_queue has AUCTION_REJECTED (VERIFIED-DB or INFERRED-AUDIT)', async ({ request }) => {
    if (process.env.STAGING_DATABASE_URL) {
      const rows = await dbQuery(
        `SELECT type, payload, user_id, created_at
           FROM notifications_queue
          WHERE type = 'AUCTION_REJECTED'
            AND user_id = $1
            AND payload->>'auction_id' = $2
          ORDER BY created_at DESC`,
        [sellerUserId, auctionId]
      );
      expect(rows, 'dbQuery returned null — STAGING_DATABASE_URL set but pool unavailable').not.toBeNull();
      expect(rows.length, 'No AUCTION_REJECTED row found in notifications_queue').toBeGreaterThanOrEqual(1);
      const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
      expect(payload.reason).toBe(REJECT_REASON);
      report.notification_verification = 'VERIFIED-DB';
    } else {
      const res = await request.get(`/api/admin/audit-log?auction_id=${auctionId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const found = (await res.json()).data.find(e => e.event_type === 'auction_rejected');
      expect(found, 'audit_log proof of rejection missing — inference invalid').toBeTruthy();
      if (report.notification_verification !== 'VERIFIED-DB') {
        report.notification_verification = 'INFERRED-AUDIT';
      }
      report.notes.push('AUCTION_REJECTED inferred via audit_log transactional coupling — STAGING_DATABASE_URL not set');
    }
    mark('GOV-REJ reject', 'pass');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 8 — Seller sees rejection
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 8 — Seller sees rejection', () => {
  test('rejected banner visible with verbatim reason', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), sellerToken);
    await page.goto(`${BASE}/seller-dashboard.html`);
    const card = page.locator(`.auction-card[data-auction-id="${auctionId}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('This auction was not approved');
    await expect(card).toContainText(REJECT_REASON);
  });

  test('state badge reads Rejected (red)', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), sellerToken);
    await page.goto(`${BASE}/seller-dashboard.html`);
    const card = page.locator(`.auction-card[data-auction-id="${auctionId}"]`);
    await expect(card.locator('.badge-rejected')).toBeVisible({ timeout: 10_000 });
  });

  test('Add Lot and Submit buttons are NOT rendered on rejected card', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), sellerToken);
    await page.goto(`${BASE}/seller-dashboard.html`);
    const card = page.locator(`.auction-card[data-auction-id="${auctionId}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator(`[data-add-lot="${auctionId}"]`)).toHaveCount(0);
    await expect(card.locator(`[data-submit-auction="${auctionId}"]`)).toHaveCount(0);
  });

  test('seller PATCH on rejected auction → 403 (edit-lock holds)', async ({ request }) => {
    const res = await request.patch(`/api/auctions/${auctionId}`, {
      data: { title: 'Should not work' },
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    // canMutateAuction refuses for state != 'draft' on a private seller.
    expect(res.status(), `Expected 403 on rejected auction edit, got ${res.status()}`).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 9 — Admin audit timeline completeness
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 9 — Admin audit timeline', () => {
  test('audit-log endpoint returns the full Phase B lifecycle for this auction', async ({ request }) => {
    const res  = await request.get(`/api/admin/audit-log?auction_id=${auctionId}&limit=50`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const events = body.data;

    // Required events (counts allow for additional auction_updated noise).
    const types = events.map(e => e.event_type);
    expect(types.filter(t => t === 'auction_submitted').length,         '≥2 auction_submitted required').toBeGreaterThanOrEqual(2);
    expect(types.filter(t => t === 'auction_returned_to_draft').length, '≥1 auction_returned_to_draft required').toBeGreaterThanOrEqual(1);
    expect(types.filter(t => t === 'auction_updated').length,           '≥1 auction_updated (subtitle edit) required').toBeGreaterThanOrEqual(1);
    expect(types.filter(t => t === 'auction_rejected').length,          '=1 auction_rejected required').toBe(1);

    // Every event row carries auction scoping + non-null created_at.
    for (const e of events) {
      expect(e.entity_type, 'every audit row must have entity_type=auction').toBe('auction');
      expect(e.auction_id).toBe(auctionId);
      expect(e.created_at).toBeTruthy();
    }

    // Descending order: the rejection should appear before the second
    // submission, which should appear before the return-to-draft.
    const idxReject  = types.indexOf('auction_rejected');
    const idxReturn  = types.indexOf('auction_returned_to_draft');
    expect(idxReject, 'auction_rejected must be present').toBeGreaterThanOrEqual(0);
    expect(idxReturn, 'auction_returned_to_draft must be present').toBeGreaterThanOrEqual(0);
    expect(idxReject, 'auction_rejected (newer) must appear before auction_returned_to_draft (older) in DESC order').toBeLessThan(idxReturn);

    mark('AUD-EXP admin audit timeline', 'pass', `${events.length} events recorded`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 10 — Seller-side audit allow-list + cross-isolation
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 10 — Seller audit endpoint', () => {
  test('GET /api/sellers/me/audit returns allow-listed events for owned auction', async ({ request }) => {
    const res  = await request.get(`/api/sellers/me/audit?auction_id=${auctionId}&limit=50`, {
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const types = body.data.map(e => e.event_type);
    expect(types).toContain('auction_submitted');
    expect(types).toContain('auction_returned_to_draft');
    expect(types).toContain('auction_rejected');
    // Allow-list filter: auction_updated MUST NOT appear in the seller view.
    expect(types.includes('auction_updated'), 'auction_updated must be filtered out for seller view').toBe(false);
  });

  test('cross-isolation: seller cannot read another sellers audit (empty list, not 403)', async ({ request }) => {
    const res = await request.get(`/api/sellers/me/audit?auction_id=${OTHER_SELLER_AUCTION_ID}&limit=10`, {
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    expect(res.status(), 'must return 200 success — not 403 (would leak existence)').toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length, 'cross-seller audit must be empty list').toBe(0);
    mark('AUD-EXP seller audit endpoint', 'pass', 'allow-list filter + cross-isolation hold');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 11 — OPS-3 Suspension visibility (reversible)
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 11 — Suspension visibility', () => {
  test('admin POST /suspend → 200', async ({ request }) => {
    const res = await request.post(`/api/admin/sellers/${sellerProfileId}/suspend`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(200);
  });

  test('suspended seller login → 403 with suspension message', async ({ request }) => {
    const res = await request.post('/api/auth/login', { data: SELLER_CREDS });
    expect(res.status(), 'login must be refused while suspended').toBe(403);
    const body = await res.json();
    expect(body.error || body.message || '', 'suspension reason must be surfaced').toMatch(/suspend/i);
  });

  test('admin POST /unsuspend → 200', async ({ request }) => {
    const res = await request.post(`/api/admin/sellers/${sellerProfileId}/unsuspend`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(200);
  });

  test('unsuspended seller login → 200 with token', async ({ request }) => {
    const res = await request.post('/api/auth/login', { data: SELLER_CREDS });
    expect(res.status(), 'login must succeed after unsuspend').toBe(200);
    const body = await res.json();
    expect(body.token, 'token must be returned after unsuspend').toBeTruthy();
    mark('OPS-3 suspension', 'pass', 'suspend → 403 → unsuspend → 200 cycle holds');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 12 — Governance validation summary
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 12 — Summary', () => {
  test('emit stdout summary + HTML annotation + governance-summary.json', async () => {
    report.finished_at = new Date().toISOString();

    // Compute overall pass/fail. The notification_verification field is not a
    // pass/fail; it's a method indicator. Suspension/audit/govret/govrej all
    // map to results entries.
    const statuses = Object.values(report.results);
    const allPass  = statuses.every(s => s === 'pass');
    const anyFail  = statuses.some(s => s === 'fail');
    report.overall = anyFail ? 'fail' : (allPass ? 'pass' : 'partial');

    // ── Stdout block ──────────────────────────────────────────────────────
    const lines = [];
    lines.push('');
    lines.push('─────────────────────────────────────────────────────');
    lines.push('GOVERNANCE REGRESSION SUMMARY');
    lines.push('─────────────────────────────────────────────────────');
    lines.push(`Staging base URL : ${report.staging_base_url}`);
    lines.push(`Test auction     : ${report.auction_id}`);
    lines.push(`Seller           : ${report.test_seller}`);
    lines.push(`Admin            : ${report.test_admin}`);
    lines.push('');
    for (const [area, status] of Object.entries(report.results)) {
      const padded = area.padEnd(32, ' ');
      lines.push(`${padded}: ${status.toUpperCase()}`);
    }
    lines.push('');
    lines.push(`Notifications queue           : ${report.notification_verification}`);
    lines.push(`Overall                       : ${report.overall.toUpperCase()}`);
    lines.push('─────────────────────────────────────────────────────');
    if (report.notes.length) {
      lines.push('Notes:');
      for (const n of report.notes) lines.push(`  - ${n}`);
      lines.push('─────────────────────────────────────────────────────');
    }
    console.log(lines.join('\n'));

    // ── HTML annotation (surfaced by Playwright HTML reporter) ────────────
    test.info().annotations.push({
      type: 'summary',
      description: JSON.stringify(report, null, 2),
    });

    // ── JSON artifact ─────────────────────────────────────────────────────
    // Written at the repo root for easy operator access. Repo-relative path
    // resolved from CWD which Playwright sets to the project root.
    try {
      const outPath = path.resolve(process.cwd(), 'governance-summary.json');
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
      console.log(`Wrote governance summary: ${outPath}`);
    } catch (err) {
      // Non-fatal — stdout + HTML annotation already carry the same data.
      console.warn(`Could not write governance-summary.json: ${err.message}`);
    }

    // ── Final assertion: every governance area must pass ───────────────────
    const failed = Object.entries(report.results)
      .filter(([, s]) => s !== 'pass')
      .map(([k, s]) => `${k}=${s}`);
    expect(failed, `Governance areas did not all pass: ${failed.join(', ')}`).toEqual([]);
  });
});

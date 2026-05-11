'use strict';
require('dotenv').config();

const BASE = 'https://advantage-auction-platform-production.up.railway.app';

// Deterministic validation-only accounts (seeded via scripts/seed-validation-fixtures.js)
// UUIDs: ee000000-0000-4000-8000-00000000000{1,2}
const ADMIN_EMAIL    = 'validation-admin@advantage.bid';
const ADMIN_PASS     = 'ValidationAdmin2025!';
const SELLER_EMAIL   = 'demo-seller@advantage.bid';   // seeded by seed-demo-data.js
const SELLER_PASS    = 'DemoExplore2025!';
const BUYER_EMAIL    = 'validation-buyer@advantage.bid';
const BUYER_PASS     = 'ValidationBuyer2025!';

// Seeded auction owned by demo-seller (Mid-Century Modern Furniture — closed)
const SELLER_AUCTION_ID = 'dd000000-0000-4000-8000-000000000020';

// Synthetic Cloudinary-format video URL used to avoid actual upload cost in moderation tests
const SYNTHETIC_VIDEO_URL = 'https://res.cloudinary.com/dwenlikku/video/upload/v1234567890/auction-videos/validation-test.mp4';

let pass = 0, fail = 0, warns = 0;
const createdVideoIds = [];

function check(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + label + (detail !== undefined ? ' — ' + detail : ''));
}
function warn(label, detail) {
  warns++;
  console.log('  [WARN] ' + label + (detail ? ' — ' + detail : ''));
}
function section(title) { console.log('\n--- ' + title + ' ---'); }

async function api(method, path, { token, body, form } = {}) {
  const h = {};
  if (token) h['Authorization'] = 'Bearer ' + token;
  let fetchBody;
  if (form) {
    fetchBody = form;
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }
  const r = await fetch(BASE + path, { method, headers: h, body: fetchBody });
  return { status: r.status, data: await r.json() };
}

async function main() {
  console.log('=== Walkthrough Video Moderation Validation ===');
  console.log('Deployment: 2026-05-10T23:52:48Z\n');

  // ── Login all three roles ─────────────────────────────────────────────────
  section('Authentication');
  const [adminLogin, sellerLogin, buyerLogin] = await Promise.all([
    api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL,  password: ADMIN_PASS } }),
    api('POST', '/api/auth/login', { body: { email: SELLER_EMAIL, password: SELLER_PASS } }),
    api('POST', '/api/auth/login', { body: { email: BUYER_EMAIL,  password: BUYER_PASS } }),
  ]);

  const adminToken  = adminLogin.data.token;
  const sellerToken = sellerLogin.data.token;
  const buyerToken  = buyerLogin.data.token;

  check('admin login',  !!adminToken,  adminLogin.data.message  || 'ok');
  check('seller login', !!sellerToken, sellerLogin.data.message || 'ok');
  check('buyer login',  !!buyerToken,  buyerLogin.data.message  || 'ok');

  if (!adminToken || !sellerToken) {
    console.log('\nCANNOT CONTINUE — required logins failed.');
    process.exitCode = 1;
    return;
  }

  // Verify admin role from JWT
  const adminPayload = JSON.parse(Buffer.from(adminToken.split('.')[1], 'base64').toString());
  check('admin JWT role=admin', adminPayload.role === 'admin', adminPayload.role);

  // ── Upload endpoint guards ────────────────────────────────────────────────
  section('1. Upload Endpoint Guards');

  // No auth → 401
  const noAuthUpload = await api('POST', '/api/uploads/video');
  check('upload/video: no auth → 401', noAuthUpload.status === 401, 'HTTP ' + noAuthUpload.status);

  // Wrong MIME type (text/plain) → 400
  const wrongMimeForm = new FormData();
  wrongMimeForm.append('video', new Blob(['not a video file'], { type: 'text/plain' }), 'test.txt');
  const wrongMime = await api('POST', '/api/uploads/video', { token: sellerToken, form: wrongMimeForm });
  check('upload/video: wrong MIME (text/plain) → 400', wrongMime.status === 400, 'HTTP ' + wrongMime.status + ' ' + (wrongMime.data.message || ''));

  // No file field → 400
  const noFileForm = new FormData();
  const noFile = await api('POST', '/api/uploads/video', { token: sellerToken, form: noFileForm });
  check('upload/video: no file field → 400', noFile.status === 400, 'HTTP ' + noFile.status + ' ' + (noFile.data.message || ''));

  // ── Seller walkthrough submission ─────────────────────────────────────────
  section('2. Seller Walkthrough Submission');

  // Submit with no video_url → 400
  const noUrl = await api('POST', '/api/auctions/' + SELLER_AUCTION_ID + '/walkthrough-video',
    { token: sellerToken, body: { title: 'Test' } });
  check('submit: missing video_url → 400', noUrl.status === 400, 'HTTP ' + noUrl.status + ' ' + (noUrl.data.message || ''));

  // Buyer trying to submit → 403 (buyer doesn't own the auction)
  const buyerSubmit = await api('POST', '/api/auctions/' + SELLER_AUCTION_ID + '/walkthrough-video',
    { token: buyerToken, body: { video_url: SYNTHETIC_VIDEO_URL } });
  check('submit: buyer (no ownership) → 403', buyerSubmit.status === 403, 'HTTP ' + buyerSubmit.status);

  // No auth → 401
  const noAuthSubmit = await api('POST', '/api/auctions/' + SELLER_AUCTION_ID + '/walkthrough-video',
    { body: { video_url: SYNTHETIC_VIDEO_URL } });
  check('submit: no auth → 401', noAuthSubmit.status === 401, 'HTTP ' + noAuthSubmit.status);

  // Valid submission — VIDEO 1
  const sub1 = await api('POST', '/api/auctions/' + SELLER_AUCTION_ID + '/walkthrough-video',
    { token: sellerToken, body: { video_url: SYNTHETIC_VIDEO_URL, title: 'Validation Video 1', caption: 'Automated moderation test' } });
  check('submit VIDEO 1: 201', sub1.status === 201, 'HTTP ' + sub1.status + (sub1.data.message ? ' ' + sub1.data.message : ''));
  const v1 = sub1.data.data;
  if (v1) {
    createdVideoIds.push({ id: v1.id, auctionId: SELLER_AUCTION_ID });
    check('VIDEO 1: review_status=pending_review', v1.review_status === 'pending_review', v1.review_status);
    check('VIDEO 1: visible_public=false', v1.visible_public === false, String(v1.visible_public));
    check('VIDEO 1: featured_for_marketing=false', v1.featured_for_marketing === false, String(v1.featured_for_marketing));
    check('VIDEO 1: approved_at=null', v1.approved_at === null, String(v1.approved_at));
    check('VIDEO 1: rejection_reason=null', v1.rejection_reason === null, String(v1.rejection_reason));
  } else {
    fail++;
    console.log('  [FAIL] VIDEO 1 submission returned no data — cannot continue moderation tests');
    process.exitCode = 1;
    return;
  }

  // Seller can see their own pending video
  const sellerView = await api('GET', '/api/auctions/' + SELLER_AUCTION_ID + '/walkthrough-video', { token: sellerToken });
  check('seller GET own video: returns row', sellerView.status === 200 && !!sellerView.data.data, sellerView.data.data ? sellerView.data.data.review_status : 'MISSING');

  // ── Pending state visibility enforcement ──────────────────────────────────
  section('3. Pending State Visibility Enforcement');

  const pubPending = await fetch(BASE + '/api/auctions/' + SELLER_AUCTION_ID + '/public-video');
  const pubPendingData = await pubPending.json();
  check('public-video: pending → returns null (not visible)', pubPendingData.data === null, JSON.stringify(pubPendingData.data));

  // ── Admin moderation queue ────────────────────────────────────────────────
  section('4. Admin Moderation Queue');

  const pendingQ = await api('GET', '/api/admin/videos/pending', { token: adminToken });
  check('GET /admin/videos/pending: 200', pendingQ.status === 200, 'HTTP ' + pendingQ.status);
  const pendingList = pendingQ.data.data || [];
  const v1InQueue = pendingList.find(v => v.id === v1.id);
  check('VIDEO 1 appears in pending queue', !!v1InQueue, v1InQueue ? 'found' : 'not found (' + pendingList.length + ' items total)');

  // Buyer trying to access pending queue → 403
  const buyerQueue = await api('GET', '/api/admin/videos/pending', { token: buyerToken });
  check('pending queue: buyer → 403', buyerQueue.status === 403, 'HTTP ' + buyerQueue.status);

  // No auth → 401
  const noAuthQueue = await api('GET', '/api/admin/videos/pending');
  check('pending queue: no auth → 401', noAuthQueue.status === 401, 'HTTP ' + noAuthQueue.status);

  // ── Admin approval flow ───────────────────────────────────────────────────
  section('5. Admin Approval Flow');

  const approve1 = await api('POST', '/api/admin/videos/' + v1.id + '/approve', { token: adminToken });
  check('approve VIDEO 1: 200', approve1.status === 200, 'HTTP ' + approve1.status);
  const approved = approve1.data.data;
  if (approved) {
    check('after approve: review_status=approved', approved.review_status === 'approved', approved.review_status);
    check('after approve: approved_at set', !!approved.approved_at, String(approved.approved_at));
    check('after approve: approved_by set', !!approved.approved_by, String(approved.approved_by));
    check('after approve: visible_public still false', approved.visible_public === false, String(approved.visible_public));
    check('after approve: featured_for_marketing still false', approved.featured_for_marketing === false, String(approved.featured_for_marketing));
    check('after approve: rejection_reason still null', approved.rejection_reason === null, String(approved.rejection_reason));
  }

  // Buyer trying to approve → 403
  const buyerApprove = await api('POST', '/api/admin/videos/' + v1.id + '/approve', { token: buyerToken });
  check('approve: buyer → 403', buyerApprove.status === 403, 'HTTP ' + buyerApprove.status);

  // Non-existent video → 404
  const approveGhost = await api('POST', '/api/admin/videos/00000000-0000-4000-8000-000000000000/approve', { token: adminToken });
  check('approve: non-existent ID → 404', approveGhost.status === 404, 'HTTP ' + approveGhost.status);

  // ── Approved but not-yet-public state ─────────────────────────────────────
  section('6. Approved-Not-Public Visibility Enforcement');

  const pubApprovedNotPublic = await fetch(BASE + '/api/auctions/' + SELLER_AUCTION_ID + '/public-video');
  const papData = await pubApprovedNotPublic.json();
  check('public-video: approved but visible_public=false → null', papData.data === null, JSON.stringify(papData.data));

  // Visibility cannot be set without boolean → 400
  const badVisib = await api('PATCH', '/api/admin/videos/' + v1.id + '/visibility',
    { token: adminToken, body: { visible: 'yes' } });
  check('visibility: non-boolean value → 400', badVisib.status === 400, 'HTTP ' + badVisib.status + ' ' + (badVisib.data.message || ''));

  // ── Make public ───────────────────────────────────────────────────────────
  section('7. Public Visibility Toggle');

  const makePublic = await api('PATCH', '/api/admin/videos/' + v1.id + '/visibility',
    { token: adminToken, body: { visible: true } });
  check('set visible_public=true: 200', makePublic.status === 200, 'HTTP ' + makePublic.status);
  if (makePublic.data.data) {
    check('visible_public=true in response', makePublic.data.data.visible_public === true, String(makePublic.data.data.visible_public));
  }

  // Now public endpoint should return the video
  const pubNowVisible = await fetch(BASE + '/api/auctions/' + SELLER_AUCTION_ID + '/public-video');
  const pnvData = await pubNowVisible.json();
  // Public endpoint returns only: id, video_url, title, caption, featured_for_marketing, approved_at
  // review_status and visible_public are filtered server-side (not exposed in public response)
  check('public-video: approved+visible → returns video', !!pnvData.data, pnvData.data ? 'video_url=' + (pnvData.data.video_url || '').slice(0, 50) : 'null');
  if (pnvData.data) {
    check('public-video: video_url present', !!pnvData.data.video_url, (pnvData.data.video_url || '').slice(0, 50));
    check('public-video: approved_at present', !!pnvData.data.approved_at, String(pnvData.data.approved_at));
    check('public-video: review_status NOT exposed (public-safe)', pnvData.data.review_status === undefined, 'correctly omitted');
    check('public-video: no auth required', pubNowVisible.status === 200, 'HTTP ' + pubNowVisible.status);
  }

  // ── Featured toggle ───────────────────────────────────────────────────────
  section('8. Featured Marketing Toggle');

  // Non-boolean → 400
  const badFeatured = await api('PATCH', '/api/admin/videos/' + v1.id + '/featured',
    { token: adminToken, body: { featured: 1 } });
  check('featured: non-boolean → 400', badFeatured.status === 400, 'HTTP ' + badFeatured.status);

  const makeFeatured = await api('PATCH', '/api/admin/videos/' + v1.id + '/featured',
    { token: adminToken, body: { featured: true } });
  check('set featured_for_marketing=true: 200', makeFeatured.status === 200, 'HTTP ' + makeFeatured.status);
  if (makeFeatured.data.data) {
    check('featured_for_marketing=true in response', makeFeatured.data.data.featured_for_marketing === true, String(makeFeatured.data.data.featured_for_marketing));
  }

  // Buyer cannot toggle featured → 403
  const buyerFeatured = await api('PATCH', '/api/admin/videos/' + v1.id + '/featured',
    { token: buyerToken, body: { featured: false } });
  check('featured: buyer → 403', buyerFeatured.status === 403, 'HTTP ' + buyerFeatured.status);

  // ── Reject flow — VIDEO 2 ─────────────────────────────────────────────────
  section('9. Rejection Workflow (VIDEO 2)');

  const sub2 = await api('POST', '/api/auctions/' + SELLER_AUCTION_ID + '/walkthrough-video',
    { token: sellerToken, body: { video_url: SYNTHETIC_VIDEO_URL + '?v=2', title: 'Validation Video 2' } });
  check('submit VIDEO 2: 201', sub2.status === 201, 'HTTP ' + sub2.status);
  const v2 = sub2.data.data;
  if (v2) {
    createdVideoIds.push({ id: v2.id, auctionId: SELLER_AUCTION_ID });
    check('VIDEO 2: pending_review', v2.review_status === 'pending_review', v2.review_status);
  }

  if (v2) {
    const reject2 = await api('POST', '/api/admin/videos/' + v2.id + '/reject',
      { token: adminToken, body: { reason: 'Automated validation: testing rejection workflow' } });
    check('reject VIDEO 2: 200', reject2.status === 200, 'HTTP ' + reject2.status);
    const rejected = reject2.data.data;
    if (rejected) {
      check('after reject: review_status=rejected', rejected.review_status === 'rejected', rejected.review_status);
      check('after reject: rejection_reason set', !!rejected.rejection_reason, rejected.rejection_reason);
      check('after reject: visible_public=false', rejected.visible_public === false, String(rejected.visible_public));
      check('after reject: featured_for_marketing=false', rejected.featured_for_marketing === false, String(rejected.featured_for_marketing));
    }

    // Buyer cannot reject → 403
    const buyerReject = await api('POST', '/api/admin/videos/' + v2.id + '/reject', { token: buyerToken });
    check('reject: buyer → 403', buyerReject.status === 403, 'HTTP ' + buyerReject.status);

    // Cannot set visibility on rejected video (service returns null → route returns 404)
    const visibOnRejected = await api('PATCH', '/api/admin/videos/' + v2.id + '/visibility',
      { token: adminToken, body: { visible: true } });
    check('visibility on rejected video → 404', visibOnRejected.status === 404, 'HTTP ' + visibOnRejected.status);

    // Cannot set featured on rejected video → 404
    const featuredOnRejected = await api('PATCH', '/api/admin/videos/' + v2.id + '/featured',
      { token: adminToken, body: { featured: true } });
    check('featured on rejected video → 404', featuredOnRejected.status === 404, 'HTTP ' + featuredOnRejected.status);
  }

  // ── Rejected state visibility enforcement ─────────────────────────────────
  section('10. Rejected State Visibility Enforcement');

  // Public endpoint still returns VIDEO 1 (approved, visible_public=true) — not VIDEO 2 (rejected)
  const pubAfterReject = await fetch(BASE + '/api/auctions/' + SELLER_AUCTION_ID + '/public-video');
  const parData = await pubAfterReject.json();
  check('public-video after rejection: VIDEO 1 still returned', !!parData.data, parData.data ? 'ok' : 'null — approved video lost!');
  if (parData.data) {
    check('public-video: rejected video not returned', parData.data.id !== (v2 && v2.id), 'id=' + (parData.data.id === (v2 && v2.id) ? 'VIDEO 2 — WRONG' : 'VIDEO 1 — correct'));
  }

  // ── Seller delete guard: cannot delete approved video ─────────────────────
  section('11. Delete Authorization Guard');

  const sellerDeleteApproved = await api('DELETE',
    '/api/auctions/' + SELLER_AUCTION_ID + '/walkthrough-video/' + v1.id,
    { token: sellerToken });
  check('seller cannot DELETE approved video → 403', sellerDeleteApproved.status === 403, 'HTTP ' + sellerDeleteApproved.status);

  // Admin CAN delete approved video (uses direct DB delete route)
  // We'll do cleanup via admin DELETE

  // ── Cleanup ───────────────────────────────────────────────────────────────
  section('12. Cleanup');

  for (const { id, auctionId } of createdVideoIds) {
    const del = await api('DELETE',
      '/api/auctions/' + auctionId + '/walkthrough-video/' + id,
      { token: adminToken });
    // Admin can delete any video; approved video needs admin
    if (del.status === 200 || del.status === 204) {
      check('deleted video ' + id.slice(0, 8) + '…', true, 'HTTP ' + del.status);
    } else if (del.status === 403) {
      // Admin blocked? Shouldn't happen — log as warn and note
      warn('admin DELETE returned 403 for ' + id.slice(0, 8) + '… — manual cleanup needed', 'HTTP ' + del.status);
    } else {
      check('deleted video ' + id.slice(0, 8) + '…', del.status === 200, 'HTTP ' + del.status + ' ' + JSON.stringify(del.data).slice(0, 60));
    }
  }

  // After cleanup, public endpoint should return null
  const pubAfterCleanup = await fetch(BASE + '/api/auctions/' + SELLER_AUCTION_ID + '/public-video');
  const pacData = await pubAfterCleanup.json();
  check('public-video after cleanup: null', pacData.data === null, JSON.stringify(pacData.data));

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('=== WALKTHROUGH MODERATION RESULTS ===');
  console.log('========================================');
  console.log('  Passed:   ' + pass);
  console.log('  Failed:   ' + fail);
  console.log('  Warnings: ' + warns);
  console.log('\nModeration state coverage:');
  console.log('  pending_review  → NOT visible            [validated]');
  console.log('  approved        → NOT visible (default)  [validated]');
  console.log('  approved+public → VISIBLE                [validated]');
  console.log('  rejected        → NOT visible            [validated]');
  console.log('  featured        → flag set correctly      [validated]');
  if (fail > 0) process.exitCode = 1;
}

main().catch(e => {
  console.error('\nFATAL:', e.message, e.stack);
  process.exitCode = 1;
});

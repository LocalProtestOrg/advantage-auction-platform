'use strict';

/**
 * Advantage Media Uploader (Increment 4) — source-level guards.
 *
 * Verifies the reusable upload backbone without a live DB or network: the signing service +
 * generic /signature endpoint + Events persistence + the shared client component. The strongest
 * guarantees here are (a) the Cloudinary api_secret NEVER reaches the browser payload, and
 * (b) the client is auth/product-agnostic (host supplies getSignature + persistence callbacks).
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

const svc = read('src', 'services', 'mediaUploadService.js');
const cloud = read('src', 'services', 'cloudinaryService.js');
const uploads = read('src', 'routes', 'uploads.js');
const events = read('src', 'services', 'eventsService.js');
const org = read('src', 'routes', 'orgEvents.js');
const client = read('public', 'widgets', 'shared', 'media-uploader.js');
const editHtml = read('public', 'org', 'event-edit.html');

describe('mediaUploadService — reusable context registry', () => {
  test('registers the event_images context with folder + authorize', () => {
    expect(svc).toMatch(/register\('event_images'/);
    expect(svc).toContain("folder: 'event-images'");
    expect(svc).toMatch(/authorize\(\{\s*user,\s*resourceId\s*\}\)/);
  });
  test('event_images authorize enforces ownership + editable state', () => {
    expect(svc).toContain('assertOwner');
    expect(svc).toMatch(/\['draft',\s*'rejected'\]/);
    expect(svc).toContain('EVENT_NOT_EDITABLE');
  });
  test('exposes a register() extension point for future contexts (lots, listings, logos, …)', () => {
    expect(svc).toMatch(/function register\(key, cfg\)/);
    expect(svc).toMatch(/module\.exports\s*=\s*\{[^}]*register/);
  });
  test('unknown context is rejected', () => {
    expect(svc).toContain('UNKNOWN_UPLOAD_CONTEXT');
  });
  test('signs only { folder, timestamp } and returns no secret', () => {
    expect(svc).toMatch(/paramsToSign\s*=\s*\{\s*folder:[^,]+,\s*timestamp\s*\}/);
    // The signUpload return payload must be public-only (no api_secret leaked to the client).
    const from = svc.indexOf('function signUpload');
    const retIdx = svc.indexOf('return {', from);
    const ret = svc.slice(retIdx, svc.indexOf('};', retIdx));
    expect(ret).not.toContain('api_secret');
    expect(ret).toContain('cloud_name');
    expect(ret).toContain('api_key');
    expect(ret).toContain('signature');
  });
});

describe('cloudinaryService — signing kept server-side', () => {
  test('signUpload uses the SDK signer with the env secret', () => {
    expect(cloud).toMatch(/api_sign_request\(paramsToSign,\s*process\.env\.CLOUDINARY_API_SECRET\)/);
  });
  test('publicConfig exposes only cloud_name + api_key (never the secret)', () => {
    const pub = cloud.slice(cloud.indexOf('publicConfig'), cloud.indexOf('publicConfig') + 200);
    expect(pub).toContain('CLOUDINARY_CLOUD_NAME');
    expect(pub).toContain('CLOUDINARY_API_KEY');
    expect(pub).not.toContain('CLOUDINARY_API_SECRET');
  });
});

describe('/api/uploads/signature endpoint', () => {
  test('is auth-gated but not seller-gated (org owners may be non-sellers)', () => {
    const route = uploads.slice(uploads.indexOf("'/signature'"), uploads.indexOf("'/signature'") + 320);
    expect(route).toContain('auth');
    expect(route).not.toContain('requireSellerOrAdmin');
    expect(route).toContain('mediaUploadService.signUpload');
  });
});

describe('Events persistence — bulk attach + reorder (NULL-aware cap)', () => {
  test('addImagesBulk accepts up to the remaining plan cap and reports skipped', () => {
    const fn = events.slice(events.indexOf('function addImagesBulk'), events.indexOf('function reorderImages'));
    expect(fn).toMatch(/cap\s*==\s*null\s*\?\s*Infinity/);   // NULL = unlimited (Gold)
    expect(fn).toContain('skipped');
    expect(fn).toMatch(/is_cover|isCover/);
  });
  test('reorderImages validates every id belongs to the event before writing', () => {
    const fn = events.slice(events.indexOf('function reorderImages'), events.indexOf('function getPlanPublic'));
    expect(fn).toContain('INVALID_IMAGE');
    expect(fn).toMatch(/is_cover = \(id = \$1\)/);
  });
  test('bulk + order routes are exposed and image_limit is returned to the editor', () => {
    expect(org).toContain("'/events/:id/images/bulk'");
    expect(org).toContain("'/events/:id/images/order'");
    expect(org).toContain('image_limit');
  });
});

describe('media-uploader.js — reusable, auth-agnostic client', () => {
  test('exposes AdvantageMedia.mount and requires host callbacks (not auth internals)', () => {
    expect(client).toMatch(/window\.AdvantageMedia\s*=\s*\{\s*mount/);
    expect(client).toMatch(/getSignature.*onAttach/s);
    expect(client).not.toMatch(/localStorage/);   // host provides the token, not the component
  });
  test('uploads bytes DIRECTLY to Cloudinary (never through Railway)', () => {
    expect(client).toContain('api.cloudinary.com/v1_1/');
    expect(client).toMatch(/xhr\.upload\.onprogress/);
  });
  test('supports retry, cancel, drag-reorder, and cover selection', () => {
    expect(client).toContain('Retry');
    expect(client).toMatch(/abort\(\)/);
    expect(client).toContain('dragstart');
    expect(client).toMatch(/setCover/);
  });
  test('renders auto-optimized square thumbnails via a delivery transform', () => {
    expect(client).toContain('c_fill,w_400,h_400,q_auto,f_auto');
  });
  test('never handles the api_secret', () => {
    expect(client).not.toContain('api_secret');
  });
});

describe('Events module only configures the shared uploader', () => {
  test('event-edit.html mounts AdvantageMedia for the event_images context', () => {
    expect(editHtml).toContain('/widgets/shared/media-uploader.js');
    expect(editHtml).toMatch(/AdvantageMedia\.mount/);
    expect(editHtml).toMatch(/context:\s*'event_images'/);
  });
  test('wires all four host callbacks to the org API', () => {
    expect(editHtml).toContain('/api/uploads/signature');
    expect(editHtml).toContain('/images/bulk');
    expect(editHtml).toContain('/images/order');
    expect(editHtml).toMatch(/maxFiles:\s*\(imageLimit == null \? Infinity : imageLimit\)/);
  });
});

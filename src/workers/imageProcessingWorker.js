'use strict';

/**
 * Image processing worker.
 *
 * Polls image_processing_jobs for pending work on a fixed interval.
 * Currently simulates processing with a short delay — no real AI calls yet.
 *
 * Lifecycle: pending → processing → complete (or failed)
 *
 * Run standalone:
 *   node src/workers/imageProcessingWorker.js
 *
 * TODO: remove.bg — replace simulateProcessing() with real API call
 * TODO: Replicate — route 'drop_shadow' and 'full_enhancement' jobs to Replicate
 * TODO: Cloudinary AI — route 'auto_crop' and 'lighting_cleanup' to Cloudinary transforms
 * TODO: retry logic — re-queue failed jobs up to MAX_ATTEMPTS before permanent failure
 * TODO: concurrency cap — limit parallel in-flight jobs to avoid provider rate limits
 */

require('dotenv').config();

const db                     = require('../db');
const imageProcessingService = require('../services/imageProcessingService');
require('../services/cloudinaryService'); // configures cloudinary.v2 credentials
const { v2: cloudinary }     = require('cloudinary');

const POLL_INTERVAL_MS = 5000;
const BATCH_SIZE       = 5;

// Cloudinary transform strings per enhancement type.
// Transforms are applied at CDN delivery time — no extra API call required.
const CLOUDINARY_TRANSFORMS = {
  background_removal: 'e_background_removal,q_auto,f_auto',
  white_background:   'e_background_removal,b_white,q_auto,f_auto',
  drop_shadow:        'e_improve,e_shadow:40,q_auto,f_auto',
  auto_crop:          'e_improve,g_auto,c_fill,w_800,h_800,q_auto,f_auto',
  lighting_cleanup:   'e_improve,e_sharpen:50,q_auto,f_auto',
  full_enhancement:   'e_improve,e_sharpen:50,e_auto_contrast,q_auto,f_auto',
};

function buildProcessedUrl(job) {
  const { original_image_url: url, enhancement_type: type } = job;
  if (!url || !url.includes('res.cloudinary.com')) return url;
  const transform = CLOUDINARY_TRANSFORMS[type] || 'e_improve,q_auto,f_auto';
  return url.replace('/upload/', `/upload/${transform}/`);
}

// Raw transformation strings for Cloudinary explicit() API calls.
// Chained with / so background is set after transparency is created.
const EAGER_TYPES = {
  background_removal: 'e_background_removal/q_auto,f_auto',
  white_background:   'e_background_removal/b_white,q_auto,f_auto',
};

// Extract Cloudinary public_id from a secure_url.
// e.g. https://res.cloudinary.com/cloud/image/upload/v1234/lot-images/abc.jpg → lot-images/abc
function extractPublicId(url) {
  const idx = url.indexOf('/upload/');
  if (idx === -1) return null;
  let path = url.slice(idx + '/upload/'.length);
  path = path.replace(/^v\d+\//, '');  // strip version prefix
  return path.replace(/\.[^.]+$/, ''); // strip file extension
}

// Trigger the Cloudinary transformation via explicit() API so the result is
// pre-generated and immediately available in CDN cache when the frontend loads it.
// Falls back to URL-based transform string if the API call fails.
async function processWithCloudinary(job) {
  const { original_image_url: url, enhancement_type: type } = job;
  const rawTransform = EAGER_TYPES[type];

  if (!url || !url.includes('res.cloudinary.com') || !rawTransform) {
    return buildProcessedUrl(job);
  }

  const publicId = extractPublicId(url);
  if (!publicId) return buildProcessedUrl(job);

  try {
    const result = await cloudinary.uploader.explicit(publicId, {
      type:  'upload',
      eager: [{ raw_transformation: rawTransform }],
    });
    const processed = result?.eager?.[0]?.secure_url;
    if (processed) {
      console.log(`[img-worker] Cloudinary ${type} applied via explicit() API`);
      return processed;
    }
  } catch (err) {
    console.warn(`[img-worker] Cloudinary explicit() failed for job ${job.id}: ${err.message} — falling back to URL transform`);
  }

  return buildProcessedUrl(job);
}

// ── Process a single job ──────────────────────────────────────────────────────
async function processOne(job) {
  console.log(`[img-worker] Processing job ${job.id} | type=${job.enhancement_type} | lot=${job.lot_temp_id || 'none'}`);

  const claimed = await imageProcessingService.markProcessing(job.id);
  if (!claimed) {
    // Another worker instance claimed it first — skip safely
    console.log(`[img-worker] Job ${job.id} already claimed, skipping`);
    return;
  }

  try {
    const processedUrl = await processWithCloudinary(job);
    const completed    = await imageProcessingService.markComplete(job.id, processedUrl);
    console.log(`[img-worker] Job ${job.id} complete → ${completed?.processed_image_url}`);
  } catch (err) {
    console.error(`[img-worker] Job ${job.id} failed:`, err.message);
    await imageProcessingService.markFailed(job.id, err.message).catch(updateErr => {
      console.error(`[img-worker] Could not mark job ${job.id} as failed:`, updateErr.message);
    });
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
async function poll() {
  let jobs;
  try {
    jobs = await imageProcessingService.getPendingJobs(BATCH_SIZE);
  } catch (err) {
    console.error('[img-worker] Failed to query pending jobs:', err.message);
    return;
  }

  if (!jobs.length) return;

  console.log(`[img-worker] Found ${jobs.length} pending job(s)`);

  // Process sequentially to keep simulated output readable in logs;
  // switch to Promise.allSettled() when real concurrency is needed.
  for (const job of jobs) {
    await processOne(job);
  }
}

// ── Stuck-job recovery ────────────────────────────────────────────────────────
// On restart, any job left in 'processing' from a previous crashed run will
// never be retried because getPendingJobs() only fetches 'pending' rows.
// Jobs created >10 minutes ago that are still 'processing' are definitively
// orphaned and safe to reset back to 'pending'.
async function recoverStuckJobs() {
  try {
    const { rowCount } = await db.query(
      `UPDATE image_processing_jobs
          SET status = 'pending'
        WHERE status    = 'processing'
          AND created_at < NOW() - INTERVAL '10 minutes'`
    );
    if (rowCount > 0) {
      console.log(`[img-worker] Recovered ${rowCount} stuck job(s) → pending`);
    }
  } catch (err) {
    console.error('[img-worker] Stuck job recovery failed:', err.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
console.log(`[img-worker] Started — polling every ${POLL_INTERVAL_MS / 1000}s, batch size ${BATCH_SIZE}`);
setInterval(poll, POLL_INTERVAL_MS);

// Recover orphaned jobs from any previous crash, then run first poll immediately.
recoverStuckJobs().then(() => poll());

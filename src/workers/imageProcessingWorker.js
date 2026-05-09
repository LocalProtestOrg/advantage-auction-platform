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

const POLL_INTERVAL_MS  = 5000;
const BATCH_SIZE        = 5;
const SIMULATED_DELAY_MS = 2000; // simulate AI processing time

// ── Simulated provider dispatch ───────────────────────────────────────────────
// Returns the URL that a real provider would produce. Placeholder for now.
async function simulateProcessing(job) {
  return new Promise((resolve) => {
    setTimeout(() => {
      // TODO: replace with actual provider API response URL
      resolve(`${job.original_image_url}?enhanced=1&type=${job.enhancement_type}`);
    }, SIMULATED_DELAY_MS);
  });
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
    const processedUrl = await simulateProcessing(job);
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

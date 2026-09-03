const db = require('../db');
const marketingQueue = require('./marketingQueueService');

/**
 * Durably enqueue a marketing job for the (future) autonomous worker. Pass a `client` to make the enqueue
 * atomic with the caller's transaction (required for financial/publishing jobs — never fire-and-forget).
 * Phase 3A only RECORDS the job; no worker executes it (autonomous marketing is not activated).
 */
async function triggerMarketingWorkflow(job, client = null) {
  try {
    await marketingQueue.enqueue(client, {
      jobType: 'marketing.prepare_campaign',
      payload: { job_id: job.id, auction_id: job.auction_id, package_type: job.package_type, target_radius_miles: job.target_radius_miles ?? 30 },
      idempotencyKey: 'marketing-job:' + job.id,
    });
  } catch (err) {
    console.error('[marketingWorkflow] durable enqueue failed:', err.message);
  }
  return prepareCampaignPreview(job);
}

// Read-only campaign PREVIEW assembly (no publishing, no spend). Retained for diagnostics/preview.
async function prepareCampaignPreview(job) {
  try {
    // Fetch auction details
    const auctionRes = await db.query(
      'SELECT title, description FROM auctions WHERE id = $1',
      [job.auction_id]
    );
    const auction = auctionRes.rows[0] || {};

    // Fetch up to 3 images from lots belonging to this auction.
    // Falls back to empty array if the images table doesn't exist yet.
    let images = [];
    try {
      const imageRes = await db.query(
        `SELECT i.url
         FROM images i
         JOIN lots l ON i.lot_id = l.id
         WHERE l.auction_id = $1 AND i.url IS NOT NULL AND i.status = 'processed'
         ORDER BY i.uploaded_at ASC
         LIMIT 3`,
        [job.auction_id]
      );
      images = imageRes.rows.map(r => r.url);
    } catch {
      // images table not yet migrated — use stubs
      images = ['[stub-image-1]', '[stub-image-2]', '[stub-image-3]'];
    }

    const payload = {
      job_id:              job.id,
      auction_id:          job.auction_id,
      package_type:        job.package_type,
      title:               auction.title    || null,
      description:         auction.description || null,
      images,
      target_radius_miles: job.target_radius_miles ?? 30
    };

    return payload;
  } catch (err) {
    console.error('[marketingWorkflow] failed to prepare campaign preview:', err.message);
    return null;
  }
}

module.exports = { triggerMarketingWorkflow, prepareCampaignPreview };

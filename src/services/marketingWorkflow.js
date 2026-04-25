const db = require('../db');

async function triggerMarketingWorkflow(job) {
  console.log(`[marketingWorkflow] job triggered: id=${job.id} auction_id=${job.auction_id} package_type=${job.package_type}`);

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

    console.log('[marketingWorkflow] prepared campaign:', JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[marketingWorkflow] failed to prepare campaign:', err.message);
  }
}

module.exports = { triggerMarketingWorkflow };

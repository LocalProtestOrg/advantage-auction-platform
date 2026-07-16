'use strict';

const db = require('../db');

// ── Seller-facing ─────────────────────────────────────────────────────────────

async function createVideo(auctionId, { videoUrl, title, caption }) {
  const { rows } = await db.query(
    `INSERT INTO auction_walkthrough_videos
       (auction_id, video_url, title, caption, review_status, visible_public, featured_for_marketing)
     VALUES ($1, $2, $3, $4, 'pending_review', false, false)
     RETURNING *`,
    [auctionId, videoUrl, title || null, caption || null]
  );
  return rows[0];
}

async function getVideoForAuction(auctionId) {
  const { rows } = await db.query(
    `SELECT * FROM auction_walkthrough_videos
      WHERE auction_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [auctionId]
  );
  return rows[0] || null;
}

async function deleteVideo(videoId) {
  const { rows } = await db.query(
    'DELETE FROM auction_walkthrough_videos WHERE id = $1 RETURNING id',
    [videoId]
  );
  return rows[0] || null;
}

// ── Admin-facing ──────────────────────────────────────────────────────────────

// Approve a video — sets review_status, approved_at, approved_by, and PUBLISHES it.
// #3 (approved business rule): normal Queue approval must result in a publicly
// available walkthrough without a second manual "Make Public" step, so approval
// sets visible_public = true. The separate setPublicVisibility action is preserved
// so an admin can later hide/re-show an already-approved video when needed.
async function approveVideo(videoId, adminUserId) {
  const { rows } = await db.query(
    `UPDATE auction_walkthrough_videos
        SET review_status = 'approved',
            approved_at   = NOW(),
            approved_by   = $2,
            rejection_reason = NULL,
            visible_public = true,
            updated_at    = NOW()
      WHERE id = $1
     RETURNING *`,
    [videoId, adminUserId]
  );
  return rows[0] || null;
}

// Reject a video with an optional reason.
// Also clears visible_public and featured_for_marketing.
async function rejectVideo(videoId, adminUserId, reason) {
  const { rows } = await db.query(
    `UPDATE auction_walkthrough_videos
        SET review_status          = 'rejected',
            rejection_reason       = $2,
            visible_public         = false,
            featured_for_marketing = false,
            approved_at            = NULL,
            approved_by            = $3,
            updated_at             = NOW()
      WHERE id = $1
     RETURNING *`,
    [videoId, reason || null, adminUserId]
  );
  return rows[0] || null;
}

// Set public visibility — only allowed after review_status = 'approved'.
async function setPublicVisibility(videoId, visible) {
  const { rows } = await db.query(
    `UPDATE auction_walkthrough_videos
        SET visible_public = $2,
            updated_at     = NOW()
      WHERE id = $1 AND review_status = 'approved'
     RETURNING *`,
    [videoId, Boolean(visible)]
  );
  return rows[0] || null;
}

// Set marketing feature flag — only allowed after review_status = 'approved'.
async function setFeaturedForMarketing(videoId, featured) {
  const { rows } = await db.query(
    `UPDATE auction_walkthrough_videos
        SET featured_for_marketing = $2,
            updated_at             = NOW()
      WHERE id = $1 AND review_status = 'approved'
     RETURNING *`,
    [videoId, Boolean(featured)]
  );
  return rows[0] || null;
}

// List all pending videos (admin queue).
async function getPendingVideos(limit = 50) {
  const { rows } = await db.query(
    `SELECT v.*, a.title AS auction_title
       FROM auction_walkthrough_videos v
       JOIN auctions a ON a.id = v.auction_id
      WHERE v.review_status = 'pending_review'
      ORDER BY v.created_at ASC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

// List all videos with an optional review_status filter (admin use).
async function listAllVideos(status, limit = 100) {
  const validStatuses = ['pending_review', 'approved', 'rejected'];
  const params = [];
  let where = '';
  if (status && validStatuses.includes(status)) {
    params.push(status);
    where = 'WHERE v.review_status = $1';
  }
  params.push(Math.min(limit, 500));
  const { rows } = await db.query(
    `SELECT v.*, a.title AS auction_title
       FROM auction_walkthrough_videos v
       JOIN auctions a ON a.id = v.auction_id
     ${where}
     ORDER BY v.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

// List all approved + publicly visible videos (e.g. for homepage or marketing).
async function getPublicVideos(limit = 20) {
  const { rows } = await db.query(
    `SELECT v.*, a.title AS auction_title
       FROM auction_walkthrough_videos v
       JOIN auctions a ON a.id = v.auction_id
      WHERE v.visible_public = true
        AND v.review_status  = 'approved'
      ORDER BY v.approved_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

// List videos eligible for marketing promotion.
async function getMarketingVideos(limit = 20) {
  const { rows } = await db.query(
    `SELECT v.*, a.title AS auction_title
       FROM auction_walkthrough_videos v
       JOIN auctions a ON a.id = v.auction_id
      WHERE v.featured_for_marketing = true
        AND v.review_status          = 'approved'
        AND v.visible_public         = true
      ORDER BY v.approved_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = {
  createVideo,
  getVideoForAuction,
  deleteVideo,
  approveVideo,
  rejectVideo,
  setPublicVisibility,
  setFeaturedForMarketing,
  getPendingVideos,
  listAllVideos,
  getPublicVideos,
  getMarketingVideos,
};

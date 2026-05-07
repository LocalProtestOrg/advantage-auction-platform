'use strict';

// TODO: remove.bg integration — POST image to https://api.remove.bg/v1.0/removebg
// TODO: Replicate integration — use Replicate API for model-based background/shadow edits
// TODO: Cloudinary AI — apply Cloudinary transformation URLs for bg removal + auto-crop
// TODO: shadow generation — composite a soft drop shadow layer after bg is removed
// TODO: auto crop — use subject detection bounding box, add 10% padding, resize to square

const db = require('../db');

const VALID_ENHANCEMENT_TYPES = [
  'background_removal',
  'white_background',
  'drop_shadow',
  'auto_crop',
  'lighting_cleanup',
  'full_enhancement',
];

class ImageProcessingService {
  async createProcessingJob({ lotTempId, originalImageUrl, enhancementType }) {
    if (!originalImageUrl) throw new Error('originalImageUrl is required');
    if (!enhancementType)  throw new Error('enhancementType is required');
    if (!VALID_ENHANCEMENT_TYPES.includes(enhancementType)) {
      throw new Error(`Invalid enhancementType. Must be one of: ${VALID_ENHANCEMENT_TYPES.join(', ')}`);
    }

    const { rows } = await db.query(
      `INSERT INTO image_processing_jobs
         (lot_temp_id, original_image_url, enhancement_type, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [lotTempId ?? null, originalImageUrl, enhancementType]
    );
    return rows[0];
  }

  async getJobById(jobId) {
    const { rows } = await db.query(
      'SELECT * FROM image_processing_jobs WHERE id = $1',
      [jobId]
    );
    return rows[0] || null;
  }

  async getPendingJobs(limit = 10) {
    const { rows } = await db.query(
      `SELECT * FROM image_processing_jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit]
    );
    return rows;
  }

  async markProcessing(jobId) {
    const { rows } = await db.query(
      `UPDATE image_processing_jobs
          SET status = 'processing'
        WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [jobId]
    );
    return rows[0] || null;
  }

  async markComplete(jobId, processedImageUrl) {
    const { rows } = await db.query(
      `UPDATE image_processing_jobs
          SET status               = 'complete',
              processed_image_url  = $2,
              completed_at         = now()
        WHERE id = $1 AND status = 'processing'
       RETURNING *`,
      [jobId, processedImageUrl ?? null]
    );
    return rows[0] || null;
  }

  async markFailed(jobId, errorMessage) {
    const { rows } = await db.query(
      `UPDATE image_processing_jobs
          SET status        = 'failed',
              error_message = $2,
              completed_at  = now()
        WHERE id = $1
       RETURNING *`,
      [jobId, errorMessage ?? 'Unknown error']
    );
    return rows[0] || null;
  }
}

module.exports = new ImageProcessingService();

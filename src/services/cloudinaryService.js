'use strict';

// Signed + direct browser uploads: DONE — see src/services/mediaUploadService.js (signUpload below)
//   and POST /api/uploads/signature. WebP + thumbnail optimization is applied at delivery-URL time
//   by the shared widgets (q_auto,f_auto,c_fill…), e.g. public/widgets/shared/gallery.js.
// Still future (NOT part of Marketplace Events): Cloudinary AI transforms (generative fill /
//   background removal) and CDN fetch-URL proxying of third-party images.

const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

class CloudinaryService {
  /**
   * Upload an image buffer to Cloudinary.
   * Returns the Cloudinary upload result (secure_url, public_id, width, height, format, bytes).
   *
   * @param {Buffer} buffer      Raw image bytes
   * @param {Object} options     Optional overrides passed to cloudinary.uploader.upload_stream
   * @returns {Promise<Object>}
   */
  async uploadBuffer(buffer, options = {}) {
    const uploadOptions = {
      folder:         options.folder    || 'lot-images',
      resource_type:  'image',
      allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'],
      // TODO Cloudinary AI transforms: add eager transforms here for background removal
      // TODO thumbnail generation: add eager: [{ width: 300, height: 300, crop: 'fill' }]
      ...options,
    };

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
        if (error) return reject(error);
        resolve(result);
      });
      stream.end(buffer);
    });
  }

  /**
   * Upload a video buffer to Cloudinary.
   * Returns the Cloudinary upload result (secure_url, public_id, format, bytes, duration).
   *
   * @param {Buffer} buffer      Raw video bytes
   * @param {Object} options     Optional overrides
   * @returns {Promise<Object>}
   */
  async uploadVideoBuffer(buffer, options = {}) {
    const uploadOptions = {
      folder:        options.folder || 'auction-videos',
      resource_type: 'video',
      allowed_formats: ['mp4', 'mov'],
      ...options,
    };

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
        if (error) return reject(error);
        resolve(result);
      });
      stream.end(buffer);
    });
  }

  /**
   * Delete an asset from Cloudinary by public_id.
   * Safe to call even if the asset no longer exists.
   */
  async destroy(publicId) {
    return cloudinary.uploader.destroy(publicId);
  }

  /**
   * Sign a set of upload params for a browser-side DIRECT upload (bytes never touch Railway).
   * Returns only the signature; the api_secret never leaves the server.
   * @param {Object} paramsToSign  e.g. { folder, timestamp } — must match exactly what the client POSTs
   * @returns {string}
   */
  signUpload(paramsToSign) {
    return cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);
  }

  /** Public (non-secret) config the browser needs to build a signed upload request. */
  publicConfig() {
    return { cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY };
  }
}

module.exports = new CloudinaryService();

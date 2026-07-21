'use strict';

const express  = require('express');
const multer   = require('multer');
const router   = express.Router();
const auth     = require('../middleware/authMiddleware');
const cloudinaryService = require('../services/cloudinaryService');
const mediaUploadService = require('../services/mediaUploadService');

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif', // iOS 15+ sends heif for HEIC files
]);

// Memory storage only — no local disk writes
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_SIZE_BYTES },
  fileFilter: function (_req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(Object.assign(new Error('Only image files are accepted'), { status: 400 }));
    }
    cb(null, true);
  },
});

function requireSellerOrAdmin(req, res, next) {
  const role = req.user?.role;
  if (role !== 'seller' && role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Seller or admin access required' });
  }
  next();
}

// POST /api/uploads/signature — reusable signed direct-to-storage upload (Advantage Media Uploader).
// Any logged-in user may ask; the per-context authorize() guard enforces ownership/editability.
// The browser uploads bytes DIRECTLY to Cloudinary with the returned params — never through Railway.
router.post('/signature', auth, async (req, res, next) => {
  try {
    const { context, resourceId } = req.body || {};
    const payload = await mediaUploadService.signUpload({ user: req.user, context, resourceId });
    return res.json(Object.assign({ success: true }, payload));
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    return next(err);
  }
});

// POST /api/uploads/image
router.post(
  '/image',
  auth,
  requireSellerOrAdmin,
  function (req, res, next) {
    upload.single('image')(req, res, function (err) {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'File too large. Maximum size is 10 MB.',
        });
      }
      if (err.status === 400) {
        return res.status(400).json({ success: false, message: err.message });
      }
      next(err);
    });
  },
  async (req, res, next) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided' });
    }

    try {
      const result = await cloudinaryService.uploadBuffer(req.file.buffer, {
        folder: 'lot-images',
      });

      return res.status(201).json({
        success:    true,
        secure_url: result.secure_url,
        public_id:  result.public_id,
        width:      result.width,
        height:     result.height,
        format:     result.format,
        bytes:      result.bytes,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/uploads/video ───────────────────────────────────────────────────
const VIDEO_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

const ALLOWED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime', // .mov
]);

const uploadVideo = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: VIDEO_MAX_BYTES },
  fileFilter: function (_req, file, cb) {
    if (!ALLOWED_VIDEO_MIME_TYPES.has(file.mimetype)) {
      return cb(Object.assign(new Error('Only MP4 and MOV video files are accepted'), { status: 400 }));
    }
    cb(null, true);
  },
});

router.post(
  '/video',
  auth,
  requireSellerOrAdmin,
  function (req, res, next) {
    uploadVideo.single('video')(req, res, function (err) {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'File too large. Maximum size is 500 MB.' });
      }
      if (err.status === 400) {
        return res.status(400).json({ success: false, message: err.message });
      }
      next(err);
    });
  },
  async (req, res, next) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No video file provided' });
    }
    try {
      const result = await cloudinaryService.uploadVideoBuffer(req.file.buffer, {
        folder: 'auction-videos',
      });
      return res.status(201).json({
        success:    true,
        secure_url: result.secure_url,
        public_id:  result.public_id,
        format:     result.format,
        bytes:      result.bytes,
        duration:   result.duration,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;

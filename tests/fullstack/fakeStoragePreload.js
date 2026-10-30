'use strict';

// Test-only preload for the isolated full-stack environment (node --require): photo storage without any real image
// host. The app's storage module is replaced by an in-memory stand-in that returns https placeholder addresses
// (https://isolated-photo-store.invalid/…), so photo workflows can be exercised end to end. Nothing leaves the machine.
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const target = path.join(__dirname, '..', '..', 'src', 'services', 'cloudinaryService.js');
const stored = new Map();
const fake = {
  isConfigured: () => true,
  async uploadBuffer(buffer, opts = {}) {
    const id = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
    const publicId = `${opts.folder || 'test'}/${id}`;
    stored.set(publicId, buffer.length);
    return { secure_url: `https://isolated-photo-store.invalid/${publicId}.jpg`, public_id: publicId, width: 800, height: 600, bytes: buffer.length };
  },
  async destroy(publicId) { stored.delete(publicId); return { result: 'ok' }; },
  _stored: stored,
};
const m = new Module(target, null);
m.filename = target; m.loaded = true; m.exports = fake;
Module._cache[target] = m;

// MediaService skeleton
class MediaService {
  async generatePresignedUpload(lotId, filename, contentType) {
    // TODO: Generate presigned S3 URL for upload, return URL and storageKey
    throw new Error('Not implemented');
  }

  async confirmUpload(storageKey, metadata) {
    // TODO: Verify upload, update images table, increment lot.images_count, process thumbnail
    throw new Error('Not implemented');
  }
}

module.exports = new MediaService();

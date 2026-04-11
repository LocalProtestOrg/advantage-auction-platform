// Lot validation stubs
module.exports = {
  validateLotPayload(payload) {
    // stub: check title, size_category, at least one image (images count maintained by media service)
    return { valid: true, errors: [] };
  }
};

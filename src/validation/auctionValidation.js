// Auction validation stubs
module.exports = {
  validateCreateDraft(payload) {
    // stub: check required fields like title, timezone
    return { valid: true, errors: [] };
  },

  validateSubmit(auction) {
    // stub: check lots, featured count, pickup windows
    return { valid: true, errors: [] };
  }
};

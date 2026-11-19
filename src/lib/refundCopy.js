'use strict';

/**
 * refundCopy: the ONE source for the refund timing sentence (owner standard, permanent, 2026-11-19).
 * Every refund confirmation (auctions and marketplace storefronts, email or any other message) places this sentence,
 * character for character, immediately after the statement that the refund has been issued. Do not paraphrase it, do not
 * change "3 - 5", and never say the refund has already posted. tests/refund-copy-standard.test.js pins the wording.
 */
const REFUND_TIMING_SENTENCE = 'Please allow this refund 3 - 5 business days to reflect on your account, depending on your bank.';

module.exports = { REFUND_TIMING_SENTENCE };

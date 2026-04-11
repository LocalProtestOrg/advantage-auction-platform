// CardVerificationService skeleton
class CardVerificationService {
  async startVerification(userId, cardToken) {
    // TODO: Create card_verification row, attempt small charge (<$1), record attempt_charge_id, set status='pending'
    throw new Error('Not implemented');
  }

  async handleProviderCallback(payload) {
    // TODO: Update status to 'verified' or 'failed', on verified create refund transaction, set refunded_at
    throw new Error('Not implemented');
  }
}

module.exports = new CardVerificationService();

'use strict';

/**
 * Appraiser membership transactional emails. Inline-HTML builders in the platform convention
 * (Advantage.Bid header, system-ui, signed "Advantage.Bid"), returning
 * { subject, html, text } for emailService.sendEmail. No legal/refund language is invented.
 */

const BRAND = 'Advantage.Bid';
const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const SUPPORT = 'info@advantage.bid';

function shell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#111">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#0f172a;border-radius:12px 12px 0 0;padding:18px 22px">
      <span style="color:#fff;font-weight:800;font-size:18px;letter-spacing:.01em">Advantage<span style="color:#5b8cff">.Bid</span></span>
    </div>
    <div style="background:#fff;border:1px solid #e6eaef;border-top:0;border-radius:0 0 12px 12px;padding:22px">
      <h1 style="margin:0 0 12px;font-size:19px;color:#0f172a">${title}</h1>
      ${bodyHtml}
      <p style="margin:22px 0 0;font-size:12.5px;color:#8a97a6">Questions? Contact us at
        <a href="mailto:${SUPPORT}" style="color:#2563eb">${SUPPORT}</a>.</p>
    </div>
    <p style="text-align:center;color:#9aa6b3;font-size:11.5px;margin:14px 0 0">Advantage.Bid</p>
  </div></body></html>`;
}

function btn(href, label) {
  return `<p style="margin:16px 0"><a href="${href}" style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;
    font-size:14px;text-decoration:none;padding:11px 18px;border-radius:10px">${label}</a></p>`;
}

/** Membership activated → prompt to complete the appraiser profile. */
function buildActivatedEmail() {
  const profileUrl = `${APP_BASE}/org/profile.html`;
  const subject = 'Your Appraiser Membership is active';
  const html = shell('Appraiser Membership Active', `
    <p style="margin:0 0 10px;font-size:14.5px;line-height:1.5">Thank you for joining ${BRAND}. Your annual Appraiser membership is now active.</p>
    <p style="margin:0 0 4px;font-size:14.5px;line-height:1.5">Next, complete your Appraiser profile so it is ready for the directory.</p>
    ${btn(profileUrl, 'Complete Your Appraiser Profile')}
    <p style="margin:0;font-size:12.5px;color:#5b6b7e">You can manage billing, renewal, and cancellation any time from your account.</p>`);
  const text = `Your Appraiser Membership is active.\n\nComplete your Appraiser profile: ${profileUrl}\n\nYou can manage billing and renewal from your account.\n\nAdvantage.Bid`;
  return { subject, html, text };
}

/** Payment failed → prompt to update the payment method. */
function buildPaymentFailedEmail() {
  const manageUrl = `${APP_BASE}/appraiser-membership.html`;
  const subject = 'Action needed: your Appraiser Membership payment failed';
  const html = shell('Payment could not be processed', `
    <p style="margin:0 0 10px;font-size:14.5px;line-height:1.5">We were unable to process the payment for your ${BRAND} Appraiser membership. Your access continues for now while we retry.</p>
    <p style="margin:0 0 4px;font-size:14.5px;line-height:1.5">Please update your payment method to avoid an interruption.</p>
    ${btn(manageUrl, 'Update Payment Method')}`);
  const text = `We could not process your Appraiser membership payment. Your access continues for now while we retry.\n\nUpdate your payment method: ${manageUrl}\n\nAdvantage.Bid`;
  return { subject, html, text };
}

/** Canceled (at period end or ended). endDate optional (ISO/day string). */
function buildCanceledEmail(endDateStr) {
  const manageUrl = `${APP_BASE}/appraiser-membership.html`;
  const subject = 'Your Appraiser Membership cancellation';
  const when = endDateStr ? ` Your access remains until ${endDateStr}.` : '';
  const html = shell('Membership cancellation received', `
    <p style="margin:0 0 10px;font-size:14.5px;line-height:1.5">Your ${BRAND} Appraiser membership is set to cancel.${when}</p>
    <p style="margin:0 0 4px;font-size:14.5px;line-height:1.5">Changed your mind? You can resume any time before it ends.</p>
    ${btn(manageUrl, 'Manage Membership')}`);
  const text = `Your Appraiser membership is set to cancel.${when}\n\nManage membership: ${manageUrl}\n\nAdvantage.Bid`;
  return { subject, html, text };
}

module.exports = { buildActivatedEmail, buildPaymentFailedEmail, buildCanceledEmail };

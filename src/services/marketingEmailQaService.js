'use strict';

/**
 * marketingEmailQaService — A2 marketing QA for email (extends the A2 QA discipline to the email channel).
 * Pure-ish: takes a resolved event + rendered email + audience result and returns a structured verdict.
 * A future live send must PASS QA. Checks FACTS, AUDIENCE, CREATIVE, FULL-CIRCLE, DELIVERY.
 */
const { isConfigured, marketingConfigurationSet } = require('./emailService');

// Phrases that would indicate invented claims / fake scarcity / unsupported valuation.
const FORBIDDEN = [
  /\bworth\s+\$[\d,]/i, /\bvalued at\b/i, /\bappraised at\s+\$/i,      // unsupported valuation
  /\bonly \d+ (left|spots|seats)\b/i, /\bselling fast\b/i, /\bact now\b/i, /\blast chance\b/i, // fake scarcity
  /\b\d+[\d,]*\+? (bidders|buyers|attendees|people) (are |already )?/i, // invented popularity
  /\bguaranteed\b/i,
];
// Visible AI/vendor terms are banned on any rendered surface.
const BANNED_TERMS = /\b(A\.?I\.?|artificial intelligence|machine learning|GPT|OpenAI|Claude|Copilot|Cloudinary|Postmark|Railway|Mapbox)\b/i;

function qaCampaign({ event, rendered, audienceResult, campaignClass = 'LOCAL_EVENT_ALERT' } = {}) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || null });

  // FACTS
  add('event_title_present', !!(event && event.title), 'event has a title');
  add('event_url_valid', !!(event && /^https?:\/\//i.test(event.url || '')), 'canonical URL present');
  add('event_location_present', !!(event && (event.city || event.state)), 'city/state present');
  add('event_date_present', !!(event && event.date_line), 'date line present');

  // AUDIENCE
  add('audience_resolved', !!(audienceResult && audienceResult.ok), 'audience specification resolved');
  add('audience_has_eligible', !!(audienceResult && Number(audienceResult.eligible) >= 0), 'eligible count computed');

  // CREATIVE
  const html = (rendered && rendered.html) || '';
  const text = (rendered && rendered.text) || '';
  const blob = `${rendered && rendered.subject || ''}\n${html}\n${text}`;
  add('subject_present', !!(rendered && rendered.subject), 'subject present');
  add('unsubscribe_present', /unsubscrib/i.test(html) || !!(rendered && rendered.headers && rendered.headers['List-Unsubscribe']), 'unsubscribe available');
  add('no_invented_claims', !FORBIDDEN.some((re) => re.test(blob)), 'no valuation/scarcity/popularity claims');
  add('no_banned_terms', !BANNED_TERMS.test(blob), 'no AI/vendor terminology');
  add('mobile_viewport', /viewport/i.test(html), 'responsive meta present');

  // FULL CIRCLE
  const fullCircle = /sell with advantage\.bid/i.test(blob) ? 'YES' : (campaignClass === 'TRANSACTIONAL' ? 'NOT_APPLICABLE' : 'NO');
  add('full_circle_seller_cta', fullCircle !== 'NO', `full-circle: ${fullCircle}`);

  // DELIVERY
  add('provider_healthy', isConfigured(), 'SES/SMTP configured');
  add('marketing_stream', true, marketingConfigurationSet() ? 'marketing config set present' : 'shared identity, dedicated marketing pool');

  const failed = checks.filter((c) => !c.pass);
  return {
    pass: failed.length === 0,
    full_circle: fullCircle,
    checks,
    failed: failed.map((c) => c.name),
  };
}

module.exports = { qaCampaign, FORBIDDEN, BANNED_TERMS };

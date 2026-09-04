'use strict';

/**
 * sesFeedbackService — application-side ingestion of Amazon SES feedback (bounce / complaint / delivery),
 * typically delivered via SNS. Idempotent (provider_event_id). HARD bounce + COMPLAINT immediately and
 * TERMINALLY suppress the address for MARKETING; SOFT bounces accumulate to a configurable threshold before
 * suppression; DELIVERY is recorded where provider evidence exists. Never claims opens/clicks (not configured).
 * No AWS secrets are stored. Authenticity is verified by the route before calling this service.
 */
const db = require('../db');
const { normalizeEmail } = require('../lib/emailNormalize');
const marketingConfig = require('./marketingConfigService');

// Suppress an address for marketing (TERMINAL for marketing selection). Idempotent on normalized_email.
async function suppressMarketing(client, normalized, reason, provider, evidenceRef) {
  await client.query(
    `INSERT INTO email_suppressions (email, normalized_email, reason, source, provider, scope, evidence_ref, updated_at)
     VALUES ($1,$1,$2,'ses_feedback',$3,'marketing',$4, now())
     ON CONFLICT (normalized_email) DO UPDATE SET reason = EXCLUDED.reason, provider = EXCLUDED.provider,
       evidence_ref = EXCLUDED.evidence_ref, updated_at = now()`,
    [normalized, reason, provider || 'ses', evidenceRef || null]);
}

async function setDeliverability(client, normalized, patch) {
  const cols = Object.keys(patch);
  const sets = cols.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await client.query(
    `INSERT INTO email_deliverability (normalized_email, ${cols.join(', ')}, updated_at)
     VALUES ($1, ${cols.map((_, i) => '$' + (i + 2)).join(', ')}, now())
     ON CONFLICT (normalized_email) DO UPDATE SET ${sets}, updated_at = now()`,
    [normalized, ...cols.map((k) => patch[k])]);
}

/**
 * Ingest ONE normalized SES feedback event. Shape: { eventType, bounceSubtype, email, providerEventId, raw }.
 * @returns {object} { ok, action, idempotent? }
 */
async function ingestEvent(evt = {}) {
  const normalized = normalizeEmail(evt.email);
  const type = String(evt.eventType || '').toLowerCase();
  if (!normalized) return { ok: false, reason: 'invalid_email' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Idempotency: a repeated provider event writes nothing new.
    if (evt.providerEventId) {
      const dup = await client.query('SELECT 1 FROM ses_feedback_events WHERE provider_event_id = $1', [evt.providerEventId]);
      if (dup.rowCount) { await client.query('COMMIT'); return { ok: true, idempotent: true }; }
    }
    await client.query(
      `INSERT INTO ses_feedback_events (event_type, bounce_subtype, normalized_email, provider_event_id, raw)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (provider_event_id) DO NOTHING`,
      [evt.eventType || null, evt.bounceSubtype || null, normalized, evt.providerEventId || null, evt.raw ? JSON.stringify(evt.raw) : null]);

    let action = 'recorded';
    const isHard = type === 'bounce' && String(evt.bounceSubtype || '').toLowerCase() !== 'transient';
    const isSoft = type === 'bounce' && String(evt.bounceSubtype || '').toLowerCase() === 'transient';
    if (isHard) {
      await setDeliverability(client, normalized, { hard_bounced: true, last_event_ref: evt.providerEventId || null });
      await suppressMarketing(client, normalized, 'hard_bounce', 'ses', evt.providerEventId);
      action = 'suppressed_hard_bounce';
    } else if (type === 'complaint') {
      await setDeliverability(client, normalized, { complaint: true, last_event_ref: evt.providerEventId || null });
      await suppressMarketing(client, normalized, 'complaint', 'ses', evt.providerEventId);
      action = 'suppressed_complaint';
    } else if (isSoft) {
      const threshold = await marketingConfig.getInt('marketing.email.soft_bounce_suppress_threshold', 4);
      const cur = (await client.query('SELECT soft_bounce_count FROM email_deliverability WHERE normalized_email = $1', [normalized])).rows[0];
      const count = ((cur && cur.soft_bounce_count) || 0) + 1;
      await setDeliverability(client, normalized, { soft_bounce_count: count, last_soft_bounce_at: new Date().toISOString(), last_event_ref: evt.providerEventId || null });
      if (count >= threshold) { await suppressMarketing(client, normalized, 'soft_bounce_threshold', 'ses', evt.providerEventId); action = 'suppressed_soft_threshold'; }
      else action = 'soft_bounce_recorded';
    } else if (type === 'delivery') {
      await setDeliverability(client, normalized, { last_delivery_at: new Date().toISOString(), last_event_ref: evt.providerEventId || null });
      action = 'delivery_recorded';
    }
    await client.query('COMMIT');
    return { ok: true, action };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

module.exports = { ingestEvent, suppressMarketing };

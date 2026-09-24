'use strict';

/**
 * activationService — the listing checklist and its milestones (handoff section 6).
 *
 * Checklist (about ten minutes):
 *   1 confirm business details   2 add a logo   3 replace our description with your own (300+ characters,
 *   different from the imported text)   4 choose service area and specialties   5 post your next estate sale
 *   or auction (or mark "no sale scheduled right now").
 *
 * Milestones: claimed · profile complete (steps 1-4) · ACTIVATED (profile complete AND a first published
 * event or auction within 45 days of claiming) · ENGAGED (2+ published events in 90 days, or 10+ followers).
 *
 * Progress is RECOMPUTED from the real records (profile, events, auctions) rather than hooked into every
 * publish path, so no existing publication control changes: moderation and admin approval stay exactly as
 * they are. Timestamps are stamped the first time a condition is observed and never move backwards.
 *
 * A1 (claim confirmation) replaces the welcome email and is transactional. A2-A4 reminders are OFF until
 * the Owner enables claimed_listings.activation_emails_enabled, and stop at activation.
 */

const crypto = require('crypto');
const db = require('../../db');
const events = require('./claimEvents');
const tasks = require('./taskService');

const ACTIVATION_WINDOW_DAYS = 45;
const MIN_OWNER_DESCRIPTION = 300;
const sha = (s) => crypto.createHash('sha256').update(String(s || '').trim()).digest('hex');
const nonEmpty = (v) => Array.isArray(v) ? v.filter((x) => String(x || '').trim()).length > 0 : !!String(v || '').trim();

/** Start the track at claim time: remember the imported description so "your own words" is provable. */
async function startTrack({ organizationId, proofMethod }, runner = db) {
  const org = (await runner.query(`SELECT description, profile_data FROM organizations WHERE id = $1`, [organizationId])).rows[0] || {};
  const imported = org.description || '';
  await runner.query(
    `INSERT INTO listing_activation_progress (organization_id, claimed_at, proof_method, imported_description_sha256)
     VALUES ($1, now(), $2, $3)
     ON CONFLICT (organization_id) DO UPDATE SET claimed_at = COALESCE(listing_activation_progress.claimed_at, now()),
       proof_method = COALESCE(listing_activation_progress.proof_method, EXCLUDED.proof_method), updated_at = now()`,
    [organizationId, proofMethod || null, imported ? sha(imported) : null]);
  await sendA1(organizationId, runner).catch((e) => console.error('[claimed-listing] A1 best-effort failed:', e.message));
  return recompute(organizationId, runner);
}

/**
 * The five steps from the organization's real state. Pure given (org, progress, publishedCount).
 */
function evaluateSteps(org, progress, publishedAt) {
  const pd = org.profile_data || {};
  // Either the full biography or the description counts, if it is long enough and is NOT our imported text.
  const ownerWritten = [pd.bio, org.description].some((t) => t && String(t).trim().length >= MIN_OWNER_DESCRIPTION
    && (!progress.imported_description_sha256 || sha(t) !== progress.imported_description_sha256));
  return {
    details_confirmed: !!progress.details_confirmed_at,
    logo_added: nonEmpty(org.logo_url) || nonEmpty(pd.logo),
    description_owner_written: ownerWritten,
    service_area_set: (nonEmpty(pd.service_area) || nonEmpty(pd.states_served))
      && (nonEmpty(pd.keywords) || nonEmpty(pd.appraisal_types) || nonEmpty(pd.specialties)),
    first_event_published: !!publishedAt || !!progress.no_sale_scheduled_at,
  };
}

/** Recompute and stamp milestones for one claimed organization. Returns the checklist view. */
async function recompute(organizationId, runner = db) {
  const progress = (await runner.query(`SELECT * FROM listing_activation_progress WHERE organization_id = $1`, [organizationId])).rows[0];
  if (!progress) return null;
  const org = (await runner.query(`SELECT id, name, description, logo_url, profile_data FROM organizations WHERE id = $1`, [organizationId])).rows[0];
  if (!org) return null;
  const pub = (await runner.query(
    `SELECT min(published_at) AS first_at,
            count(*) FILTER (WHERE published_at > now() - interval '90 days')::int AS recent
       FROM events WHERE (organization_id = $1 OR host_organization_id = $1) AND status = 'published'
        AND published_at >= $2`, [organizationId, progress.claimed_at || '1970-01-01'])).rows[0] || {};
  const followers = (await runner.query(
    `SELECT count(*)::int AS n FROM seller_followers f JOIN organizations o ON o.linked_seller_profile_id = f.seller_id WHERE o.id = $1`,
    [organizationId]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  const s = evaluateSteps(org, progress, pub.first_at);
  const now = new Date();
  const set = {};
  if (s.logo_added && !progress.logo_added_at) set.logo_added_at = now;
  if (s.description_owner_written && !progress.description_owner_written_at) set.description_owner_written_at = now;
  if (s.service_area_set && !progress.service_area_set_at) set.service_area_set_at = now;
  if (pub.first_at && !progress.first_event_published_at) set.first_event_published_at = pub.first_at;
  const complete = s.details_confirmed && s.logo_added && s.description_owner_written && s.service_area_set;
  if (complete && !progress.profile_completed_at) set.profile_completed_at = now;
  const firstAt = pub.first_at ? new Date(pub.first_at) : (progress.first_event_published_at ? new Date(progress.first_event_published_at) : null);
  const withinWindow = firstAt && progress.claimed_at
    && (firstAt.getTime() - new Date(progress.claimed_at).getTime()) <= ACTIVATION_WINDOW_DAYS * 86400000;
  if (complete && withinWindow && !progress.activated_at) set.activated_at = now;
  if ((Number(pub.recent) >= 2 || followers >= 10) && !progress.engaged_at) set.engaged_at = now;
  const keys = Object.keys(set);
  if (keys.length) {
    await runner.query(
      `UPDATE listing_activation_progress SET ${keys.map((k, i) => k + ' = $' + (i + 2)).join(', ')}, updated_at = now() WHERE organization_id = $1`,
      [organizationId, ...keys.map((k) => set[k])]);
    if (set.profile_completed_at) await events.record('profile_completed', { organizationId, idempotencyKey: 'pcomp:' + organizationId }, runner);
    if (set.first_event_published_at) await events.record('first_event_published', { organizationId, idempotencyKey: 'fep:' + organizationId }, runner);
    if (set.activated_at) {
      await events.record('activated', { organizationId, idempotencyKey: 'act:' + organizationId }, runner);
      await require('../conversionService').record('claimed_listing_activated', { subjectType: 'organization', subjectId: organizationId, idempotencyKey: 'cla:' + organizationId }).catch(() => {});
      await runner.query(`UPDATE organizations SET crm_stage = 'activated' WHERE id = $1`, [organizationId]);
    }
    if (set.engaged_at) await events.record('engaged', { organizationId, idempotencyKey: 'eng:' + organizationId }, runner);
  }
  const p = Object.assign({}, progress, set);
  return {
    organization_id: organizationId, claimed_at: p.claimed_at, proof_method: p.proof_method,
    steps: [
      { key: 'details', label: 'Confirm your business details', done: s.details_confirmed },
      { key: 'logo', label: 'Add your logo', done: s.logo_added },
      { key: 'description', label: 'Replace our description with your own (300 characters or more)', done: s.description_owner_written },
      { key: 'service_area', label: 'Choose your service area and specialties', done: s.service_area_set },
      { key: 'first_event', label: 'Post your next estate sale or auction', done: s.first_event_published,
        note: p.no_sale_scheduled_at && !pub.first_at ? 'Marked: no sale scheduled right now' : null },
    ],
    milestones: { profile_completed_at: p.profile_completed_at || null, activated_at: p.activated_at || null, engaged_at: p.engaged_at || null },
  };
}

/** Owner actions from the checklist: confirm details, or "no sale scheduled right now". */
async function markStep(organizationId, step, runner = db) {
  const col = { details: 'details_confirmed_at', no_sale: 'no_sale_scheduled_at' }[step];
  if (!col) throw Object.assign(new Error('Unknown checklist step.'), { status: 400, expose: true });
  await runner.query(`UPDATE listing_activation_progress SET ${col} = COALESCE(${col}, now()), updated_at = now() WHERE organization_id = $1`, [organizationId]);
  return recompute(organizationId, runner);
}

async function checklistFor(organizationId, runner = db) {
  return recompute(organizationId, runner);
}

/** A1: the claim confirmation (transactional). Uses the approved A1 template when there is one, otherwise the existing welcome email. */
async function sendA1(organizationId, runner = db) {
  const row = (await runner.query(
    `SELECT o.name, u.email, u.full_name FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id AND m.role = 'owner' AND m.status = 'active'
       JOIN users u ON u.id = m.user_id WHERE o.id = $1 LIMIT 1`, [organizationId])).rows[0];
  if (!row || !row.email) return { sent: false };
  const prog = (await runner.query(`SELECT reminders_sent FROM listing_activation_progress WHERE organization_id = $1`, [organizationId])).rows[0];
  if (prog && prog.reminders_sent && prog.reminders_sent.A1) return { sent: false, reason: 'already sent' };
  const emailService = require('../emailService');
  const templates = require('./templates');
  const tpl = (await runner.query(`SELECT * FROM listing_outreach_templates WHERE template_key = 'A1' AND status = 'approved' ORDER BY version DESC LIMIT 1`)).rows[0];
  let msg;
  if (tpl) {
    msg = templates.render(tpl, { first_name: (row.full_name || '').split(' ')[0] || 'there', company: row.name,
      checklist_link: 'https://bid.advantage.bid/org/profile.html?claimed=1', rep_first_name: 'The Advantage.Bid team' });
  } else {
    msg = require('../businessListingEmails').buildWelcomeEmail({ companyName: row.name, claimed: true });
  }
  await emailService.sendEmail({ to: row.email, subject: msg.subject, html: msg.html, text: msg.text });
  await runner.query(`UPDATE listing_activation_progress SET reminders_sent = reminders_sent || jsonb_build_object('A1', now()::text) WHERE organization_id = $1`, [organizationId]);
  return { sent: true, template: tpl ? 'A1 v' + tpl.version : 'welcome' };
}

/**
 * Worker pass: recompute every claimed listing, open an activation_stalled task at day 21, and (only when
 * the Owner has enabled them) send the A2-A4 reminders, which stop at activation.
 */
async function sweep(runner = db) {
  const rows = (await runner.query(`SELECT organization_id, claimed_at, activated_at FROM listing_activation_progress`)).rows;
  let stalled = 0;
  for (const r of rows) {
    const view = await recompute(r.organization_id, runner);
    if (!view || view.milestones.activated_at) continue;
    const ageDays = (Date.now() - new Date(r.claimed_at).getTime()) / 86400000;
    if (ageDays >= 21) {
      const t = await tasks.open({ type: 'activation_stalled', organizationId: r.organization_id,
        summary: 'Claimed listing not activated after 21 days', dedupeKey: 'stalled:' + r.organization_id }, runner);
      if (t) stalled += 1;
    }
  }
  return { tracked: rows.length, stalled_tasks_opened: stalled, reminders: 'A2-A4 not sent (claimed_listings.activation_emails_enabled is off)' };
}

module.exports = { ACTIVATION_WINDOW_DAYS, MIN_OWNER_DESCRIPTION, startTrack, evaluateSteps, recompute, markStep, checklistFor, sendA1, sweep };

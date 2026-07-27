'use strict';

/**
 * Marketplace Events — seller creation fields (Increment 3) source-level guards.
 *
 * The seller create/edit experience must capture the Marketplace Event type + contact info and
 * round-trip them through the org API, without a live DB. If a field is dropped from a form, the
 * POST/PATCH body, or the route serializer, the seller silently loses data — these fail first.
 */

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
const newHtml = read('public', 'org', 'event-new.html');
const editHtml = read('public', 'org', 'event-edit.html');
const route = read('src', 'routes', 'orgEvents.js');

const TYPES = ['estate_sale', 'in_person_auction', 'tag_sale', 'moving_sale', 'business_liquidation', 'other'];

describe('create form (event-new.html) captures type + contact', () => {
  test('exposes an event type selector with all six types', () => {
    expect(newHtml).toContain('id="eventType"');
    for (const t of TYPES) expect(newHtml).toContain(`value="${t}"`);
  });
  test('exposes contact email + phone inputs', () => {
    expect(newHtml).toContain('id="contactEmail"');
    expect(newHtml).toContain('id="contactPhone"');
  });
  test('posts eventType + contact fields to the org API', () => {
    expect(newHtml).toMatch(/eventType:\s*\$\('eventType'\)\.value/);
    expect(newHtml).toMatch(/contactEmail:\s*\$\('contactEmail'\)\.value/);
    expect(newHtml).toMatch(/contactPhone:\s*\$\('contactPhone'\)\.value/);
  });
});

describe('edit form (event-edit.html) round-trips type + contact', () => {
  test('renders a type selector seeded from the event (typeOpts)', () => {
    expect(editHtml).toContain('typeOpts');
    expect(editHtml).toMatch(/id="eventType"/);
    for (const t of TYPES) expect(editHtml).toContain(`'${t}'`);
  });
  test('renders + collects contact fields', () => {
    expect(editHtml).toContain('id="contactEmail"');
    expect(editHtml).toContain('id="contactPhone"');
    expect(editHtml).toMatch(/eventType:\s*\$\('eventType'\)\.value/);
    expect(editHtml).toMatch(/contactEmail:\s*\$\('contactEmail'\)\.value/);
  });
  test('honors the draft/rejected edit-lock (fields disabled via `dis`)', () => {
    expect(editHtml).toMatch(/id="eventType"'\s*\+\s*dis/);
  });
});

describe('org route serializer exposes the new fields for round-trip', () => {
  test('serializeEvent returns event_type + contact_email + contact_phone', () => {
    const ser = route.slice(route.indexOf('function serializeEvent'), route.indexOf('function mapOrgUpdate'));
    expect(ser).toContain('event_type: e.event_type');
    expect(ser).toContain('contact_email: e.contact_email');
    expect(ser).toContain('contact_phone: e.contact_phone');
  });
});

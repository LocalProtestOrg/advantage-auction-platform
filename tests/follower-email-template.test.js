'use strict';

/** The Advantage.Bid-controlled FOLLOWER_EVENT email template. Seller supplies only a short message;
 *  Advantage.Bid owns the template, CTA, branding, escaping, and unsubscribe controls. */
const { buildFollowerEventEmail } = require('../src/services/followerEmails');

const BASE = {
  campaign_id: 'c1', seller_id: 's1', event_id: 'e1',
  company_name: 'Lewis & Maese', event_title: 'Fall Estate Collection',
  sale_type: 'estate_sale', event_url: 'https://bid.advantage.bid/event.html?slug=fall',
  image_url: 'https://res.cloudinary.com/x/img.jpg',
  date_line: 'Sat, Sep 13, 2026 · 11:00 AM CDT', location_line: 'Houston, TX',
  custom_message: 'A great collection this weekend!',
};
const OPTS = { toAddress: 'buyer@example.com', unsubscribeUrl: 'https://bid.advantage.bid/api/public/follower-emails/unsubscribe?token=TOK' };

describe('buildFollowerEventEmail', () => {
  test('returns to/subject/html/text with the company + event title in the subject', () => {
    const m = buildFollowerEventEmail(BASE, OPTS);
    expect(m.to).toBe('buyer@example.com');
    expect(m.subject).toContain('Lewis & Maese');
    expect(m.subject).toContain('Fall Estate Collection');
  });
  test('CTA links back to the Advantage.Bid event page (never bypasses the platform)', () => {
    const m = buildFollowerEventEmail(BASE, OPTS);
    expect(m.html).toContain('bid.advantage.bid/event.html?slug=fall');
    expect(m.html).toContain('View Event');
  });
  test('includes the event image, date, location, and the seller custom message', () => {
    const m = buildFollowerEventEmail(BASE, OPTS);
    expect(m.html).toContain('res.cloudinary.com/x/img.jpg');
    expect(m.html).toContain('Sep 13, 2026');
    expect(m.html).toContain('Houston, TX');
    expect(m.html).toContain('A great collection this weekend!');
  });
  test('HTML-escapes seller/event supplied strings (no injection)', () => {
    const m = buildFollowerEventEmail({ ...BASE, company_name: 'Evil<script>', custom_message: '<img src=x onerror=alert(1)>' }, OPTS);
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<img src=x onerror');
    expect(m.html).toContain('Evil&lt;script&gt;');
  });
  test('includes unsubscribe controls + one-click List-Unsubscribe headers', () => {
    const m = buildFollowerEventEmail(BASE, OPTS);
    expect(m.html).toContain('unsubscribe');
    expect(m.html).toContain('scope=all');
    expect(m.headers['List-Unsubscribe']).toBe('<https://bid.advantage.bid/api/public/follower-emails/unsubscribe?token=TOK>');
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
  test('uses the correct noun for auction vs estate sale', () => {
    expect(buildFollowerEventEmail({ ...BASE, sale_type: 'auction' }, OPTS).html).toMatch(/new auction/);
    expect(buildFollowerEventEmail({ ...BASE, sale_type: 'estate_sale' }, OPTS).html).toMatch(/new estate sale/);
  });
  test('Public Language Standard: no AI/vendor terms in the VISIBLE email text (asset URLs excluded)', () => {
    const m = buildFollowerEventEmail(BASE, OPTS);
    // The standard governs rendered/visible text, not asset URLs (a CDN host in an <img src> is fine).
    // Strip tags + URLs, then assert no AI or infra-vendor WORDS appear to a reader.
    const visible = (m.subject + ' ' + m.text + ' ' + m.html.replace(/<[^>]+>/g, ' '))
      .replace(/https?:\/\/\S+/g, ' ');
    expect(visible).not.toMatch(/\bA\.?I\.?\b|artificial intelligence|machine learning|GPT|OpenAI|LLM|Copilot|Cloudinary|Postmark|Railway/i);
  });
  test('omits image markup and headers when no image / no unsubscribe url given', () => {
    const m = buildFollowerEventEmail({ ...BASE, image_url: null }, { toAddress: 'x@y.com' });
    expect(m.html).not.toContain('<img');
    expect(m.headers).toBeUndefined();
  });
});

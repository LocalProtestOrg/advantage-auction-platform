'use strict';

/**
 * Public Data Deletion Instructions page (Meta App Settings "User data deletion" URL).
 * Static, public, canonical, cross-linked, reuses the official privacy contact, no invented promises, no
 * banned public-language terms, and not gated by the HTML auth gate.
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'data-deletion.html'), 'utf8');
const privacy = fs.readFileSync(path.join(__dirname, '..', 'public', 'privacy.html'), 'utf8');

describe('data-deletion.html — Meta user data deletion instructions', () => {
  test('canonical + title + description identify the Advantage.Bid deletion page', () => {
    expect(html).toContain('<link rel="canonical" href="https://bid.advantage.bid/data-deletion.html" />');
    expect(html).toMatch(/<title>Data Deletion Instructions - Advantage\.Bid<\/title>/);
    expect(html).toMatch(/<meta name="description" content="[^"]*deletion[^"]*"/i);
    expect(html).not.toMatch(/name="robots"\s+content="noindex/i); // must be publicly indexable for Meta review
  });
  test('content is static semantic HTML (not client-rendered markdown) with clear request steps', () => {
    expect(html).toMatch(/<main id="doc"/); expect(html).toMatch(/<h1>Data Deletion Instructions<\/h1>/);
    expect(html).toMatch(/<ol>[\s\S]*Data Deletion Request[\s\S]*<\/ol>/);
    expect(html).not.toContain('md-render.js'); expect(html).not.toContain('renderMarkdownInto');
    expect(html).toMatch(/<address>/); expect(html).toMatch(/Facebook and Instagram/);
  });
  test('reuses the official privacy contact exactly as the Privacy Policy states it', () => {
    for (const s of ['privacy@advantage.bid', '(551) 655-7050', '300 Communipaw Ave #137', 'Jersey City, NJ 07304', 'Advantage Auction Company, LLC d/b/a Advantage.Bid']) {
      expect(html).toContain(s); expect(privacy).toContain(s);
    }
  });
  test('cross-links to the Privacy Policy and Terms of Use', () => {
    expect(html).toMatch(/href="\/privacy\.html"/); expect(html).toMatch(/href="\/terms\.html"/);
  });
  test('no invented deadlines/guarantees, no AI or vendor terms, no tracking/attribution URLs', () => {
    expect(html).not.toMatch(/within \d+\s*(business )?days|guarantee|GDPR|CCPA|Article \d+/i);
    expect(html).not.toMatch(/\bAI\b|A\.I\.|Artificial Intelligence|Machine Learning|OpenAI|GPT|LLM|Copilot|Cloudinary|Railway|Neon|Postmark/i);
    expect(html).not.toMatch(/utm_|gclid|fbclid|claude\.ai|anthropic/i);
  });
  test('public: the HTML auth gate does not gate /data-deletion.html; sitemap lists it', () => {
    const gate = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'htmlAuthGate.js'), 'utf8');
    expect(gate).not.toContain('data-deletion');
    expect(fs.readFileSync(path.join(__dirname, '..', 'public', 'sitemap.html'), 'utf8')).toContain('href="/data-deletion.html"');
  });
});

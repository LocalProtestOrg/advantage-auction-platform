'use strict';

/**
 * Seller Agreement version 4 (published 2026-11-06) has a quoted paragraph whose **bold** phrase wraps across two
 * source lines. The page and PDF renderers read line by line, so the signing page showed raw ** markers (caught by
 * tests/browser/seller-agreement.browser.test.js in CI). Consecutive > lines are now one paragraph in both renderers,
 * which fixes every published version without changing any agreement text.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseAgreementMarkdown, parseInlineBold } = require('../src/services/agreementPdfService');

const webParse = (() => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'widgets', 'shared', 'agreement-render.js'), 'utf8'), ctx);
  return ctx.window.AgreementRender.parse;
})();

const v4 = fs.readFileSync(path.join(__dirname, '..', 'docs', 'seller-agreement-v1-content.md'), 'utf8');
const body = v4.slice(v4.indexOf('## Agreement body'), v4.indexOf('### Authoring notes'));

test('the PDF renderer joins a wrapped quote and leaves no raw ** in the published v4 text', () => {
  const blocks = parseAgreementMarkdown(body);
  for (const b of blocks.filter((x) => x.text)) {
    for (const run of parseInlineBold(b.text)) expect([b.text, /\*\*/.test(run.text)]).toEqual([b.text, false]);
  }
  const q = blocks.find((b) => /only to sellers that Advantage has classified/.test(b.text || ''));
  expect(q.text).toMatch(/studios\)\. They do not alter the individual seller terms above\.$/);
  expect(parseInlineBold(q.text).filter((r) => r.bold).map((r) => r.text))
    .toContain('only to sellers that Advantage has classified and approved as professional sellers');
});

test('the web page renderer matches the PDF renderer block for block', () => {
  const pdf = parseAgreementMarkdown(body).map((b) => [b.type === 'para' ? 'p' : b.type, b.text || '']);
  const web = webParse(body).map((b) => [b.type === 'para' || b.type === 'quote' ? 'p' : b.type, b.text || '']);
  expect(web).toEqual(pdf);
});

test('separate quotes and ordinary lines are not merged', () => {
  const md = '> one\n\n> two\nplain\n> three';
  expect(parseAgreementMarkdown(md).filter((b) => b.type === 'para').map((b) => b.text)).toEqual(['one', 'two', 'plain', 'three']);
  expect(webParse(md).filter((b) => b.text).map((b) => b.text)).toEqual(['one', 'two', 'plain', 'three']);
});

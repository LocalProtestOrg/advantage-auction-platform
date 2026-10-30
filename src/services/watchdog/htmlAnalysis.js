'use strict';

/**
 * htmlAnalysis — what is wrong with a served HTML document, without a browser. Pure (no network, no database).
 * Used by the server-side watchdog checks (httpChecks.js, servedHtml.js) and their tests.
 *
 *   analyzeHtml(html, { expectText, requireSeo, requireJsonLd }) → [{ code, severity, detail }]
 *
 * Codes (severity critical unless noted):
 *   MALFORMED_HTML      no <html>/<head>/<body> structure, or no closing </html>
 *   SCRIPT_SYNTAX       an inline script is not valid JavaScript as served (e.g. a tag injected inside it: the
 *                       seller agreement defect of 2026-10-30)
 *   RAW_SCRIPT_TEXT     script source is visible as page text
 *   TEMPLATE_MARKERS    unfilled {{placeholders}} in visible text
 *   MISSING_CONTENT     an expected marker is not in the visible text or markup
 *   NO_TITLE            (warning) no <title>
 *   SEO_MISSING         (warning) a required SEO tag (description, canonical, og:title) is missing
 *   JSONLD_INVALID      a JSON-LD block does not parse, or has no @type
 *   JSONLD_MISSING      (warning) structured data was expected but none is present
 */

const vm = require('vm');
const { parseDocument, DomUtils } = require('htmlparser2');
const { RAW_SCRIPT_PATTERNS } = require('./pageHealth');

const JS_TYPES = /^(text|application)\/(javascript|ecmascript)$|^module$/;

/** Inline JavaScript scripts and JSON-LD blocks of a document. */
function scriptsOf(doc) {
  const scripts = DomUtils.findAll((n) => n.name === 'script', doc.children);
  const inline = []; const jsonld = []; const srcs = [];
  for (const s of scripts) {
    const a = s.attribs || {};
    if (a.src) { srcs.push(a.src); continue; }
    const type = String(a.type || '').toLowerCase();
    if (type === 'application/ld+json') { jsonld.push(DomUtils.textContent(s)); continue; }
    if (type && !JS_TYPES.test(type)) continue;                      // templates and other data blocks
    inline.push({ code: DomUtils.textContent(s), module: type === 'module' });
  }
  return { inline, jsonld, srcs };
}

/** null when the code parses as JavaScript, else the error message. Modules are checked without import/export lines. */
function scriptError(code, isModule) {
  try { new vm.Script(isModule ? code.replace(/^\s*(import|export)\b.*$/gm, '') : code, { filename: 'inline.js' }); return null; }
  catch (e) { return e.message; }
}

/** Visible text: everything outside script, style, noscript and template elements. */
function visibleText(doc) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 'text') out.push(n.data);
      else if (n.children && !['script', 'style', 'noscript', 'template', 'head'].includes(n.name)) walk(n.children);
    }
  };
  walk(doc.children);
  return out.join(' ').replace(/\s+/g, ' ');
}

const metaContent = (doc, attr, value) => {
  const m = DomUtils.findOne((n) => n.name === 'meta' && String((n.attribs || {})[attr] || '').toLowerCase() === value, doc.children);
  return m ? String(m.attribs.content || '').trim() : null;
};

function analyzeHtml(html, { expectText = [], requireSeo = false, requireJsonLd = false } = {}) {
  const issues = [];
  const add = (code, severity, detail) => issues.push({ code, severity, detail: String(detail).slice(0, 400) });
  const src = String(html == null ? '' : html);
  if (!/<html[\s>]/i.test(src) || !/<body[\s>]/i.test(src)) add('MALFORMED_HTML', 'critical', 'the document has no html/body structure');
  else if (!/<\/html>/i.test(src)) add('MALFORMED_HTML', 'critical', 'the document is cut off (no closing html tag)');
  const doc = parseDocument(src);
  const { inline, jsonld } = scriptsOf(doc);
  inline.forEach((s, i) => {
    const e = scriptError(s.code, s.module);
    if (e) add('SCRIPT_SYNTAX', 'critical', `inline script ${i + 1} of ${inline.length} does not parse: ${e}`);
  });
  const text = visibleText(doc);
  const raw = RAW_SCRIPT_PATTERNS.filter((re) => re.test(text));
  if (raw.length >= 2) add('RAW_SCRIPT_TEXT', 'critical', 'script source is visible on the page');
  const markers = text.match(/\{\{\s*[\w.]+\s*\}\}/g);
  if (markers) add('TEMPLATE_MARKERS', 'critical', 'unfilled placeholders: ' + [...new Set(markers)].slice(0, 5).join(', '));
  for (const t of expectText) {
    const ok = t instanceof RegExp ? (t.test(text) || t.test(src)) : (text.includes(t) || src.includes(t));
    if (!ok) add('MISSING_CONTENT', 'critical', 'expected content not found: ' + String(t));
  }
  const titleEl = DomUtils.findOne((n) => n.name === 'title', doc.children);
  const title = titleEl ? DomUtils.textContent(titleEl).trim() : '';
  if (!title) add('NO_TITLE', 'warning', 'the page has no title');
  if (requireSeo) {
    const missing = [];
    if (!metaContent(doc, 'name', 'description')) missing.push('meta description');
    if (!DomUtils.findOne((n) => n.name === 'link' && String((n.attribs || {}).rel || '').toLowerCase() === 'canonical', doc.children)) missing.push('canonical link');
    if (!metaContent(doc, 'property', 'og:title')) missing.push('og:title');
    if (missing.length) add('SEO_MISSING', 'warning', 'missing ' + missing.join(', '));
  }
  jsonld.forEach((block, i) => {
    let v;
    try { v = JSON.parse(block); } catch (e) { add('JSONLD_INVALID', 'critical', `structured data block ${i + 1} is not valid JSON: ${e.message}`); return; }
    const items = Array.isArray(v) ? v : (v && Array.isArray(v['@graph']) ? v['@graph'] : [v]);
    if (!items.length || items.some((x) => !x || typeof x !== 'object' || !x['@type'])) add('JSONLD_INVALID', 'critical', `structured data block ${i + 1} has an entry without @type`);
  });
  if (requireJsonLd && !jsonld.length) add('JSONLD_MISSING', 'warning', 'no structured data on a page that should have it');
  return issues;
}

module.exports = { analyzeHtml, scriptsOf, scriptError, visibleText };

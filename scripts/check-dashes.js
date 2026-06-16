#!/usr/bin/env node
/**
 * check-dashes.js — Em-dash governance lint (SOP: no em/en dashes in customer-facing copy).
 *
 * Scans customer-facing files for Unicode em dash (U+2014 —), en dash (U+2013 –),
 * horizontal bar (U+2015 ―), and their HTML entities (&mdash; &ndash; &#8212; &#8211;).
 * These must be replaced with a comma, colon, semicolon, parentheses, or a standard
 * ASCII hyphen (-) in any text a customer can read.
 *
 * Scope (customer-facing only, matches the approved sweep):
 *   - all .html and .js under public/
 *   - src/lib/notificationContent.js
 *   - src/services/operationalCloseEmailService.js
 *   - src/services/emailService.js
 *
 * NOT in scope (intentionally skipped): docs/, scripts/, db/, server-side code other
 * than the email/notification templates above, box-drawing separators (U+2500).
 *
 * Usage:   node scripts/check-dashes.js
 * Exit 0 = clean, exit 1 = violations found (CI-friendly).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BAD = [
  { re: /—/g, name: 'em dash (U+2014)' },
  { re: /–/g, name: 'en dash (U+2013)' },
  { re: /―/g, name: 'horizontal bar (U+2015)' },
  { re: /&mdash;/g, name: '&mdash;' },
  { re: /&ndash;/g, name: '&ndash;' },
  { re: /&#8212;/g, name: '&#8212;' },
  { re: /&#8211;/g, name: '&#8211;' },
];

function walk(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function targetFiles() {
  const files = walk(path.join(ROOT, 'public'), []).filter((f) => /\.(html|js)$/.test(f));
  for (const rel of [
    'src/lib/notificationContent.js',
    'src/services/operationalCloseEmailService.js',
    'src/services/emailService.js',
  ]) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) files.push(p);
  }
  return files;
}

let violations = 0;
const offenders = [];
for (const file of targetFiles()) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    for (const { re, name } of BAD) {
      re.lastIndex = 0;
      if (re.test(lines[ln])) {
        violations++;
        offenders.push({
          file: path.relative(ROOT, file).split(path.sep).join('/'),
          line: ln + 1,
          char: name,
          text: lines[ln].trim().slice(0, 100),
        });
      }
    }
  }
}

if (violations === 0) {
  console.log('check-dashes: clean. No em/en dashes in customer-facing content.');
  process.exit(0);
}

console.error(`check-dashes: ${violations} disallowed dash(es) found:\n`);
for (const o of offenders) {
  console.error(`  ${o.file}:${o.line}  [${o.char}]  ${o.text}`);
}
console.error('\nReplace with a comma, colon, semicolon, parentheses, or a standard hyphen (-).');
process.exit(1);

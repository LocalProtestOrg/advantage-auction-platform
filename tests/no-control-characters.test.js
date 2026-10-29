'use strict';

/**
 * Repository guard (2026-10-29): no tracked source, test, migration or document file may contain a raw
 * control character other than tab, line feed and carriage return.
 *
 * Why: an earlier tooling error wrote a literal backspace (0x08) where a regex `\b` was intended. A regex
 * holding a raw backspace never matches real text, so guards built on it passed no matter what the code
 * did (Phone Sasha's "AI" wording check, two fee-copy guards, a Meta ad-endpoint check, and the importer's
 * HTTP-status parser). Write control characters as escapes (e.g. '\x01') instead.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BAD = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

test('tracked .js/.html/.sql/.md files contain no raw control characters', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.js', '*.html', '*.sql', '*.md'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(Boolean);
  expect(files.length).toBeGreaterThan(100);
  const offenders = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { continue; }   // deleted in the working tree
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = BAD.exec(lines[i]);
      if (m) { offenders.push(f + ':' + (i + 1) + ' (0x' + m[0].charCodeAt(0).toString(16).padStart(2, '0') + ')'); break; }
    }
  }
  expect(offenders).toEqual([]);
});

test('the dedupe fingerprint separator is still the same character after escaping it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/eventImport/dedupe.js'), 'utf8');
  expect(src).toContain(".join('\\x01')");
  expect('\x01'.charCodeAt(0)).toBe(1);
});

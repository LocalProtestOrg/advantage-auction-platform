'use strict';

/**
 * spreadsheet — reads a seller's inventory spreadsheet (CSV or Excel .xlsx) into plain rows of text, and writes CSV.
 *
 * Safety:
 *   - Size, row, column and cell limits; anything over a limit is refused with a clear message, never truncated silently.
 *   - .xlsx: read through the bounded zipReader; only the first worksheet's stored values are used. Formulas are never
 *     evaluated (the value Excel saved is read as text), macros/external links are ignored, and a document type
 *     declaration (DTD) is refused, so no XML entity can be expanded.
 *   - CSV output escapes cells that a spreadsheet program would treat as a formula (= + - @ tab CR), so an error report
 *     opened in Excel cannot run anything.
 * Pure (no DB, no network).
 */

const zip = require('./zipReader');

function sheetErr(code, message) { const e = new Error(message); e.status = 422; e.code = code; return e; }

const LIMITS = { maxBytes: 5 * 1024 * 1024, maxRows: 2000, maxColumns: 60, maxCellChars: 10000 };

function checkShape(rows, limits) {
  // Trailing empty rows are common (Excel, CSV editors); drop them before counting.
  while (rows.length && rows[rows.length - 1].every((c) => !String(c || '').trim())) rows.pop();
  if (!rows.length) throw sheetErr('SHEET_EMPTY', 'The spreadsheet is empty. Add a header row and at least one item.');
  if (rows.length - 1 > limits.maxRows) throw sheetErr('SHEET_TOO_MANY_ROWS', `This spreadsheet has ${rows.length - 1} item rows; the limit is ${limits.maxRows} per import. Split it into smaller files.`);
  for (const r of rows) {
    if (r.length > limits.maxColumns) throw sheetErr('SHEET_TOO_MANY_COLUMNS', `The spreadsheet has more than ${limits.maxColumns} columns. Remove unused columns and try again.`);
    for (const c of r) if (String(c).length > limits.maxCellChars) throw sheetErr('SHEET_CELL_TOO_LONG', `A cell is longer than ${limits.maxCellChars} characters. Shorten it and try again.`);
  }
  return rows;
}

// ── CSV (RFC 4180, plus a leading byte-order mark, LF or CRLF line ends, and a ; or tab delimiter if detected) ───────
function parseCsv(input, limits = LIMITS) {
  let text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.indexOf('\u0000') !== -1) throw sheetErr('SHEET_INVALID', 'This does not look like a text CSV file. Save it as "CSV UTF-8" and try again.');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = { ',': (firstLine.match(/,/g) || []).length, ';': (firstLine.match(/;/g) || []).length, '\t': (firstLine.match(/\t/g) || []).length };
  const delim = counts[';'] > counts[','] && counts[';'] >= counts['\t'] ? ';' : (counts['\t'] > counts[','] ? '\t' : ',');
  const rows = []; let row = []; let cell = ''; let i = 0; let quoted = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += ch; i++;
      if (cell.length > limits.maxCellChars) throw sheetErr('SHEET_CELL_TOO_LONG', `A cell is longer than ${limits.maxCellChars} characters (check for an unclosed quotation mark).`);
      continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i++; continue; }
    if (ch === delim) { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length > limits.maxRows + 1 + 50) throw sheetErr('SHEET_TOO_MANY_ROWS', `This spreadsheet has more than ${limits.maxRows} item rows. Split it into smaller files.`);
      i += (ch === '\r' && text[i + 1] === '\n') ? 2 : 1; continue;
    }
    cell += ch; i++;
  }
  if (quoted) throw sheetErr('SHEET_INVALID', 'The CSV has an unclosed quotation mark. Check the last edited cell and try again.');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return checkShape(rows, limits);
}

// ── XLSX ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function decodeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'quot') return '"'; if (e === 'apos') return "'";
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }).replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));   // Excel's escaped control characters
}
// All text inside <t>…</t> (or <t xml:space="preserve">) between from and to.
function textRuns(xml) {
  let out = ''; let p = 0;
  for (;;) {
    const a = xml.indexOf('<t', p); if (a === -1) break;
    const c = xml[a + 2];
    if (c !== '>' && c !== ' ' && c !== '/') { p = a + 2; continue; }   // <tc>, <tab>… are not text runs
    const gt = xml.indexOf('>', a); if (gt === -1) break;
    if (xml[gt - 1] === '/') { p = gt + 1; continue; }                  // <t/>
    const close = xml.indexOf('</t>', gt); if (close === -1) break;
    out += decodeXml(xml.slice(gt + 1, close)); p = close + 4;
  }
  return out;
}
function colIndex(ref) {
  const m = /^([A-Z]{1,3})[0-9]+$/.exec(ref || ''); if (!m) return -1;
  let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function attr(tag, name) { const m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag); return m ? m[1] : null; }

function parseXlsx(buf, limits = LIMITS) {
  const entries = zip.listEntries(buf, { maxEntries: 500, maxEntryBytes: 25 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024, maxRatio: 500 });
  const byName = new Map(entries.map((e) => [e.name.replace(/^\/+/, ''), e]));
  const read = (name) => { const e = byName.get(name); return e ? zip.readEntry(buf, e, { maxEntryBytes: 25 * 1024 * 1024 }).toString('utf8') : null; };
  if (!byName.has('[Content_Types].xml') || !byName.has('xl/workbook.xml')) throw sheetErr('SHEET_INVALID', 'This is not an Excel workbook (.xlsx). Save the file as .xlsx or CSV and try again.');
  const guard = (xml) => { if (xml && /<!DOCTYPE|<!ENTITY/i.test(xml)) throw sheetErr('SHEET_INVALID', 'This workbook contains content that is not allowed. Save it again as a standard .xlsx or CSV.'); return xml; };

  // First worksheet in workbook order → its part name via the workbook relationships.
  const wb = guard(read('xl/workbook.xml'));
  const sheetTag = (/<sheet\s[^>]*>/.exec(wb) || [])[0];
  let sheetPath = 'xl/worksheets/sheet1.xml';
  if (sheetTag) {
    const rid = attr(sheetTag, 'r:id');
    const rels = guard(read('xl/_rels/workbook.xml.rels')) || '';
    const relTag = rid ? (rels.match(/<Relationship\s[^>]*>/g) || []).find((t) => attr(t, 'Id') === rid) : null;
    const target = relTag && attr(relTag, 'Target');
    if (target && !/^[a-z]+:/i.test(target)) sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  }
  const sheet = guard(read(sheetPath));
  if (!sheet) throw sheetErr('SHEET_INVALID', 'The workbook has no worksheet to import.');

  const shared = [];
  const sst = guard(read('xl/sharedStrings.xml'));
  if (sst) {
    const maxShared = (limits.maxRows + 1) * limits.maxColumns;
    let p = 0;
    for (;;) {
      const a = sst.indexOf('<si', p); if (a === -1) break;
      const tagEnd = sst.indexOf('>', a); if (tagEnd === -1) break;
      if (sst[tagEnd - 1] === '/') { shared.push(''); p = tagEnd + 1; }          // <si/>: an empty string
      else {
        const end = sst.indexOf('</si>', tagEnd); if (end === -1) break;        // unterminated: stop (never rescan)
        shared.push(textRuns(sst.slice(tagEnd + 1, end))); p = end + 5;
      }
      if (shared.length > maxShared) throw sheetErr('SHEET_INVALID', 'This workbook has more text entries than its rows and columns could use. Save it again as a standard .xlsx or CSV.');
    }
  }

  const rows = []; let p = 0;
  for (;;) {
    const a = sheet.indexOf('<row', p); if (a === -1) break;
    const tagEnd = sheet.indexOf('>', a); if (tagEnd === -1) break;
    const rowTag = sheet.slice(a, tagEnd + 1);
    let end;
    if (rowTag.endsWith('/>')) { end = tagEnd + 1; p = end; }
    else { end = sheet.indexOf('</row>', tagEnd); if (end === -1) break; p = end + 6; }
    const rn = parseInt(attr(rowTag, 'r') || String(rows.length + 1), 10);
    if (!(rn >= 1) || rn > limits.maxRows + 1) {
      if (rn > limits.maxRows + 1) throw sheetErr('SHEET_TOO_MANY_ROWS', `This spreadsheet has more than ${limits.maxRows} item rows. Split it into smaller files.`);
      continue;
    }
    const body = rowTag.endsWith('/>') ? '' : sheet.slice(tagEnd + 1, end);
    const cells = [];
    let q = 0; let next = 0;
    for (;;) {
      const c = body.indexOf('<c', q); if (c === -1) break;
      const cTagEnd = body.indexOf('>', c); if (cTagEnd === -1) break;
      const cTag = body.slice(c, cTagEnd + 1);
      if (!/^<c[\s/>]/.test(cTag)) { q = cTagEnd + 1; continue; }
      let inner = '';
      if (cTag.endsWith('/>')) q = cTagEnd + 1;
      else { const ce = body.indexOf('</c>', cTagEnd); if (ce === -1) break; inner = body.slice(cTagEnd + 1, ce); q = ce + 4; }
      let idx = colIndex(attr(cTag, 'r')); if (idx < 0) idx = next;
      next = idx + 1;
      if (idx >= limits.maxColumns) throw sheetErr('SHEET_TOO_MANY_COLUMNS', `The spreadsheet has more than ${limits.maxColumns} columns. Remove unused columns and try again.`);
      const t = attr(cTag, 't');
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      let val = '';
      if (t === 's') val = v != null ? (shared[parseInt(v, 10)] ?? '') : '';
      else if (t === 'inlineStr') val = textRuns(inner);
      else if (t === 'b') val = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
      else if (t === 'e') val = '';                               // an Excel error such as #N/A is an empty cell
      else val = v != null ? decodeXml(v) : '';                   // number, date serial or formula's stored string result
      if (val.length > limits.maxCellChars) throw sheetErr('SHEET_CELL_TOO_LONG', `A cell is longer than ${limits.maxCellChars} characters. Shorten it and try again.`);
      cells[idx] = val;
    }
    for (let k = 0; k < cells.length; k++) if (cells[k] === undefined) cells[k] = '';
    while (rows.length < rn - 1) rows.push([]);
    rows[rn - 1] = cells;
  }
  return checkShape(rows.map((r) => r || []), limits);
}

/** Detect the kind from the file name and content, then parse. Returns { kind, rows }. */
function parse(buffer, filename, limits = LIMITS) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw sheetErr('SHEET_EMPTY', 'The file is empty.');
  if (buffer.length > limits.maxBytes) throw sheetErr('SHEET_TOO_LARGE', `The file is larger than ${Math.round(limits.maxBytes / 1048576)} MB. Split it into smaller files.`);
  const name = String(filename || '').toLowerCase();
  const isZip = buffer.readUInt32LE(0) === 0x04034b50;
  if (name.endsWith('.xlsx') || (isZip && !name.endsWith('.csv'))) {
    if (!isZip) throw sheetErr('SHEET_INVALID', 'This file is not a valid Excel workbook (.xlsx).');
    return { kind: 'xlsx', rows: parseXlsx(buffer, limits) };
  }
  if (name.endsWith('.xls') || buffer.readUInt32LE(0) === 0xe011cfd0) {
    throw sheetErr('SHEET_OLD_EXCEL', 'Older Excel files (.xls) are not supported. In Excel choose File, Save As, "Excel Workbook (.xlsx)" or "CSV UTF-8".');
  }
  if (isZip) throw sheetErr('SHEET_INVALID', 'This file is a ZIP archive, not a CSV. Upload the spreadsheet itself.');
  return { kind: 'csv', rows: parseCsv(buffer, limits) };
}

// ── CSV output ─────────────────────────────────────────────────────────────────────────────────────────────────────
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^\s*[=+\-@|\t\r]/.test(s)) s = "'" + s;                  // never a formula when opened in a spreadsheet
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) { return '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

module.exports = { parse, parseCsv, parseXlsx, toCsv, csvCell, LIMITS };

'use strict';

/**
 * csvConnector — V1 proof-of-concept connector. Its only job is to prove the pipeline end to end; it is
 * NOT a production source. Yields raw records; the declarative fieldMap (per source) maps them to the
 * canonical shape, so the connector knows nothing about canonical fields.
 *
 * config: { csvText, idColumn, urlColumn, updatedColumn, imageColumn, imageDelimiter }
 *   idColumn      — REQUIRED: which column is the stable source event id (the idempotency key)
 *   urlColumn     — optional: the attribution URL column
 *   updatedColumn — optional: the source "last updated" column
 *   imageColumn   — optional: a column holding delimiter-separated image URLs
 */

// Minimal RFC4180-ish CSV parser (quotes, escaped quotes, commas, CRLF). No dependency.
function parseCsv(text) {
  const rows = []; let row = [], field = '', i = 0, inQ = false;
  const s = String(text == null ? '' : text);
  while (i < s.length) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ''));
}

function toObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((r) => { const o = {}; header.forEach((h, idx) => { o[h] = r[idx] != null ? r[idx] : ''; }); return o; });
}

module.exports = {
  key: 'csv',
  kind: 'csv',
  capabilities: { incremental: false, deletions: true, images: true },

  async *fetch({ config, limit } = {}) {
    config = config || {};
    const idCol = config.idColumn;
    const records = toObjects(config.csvText || '');
    const delim = config.imageDelimiter || /[;|]/;
    let n = 0;
    for (const payload of records) {
      if (limit != null && n >= limit) return;
      const sourceEventId = idCol && payload[idCol] != null ? String(payload[idCol]).trim() : null;
      if (!sourceEventId) continue; // no idempotency key → skip (a malformed row, not an event)
      const images = config.imageColumn && payload[config.imageColumn]
        ? String(payload[config.imageColumn]).split(delim).map((u) => u.trim()).filter(Boolean).map((url, i) => ({ url, position: i }))
        : [];
      yield {
        sourceEventId,
        sourceUrl: config.urlColumn ? (payload[config.urlColumn] || null) : null,
        sourceUpdatedAt: config.updatedColumn ? (payload[config.updatedColumn] || null) : null,
        payload,
        images,
      };
      n++;
    }
  },

  describe() { return { name: 'CSV upload', docs: 'Proof-of-concept connector. config.csvText + idColumn required.' }; },
};

module.exports.parseCsv = parseCsv;
module.exports.toObjects = toObjects;

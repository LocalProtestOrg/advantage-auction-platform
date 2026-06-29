#!/usr/bin/env node
/*
 * download-historical-images.js — Phase 1 historical-archive image retrieval.
 *
 * These are Advantage Auction Company's OWN historical auction catalogs. This
 * utility downloads each lot's PRIMARY image from the extracted image URL maps
 * and saves it locally into the matching catalog folder's images/ directory,
 * preserving the exact filenames already defined by the archive package
 * (recommended_filename / image_checklist.txt).
 *
 * SAFETY / DESIGN (per approved plan + clarifications):
 *  - Runs LOCALLY. No database, no Cloudinary, no secrets. Read CSV → write files.
 *  - Download + keep an image ONLY if the URL is still valid. If an image cannot
 *    be retrieved, log it and CONTINUE — the lot is simply left without an image.
 *    A single failure never aborts the run.
 *  - Idempotent / resumable: an already-present non-empty file is skipped.
 *  - Gentle: small concurrency + inter-request delay + per-request timeout + 1 retry.
 *  - Joins catalog folder <-> URL-map folder by IDENTICAL folder name, and
 *    lot image_filename <-> recommended_filename.
 *  - Writes a manifest (import-manifest-images.json) with per-auction stats and
 *    the full list of failures / lots left imageless.
 *
 * Usage:
 *   node scripts/download-historical-images.js --dry-run   # plan only, no writes
 *   node scripts/download-historical-images.js             # download
 */
const fs = require('fs');
const path = require('path');

const ARCHIVE_ROOT = path.join(__dirname, '..', 'docs', 'historical-auctions', 'archive');
const CATALOG_DIR = path.join(ARCHIVE_ROOT, 'Advantage Auction Historical Archive');
const URLMAP_DIR = path.join(ARCHIVE_ROOT, 'Advantage_Auction_Image_URL_Maps');
const MANIFEST_PATH = path.join(ARCHIVE_ROOT, 'import-manifest-images.json');

const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = 5;
const DELAY_MS = 120;
const TIMEOUT_MS = 30000;
const UA = 'Mozilla/5.0 (AdvantageAuction historical-archive importer)';

// ── Minimal RFC-4180-ish CSV parser (quote-aware; fields may contain commas) ──
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function readCsv(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = parseCsvLine(l);
    const row = {};
    header.forEach((h, idx) => { row[h.trim()] = (cells[idx] || '').trim(); });
    return row;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return { ok: false, reason: `non-image (${ct || 'unknown'})` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, reason: 'empty body' };
    return { ok: true, buf };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch error') };
  } finally { clearTimeout(t); }
}

async function fetchImage(url) {
  let r = await fetchOnce(url);
  if (!r.ok) { await sleep(400); r = await fetchOnce(url); }
  return r;
}

(async () => {
  if (typeof fetch !== 'function') {
    console.error('FATAL: global fetch unavailable (need Node 18+).');
    process.exit(1);
  }
  if (!fs.existsSync(CATALOG_DIR) || !fs.existsSync(URLMAP_DIR)) {
    console.error('FATAL: archive folders not found under ' + ARCHIVE_ROOT);
    process.exit(1);
  }

  const folders = fs.readdirSync(CATALOG_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  console.log(`${DRY_RUN ? '[DRY-RUN] ' : ''}Historical image retrieval — ${folders.length} auction folders\n`);

  const manifest = { generated_for: 'historical-archive Phase 1', dry_run: DRY_RUN, auctions: [] };
  let totLots = 0, totUrls = 0, totHave = 0, totDownloaded = 0, totFailed = 0, totNoUrl = 0;

  for (const folder of folders) {
    const urlMapFile = path.join(URLMAP_DIR, folder, 'image_url_map.csv');
    const imagesDir = path.join(CATALOG_DIR, folder, 'images');
    const lotsFile = path.join(CATALOG_DIR, folder, 'lots.csv');

    // The URL map is keyed by recommended_filename → primary_image_url.
    const urlByFile = {};
    if (fs.existsSync(urlMapFile)) {
      for (const r of readCsv(urlMapFile)) {
        const fn = r.recommended_filename;
        const u = r.primary_image_url;
        if (fn && u) urlByFile[fn] = u;
      }
    }
    // Authoritative filename list = lots.csv.image_filename (covers suffixed sub-lots
    // like 0018B.jpg that the checklist's numeric pattern misses). One image per lot.
    let expectedFiles = [];
    if (fs.existsSync(lotsFile)) {
      expectedFiles = readCsv(lotsFile).map((r) => r.image_filename).filter(Boolean);
    }
    if (!expectedFiles.length) expectedFiles = Object.keys(urlByFile);

    const stat = { folder, lots: expectedFiles.length, urls_available: 0, already_present: 0, downloaded: 0, failed: 0, no_url: 0, failures: [] };

    if (!DRY_RUN) fs.mkdirSync(imagesDir, { recursive: true });

    // Build work list.
    const work = [];
    for (const fn of expectedFiles) {
      const dest = path.join(imagesDir, fn);
      const url = urlByFile[fn];
      if (url) stat.urls_available++;
      if (!url) { stat.no_url++; stat.failures.push({ file: fn, reason: 'no source URL in map' }); continue; }
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { stat.already_present++; continue; }
      work.push({ fn, url, dest });
    }

    if (DRY_RUN) {
      // Probe just the first pending URL to confirm reachability without writing.
      let probe = 'n/a (nothing pending)';
      if (work.length) { const r = await fetchImage(work[0].url); probe = r.ok ? `reachable (${r.buf.length} bytes)` : `UNREACHABLE: ${r.reason}`; }
      console.log(`${folder}\n  lots=${stat.lots} urls=${stat.urls_available} present=${stat.already_present} pending=${work.length} no_url=${stat.no_url} | probe: ${probe}`);
    } else {
      // Download with bounded concurrency.
      let idx = 0;
      async function worker() {
        while (idx < work.length) {
          const job = work[idx++];
          const r = await fetchImage(job.url);
          if (r.ok) { fs.writeFileSync(job.dest, r.buf); stat.downloaded++; }
          else { stat.failed++; stat.failures.push({ file: job.fn, reason: r.reason }); }
          await sleep(DELAY_MS);
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length || 1) }, worker));
      console.log(`${folder}\n  lots=${stat.lots} downloaded=${stat.downloaded} present=${stat.already_present} failed=${stat.failed} no_url=${stat.no_url}`);
    }

    manifest.auctions.push(stat);
    totLots += stat.lots; totUrls += stat.urls_available; totHave += stat.already_present;
    totDownloaded += stat.downloaded; totFailed += stat.failed; totNoUrl += stat.no_url;
  }

  manifest.totals = { lots: totLots, urls_available: totUrls, already_present: totHave, downloaded: totDownloaded, failed: totFailed, no_url: totNoUrl };
  if (!DRY_RUN) fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  console.log('\n=== TOTALS ===');
  console.log(JSON.stringify(manifest.totals, null, 2));
  const imaged = totHave + totDownloaded;
  console.log(`Lots that will have an image: ${imaged}/${totLots} | imageless: ${totLots - imaged}`);
  if (!DRY_RUN) console.log('Manifest: ' + MANIFEST_PATH);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

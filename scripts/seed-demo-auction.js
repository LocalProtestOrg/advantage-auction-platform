#!/usr/bin/env node
/* seed-demo-auction.js — REBUILD the canonical Heritage & Home (DEMO) auction from the supplied real-world
 * catalog. Deterministic, idempotent, DEMO-ONLY.
 *
 *   railway run node scripts/seed-demo-auction.js
 *
 * Source (authoritative): demo-data/heritage-home-demo-auction/Example Auction.csv + images/{lot}_{seq}.jpg
 * - Parses the CSV (RFC4180: quoted fields, embedded commas, "" escapes).
 * - Uploads each lot's photos to Cloudinary (the platform's durable image store) and links them; on re-run
 *   it REUSES the already-uploaded URLs (snapshots the demo auction's current images first) so re-imports
 *   are fast and never re-upload.
 * - Rebuilds one demo auction (fixed UUID) under the existing demo seller d0002, with A/B display numbers,
 *   PUBLIC start prices, and CONFIDENTIAL reserves. Lots stay open far in the future so the demo never
 *   expires. Never touches non-demo sellers/auctions. Also removes the OLD demo auction d0007.
 *
 * NEVER fabricates or substitutes an image. A lot with no supplied image gets the normal no-image state
 * and is reported. Reserve is stored only when it is ABOVE the start price (a binding confidential
 * threshold); a reserve at/below start imposes nothing and is treated as no reserve.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const cloudinary = require('../src/services/cloudinaryService');
const { parseLotNumber } = require('../src/lib/lotNumber');

const SELLER = '00000000-0000-4000-a000-0000000d0002';   // Heritage & Home (DEMO) seller_profile
const AUCTION = '00000000-0000-4000-a000-0000000d0003';  // canonical demo auction (referenced by Sales Toolbox + outreach)
// Aborted/duplicate demo auctions to remove. NOT d0007 — that is the storefront's legitimate PAST-SALE
// portfolio piece + the unsold→Marketplace conversion demo (a past auction is not a competing catalog).
const REMOVE_AUCTIONS = ['00000000-0000-4000-a000-0000000d0100'];
const IMAGE_FOLDER = 'demo-heritage-auction';            // Cloudinary folder — reuse ONLY images THIS importer uploaded
const DIR = path.join(__dirname, '..', 'demo-data', 'heritage-home-demo-auction');
const CSV = path.join(DIR, 'Example Auction.csv');
const IMAGES = path.join(DIR, 'images');
const FUTURE_YEARS = 5;

// ── Robust RFC4180 CSV parser ──────────────────────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let i = 0; let inQ = false;
  const pushF = () => { row.push(field); field = ''; };
  const pushR = () => { pushF(); rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { pushF(); i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { pushR(); i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) pushR();
  return rows.filter((r) => r.length && r.some((c) => String(c).trim() !== ''));
}

const dollarsToCents = (v) => { const n = Math.round(parseFloat(String(v || '').replace(/[^0-9.]/g, '')) * 100); return Number.isFinite(n) ? n : 0; };

// Ordered local image files for a lot key (e.g. "100a"): {key}_{seq}.jpg sorted by numeric seq. JPG only.
function localImagesFor(key) {
  const files = fs.readdirSync(IMAGES).filter((f) => {
    const m = f.match(/^(.+)_(\d+)\.jpg$/i);
    return m && m[1].toLowerCase() === key.toLowerCase();
  });
  return files.map((f) => ({ f, seq: parseInt(f.match(/_(\d+)\.jpg$/i)[1], 10) }))
    .sort((a, b) => a.seq - b.seq).map((x) => x.f);
}

(async () => {
  // ── Parse + validate the source (works offline; the basis for DRY_RUN) ──────────────────────────────
  const allRows = parseCsv(fs.readFileSync(CSV, 'utf8'));
  const header = allRows.shift().map((h) => h.trim());
  const col = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const ci = { lot: col('Lot Number'), title: col('Title'), desc: col('Description'),
    reserve: col('Reserve Price'), start: col('Start Price'), cond: col('Condition') };
  const rows = allRows;
  console.log('Parsed CSV rows:', rows.length, '| header:', header.join(' | '));

  // Validation mapping: CSV lot → display → image files. Detect no-image lots, orphan images, non-jpg.
  const csvKeys = new Set(rows.map((r) => parseLotNumber(r[ci.lot]).display.toLowerCase()));
  const imgFiles = fs.readdirSync(IMAGES);
  const jpgKeys = new Set(imgFiles.filter((f) => /_\d+\.jpg$/i.test(f)).map((f) => f.replace(/_\d+\.jpg$/i, '').toLowerCase()));
  const nonJpg = imgFiles.filter((f) => !/_\d+\.jpg$/i.test(f));
  const noImage = [...csvKeys].filter((k) => !jpgKeys.has(k));
  const orphan = [...jpgKeys].filter((k) => !csvKeys.has(k));
  console.log('Distinct CSV lots:', csvKeys.size, '| image lot-keys:', jpgKeys.size,
    '| lots w/o image:', noImage.join(',') || 'none', '| orphan image keys:', orphan.join(',') || 'none',
    '| non-jpg files (skipped):', nonJpg.join(',') || 'none');
  if (process.env.DRY_RUN) { console.log('\nDRY_RUN — no DB writes, no uploads.'); process.exit(0); }

  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); process.exit(2); }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  const q = (s, p) => c.query(s, p);
  try {
    // Guard: the target seller must exist and be a DEMO seller.
    const sp = (await q('SELECT id, is_demo FROM seller_profiles WHERE id=$1', [SELLER])).rows[0];
    if (!sp) { console.error('DEMO seller missing — run scripts/demo-environment.js + seed-demo-storefront.js first.'); process.exit(1); }
    if (!sp.is_demo) { console.error('REFUSE: target seller is not is_demo.'); process.exit(2); }

    // Snapshot images THIS importer previously uploaded (identified by the Cloudinary folder) so a re-run of
    // the SAME catalog reuses them without re-uploading. We NEVER reuse images from a different prior catalog
    // (e.g. the old d0003 lots) — matching only our folder guarantees a new lot never inherits a stale photo.
    const prior = {};
    for (const r of (await q(
      `SELECT l.lot_number_display AS d, li.image_url AS url, li.sort_order AS so
         FROM lots l JOIN lot_images li ON li.lot_id = l.id
        WHERE l.auction_id=$1 AND li.image_url LIKE '%/' || $2 || '/%'`, [AUCTION, IMAGE_FOLDER])).rows) {
      const k = String(r.d || '').toLowerCase(); (prior[k] = prior[k] || []).push({ url: r.url, so: r.so });
    }
    Object.values(prior).forEach((a) => a.sort((x, y) => x.so - y.so));
    const reusing = Object.keys(prior).length > 0;
    console.log(reusing ? `Reusing images for ${Object.keys(prior).length} lots from a prior import.` : 'First import — uploading images to Cloudinary.');

    await q('BEGIN');
    // Rebuild: remove this demo auction's lots (cascade images) + the legacy demo auction. DEMO-scoped only.
    await q('DELETE FROM lots WHERE auction_id=$1', [AUCTION]);
    await q(`INSERT INTO auctions (id, seller_id, title, subtitle, description, public_auction_type,
               city, address_state, zip, state, start_time, end_time, is_demo, marketplace_status, is_archived, buyer_premium_bps)
             VALUES ($1,$2,'Heritage & Home Estate Auction (DEMO)','A curated single-owner estate — furnishings, fine art, jewelry & collectibles',
               'A demonstration estate auction showcasing the Advantage.Bid Professional Seller experience: full catalog, A/B supplemental lots, starting bids, confidential reserves, proxy bidding, and storefront integration.',
               'estate','Maplewood','OH','44060','active', now() - interval '2 days',
               now() + interval '${FUTURE_YEARS} years', true, 'hidden', false, 1500)
             ON CONFLICT (id) DO UPDATE SET state='active', is_demo=true, is_archived=false,
               marketplace_status='hidden', end_time=now() + interval '${FUTURE_YEARS} years', updated_at=now()`,
      [AUCTION, SELLER]);

    const report = { total: 0, standard: 0, suffix: 0, withImg: 0, noImg: [], realReserve: 0, uploaded: 0, reused: 0, suffixes: new Set() };
    let pos = 0;
    for (const r of rows) {
      pos++;
      const ln = parseLotNumber(r[ci.lot]);
      const title = String(r[ci.title] || '').trim() || 'Lot ' + ln.display;
      const desc = String(r[ci.desc] || '').trim() || null;
      const startC = dollarsToCents(r[ci.start]);
      const reserveDollarsC = dollarsToCents(r[ci.reserve]);
      const startCents = startC > 0 ? startC : 100;                 // opening min; default $1 if absent
      const reserveCents = reserveDollarsC > startCents ? reserveDollarsC : null; // binding reserve only if ABOVE start
      const condition = ci.cond >= 0 ? (String(r[ci.cond] || '').trim() || null) : null;
      report.total++; if (ln.suffix) { report.suffix++; report.suffixes.add(ln.suffix); } else report.standard++;
      if (reserveCents != null) report.realReserve++;

      const closesAt = `now() + interval '${FUTURE_YEARS} years' + make_interval(secs => ${pos * 60})`;
      const lot = (await q(
        `INSERT INTO lots (auction_id, lot_number, lot_number_display, title, description, condition,
             size_category, pickup_group, state, starting_bid_cents, reserve_cents, closes_at, bid_count, current_bid_cents)
         VALUES ($1,$2,$3,$4,$5,$6,'B','B_group','open',$7,$8, ${closesAt}, 0, 0) RETURNING id`,
        [AUCTION, ln.base, ln.display, title, desc, condition, startCents, reserveCents])).rows[0];

      // Images — reuse prior URLs if present; else upload the supplied local jpgs (never fabricate).
      const key = ln.display.toLowerCase();
      let urls = [];
      if (reusing && prior[key] && prior[key].length) {
        urls = prior[key].map((x) => x.url); report.reused += urls.length;
      } else {
        const files = localImagesFor(ln.display);
        for (const f of files) {
          const buf = fs.readFileSync(path.join(IMAGES, f));
          const up = await cloudinary.uploadBuffer(buf, { folder: IMAGE_FOLDER,
            public_id: 'lot-' + ln.display.toLowerCase() + '-' + f.match(/_(\d+)\.jpg$/i)[1], overwrite: true });
          urls.push(up.secure_url); report.uploaded++;
        }
      }
      for (let s = 0; s < urls.length; s++) {
        await q('INSERT INTO lot_images (lot_id, image_url, sort_order) VALUES ($1,$2,$3)', [lot.id, urls[s], s]);
      }
      if (urls.length) {
        await q('UPDATE lots SET thumbnail_url=$2, images_count=$3 WHERE id=$1', [lot.id, urls[0], urls.length]);
        report.withImg++;
      } else {
        report.noImg.push(ln.display);
      }
      if (pos % 25 === 0) console.log('  …imported', pos, 'lots');
    }

    // Remove legacy/aborted contradictory demo auctions. Delete their lots first (lots→children cascade),
    // then the auction row — robust whether or not auctions→lots cascades. DEMO-scoped only (is_demo guard).
    const toRemove = (await q('SELECT id FROM auctions WHERE id = ANY($1) AND is_demo=true', [REMOVE_AUCTIONS])).rows.map((r) => r.id);
    if (toRemove.length) {
      await q('DELETE FROM lots WHERE auction_id = ANY($1)', [toRemove]);
      await q('DELETE FROM auctions WHERE id = ANY($1)', [toRemove]);
    }
    const oldDel = { rowCount: toRemove.length };

    await q('COMMIT');

    console.log('\n=== DEMO AUCTION IMPORT COMPLETE ===');
    console.log('  auction_id       ', AUCTION);
    console.log('  total lots       ', report.total, '(standard ' + report.standard + ', A/B suffix ' + report.suffix + ')');
    console.log('  suffixes         ', [...report.suffixes].sort().join(','));
    console.log('  lots with images ', report.withImg, '| lots WITHOUT image:', report.noImg.length ? report.noImg.join(',') : 'none');
    console.log('  images uploaded  ', report.uploaded, '| reused', report.reused);
    console.log('  lots w/ binding reserve (reserve>start):', report.realReserve, '(reserve VALUES intentionally not printed)');
    console.log('  legacy demo auctions removed:', oldDel.rowCount);
    process.exit(0);
  } catch (e) {
    try { await q('ROLLBACK'); } catch (_) {}
    console.error('IMPORT FAILED:', e && e.stack ? e.stack : e);
    process.exit(1);
  } finally { c.release(); await pool.end(); }
})();

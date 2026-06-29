#!/usr/bin/env node
/*
 * seed-historical-auctions.js — STAGING-guarded import of Advantage Auction
 * Company's 8 OWN historical auction catalogs as native CLOSED (non-archived)
 * auctions on the public Past Auctions surface.
 *
 * Reuses existing architecture only (no new tables, no migration):
 *   auctions (state='closed', is_archived=false, public_auction_type='historical_archive')
 *   lots     (cleaned title + category, NO prices/bids/buyers, NO descriptions)
 *   lot_images (Cloudinary-rehosted primary image; absent when no image was retrieved)
 *
 * Source of truth: docs/historical-auctions/archive/Advantage Auction Historical Archive/
 *   - Historical Auction Index.csv   (folder → title + internal placeholder date)
 *   - <folder>/lots.csv              (display_order, image_filename, cleaned title, category)
 *   - <folder>/auction.json          (public_summary)
 *   - <folder>/images/<filename>     (locally downloaded by download-historical-images.js)
 *
 * IMPORT RULES (per approved plan + clarifications):
 *   - Preserve: auction title, lot order, cleaned lot titles, categories, image filenames.
 *   - Do NOT import: descriptions, estimates, realized prices, bidder info, original
 *     lot numbers, original auction IDs, source-platform metadata, original dates.
 *   - Placeholder dates are internal only (relative order preserved) and never shown
 *     publicly (UI suppresses dates for public_auction_type='historical_archive').
 *   - No invented business data: size_category/pickup/condition/prices left NULL.
 *   - Images: rehost only if a local file exists; otherwise the lot has no image.
 *
 * Idempotent: deterministic UUIDs (5c block); re-runs upsert. Cloudinary uploads are
 * cached locally (cloudinary-url-cache.json) and use deterministic public_ids, so
 * re-runs do not create duplicate assets or re-upload.
 *
 * Usage:
 *   railway run --service advantage-staging node scripts/seed-historical-auctions.js
 *   railway run --service advantage-staging node scripts/seed-historical-auctions.js --remove-demos
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const cloudinary = require('../src/services/cloudinaryService');

const PROD_EP = 'ep-proud-leaf-an8pzkib';
const STG_EP = 'ep-royal-dawn-anarou3f';

const ARCHIVE_ROOT = path.join(__dirname, '..', 'docs', 'historical-auctions', 'archive');
const CATALOG_DIR = path.join(ARCHIVE_ROOT, 'Advantage Auction Historical Archive');
const INDEX_CSV = path.join(CATALOG_DIR, 'Historical Auction Index.csv');
const CACHE_PATH = path.join(ARCHIVE_ROOT, 'cloudinary-url-cache.json');

const REMOVE_DEMOS = process.argv.includes('--remove-demos');

// Dedicated historical seller so attribution reads "Advantage Auction Company"
// without disturbing the demo seller used by the Summer Showcase seed.
const SELLER_SP = '5c000000-0000-4000-8000-0000000000aa';
// Demo curated "Sample Auction Results" auctions to replace (clarification #2).
const DEMO_AUCTIONS = [1, 2, 3, 4, 5, 6].map((n) => `5b00000${n}-0000-4000-8000-000000000000`);

// ── CSV (quote-aware) ─────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out;
}
function readCsv(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((l) => { const c = parseCsvLine(l); const r = {}; header.forEach((h, i) => { r[h] = (c[i] || '').trim(); }); return r; });
}

// Conservative title cleanup — fixes obvious presentation artifacts from decade-old
// catalog OCR WITHOUT inventing, rewriting, or re-casing historical content. It does
// NOT title-case words (that would corrupt measurement units like "CT"/"MM" and proper
// nouns) and does NOT attempt to un-truncate titles (no inferred information).
function cleanTitle(t) {
  if (!t) return t;
  let s = String(t);
  s = s.replace(/\*/g, ' ');                       // remove stray catalog asterisks
  s = s.replace(/\s+/g, ' ');                      // collapse runs of whitespace
  s = s.replace(/\s+([,;:.!?])/g, '$1');           // no space BEFORE punctuation
  s = s.replace(/([,;:])(?=[^\s\d])/g, '$1 ');     // single space AFTER , ; : (never inside numbers like 5,000)
  s = s.replace(/([,;])\1+/g, '$1');               // dedupe repeated , or ;
  s = s.replace(/^[\s*–—·•|]+/, '');                // strip leading stray symbols (NOT . , : — a leading "." is a decimal like ".65 CT")
  s = s.trim();
  if (s && /[a-z]/.test(s.charAt(0))) s = s.charAt(0).toUpperCase() + s.slice(1); // capitalize first letter only
  return s;
}

// Cloudinary URL cache: { "<folder>/<filename>": secure_url }
let cache = {};
function loadCache() { try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { cache = {}; } }
function saveCache() { try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)); } catch { /* best-effort */ } }

async function uploadImage(folder, n, filename) {
  const key = `${folder}/${filename}`;
  if (cache[key]) return cache[key];
  const filePath = path.join(CATALOG_DIR, folder, 'images', filename);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) return null;
  const buf = fs.readFileSync(filePath);
  const publicId = filename.replace(/\.[^.]+$/, '');
  const res = await cloudinary.uploadBuffer(buf, {
    folder: `historical-auctions/${n}`,
    public_id: publicId,
    overwrite: true,
    use_filename: false,
    unique_filename: false,
  });
  cache[key] = res.secure_url;
  return res.secure_url;
}

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); process.exit(2); }
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint. STAGING-only.'); process.exit(2); }
  if (!raw.includes(STG_EP)) { console.error(`REFUSE: not the STAGING endpoint (${STG_EP}).`); process.exit(2); }
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('REFUSE: Cloudinary credentials missing in environment.'); process.exit(2);
  }

  loadCache();
  const idx = readCsv(INDEX_CSV); // archive_folder, auction_title, ..., fallback_internal_import_date_if_required
  const folders = idx.map((r) => ({
    folder: r.archive_folder,
    title: r.auction_title,
    date: r.fallback_internal_import_date_if_required,
  })).filter((f) => f.folder && fs.existsSync(path.join(CATALOG_DIR, f.folder)))
    .sort((a, b) => a.folder.localeCompare(b.folder));

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  const auctionIds = [];
  let totLots = 0, totImaged = 0;
  try {
    // 1) Dedicated historical seller (idempotent upsert).
    await c.query(
      `INSERT INTO seller_profiles (id, user_id, seller_type, display_name, location_label, bio)
       VALUES ($1, NULL, 'business', 'Advantage Auction Company', 'Knoxville, TN',
               'Advantage Auction Company — historical auction archive.')
       ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name, location_label=EXCLUDED.location_label, bio=EXCLUDED.bio`,
      [SELLER_SP]);

    // 2) Import each auction.
    for (let n = 1; n <= folders.length; n++) {
      const { folder, title, date } = folders[n - 1];
      const aid = `5c00000${n}-0000-4000-8000-000000000000`;
      auctionIds.push(aid);

      // Auction-level safe summary (no prohibited data).
      let summary = 'A historical Advantage Auction Company past auction.';
      try { summary = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, folder, 'auction.json'), 'utf8')).auction.public_summary || summary; } catch { /* keep default */ }

      const startISO = `${date} 15:00:00+00`;
      const endISO = `${date} 23:00:00+00`;
      await c.query(
        `INSERT INTO auctions (id, seller_id, title, subtitle, description, state, public_auction_type,
            city, address_state, zip, lat, lng, shipping_available, start_time, end_time, is_archived)
         VALUES ($1,$2,$3,'Presented for historical reference only.',$4,'closed','historical_archive',
            'Knoxville','TN','37902',35.9606,-83.9207,false,
            TIMESTAMPTZ '${startISO}', TIMESTAMPTZ '${endISO}', false)
         ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, subtitle=EXCLUDED.subtitle, description=EXCLUDED.description,
            state='closed', public_auction_type='historical_archive', is_archived=false,
            start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time`,
        [aid, SELLER_SP, title, summary]);

      // Replace this auction's lots/images for a clean idempotent re-run.
      await c.query(`DELETE FROM lot_images WHERE lot_id IN (SELECT id FROM lots WHERE auction_id=$1)`, [aid]);
      await c.query(`DELETE FROM lots WHERE auction_id=$1`, [aid]);

      const lots = readCsv(path.join(CATALOG_DIR, folder, 'lots.csv'))
        .map((r) => ({ order: parseInt(r.display_order, 10), file: r.image_filename, title: cleanTitle(r.title), category: r.category }))
        .filter((l) => l.order && l.title)
        .sort((a, b) => a.order - b.order);

      let coverUrl = null, imaged = 0;
      for (const lot of lots) {
        let url = null;
        if (lot.file) {
          try { url = await uploadImage(folder, n, lot.file); }
          catch (e) { console.error(`  upload failed ${folder}/${lot.file}: ${e.message}`); url = null; }
        }
        if (url) { imaged++; if (!coverUrl) coverUrl = url; }
        const lid = `5c00000${n}-0000-4000-8000-${String(lot.order).padStart(12, '0')}`;
        await c.query(
          `INSERT INTO lots (id, auction_id, lot_number, title, description, category, size_category, pickup_category,
              condition, era, starting_bid_cents, bid_increment_cents, current_bid_cents, bid_count,
              winning_amount_cents, winning_buyer_user_id, state, is_featured, shippable, thumbnail_url, images_count)
           VALUES ($1,$2,$3,$4,NULL,$5,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,'closed',false,false,$6,$7)`,
          [lid, aid, lot.order, lot.title, lot.category || null, url, url ? 1 : 0]);
        if (url) await c.query(`INSERT INTO lot_images (lot_id, image_url, sort_order) VALUES ($1,$2,0)`, [lid, url]);
      }
      saveCache();

      await c.query(`UPDATE auctions SET cover_image_url=$2, banner_image_url=$2 WHERE id=$1`, [aid, coverUrl]);
      totLots += lots.length; totImaged += imaged;
      console.log(`${folder}\n  lots=${lots.length} imaged=${imaged} imageless=${lots.length - imaged} cover=${coverUrl ? 'yes' : 'NONE'}`);
    }

    // 3) Optionally replace the demo "Sample Auction Results" set.
    if (REMOVE_DEMOS) {
      await c.query(`DELETE FROM lot_images WHERE lot_id IN (SELECT id FROM lots WHERE auction_id = ANY($1::uuid[]))`, [DEMO_AUCTIONS]);
      await c.query(`DELETE FROM lots WHERE auction_id = ANY($1::uuid[])`, [DEMO_AUCTIONS]);
      await c.query(`DELETE FROM auctions WHERE id = ANY($1::uuid[])`, [DEMO_AUCTIONS]);
      console.log('Removed demo curated auctions (5b block).');
    }

    // 4) Verify.
    const a = (await c.query(`SELECT COUNT(*)::int n FROM auctions WHERE id = ANY($1::uuid[]) AND state='closed' AND is_archived=false AND public_auction_type='historical_archive'`, [auctionIds])).rows[0].n;
    const lc = (await c.query(`SELECT COUNT(*)::int n,
        COUNT(*) FILTER (WHERE winning_amount_cents IS NOT NULL)::int priced,
        COUNT(*) FILTER (WHERE winning_buyer_user_id IS NOT NULL)::int buyers,
        COUNT(*) FILTER (WHERE description IS NOT NULL AND description<>'')::int descs,
        COUNT(*) FILTER (WHERE thumbnail_url IS NOT NULL)::int imaged,
        COALESCE(SUM(bid_count),0)::int bids,
        COUNT(DISTINCT category)::int cats
      FROM lots WHERE auction_id = ANY($1::uuid[])`, [auctionIds])).rows[0];
    const demo = (await c.query(`SELECT COUNT(*)::int n FROM auctions WHERE id = ANY($1::uuid[])`, [DEMO_AUCTIONS])).rows[0].n;
    const pub = (await c.query(`SELECT COUNT(*)::int n FROM auctions WHERE state='closed' AND is_archived IS NOT TRUE`)).rows[0].n;

    console.log('\n=== VERIFY ===');
    console.log(`historical auctions: ${a}/8`);
    console.log(`lots: ${lc.n} (expect 1802) | imaged=${lc.imaged} | categories=${lc.cats}`);
    console.log(`leakage check — priced=${lc.priced} buyers=${lc.buyers} descriptions=${lc.descs} bids=${lc.bids} (all expect 0)`);
    console.log(`demo auctions remaining: ${demo}${REMOVE_DEMOS ? ' (expect 0)' : ' (kept; pass --remove-demos to replace)'}`);
    console.log(`total public closed/non-archived auctions: ${pub}`);

    const pass = a === 8 && lc.n === 1802 && lc.priced === 0 && lc.buyers === 0 && lc.descs === 0 && lc.bids === 0
      && (!REMOVE_DEMOS || demo === 0);
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    process.exitCode = pass ? 0 : 1;
  } catch (e) { console.error('FATAL', e.message); console.error(e.stack); process.exitCode = 1; }
  finally { saveCache(); c.release(); await pool.end(); }
})();

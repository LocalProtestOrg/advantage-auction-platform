#!/usr/bin/env node
/* reconcile-creative-registry.js — compares three sources of truth and reports anything unexplained:

     FILESYSTEM   docs/marketing/production-creative/**            (what the Owner has put there)
     REGISTRY     marketing_production_creative + _creative_packages (what is governed)
     META         marketing_provider_images                        (what has been uploaded)

   An UNEXPLAINED file is a production image on disk that the registry does not know about. The
   required condition is UNEXPLAINED = 0, so that when the Owner drops a new advertisement into the
   folder it is visible immediately rather than silently ignored.

   This never approves anything. A newly discovered file is reported, registered as UNAPPROVED, and
   left for an explicit Owner decision.

   Usage: node scripts/reconcile-creative-registry.js [--category=professional-seller] [--json] */

const db = require('../src/db');
const registry = require('../src/services/productionCreativeRegistry');

const ARG = (n) => (process.argv.find((a) => a.startsWith('--' + n + '=')) || '').split('=')[1] || null;
const CATEGORY = ARG('category');
const JSON_OUT = process.argv.includes('--json');

(async () => {
  const scan = registry.scan();
  const onDisk = scan.assets.filter((a) => !CATEGORY || a.category === CATEGORY);

  const rows = (await db.query(
    `SELECT c.id, c.sha256, c.filename, c.relative_path, c.category, c.owner_approved_for_production,
            c.production_eligible, c.ineligible_reason, c.approval_source,
            (SELECT json_agg(json_build_object('package_key', p.package_key, 'purpose', p.audience_purpose,
                                               'active', p.active, 'version', p.version,
                                               'destination', p.destination_url))
               FROM marketing_creative_packages p WHERE p.production_creative_id = c.id) AS packages,
            (SELECT provider_image_hash FROM marketing_provider_images i
              WHERE i.production_creative_id = c.id LIMIT 1) AS provider_image_hash
       FROM marketing_production_creative c
      WHERE ($1::text IS NULL OR c.category = $1)`, [CATEGORY])).rows;
  const byHash = new Map(rows.map((r) => [r.sha256, r]));
  const byPath = new Map(rows.map((r) => [r.relative_path, r]));

  const report = onDisk.map((a) => {
    const rec = byPath.get(a.relative_path) || byHash.get(a.sha256) || null;
    const dupOf = !byPath.get(a.relative_path) && byHash.get(a.sha256) ? byHash.get(a.sha256).filename : null;
    return {
      filename: a.filename,
      relative_path: a.relative_path,
      category: a.category,
      sha256: a.sha256,
      registered: !!rec,
      owner_approved: rec ? rec.owner_approved_for_production : false,
      eligible: rec ? rec.production_eligible : false,
      approval_source: rec ? rec.approval_source : null,
      packages: (rec && rec.packages) || [],
      provider_image_hash: rec ? rec.provider_image_hash : null,
      duplicate_of: dupOf,
      block_reason: rec && !rec.production_eligible ? (rec.ineligible_reason || 'not approved') : null,
      // A file is EXPLAINED when the registry knows it and its state is decided either way.
      unexplained: !rec,
    };
  });

  // Non-image files are inventoried but are never advertising assets.
  const nonImages = scan.nonImages.filter((p) => !CATEGORY || p.split('/')[0] === CATEGORY);

  const counts = {
    filesystem: report.length,
    registered: report.filter((r) => r.registered).length,
    eligible: report.filter((r) => r.eligible).length,
    blocked: report.filter((r) => r.registered && !r.eligible).length,
    meta_uploaded: report.filter((r) => r.provider_image_hash).length,
    packaged: report.filter((r) => r.packages.length).length,
    unexplained: report.filter((r) => r.unexplained).length,
    non_image_files: nonImages.length,
  };

  if (JSON_OUT) { console.log(JSON.stringify({ counts, report, nonImages }, null, 2)); process.exit(counts.unexplained ? 1 : 0); }

  console.log('CREATIVE RECONCILIATION' + (CATEGORY ? ' — ' + CATEGORY : '') + '\n');
  for (const r of report) {
    console.log((r.eligible ? 'ELIGIBLE  ' : (r.registered ? 'BLOCKED   ' : 'UNKNOWN   ')) + r.filename);
    console.log('   registered=' + r.registered + '  owner_approved=' + r.owner_approved
      + '  meta_image=' + (r.provider_image_hash ? r.provider_image_hash.slice(0, 12) + '…' : 'not uploaded'));
    console.log('   packages=' + (r.packages.length
      ? r.packages.map((p) => p.package_key + ' (' + p.purpose + (p.active ? ', active' : ', inactive') + ')').join(', ')
      : 'none'));
    if (r.duplicate_of) console.log('   duplicate content of: ' + r.duplicate_of);
    if (r.block_reason) console.log('   blocked: ' + String(r.block_reason).slice(0, 140));
  }
  console.log('\nNON-IMAGE FILES (never advertising assets): ' + (nonImages.length ? nonImages.join(', ') : 'none'));
  console.log('\nCOUNTS');
  Object.entries(counts).forEach(([k, v]) => console.log('  ' + k.padEnd(18) + v));
  console.log('\nRESULT: ' + (counts.unexplained === 0 ? 'PASS — every production image is accounted for'
    : 'FAIL — ' + counts.unexplained + ' unexplained production image(s)'));
  process.exit(counts.unexplained ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

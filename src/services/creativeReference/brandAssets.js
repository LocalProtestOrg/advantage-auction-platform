'use strict';

/**
 * creativeReference/brandAssets — Phase 3P.2 official logo registry (config: docs/marketing/phase3p2/config/logo-asset-system.json).
 * Verifies each registered file's SHA-256 (boot + admin readiness); lists files present in the folder that are NOT
 * registered (never authoritative until the Owner identifies them). The engine's logo_stage performs the same check
 * before compositing; nothing anywhere draws, typesets or approximates the logo.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SYS = require('../../../docs/marketing/phase3p2/config/logo-asset-system.json');
const ROOT = path.join(__dirname, '..', '..', '..', SYS.asset_registry.root);

function verify() {
  const variants = []; const problems = [];
  for (const v of SYS.asset_registry.variants) {
    const p = path.join(ROOT, v.file);
    if (!fs.existsSync(p)) { problems.push('missing ' + v.file); variants.push({ key: v.key, file: v.file, present: false, verified: false }); continue; }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const ok = sha === v.sha256;
    if (!ok) problems.push('hash mismatch ' + v.file);
    variants.push({ key: v.key, file: v.file, present: true, verified: ok });
  }
  const registered = new Set(SYS.asset_registry.variants.map((v) => v.file));
  const unregistered = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((f) => /\.(png|jpe?g|webp|svg)$/i.test(f) && !registered.has(f)) : [];
  return { ok: problems.length === 0, variants, problems, unregistered_files: unregistered, absolute_rule: SYS.absolute_rule };
}

module.exports = { verify, SYS, ROOT };

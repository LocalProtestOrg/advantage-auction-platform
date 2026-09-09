'use strict';

/**
 * creativeReference/engineBridge — bounded Node <-> Python bridge to creative-engine/calibrate.py (Pillow families,
 * perceptual layout signatures, image stats). Same safety posture as creativeEngineService: fixed script path, JSON
 * on stdin only, explicit timeout + kill, structured errors, never throws raw. Reference images reach Python ONLY
 * through 'signature' / 'image_info' (scorer / indexer); 'render' never receives them.
 */
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'creative-engine', 'calibrate.py');
const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const TIMEOUT_MS = Number(process.env.CREATIVE_ENGINE_TIMEOUT_MS || 90000);

function call(req, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', settled = false, child;
    try { child = spawn(PYTHON, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }); }
    catch (e) { return resolve({ ok: false, error: 'spawn_failed: ' + e.message }); }
    const timer = setTimeout(() => { if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch (_) {} resolve({ ok: false, error: 'timeout' }); } }, timeoutMs);
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: 'engine_unavailable: ' + e.message }); } });
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      let parsed = null; try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch (_) { parsed = null; }
      resolve(parsed || { ok: false, error: 'bad_output', code, stderr: (err || '').slice(0, 500) });
    });
    try { child.stdin.write(JSON.stringify(req)); child.stdin.end(); } catch (_) { /* close resolves */ }
  });
}

const render = (family, spec) => module.exports.call({ op: 'render', family, spec });
const signatures = (paths) => module.exports.call({ op: 'signature', paths });
const pairwise = (paths) => module.exports.call({ op: 'pairwise', paths });
const imageInfo = (paths) => module.exports.call({ op: 'image_info', paths });

/** Cosine distance (mirror of adb_engine.signature.distance) so Node can compare stored signatures without Python. */
function distance(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 1;
  const d = Math.round((1 - dot / (Math.sqrt(na) * Math.sqrt(nb))) * 10000) / 10000; return d === 0 ? 0 : d;
}

module.exports = { SCRIPT, PYTHON, call, render, signatures, pairwise, imageInfo, distance };

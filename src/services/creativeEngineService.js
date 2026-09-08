'use strict';

/**
 * creativeEngineService — the durable Node <-> Python integration (Phase 3O Wave 1, blocker 5). The Marketing
 * Package runtime (Node) requests a production creative job; the calibrated creative engine (Python, under
 * creative-engine/) executes it. VS Code owns production execution — Desktop Marketing never runs it.
 *
 * Contract: a validated JSON job on stdin -> creative-engine/produce.py -> a JSON result on stdout. Bounded:
 * explicit timeout, structured errors (never throws raw), idempotency by job_id, safe temp handling + cleanup,
 * no arbitrary command injection (fixed script path; input only via stdin), worker-safe. Provenance is
 * persisted so every creative is auditable (auction -> lot -> source -> extraction -> fidelity -> usage).
 */

const path = require('path');
const { spawn } = require('child_process');
const db = require('../db');

const ENGINE = path.join(__dirname, '..', '..', 'creative-engine', 'produce.py');
const PYTHON = process.env.PYTHON_BIN || 'python3';
const DEFAULT_TIMEOUT_MS = Number(process.env.CREATIVE_ENGINE_TIMEOUT_MS || 60000);

// Run the Python engine with a JSON job on stdin. Resolves with a structured result; NEVER rejects — a
// failure returns { ok:false, error }. Bounded by timeout (kills the child).
function runEngine(job, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', settled = false;
    let child;
    try {
      child = spawn(PYTHON, [ENGINE], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch (e) { return resolve({ ok: false, error: 'spawn_failed: ' + e.message }); }
    const timer = setTimeout(() => { if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch (_) {} resolve({ ok: false, error: 'timeout' }); } }, timeoutMs);
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: 'engine_unavailable: ' + e.message }); } });
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch (_) { parsed = null; }
      if (parsed) return resolve(parsed);
      return resolve({ ok: false, error: 'bad_output', code, stderr: (err || '').slice(0, 500) });
    });
    try { child.stdin.write(JSON.stringify(job)); child.stdin.end(); } catch (e) { /* close handler resolves */ }
  });
}

// Request a creative job for a purchase/obligation. Idempotent by job_id: a completed job returns its stored
// result. Persists the job + provenance. Best-effort; a Python-unavailable production environment returns a
// structured error and the obligation stays in review (never falsely completed).
async function requestCreative({ jobId, auctionId, formats, lots, catalogFamilies }, runner) {
  const r = runner || db;
  const existing = (await r.query(`SELECT status, result FROM marketing_creative_jobs WHERE job_id = $1`, [jobId])).rows[0];
  if (existing && existing.status === 'completed') return { ok: true, idempotent_replay: true, result: existing.result };

  const job = { job_id: jobId, auction_id: auctionId, formats: formats || ['4:5', '1:1'], catalog_families: catalogFamilies || [], lots: lots || [] };
  await r.query(
    `INSERT INTO marketing_creative_jobs (job_id, auction_id, status, request)
     VALUES ($1,$2,'running',$3::jsonb) ON CONFLICT (job_id) DO UPDATE SET status='running', request=EXCLUDED.request`,
    [jobId, auctionId, JSON.stringify(job)]);

  const result = await module.exports.runEngine(job);   // via exports so it is unit-mockable
  const status = result && result.ok ? 'completed' : (result && result.error === 'engine_unavailable' ? 'engine_unavailable' : 'review');
  await r.query(
    `UPDATE marketing_creative_jobs SET status=$2, result=$3::jsonb, runtime_version=$4, updated_at=now() WHERE job_id=$1`,
    [jobId, status, JSON.stringify(result || {}), (result && result.runtime_version) || null]);

  // Persist provenance rows (auditable creative lineage). No PII.
  for (const p of ((result && result.provenance) || [])) {
    await r.query(
      `INSERT INTO marketing_creative_provenance (job_id, auction_id, lot_id, source_image, fidelity, extracted_asset, rgb_edited, generative)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [jobId, auctionId, String(p.lot_id), p.source_image || null, p.fidelity || null, p.extracted_asset || null, p.rgb_edited === true, p.generative === true]).catch(() => {});
  }
  return result;
}

async function getJob(jobId, runner) {
  const r = runner || db;
  return (await r.query(`SELECT * FROM marketing_creative_jobs WHERE job_id=$1`, [jobId])).rows[0] || null;
}

module.exports = { runEngine, requestCreative, getJob, ENGINE };

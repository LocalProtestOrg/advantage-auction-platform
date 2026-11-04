#!/usr/bin/env node
/* check-secrets.js — finds credentials (API keys, secrets, tokens, passwords, database addresses with passwords) before
   they are committed, logged, printed in test output or put on a command line. Shapes: src/lib/secretPatterns.js.
   Never prints a credential: a finding shows the file and line, the kind of credential and its length only.

   Usage:
     node scripts/check-secrets.js --staged            what is about to be committed (the pre-commit hook, .githooks)
     node scripts/check-secrets.js --all               every file tracked by git (CI)
     node scripts/check-secrets.js --range A..B        lines added between two commits
     node scripts/check-secrets.js --file out.txt      a log or test output file (CI scans the test run's output)
     <command> | node scripts/check-secrets.js --stdin
     node scripts/check-secrets.js --processes         command lines of running processes on this computer
     node scripts/check-secrets.js --config <file.json> "args" of each server in a desktop integration config
   Exit code 1 when anything is found, 0 when clean.
   A line can be excused only with the marker  secret-scan: allow  and a reason, for a value that is not a credential. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findSecrets } = require('../src/lib/secretPatterns');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i === -1 ? null : args[i + 1]; };
const SKIP = /(^|\/)(node_modules|\.git|coverage|playwright-report|test-results)\//;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|mov|webm|psd|ai|sketch|xlsx?|docx?|pptx?)$/i;
const ALLOW_MARK = /secret-scan:\s*allow\b/;
const git = (a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const findings = [];
function scanText(label, text, lineOffset = 0) {
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (ALLOW_MARK.test(line)) return;
    for (const f of findSecrets(line)) findings.push({ where: `${label}:${i + 1 + lineOffset}`, kind: f.id, size: f.preview });
  });
}

function scanTracked(files) {
  for (const f of files) {
    if (!f || SKIP.test(f) || BINARY.test(f)) continue;
    const p = path.join(ROOT, f);
    let st; try { st = fs.statSync(p); } catch (_) { continue; }
    if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
    const text = fs.readFileSync(p, 'utf8');
    if (text.includes('\u0000')) continue;   // binary
    scanText(f, text);
  }
}

// Added lines of a unified diff, with their file and line number in the new version.
function scanDiff(diff) {
  let file = null; let line = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { line = Number(h[1]) - 1; continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      line++;
      if (!file || file === '/dev/null' || SKIP.test(file) || BINARY.test(file) || ALLOW_MARK.test(l)) continue;
      for (const f of findSecrets(l.slice(1))) findings.push({ where: `${file}:${line}`, kind: f.id, size: f.preview });
    } else if (!l.startsWith('-')) line++;
  }
}

function processCommandLines() {
  let rows = [];
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { "$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)" }'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    rows = out.split(/\r?\n/).filter(Boolean).map((r) => r.split('\t'));
  } else {
    rows = execFileSync('ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8' }).split('\n').filter(Boolean)
      .map((r) => { const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(r); return m ? [m[1], m[2], m[3]] : null; }).filter(Boolean);
  }
  for (const [pid, name, cmd] of rows) {
    if (!cmd || String(pid) === String(process.pid)) continue;
    for (const f of findSecrets(cmd)) findings.push({ where: `process ${pid} (${name})`, kind: f.id, size: f.preview });
  }
}

function desktopConfig(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [name, s] of Object.entries(j.mcpServers || j.servers || {})) {
    const argv = (s.args || []).join(' ');
    for (const f of findSecrets(argv)) findings.push({ where: `${path.basename(file)} → ${name} args`, kind: f.id, size: f.preview });
    // A value right after a credential flag is a credential, whatever it looks like.
    (s.args || []).forEach((a, i) => {
      if (/^--?(api[-_]?key|token|secret|password|access[-_]?token)$/i.test(a) && s.args[i + 1]) findings.push({ where: `${path.basename(file)} → ${name} args`, kind: 'credential_flag_value', size: '[' + String(s.args[i + 1]).length + ' characters]' });
      if (/^--?(api[-_]?key|token|secret|password|access[-_]?token)=.+/i.test(a)) findings.push({ where: `${path.basename(file)} → ${name} args`, kind: 'credential_flag_value', size: '[value on the command line]' });
    });
  }
}

(async () => {
  if (args.includes('--staged')) scanDiff(git(['diff', '--cached', '-U0', '--no-color', '--diff-filter=ACMR']));
  else if (args.includes('--all')) scanTracked(git(['ls-files', '-z']).split('\u0000'));
  else if (argOf('--range')) scanDiff(git(['diff', '-U0', '--no-color', '--diff-filter=ACMR', argOf('--range')]));
  else if (argOf('--file')) scanText(argOf('--file'), fs.readFileSync(argOf('--file'), 'utf8'));
  else if (args.includes('--stdin')) { let s = ''; for await (const c of process.stdin) s += c; scanText('stdin', s); }
  else if (args.includes('--processes')) processCommandLines();
  else if (argOf('--config')) desktopConfig(argOf('--config'));
  else { console.error('Usage: --staged | --all | --range A..B | --file <f> | --stdin | --processes | --config <file.json>'); process.exit(2); }

  if (!findings.length) { console.log('[secret-scan] clean'); return; }
  console.error(`[secret-scan] ${findings.length} possible credential${findings.length === 1 ? '' : 's'} found (values not shown):`);
  for (const f of findings.slice(0, 200)) console.error(`  ${f.where}  ${f.kind}  ${f.size}`);
  console.error('Remove the credential (use an environment variable; see docs/security/secret-management.md). If it is not a credential,\n'
    + 'add the comment "secret-scan: allow <reason>" on that line.');
  process.exitCode = 1;
})().catch((e) => { console.error('[secret-scan] failed:', e.message); process.exit(2); });

'use strict';

/**
 * netGuard — SSRF-safe, honest fetching for website discovery.
 *
 *   isPublicAddress(ip)              → bool (rejects loopback, private, link-local, CGNAT, multicast…)
 *   checkUrl(url, { lookup })        → { ok, reason?, url, host, addresses }
 *   safeFetch(url, opts)             → { ok, status, headers, text, url, redirects, contentType, reason }
 *   createHostPacer({ minIntervalMs }) → { wait(host) } spacing requests per host
 *
 * Every request identifies itself with the importer's one honest identity (http.DEFAULT_UA). A caller
 * can never substitute another User-Agent: passing one throws. Redirects are followed manually so each
 * hop is re-checked (public address, allowed protocol/port, same site unless explicitly allowed). No
 * cookies, no credentials. HTTP statuses never throw; network failures return status 'network'.
 */

const net = require('net');
const dnsp = require('dns').promises;
const httpMod = require('http');
const httpsMod = require('https');

/**
 * The default transport: Node http/https with the connection PINNED to the address checkUrl just approved.
 * The platform fetch would resolve the hostname again on connect, so a hostile DNS server could answer a public
 * address to the check and a private one to the connection (DNS rebinding). Here the socket can only go to an
 * address that passed isPublicAddress, TLS still verifies the real hostname (servername), and no connection is
 * reused (agent: false). Returns a fetch-like response whose body is read with the same size cap.
 */
function pinnedFetch(url, init, approved, maxBytes) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? httpsMod : httpMod;
    const address = (approved || [])[0];
    if (!address || !isPublicAddress(address)) { reject(new Error('no approved address')); return; }
    const family = net.isIP(address);
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET',
      headers: init.headers, agent: false, servername: net.isIP(u.hostname) ? undefined : u.hostname,
      lookup: (host, opts, cb) => { if (opts && opts.all) cb(null, [{ address, family }]); else cb(null, address, family); },
    }, (res) => {
      const chunks = []; let size = 0; let tooLarge = false;
      res.on('data', (c) => {
        if (tooLarge) return;
        size += c.length;
        if (size > (maxBytes || DEFAULT_MAX_BYTES)) { tooLarge = true; res.destroy(); return; }
        chunks.push(c);
      });
      const finish = () => resolve({ status: res.statusCode, headers: res.headers, body: null,
        text: async () => { if (tooLarge) { const e = new Error('too_large'); e.code = 'TOO_LARGE'; throw e; } return Buffer.concat(chunks).toString('utf8'); } });
      res.on('end', finish);
      res.on('close', () => { if (tooLarge) finish(); });
      res.on('error', (e) => { if (tooLarge) finish(); else reject(e); });
    });
    if (init.signal) init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    req.on('error', reject);
    req.end();
  });
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25000;

function v4ToInt(ip) { return ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0) >>> 0; }
function inV4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
];

// Expand an IPv6 address to 8 hextets (handles '::' and an embedded IPv4 tail).
function expandV6(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + ((n >>> 16).toString(16)) + ':' + ((n & 0xFFFF).toString(16));
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  const parts = t === null ? h : h.concat(Array(8 - h.length - t.length).fill('0'), t);
  return parts.map((p) => parseInt(p || '0', 16));
}

function isPublicAddress(ip) {
  const s = String(ip || '').trim();
  const kind = net.isIP(s.replace(/^\[|\]$/g, '').split('%')[0]);
  if (kind === 4) return !V4_BLOCKED.some(([b, bits]) => inV4(s, b, bits));
  if (kind !== 6) return false;
  const x = expandV6(s);
  if (x.length !== 8 || x.some((n) => Number.isNaN(n))) return false;
  if (x.every((n) => n === 0)) return false;                                   // ::
  if (x.slice(0, 7).every((n) => n === 0) && x[7] === 1) return false;          // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the embedded IPv4.
  if (x.slice(0, 5).every((n) => n === 0) && (x[5] === 0xFFFF || x[5] === 0)) {
    const v4 = [x[6] >> 8, x[6] & 255, x[7] >> 8, x[7] & 255].join('.');
    return isPublicAddress(v4);
  }
  if ((x[0] & 0xFE00) === 0xFC00) return false;    // fc00::/7 unique local
  if ((x[0] & 0xFFC0) === 0xFE80) return false;    // fe80::/10 link-local
  if ((x[0] & 0xFF00) === 0xFF00) return false;    // ff00::/8 multicast
  if (x[0] === 0x2001 && x[1] === 0x0db8) return false;   // documentation
  if (x[0] === 0x0064 && x[1] === 0xff9b) return false;   // NAT64 64:ff9b::/96 and 64:ff9b:1::/48 (could reach private v4)
  if (x.slice(0, 4).every((n) => n === 0) && x[4] === 0xFFFF && x[5] === 0) return false;   // ::ffff:0:0/96 (IPv4-translated)
  if (x[0] === 0x2002) return false;                        // 6to4 (embeds an arbitrary IPv4)
  if (x[0] === 0x2001 && x[1] === 0x0000) return false;     // Teredo (embeds an arbitrary IPv4)
  if (x[0] === 0x0100 && x.slice(1, 4).every((n) => n === 0)) return false;   // 100::/64 discard-only
  return true;
}

async function checkUrl(url, { lookup } = {}) {
  let u;
  try { u = new URL(String(url)); } catch (_) { return { ok: false, reason: 'invalid_url', url, host: null, addresses: [] }; }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const base = { url: u.toString(), host, addresses: [] };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return Object.assign(base, { ok: false, reason: 'protocol_not_allowed' });
  if (u.username || u.password) return Object.assign(base, { ok: false, reason: 'credentials_in_url' });
  if (u.port && !['80', '443'].includes(u.port)) return Object.assign(base, { ok: false, reason: 'port_not_allowed' });
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return Object.assign(base, { ok: false, reason: 'private_address' });
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      const res = await (lookup || ((h) => dnsp.lookup(h, { all: true })))(host);
      addresses = (Array.isArray(res) ? res : [res]).map((a) => (typeof a === 'string' ? a : a.address)).filter(Boolean);
    } catch (e) { return Object.assign(base, { ok: false, reason: 'dns_failed' }); }
  }
  base.addresses = addresses;
  if (!addresses.length) return Object.assign(base, { ok: false, reason: 'dns_failed' });
  // Every address must be public: one private answer among many is a rebinding risk.
  if (addresses.some((a) => !isPublicAddress(a))) return Object.assign(base, { ok: false, reason: 'private_address' });
  return Object.assign(base, { ok: true });
}

const bareHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
function sameSiteHost(original, next) {
  const a = bareHost(original), b = bareHost(next);
  return a === b || b.endsWith('.' + a);
}

function headersObject(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function') h.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
  else for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
  return out;
}

async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = typeof res.text === 'function' ? await res.text() : '';
    if (Buffer.byteLength(t) > maxBytes) { const e = new Error('too_large'); e.code = 'TOO_LARGE'; throw e; }
    return t;
  }
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { try { await reader.cancel(); } catch (_) {} const e = new Error('too_large'); e.code = 'TOO_LARGE'; throw e; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function safeFetch(url, opts = {}) {
  const headersIn = opts.headers || {};
  if (Object.keys(headersIn).some((k) => k.toLowerCase() === 'user-agent')) {
    throw new Error('netGuard: the importer identity cannot be overridden');
  }
  const { DEFAULT_UA } = require('./http');
  // Tests inject fetchImpl; production always uses the pinned transport (never the re-resolving platform fetch).
  const fetchImpl = opts.fetchImpl || null;
  const maxRedirects = opts.maxRedirects != null ? opts.maxRedirects : 5;
  const sameSite = opts.sameSite !== false;
  const allowedHosts = (opts.allowedHosts || []).map(bareHost);
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const redirects = [];
  let current = String(url);
  let originalHost = null;
  const fail = (status, reason, extra) => Object.assign({ ok: false, status, headers: {}, text: '', url: current, redirects, contentType: '', reason }, extra || {});

  for (let hop = 0; ; hop++) {
    const chk = await checkUrl(current, { lookup: opts.lookup });
    if (!chk.ok) return fail('blocked', chk.reason);
    if (originalHost === null) originalHost = chk.host;
    else if (sameSite && !sameSiteHost(originalHost, chk.host) && !allowedHosts.includes(bareHost(chk.host))) return fail('blocked', 'offsite_redirect');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      const init = {
        method: 'GET', redirect: 'manual', signal: ctrl.signal, credentials: 'omit',
        headers: Object.assign({ Accept: opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,text/calendar;q=0.9,application/json;q=0.8,*/*;q=0.5' },
          headersIn, { 'User-Agent': DEFAULT_UA }),
      };
      res = fetchImpl ? await fetchImpl(current, init) : await pinnedFetch(current, init, chk.addresses, maxBytes);
    } catch (e) {
      clearTimeout(timer);
      return fail('network', ctrl.signal.aborted ? 'timeout' : String((e && e.message) || 'network error'));
    }
    const status = res.status;
    const headers = headersObject(res.headers);
    if (status >= 300 && status < 400 && headers.location) {
      clearTimeout(timer);
      if (hop >= maxRedirects) return fail(status, 'too_many_redirects', { headers });
      let next;
      try { next = new URL(headers.location, current).toString(); } catch (_) { return fail(status, 'bad_redirect', { headers }); }
      redirects.push({ from: current, to: next, status });
      current = next;
      continue;
    }
    let text = '';
    try { text = await readCapped(res, maxBytes); }
    catch (e) {
      clearTimeout(timer);
      if (e.code === 'TOO_LARGE') return fail(status, 'too_large', { headers });
      return fail('network', ctrl.signal.aborted ? 'timeout' : String((e && e.message) || 'read failed'));
    }
    clearTimeout(timer);
    const contentType = String(headers['content-type'] || '').toLowerCase();
    const ok = status >= 200 && status < 300;
    return { ok, status, headers, text, url: current, redirects, contentType, reason: ok ? null : 'http_status' };
  }
}

function createHostPacer({ minIntervalMs = 3000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const last = new Map();
  return {
    // intervalMs: a longer spacing for this host (e.g. its robots.txt Crawl-delay); never shorter than the minimum.
    async wait(host, intervalMs) {
      const key = bareHost(host);
      const prev = last.get(key);
      const spacing = Math.max(minIntervalMs, Number(intervalMs) || 0);
      if (prev != null) {
        const gap = prev + spacing - now();
        if (gap > 0) await sleep(gap);
      }
      last.set(key, now());
    },
  };
}

module.exports = { isPublicAddress, checkUrl, safeFetch, pinnedFetch, createHostPacer, sameSiteHost, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS };

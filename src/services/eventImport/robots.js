'use strict';

/**
 * robots — RFC 9309 robots.txt parsing and evaluation for the honest importer identity.
 *
 *   parseRobots(text)                         → { groups:[{ agents, rules:[{allow,path}], crawlDelay }], sitemaps }
 *   isAllowed(parsed, agentToken, path)       → bool (most specific group; longest match; Allow wins ties)
 *   crawlDelaySeconds(parsed, agentToken)     → number | null
 *   fetchRobots(origin, { fetchFn })          → the fetched + evaluated policy for one origin
 *
 * FETCH POLICY (documented choice):
 *   2xx                → parse and obey
 *   404 / 410          → no robots file: everything allowed (RFC 9309 §2.3.1.3)
 *   401 / 403          → DISALLOW ALL, refused:true. RFC 9309 would allow crawling on a 4xx, but a host
 *                        that refuses even robots.txt is refusing us; we treat that as a refusal, never
 *                        as permission.
 *   429 / 5xx / network→ DISALLOW ALL, transient:true (RFC 9309 §2.3.1.4: assume complete disallow)
 *   other 4xx          → allow all (RFC 9309 §2.3.1.3)
 */

const AGENT_TOKEN = 'AdvantageBidBot';

function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;          // group being built
  let lastWasAgent = false;    // consecutive user-agent lines share one group
  const lines = String(text || '').replace(/^﻿/, '').split(/\r\n|\r|\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 1) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [], crawlDelay: null }; groups.push(current); }
      if (value) current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap') { if (value) sitemaps.push(value); continue; }
    if (!current) continue;    // rules before any user-agent are ignored
    if (field === 'allow' || field === 'disallow') {
      current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return { groups, sitemaps };
}

// The group(s) for this agent: the most specific (longest) matching product token; else '*'.
function groupsFor(parsed, agentToken) {
  const token = String(agentToken || AGENT_TOKEN).toLowerCase();
  const groups = (parsed && parsed.groups) || [];
  let best = 0; let picked = [];
  for (const g of groups) {
    for (const a of g.agents) {
      if (a !== '*' && token.startsWith(a) && a.length >= best) {
        if (a.length > best) { best = a.length; picked = []; }
        if (!picked.includes(g)) picked.push(g);
      }
    }
  }
  if (picked.length) return picked;
  return groups.filter((g) => g.agents.includes('*'));
}

// Robots wildcard match ('*' any run, trailing '$' end anchor), in linear-ish time: the classic greedy
// matcher with one backtrack point, never a compiled regex of repeated .* (which a hostile robots.txt
// could make catastrophic). Rule and path lengths are capped.
function ruleMatches(rule, path) {
  let p = String(rule).slice(0, 512); const t = String(path).slice(0, 2048);
  let anchored = false;
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
  let i = 0, j = 0, star = -1, mark = 0;
  while (j < t.length) {
    if (i < p.length && p[i] === '*') { star = i++; mark = j; continue; }
    if (i < p.length && p[i] === t[j]) { i++; j++; continue; }
    if (i >= p.length && !anchored) return true;            // the rule is a prefix of the path
    if (star >= 0) { i = star + 1; j = ++mark; continue; }
    return false;
  }
  while (i < p.length && p[i] === '*') i++;
  return i === p.length;
}

// Percent-encoding is normalized so "/a%7Eb" and "/a~b" compare alike.
function norm(p) { try { return decodeURI(p); } catch (_) { return p; } }

function isAllowed(parsed, agentToken, pathWithQuery) {
  const path = norm(String(pathWithQuery || '/') || '/');
  if (/^\/robots\.txt(\?|$)/i.test(path)) return true;
  let bestLen = -1; let allowed = true;
  for (const g of groupsFor(parsed, agentToken)) {
    for (const r of g.rules) {
      if (!r.path) continue;            // empty Disallow / Allow: matches nothing
      if (!ruleMatches(norm(r.path), path)) continue;
      const len = r.path.replace(/\$$/, '').length;
      if (len > bestLen || (len === bestLen && r.allow && !allowed)) { bestLen = len; allowed = r.allow; }
    }
  }
  return allowed;
}

function crawlDelaySeconds(parsed, agentToken) {
  for (const g of groupsFor(parsed, agentToken)) if (g.crawlDelay != null) return g.crawlDelay;
  return null;
}

async function fetchRobots(origin, { fetchFn } = {}) {
  const url = new URL('/robots.txt', origin).toString();
  const fetcher = fetchFn || ((u) => require('./netGuard').safeFetch(u, { maxBytes: 512 * 1024 }));
  let r;
  try { r = await fetcher(url); } catch (e) { r = { status: 'network', text: '', reason: e && e.message }; }
  const status = r ? r.status : 'network';
  const out = { status, allowAll: false, disallowAll: false, refused: false, transient: false,
    parsed: { groups: [], sitemaps: [] }, sitemaps: [], evidence: { url, status } };
  if (typeof status === 'number' && status >= 200 && status < 300) {
    out.parsed = parseRobots(r.text);
    out.sitemaps = out.parsed.sitemaps;
  } else if (status === 404 || status === 410) {
    out.allowAll = true;
  } else if (status === 401 || status === 403) {
    out.disallowAll = true; out.refused = true;
  } else if (status === 429 || status === 'network' || (typeof status === 'number' && status >= 500)) {
    out.disallowAll = true; out.transient = true;
  } else {
    out.allowAll = true;
  }
  return out;
}

/** Is this path allowed under a fetchRobots() result? */
function policyAllows(policy, agentToken, pathWithQuery) {
  if (!policy) return false;
  if (policy.disallowAll) return false;
  if (policy.allowAll) return true;
  return isAllowed(policy.parsed, agentToken, pathWithQuery);
}

module.exports = { AGENT_TOKEN, parseRobots, isAllowed, crawlDelaySeconds, fetchRobots, policyAllows, ruleMatches };

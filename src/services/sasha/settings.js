'use strict';

/**
 * Sasha operational switches (platform_config, category 'sasha'). Independent controls:
 *   sasha.enabled                 — global stop (everything below requires it)
 *   sasha.engine_enabled          — model processing (off → messages are recorded and handed to staff, no replies)
 *   sasha.email_inbound_enabled   — accept mail on the company-inbox route (off → receipts are held, not lost)
 *   sasha.email_autoreply_enabled — send email replies without a person (off → Sasha drafts, staff send)
 *   sasha.chat_bid_enabled        — chat on bid.advantage.bid
 *   sasha.chat_www_enabled        — chat on www.advantage.bid (Brilliant Directories)
 *   sasha.daily_budget_usd        — model spend cap per UTC day (reached → hand to staff, no model calls)
 *   sasha.imap_read_enabled       — read info@advantage.bid over IMAP (read-only) and RECORD new mail (shadow)
 *   sasha.imap_process_enabled    — hand IMAP-recorded mail to Sasha (requires imap_read_enabled)
 * A 15-second cache keeps the chat path fast; every switch change clears it.
 */

const db = require('../../db');

const KEYS = ['sasha.enabled', 'sasha.engine_enabled', 'sasha.email_inbound_enabled', 'sasha.email_autoreply_enabled',
  'sasha.chat_bid_enabled', 'sasha.chat_www_enabled', 'sasha.daily_budget_usd', 'sasha.imap_read_enabled', 'sasha.imap_process_enabled'];
const BOOL_KEYS = KEYS.filter((k) => k !== 'sasha.daily_budget_usd');
const TTL_MS = 15000;
let cache = null, cachedAt = 0;

const asBool = (v) => v === true || v === 'true';

async function load(runner = db) {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const rows = (await runner.query(`SELECT key, value FROM platform_config WHERE key = ANY($1::text[])`, [KEYS])).rows;
  const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const s = {};
  for (const k of BOOL_KEYS) s[k.replace('sasha.', '')] = asBool(raw[k]);
  const budget = Number(raw['sasha.daily_budget_usd']);
  s.daily_budget_usd = Number.isFinite(budget) && budget >= 0 ? budget : 25;
  cache = s; cachedAt = Date.now();
  return s;
}

/** Effective switches: every channel switch requires the global switch. */
async function effective(runner) {
  const s = await load(runner);
  const on = s.enabled;
  return {
    ...s,
    engine: on && s.engine_enabled,
    email_inbound: on && s.email_inbound_enabled,
    email_autoreply: on && s.email_inbound_enabled && s.email_autoreply_enabled,
    chat_bid: on && s.chat_bid_enabled,
    chat_www: on && s.chat_www_enabled,
    imap_read: on && s.imap_read_enabled,
    imap_process: on && s.imap_read_enabled && s.imap_process_enabled,
  };
}

async function set(key, value, runner = db) {
  if (!KEYS.includes(key)) throw Object.assign(new Error('Unknown Sasha setting'), { status: 400 });
  let v = value;
  if (BOOL_KEYS.includes(key)) {
    if (typeof value !== 'boolean') throw Object.assign(new Error('Switch value must be true or false'), { status: 400 });
  } else {
    v = Number(value);
    if (!Number.isFinite(v) || v < 0 || v > 1000) throw Object.assign(new Error('Budget must be between 0 and 1000 (USD per day)'), { status: 400 });
  }
  await runner.query(`INSERT INTO platform_config (key, value, category) VALUES ($1, $2::jsonb, 'sasha')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(v)]);
  clear();
  return v;
}

function clear() { cache = null; cachedAt = 0; }

module.exports = { load, effective, set, clear, KEYS, BOOL_KEYS };

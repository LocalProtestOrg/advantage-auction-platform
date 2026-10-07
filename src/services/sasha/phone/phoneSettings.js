'use strict';

/**
 * Phone Sasha switches and limits (platform_config, category 'sasha_phone', migration 188). Defaults are the safe
 * values: the real phone channel is OFF and no provider is selected. Simulations (Super Admin tester, tests) do not
 * need the channel switch, but they never reach a real provider either.
 */

const db = require('../../../db');

const DEFAULTS = {
  enabled: false, provider: 'none', verify_provider: 'none',
  disclosure_text: "You've reached Advantage.Bid. This call is answered by Sasha, our virtual assistant, and is transcribed for customer support.",
  max_concurrent_calls: 10, daily_budget_usd: 10, per_call_budget_usd: 0.75, transcript_retention_days: 90,
  code_ttl_minutes: 10, code_max_attempts: 5, code_max_sends_per_30min: 3, lockout_minutes: 60, session_max_minutes: 20,
  voice: { tts_provider: null, voice: null, language: 'en-US' },
};
const NUM = { max_concurrent_calls: [1, 200], daily_budget_usd: [0, 1000], per_call_budget_usd: [0, 25], transcript_retention_days: [1, 3650],
  code_ttl_minutes: [2, 30], code_max_attempts: [1, 10], code_max_sends_per_30min: [1, 10], lockout_minutes: [5, 1440], session_max_minutes: [2, 60] };
const PROVIDERS = ['none', 'twilio_cr', 'retell'];
const VERIFY_PROVIDERS = ['none', 'twilio_verify'];
const TTL_MS = 15000;
let cache = null; let cachedAt = 0;

async function load(runner = db) {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const s = { ...DEFAULTS, voice: { ...DEFAULTS.voice } };
  try {
    const rows = (await runner.query(`SELECT key, value FROM platform_config WHERE key LIKE 'sasha.phone.%'`)).rows;
    for (const { key, value } of rows) {
      const k = key.slice('sasha.phone.'.length);
      if (k === 'enabled') s.enabled = value === true;
      else if (k === 'provider') s.provider = PROVIDERS.includes(value) ? value : 'none';
      else if (k === 'verify_provider') s.verify_provider = VERIFY_PROVIDERS.includes(value) ? value : 'none';
      else if (k === 'disclosure_text' && typeof value === 'string' && value.trim()) s.disclosure_text = value.trim().slice(0, 400);
      else if (k === 'voice' && value && typeof value === 'object') s.voice = { ...s.voice, ...value };
      else if (NUM[k] && Number.isFinite(Number(value)) && Number(value) >= NUM[k][0] && Number(value) <= NUM[k][1]) s[k] = Number(value);
    }
  } catch (e) { s.enabled = false; s.load_error = e.message; }   // fail closed
  cache = s; cachedAt = Date.now();
  return s;
}

/** Real telephone traffic is allowed only when the switch is on AND a provider is selected. */
async function liveCallsAllowed(runner) { const s = await load(runner); return !!(s.enabled && s.provider !== 'none'); }

function clear() { cache = null; cachedAt = 0; }

module.exports = { load, liveCallsAllowed, clear, DEFAULTS, NUM, PROVIDERS, VERIFY_PROVIDERS };

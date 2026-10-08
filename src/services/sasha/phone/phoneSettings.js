'use strict';

/**
 * Phone Sasha switches and limits (platform_config, category 'sasha_phone', migration 188). Defaults are the safe
 * values: the real phone channel is OFF and no provider is selected. Simulations (Super Admin tester, tests) do not
 * need the channel switch, but they never reach a real provider either.
 */

const db = require('../../../db');

// Owner direction (2026-10-08): the call opens with the Advantage.Bid routing menu, then Sasha greets the caller as an
// Advantage.Bid representative. No assistant-type announcement is added; an optional call_notice (empty by default) can
// be spoken before the menu if the owner ever sets one. disclosure_text is kept for history only and is not spoken.
const DEFAULT_MENU = [
  'Thank you for calling Advantage.Bid, where you always get the advantage!',
  'If you are a buyer, please press 1.',
  'If you are a seller, please press 2.',
  'If you have recently purchased and need assistance with pickup, please press 3.',
  'For all other questions, please press 4.',
].join('\n');
const DEFAULTS = {
  enabled: false, provider: 'none', verify_provider: 'none', access_mode: 'staff_only',
  greeting: 'Thank you for calling Advantage.Bid. This is Sasha. How can I help you today?',
  menu_text: DEFAULT_MENU, call_notice: '',
  disclosure_text: "You've reached Advantage.Bid. This call is answered by Sasha, our virtual assistant, and is transcribed for customer support.",
  max_concurrent_calls: 10, daily_budget_usd: 10, per_call_budget_usd: 0.75, transcript_retention_days: 90,
  code_ttl_minutes: 10, code_max_attempts: 5, code_max_sends_per_30min: 3, lockout_minutes: 60, session_max_minutes: 20,
  // Adult female, neutral American. Used for the menu (<Say>) and for Sasha (ConversationRelay); editable by Super Admin.
  voice: { tts_provider: 'Google', voice: 'en-US-Chirp3-HD-Aoede', language: 'en-US' },
};
const ACCESS_MODES = ['staff_only', 'public'];
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
      else if (k === 'access_mode') s.access_mode = ACCESS_MODES.includes(value) ? value : 'staff_only';
      else if (k === 'greeting' && typeof value === 'string' && value.trim()) s.greeting = value.trim().slice(0, 300);
      else if (k === 'menu_text' && typeof value === 'string' && value.trim()) s.menu_text = value.trim().slice(0, 1200);
      else if (k === 'call_notice' && typeof value === 'string') s.call_notice = value.trim().slice(0, 400);
      else if (k === 'voice' && value && typeof value === 'object') {
        // Null fields keep the defaults (a half-configured voice must never leave the call without one).
        for (const f of ['tts_provider', 'voice', 'language']) if (value[f]) s.voice[f] = String(value[f]);
      }
      else if (NUM[k] && Number.isFinite(Number(value)) && Number(value) >= NUM[k][0] && Number(value) <= NUM[k][1]) s[k] = Number(value);
    }
  } catch (e) { s.enabled = false; s.load_error = e.message; }   // fail closed
  cache = s; cachedAt = Date.now();
  return s;
}

/** Real telephone traffic is allowed only when the switch is on AND a provider is selected. */
async function liveCallsAllowed(runner) { const s = await load(runner); return !!(s.enabled && s.provider !== 'none'); }

function clear() { cache = null; cachedAt = 0; }

/** The Twilio ConversationRelay line specifically (the only live voice adapter built). */
async function relayLineOn(runner) { const s = await load(runner); return !!(s.enabled && s.provider === 'twilio_cr'); }

/** Menu lines (one per spoken sentence). */
function menuLines(s) { return String((s && s.menu_text) || DEFAULT_MENU).split(/\n+/).map((x) => x.trim()).filter(Boolean).slice(0, 10); }

module.exports = { load, liveCallsAllowed, relayLineOn, menuLines, clear, DEFAULTS, NUM, PROVIDERS, VERIFY_PROVIDERS, ACCESS_MODES, DEFAULT_MENU };

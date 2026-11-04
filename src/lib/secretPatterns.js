'use strict';

/**
 * secretPatterns — the one list of credential shapes that must never appear in committed files, logs, test output or
 * process command lines (docs/security/secret-management.md). Used by scripts/check-secrets.js (commits, repository,
 * test output, command lines) and src/lib/logRedaction.js (the app's own log lines).
 *
 * Each pattern matches a credential by its shape, so a match never needs the real value to be known. Values that are
 * clearly labelled test placeholders (for example sk_test_isolated_placeholder) are allowed.
 */

const PATTERNS = [
  { id: 'stripe_secret_key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: 'stripe_webhook_secret', re: /\bwhsec_[A-Za-z0-9]{20,}\b/g },
  { id: 'aws_access_key_id', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { id: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g },
  { id: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'anthropic_api_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai_api_key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { id: 'neon_api_key', re: /\bnapi_[A-Za-z0-9]{40,}\b/g },
  { id: 'twilio_secret', re: /\bSK[0-9a-f]{32}\b/g },
  { id: 'private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/g },
  // A database address with a password in it (postgres://user:password@host); local and placeholder addresses allowed.
  { id: 'database_url_with_password', re: /\bpostgres(?:ql)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]{6,}@[^\s/'"`]+/g },
  // A long signed token (JSON Web Token): three base64url parts, the first starting {"alg"...
  { id: 'json_web_token', re: /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}\b/g },
  // A key or secret written straight after its name: API_KEY=..., "apiKey": "...", --api-key ..., Authorization: Bearer ...
  { id: 'named_secret_value', re: /\b(?:[A-Z0-9]+_)*(?:API_KEY|SECRET(?:_KEY)?|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|PASSWORD|INGEST_KEY)\s*[=:]\s*["']?([A-Za-z0-9_\-+/=.]{20,})["']?/g, group: 1 },
  { id: 'named_secret_value', re: /["'](?:api[_-]?key|apiKey|secret|access[_-]?token|client[_-]?secret)["']\s*:\s*["']([A-Za-z0-9_\-+/=.]{20,})["']/gi, group: 1 },
  { id: 'command_line_secret', re: /--(?:api-key|apikey|token|access-token|secret|password)(?:=|\s+)["']?([A-Za-z0-9_\-+/=.]{16,})["']?/gi, group: 1 },
  { id: 'bearer_token', re: /\bBearer\s+([A-Za-z0-9_\-+/=.]{30,})/g, group: 1 },
];

// Labelled test placeholders and documentation examples: allowed.
const ALLOWED = [
  /placeholder/i, /^x{8,}$/i, /example/i, /your[_-]?(?:key|secret|token)/i, /changeme/i, /dummy/i, /fake/i, /redacted/i,
  /not[_-]?a[_-]?secret/i, /test[_-]?only/i, /^<.*>$/, /\$\{/, /^\*+$/, /^\.{3,}$/, /ci-test/i, /isolated/i, /local-dev/i,
];
const LOCAL_DB = /@(?:127\.0\.0\.1|localhost|host|HOST|db|postgres)(?:[:/]|$)|:(?:password|pass|pw|secret|PASSWORD)@|:\*+@/;

// Words that label a value as a test or example value when they are a part of it (test-secret-..., ..._fixture_...).
const LABEL_WORDS = /(^|[-_.])(test|tests|testing|fixture|noprod|sample|demo|unit|certification|race|example|changeme|change|your|local)([-_.]|$)/i;
// A name in code, not a value: process.env.JWT_SECRET, config.apiKey.
const CODE_REFERENCE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;

function isAllowed(id, value, whole) {
  if (ALLOWED.some((re) => re.test(value))) return true;
  if ((id === 'named_secret_value' || id === 'command_line_secret') && CODE_REFERENCE.test(value)) return true;   // not for tokens (a JWT is dotted too)
  // The label words are looked for after a provider prefix, so a real test-mode key (sk_test_51...) is still found.
  if (LABEL_WORDS.test(String(value).replace(/^(?:sk|rk)_(?:live|test)_/, ''))) return true;
  if (id === 'database_url_with_password' && LOCAL_DB.test(whole)) return true;
  return false;
}

/** Every credential-shaped value in `text`: [{ id, index, preview }] — the preview never contains the value itself. */
function findSecrets(text) {
  const out = [];
  const s = String(text == null ? '' : text);
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(s))) {
      const value = p.group ? m[p.group] : m[0];
      if (!value || isAllowed(p.id, value, m[0])) continue;
      out.push({ id: p.id, index: m.index, preview: mask(value) });
    }
  }
  return out;
}

// A masked hint (length and character class only), so a report never repeats the credential.
function mask(value) { return '[' + String(value).length + ' characters]'; }

/** The text with every credential-shaped value replaced by [REDACTED:<kind>]. */
function redact(text) {
  let s = String(text == null ? '' : text);
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    s = s.replace(p.re, (whole, ...g) => {
      const value = p.group ? g[p.group - 1] : whole;
      if (!value || isAllowed(p.id, value, whole)) return whole;
      return p.group ? whole.replace(value, '[REDACTED:' + p.id + ']') : '[REDACTED:' + p.id + ']';
    });
  }
  return s;
}

module.exports = { PATTERNS, findSecrets, redact, mask };

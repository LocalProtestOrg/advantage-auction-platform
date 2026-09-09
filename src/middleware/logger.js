// Request logger — logs API calls with method, path, status, duration.
// Skips static asset requests (.js, .css, .html, images) to keep logs clean.
//
// SECRET SAFETY: the logged URL is sanitized before it is written.
//   • Provider verification callbacks (e.g. Meta's GET /api/meta/webhook?hub.verify_token=…, which Meta also
//     sends as hub_verify_token) are logged as PATH ONLY — the whole query string is dropped for those routes.
//   • On every other route, query parameters whose NAME looks sensitive (token/secret/password/signature/
//     api key/authorization, in any spelling with . _ -) have their VALUES replaced with [REDACTED]; the rest
//     of the query string is kept so ordinary observability (limit=, page=, ids) is unchanged.
//   • Headers and bodies are never logged, so the App Secret (X-Hub-Signature-256 HMAC) and bearer tokens
//     never reach the log.
const STATIC_EXT = /\.(js|css|html|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|map)$/i;

// Routes whose query string is dropped entirely from the log (provider handshake callbacks).
const QUERY_STRIPPED_PATHS = ['/api/meta/webhook'];
// Query parameter NAMES whose values are redacted everywhere (normalized: lowercase, separators removed).
const SENSITIVE_KEY = /(token|secret|password|passwd|signature|apikey|accesskey|authorization|credential)/i;

function normalizeKey(k) { return String(k).toLowerCase().replace(/[._-]/g, ''); }

/** The URL as it may safely appear in a log line. Exported for tests. */
function loggedUrl(req) {
  const url = String((req && (req.originalUrl || req.url)) || '');
  const q = url.indexOf('?');
  if (q === -1) return url;
  const path = url.slice(0, q);
  if (QUERY_STRIPPED_PATHS.some((p) => path === p || path.startsWith(p + '/'))) return path + '?[query-redacted]';
  let params;
  try { params = new URLSearchParams(url.slice(q + 1)); } catch (_) { return path + '?[query-redacted]'; }
  let changed = false;
  const out = new URLSearchParams();
  for (const [k, v] of params) {
    if (SENSITIVE_KEY.test(normalizeKey(k))) { out.append(k, '[REDACTED]'); changed = true; } else out.append(k, v);
  }
  return changed ? path + '?' + out.toString() : url;
}

const logger = (req, res, next) => {
  if (!req.path.startsWith('/api') && STATIC_EXT.test(req.path)) return next();
  const start = Date.now();
  res.on('finish', () => {
    const ms  = Date.now() - start;
    const lvl = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN ' : 'INFO ';
    console.log(`[${new Date().toISOString()}] ${lvl} [http] ${req.method} ${loggedUrl(req)} ${res.statusCode} ${ms}ms`);
  });
  next();
};

module.exports = logger;
module.exports.loggedUrl = loggedUrl;
module.exports.QUERY_STRIPPED_PATHS = QUERY_STRIPPED_PATHS;

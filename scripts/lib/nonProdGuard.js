'use strict';

/**
 * Guard for local/test helper scripts that write payment test data or drive payment endpoints.
 * Refuses to run against the PRODUCTION database or with LIVE payment keys. Never prints secrets.
 */

const PROD_DB_ENDPOINT = 'ep-proud-leaf-an8pzkib';   // production Neon endpoint (see scripts/prod-migrate-*.js)

function productionReasons(env = process.env) {
  const reasons = [];
  const dbUrl = String(env.DATABASE_URL || '');
  if (dbUrl.includes(PROD_DB_ENDPOINT)) reasons.push('DATABASE_URL points at the production database');
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') reasons.push('NODE_ENV is production');
  if (/^(sk|rk)_live_/.test(String(env.STRIPE_SECRET_KEY || '').trim())) reasons.push('the payment secret key is a LIVE key');
  if (/^pk_live_/.test(String(env.STRIPE_PUBLISHABLE_KEY || '').trim())) reasons.push('the payment publishable key is a LIVE key');
  return reasons;
}

// Exit (code 2) when any production signal is present.
function refuseProduction(scriptName, env = process.env) {
  const reasons = productionReasons(env);
  if (reasons.length) {
    console.error(`REFUSE: ${scriptName} is a test-data script and will not run: ${reasons.join('; ')}.`);
    process.exit(2);
  }
}

module.exports = { productionReasons, refuseProduction, PROD_DB_ENDPOINT };

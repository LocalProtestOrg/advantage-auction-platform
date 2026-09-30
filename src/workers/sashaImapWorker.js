'use strict';

/**
 * Sasha IMAP worker — every 2 minutes, reads NEW mail from info@advantage.bid (read-only) through
 * imapIngestService. Inert unless sasha.imap_read_enabled (and the global sasha.enabled) is ON and the mailbox
 * credentials are configured: while OFF each tick is one database read and no mailbox connection is attempted.
 * A rejected login latches OFF (no retries) until a Super Admin clears it in Sasha settings.
 */

const POLL_MS = 2 * 60 * 1000;
const HEALTH_MS = 5 * 60 * 1000;

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const r = await require('../services/sasha/imap/imapIngestService').pollOnce();
    if (r && !r.skipped) console.log('[sashaImap] poll: ' + JSON.stringify(r));
  } catch (e) {
    console.error('[sashaImap] poll error: ' + require('../services/sasha/imap/safeImapClient').redact(e && e.message));
  } finally { running = false; }
}
async function health() {
  try {
    const r = await require('../services/sasha/imap/imapIngestService').healthCheck();
    if (r && r.alerts && r.alerts.length) console.log('[sashaImap] health alerts: ' + r.alerts.join(','));
  } catch (e) { console.error('[sashaImap] health error: ' + require('../services/sasha/imap/safeImapClient').redact(e && e.message)); }
}

if (require.main === module) {
  console.log('[sashaImap] worker started (poll 2m; inert unless sasha.imap_read_enabled)');
  setTimeout(tick, 60 * 1000);
  setInterval(tick, POLL_MS);
  setInterval(health, HEALTH_MS);
}

module.exports = { tick, health, POLL_MS };

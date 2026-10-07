'use strict';

/**
 * Phone transcript retention. After a call ends, cs_calls.transcript_purge_after = end + sasha.phone.transcript_retention_days
 * (default 90). This pass blanks the spoken turns of calls past that date. The call row, its non-sensitive summary
 * (also kept as a system note), handoffs/callbacks and the disclosure audit are kept. No audio is ever stored.
 */

const db = require('../../../db');
const PURGED = '[transcript removed after the retention period]';

async function purgeExpired({ limit = 200 } = {}) {
  const due = (await db.query(`SELECT id, conversation_id FROM cs_calls WHERE transcript_purged_at IS NULL AND transcript_purge_after IS NOT NULL
      AND transcript_purge_after < now() ORDER BY transcript_purge_after LIMIT $1`, [limit])).rows;
  let messages = 0;
  for (const c of due) {
    const r = await db.query(`UPDATE cs_messages SET body_text = $2 WHERE conversation_id = $1 AND direction IN ('inbound','outbound') AND body_text <> $2`, [c.conversation_id, PURGED]);
    messages += r.rowCount;
    await db.query(`UPDATE cs_calls SET transcript_purged_at = now() WHERE id = $1`, [c.id]);
  }
  return { calls: due.length, messages };
}

module.exports = { purgeExpired, PURGED };

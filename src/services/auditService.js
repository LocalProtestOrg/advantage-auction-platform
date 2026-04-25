// Audit log helper — writes within an existing transaction client.
// The write is atomic with the parent state change: if the audit INSERT fails,
// the whole transaction rolls back.

async function logEvent(client, {
  eventType, entityType, entityId,
  auctionId, lotId, paymentId,
  actorId, metadata
}) {
  await client.query(
    `INSERT INTO audit_log
       (event_type, entity_type, entity_id, auction_id, lot_id, payment_id, actor_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      eventType,
      entityType,
      entityId,
      auctionId  || null,
      lotId      || null,
      paymentId  || null,
      actorId    || null,
      metadata   ? JSON.stringify(metadata) : null
    ]
  );
}

module.exports = { logEvent };

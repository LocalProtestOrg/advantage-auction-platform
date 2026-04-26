const crypto = require('crypto');
const db = require('../db');

const STALE_SECONDS = 30;

const idempotencyMiddleware = async (req, res, next) => {
  const key = req.headers['idempotency-key'];
  if (!key) return next();

  const hash = crypto.createHash('sha256')
    .update(key + req.method + req.originalUrl + JSON.stringify(req.body))
    .digest('hex');

  const route = `${req.method} ${req.originalUrl}`;

  try {
    try {
      await db.query(
        `INSERT INTO payment_idempotency_keys (idempotency_key, route) VALUES ($1, $2)`,
        [hash, route]
      );
    } catch (insertErr) {
      if (insertErr.code !== '23505') throw insertErr;

      const { rows } = await db.query(
        `SELECT response_status, response_body, created_at
         FROM payment_idempotency_keys
         WHERE idempotency_key = $1 AND route = $2`,
        [hash, route]
      );
      const record = rows[0];

      if (record && record.response_body !== null) {
        // Completed — replay stored response
        return res.status(record.response_status).json(record.response_body);
      }

      // In-flight: check staleness
      const ageSeconds = (Date.now() - new Date(record.created_at).getTime()) / 1000;
      if (ageSeconds > STALE_SECONDS) {
        // Stale (crashed process) — delete and let this request proceed
        await db.query(
          `DELETE FROM payment_idempotency_keys
           WHERE idempotency_key = $1 AND route = $2 AND response_body IS NULL`,
          [hash, route]
        );
        await db.query(
          `INSERT INTO payment_idempotency_keys (idempotency_key, route) VALUES ($1, $2)`,
          [hash, route]
        );
      } else {
        return res.status(409).json({
          success: false,
          message: 'Request already in progress. Retry shortly.'
        });
      }
    }

    // Slot claimed — store the response before sending it
    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      try {
        await db.query(
          `UPDATE payment_idempotency_keys
           SET response_status = $1, response_body = $2::jsonb
           WHERE idempotency_key = $3 AND route = $4`,
          [res.statusCode, JSON.stringify(body), hash, route]
        );
      } catch (storeErr) {
        console.error('[idempotency] Failed to store response:', storeErr.message);
      }
      return originalJson(body);
    };

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = idempotencyMiddleware;

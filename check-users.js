require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    const result = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'users';
    `);

    console.log(JSON.stringify(result.rows, null, 2));
  } catch (e) {
    console.error(e.message);
  } finally {
    await pool.end();
  }
})();
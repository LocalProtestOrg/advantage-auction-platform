const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD || ''),
});

pool.on('connect', () => {
  console.log('PostgreSQL connected');
});

pool.on('error', (err) => {
  console.error('Unexpected DB error', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  connect: () => pool.connect(),
  pool
};
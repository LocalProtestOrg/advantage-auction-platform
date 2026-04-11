const { Pool } = require('pg');
const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: isProduction ? { rejectUnauthorized: false } : false
});

module.exports = {
  connect: () => pool.connect(),
  query: (...args) => pool.query(...args)
};

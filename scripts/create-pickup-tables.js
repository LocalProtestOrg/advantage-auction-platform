const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

const sql = `
CREATE TABLE IF NOT EXISTS pickup_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID REFERENCES auctions(id) UNIQUE,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  schedule JSONB,
  admin_overridden BOOLEAN DEFAULT FALSE,
  admin_override_by UUID REFERENCES users(id),
  admin_override_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pickup_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pickup_schedule_id UUID REFERENCES pickup_schedules(id) ON DELETE CASCADE,
  lot_id UUID REFERENCES lots(id) ON DELETE CASCADE,
  buyer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  slot_start TIMESTAMPTZ,
  slot_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lot_id)
);

CREATE TABLE IF NOT EXISTS slots_capacity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pickup_schedule_id UUID NOT NULL REFERENCES pickup_schedules(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('A','B','C')),
  slot_number INT NOT NULL,
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  capacity INT NOT NULL CHECK (capacity > 0),
  assigned INT NOT NULL DEFAULT 0 CHECK (assigned >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(pickup_schedule_id, category, slot_number)
);
`;

pool.query(sql)
  .then(() => {
    return pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('pickup_schedules','pickup_assignments','slots_capacity') ORDER BY tablename");
  })
  .then(r => {
    console.log('Tables confirmed:', r.rows.map(x => x.tablename).join(', '));
    pool.end();
  })
  .catch(e => {
    console.error('Error:', e.message);
    pool.end();
  });

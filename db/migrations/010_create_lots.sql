CREATE TABLE IF NOT EXISTS lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  starting_price NUMERIC(10,2) DEFAULT 0,
  current_price NUMERIC(10,2) DEFAULT 0,
  bid_increment NUMERIC(10,2) DEFAULT 1,
  position INTEGER DEFAULT 0,
  pickup_category TEXT CHECK (pickup_category IN ('A','B','C')),
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
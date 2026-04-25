CREATE TABLE IF NOT EXISTS lot_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,

  image_url TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,

  created_at TIMESTAMP DEFAULT NOW()
);

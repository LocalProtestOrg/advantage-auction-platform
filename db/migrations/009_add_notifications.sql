-- Notifications table for audit trail and delivery tracking
-- Tracks all notifications sent to users (email, SMS, push, etc.)

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('outbid', 'auction_won', 'payment_confirmed', 'pickup_scheduled', 'registration_confirmation', 'auction_reminder')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'bounced')),
  related_auction_id UUID REFERENCES auctions(id) ON DELETE SET NULL,
  related_lot_id UUID REFERENCES lots(id) ON DELETE SET NULL,
  related_payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
  related_pickup_id UUID REFERENCES pickup_assignments(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  failed_reason TEXT,
  retry_count INT DEFAULT 0 CHECK (retry_count >= 0),
  max_retries INT DEFAULT 3 CHECK (max_retries > 0),
  recipient_email TEXT,
  recipient_phone TEXT,
  metadata JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for efficient lookups
CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_type ON notifications(notification_type);
CREATE INDEX idx_notifications_status ON notifications(status) WHERE status IN ('pending', 'failed');
CREATE INDEX idx_notifications_sent_at ON notifications(sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX idx_notifications_auction ON notifications(related_auction_id);
CREATE INDEX idx_notifications_lot ON notifications(related_lot_id);

-- User notification preferences (opt-in/opt-out)
CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_outbid BOOLEAN DEFAULT true,
  email_auction_won BOOLEAN DEFAULT true,
  email_payment_confirmed BOOLEAN DEFAULT true,
  email_pickup_scheduled BOOLEAN DEFAULT true,
  email_registration_confirmation BOOLEAN DEFAULT true,
  email_auction_reminder BOOLEAN DEFAULT true,
  sms_outbid BOOLEAN DEFAULT false,
  sms_auction_won BOOLEAN DEFAULT false,
  sms_pickup_scheduled BOOLEAN DEFAULT false,
  push_outbid BOOLEAN DEFAULT false,
  push_auction_won BOOLEAN DEFAULT false,
  push_pickup_scheduled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create trigger to auto-update notification_preferences when users are created
-- (optional: handled in service layer for control)

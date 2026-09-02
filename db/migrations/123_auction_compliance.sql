-- 123_auction_compliance.sql — Auction Compliance Review (decision-support) engine.
-- Ships the ENGINE + a small, CONSERVATIVE, ILLUSTRATIVE ruleset. Rules are SCREENING/REVIEW indicators
-- ("POSSIBLE COMPLIANCE CONCERN — REVIEW SUGGESTED"), NOT legal determinations. The model carries
-- authoritative-source metadata columns (agency/citation/url/effective_date/last_verified/version/
-- jurisdiction) so real federal/state rules can be added later WITHOUT rebuilding the engine. Additive +
-- idempotent.

CREATE TABLE IF NOT EXISTS compliance_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE,                 -- stable machine code (e.g. 'firearms')
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,                        -- category/risk grouping
  severity        TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  jurisdiction    TEXT,                                 -- NULL = applies everywhere (nationwide "possible concern")
  match_terms     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- array of word-boundary terms/phrases
  match_regex     TEXT,                                 -- optional explicit regex (advanced rules)
  reason          TEXT NOT NULL,                        -- human-readable, conservative ("Possible ...")
  review_behavior TEXT NOT NULL DEFAULT 'flag_for_review' CHECK (review_behavior IN ('flag_for_review','block')),
  -- Authoritative-source metadata (populated only for real legal rules; NULL for illustrative screening rules)
  source_agency   TEXT,
  source_citation TEXT,
  source_url      TEXT,
  effective_date  DATE,
  last_verified_at TIMESTAMPTZ,
  version         INTEGER NOT NULL DEFAULT 1,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compliance_rules_active ON compliance_rules(active) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS compliance_flags (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id    UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  lot_id        UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  rule_id       UUID REFERENCES compliance_rules(id) ON DELETE SET NULL,
  rule_code     TEXT,                                   -- snapshot (survives rule edits/deletes)
  category      TEXT,
  severity      TEXT NOT NULL DEFAULT 'medium',
  jurisdiction  TEXT,
  reason        TEXT,                                   -- snapshot of the rule reason at detection
  matched_term  TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','reviewed_allowed','cleared','auto_cleared','action_taken')),
  action        TEXT,                                   -- e.g. 'lot_withdrawn' | 'auction_unpublished' | 'seller_contacted'
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   TIMESTAMPTZ,
  admin_notes   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lot_id, rule_id)                              -- one flag per (lot, rule): idempotent rescans
);
CREATE INDEX IF NOT EXISTS idx_compliance_flags_auction ON compliance_flags(auction_id);
CREATE INDEX IF NOT EXISTS idx_compliance_flags_status ON compliance_flags(status);

-- ── Conservative ILLUSTRATIVE starter rules (screening only; NOT legal determinations) ─────────────────
-- jurisdiction = NULL (nationwide "possible concern"); source_* NULL (illustrative). Word-boundary terms
-- chosen to limit obvious false positives (bare ambiguous words like "gun"/"shot"/"case"/"barrel" avoided).
INSERT INTO compliance_rules (code, name, category, severity, match_terms, reason, notes) VALUES
 ('firearms','Firearms / regulated weapons','firearms','high',
   '["firearm","firearms","handgun","pistol","revolver","rifle","shotgun","ar-15","ak-47","glock","silencer","suppressor"]'::jsonb,
   'Possible firearm or regulated weapon.','Illustrative screening rule — review suggested; not a legal determination.'),
 ('ammunition','Ammunition','ammunition','high',
   '["ammunition","ammo","gunpowder","smokeless powder","black powder"]'::jsonb,
   'Possible ammunition or explosive component.','Illustrative screening rule.'),
 ('alcohol','Alcohol','alcohol','medium',
   '["whiskey","whisky","bourbon","scotch","vodka","tequila","rum","gin","cognac","liquor","wine bottle","champagne"]'::jsonb,
   'Possible alcohol product.','Illustrative screening rule.'),
 ('tobacco_nicotine','Tobacco / nicotine','tobacco','medium',
   '["cigarettes","cigars","chewing tobacco","nicotine","vape","e-cigarette","vaping"]'::jsonb,
   'Possible tobacco or nicotine product.','Illustrative screening rule.'),
 ('controlled_substance','Controlled / prescription substances','controlled_substance','high',
   '["prescription drug","controlled substance","opioid","oxycodone","adderall","cannabis","marijuana","kratom"]'::jsonb,
   'Possible prescription or controlled substance.','Illustrative screening rule.'),
 ('wildlife_ivory','Wildlife / ivory / protected species','wildlife','medium',
   '["ivory","elephant tusk","rhino horn","tortoiseshell","endangered species","taxidermy"]'::jsonb,
   'Possible wildlife, ivory, or protected-species item.','Illustrative screening rule.'),
 ('hazmat','Hazardous materials','hazmat','medium',
   '["asbestos","mercury","radioactive","explosive","fireworks","compressed gas","propane tank"]'::jsonb,
   'Possible hazardous material.','Illustrative screening rule.'),
 ('recalled','Recalled products','recalled','low',
   '["recalled","recall notice","safety recall"]'::jsonb,
   'Possible recalled product.','Illustrative screening rule.'),
 ('medical_device','Regulated medical products/devices','medical','low',
   '["hearing aid","cpap","defibrillator","medical device","prescription glasses"]'::jsonb,
   'Possible regulated medical product or device.','Illustrative screening rule.'),
 ('counterfeit','Counterfeit goods','counterfeit','medium',
   '["counterfeit","knockoff","bootleg","fake designer"]'::jsonb,
   'Possible counterfeit-goods concern.','Illustrative screening rule.'),
 ('stolen_indicator','Stolen-property indicators','stolen','medium',
   '["stolen","serial number removed","no questions asked"]'::jsonb,
   'Possible stolen-property indicator.','Illustrative screening rule.')
ON CONFLICT (code) DO NOTHING;

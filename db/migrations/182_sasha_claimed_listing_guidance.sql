-- 182: Sasha guidance for claimed-listing questions (VSCODE-HANDOFF section 14, 2026-09-30).
-- ADDITIVE / IDEMPOTENT. Seeds ONE guidance row as status 'draft'. Sasha reads only approved (and conflict) guidance,
-- so this changes nothing until the Owner approves it in Admin, Sasha Settings & Knowledge. Re-running never
-- overwrites an edited or approved row. Source copy: docs/sasha/kb/claimed-listing-help.md.
INSERT INTO cs_kb_articles (slug, title, body, audience, status, conflict_note, source) VALUES
('claimed-listing-help', 'Claiming a business listing',
'Claiming a business listing in the Advantage.Bid directory is free. There is no monthly charge and no credit card.
To claim a listing, use the claim button on the listing page. The link is sent to the email address shown on that listing.
For help with claiming, call (551) 655-7050.

Hand the conversation to the team (request_human) for anything about:
- a claim link (a new link, an expired link, a link sent to the wrong person);
- who owns or manages a listing, or a request to transfer or confirm ownership;
- removing, hiding or correcting a listing''s business details on the company''s behalf;
- a dispute between businesses or people about a listing;
- outreach emails about a listing (who was contacted, why, or asking to stop). If they ask to stop, say the team will make sure they are not contacted again.

Never issue or resend a claim link, never confirm or deny who owns a listing or who was contacted, and never say which email address a listing uses.',
 'all', 'draft', NULL, 'Claimed Listing reconciliation (2026-09-30); Owner approval pending')
ON CONFLICT (slug) DO NOTHING;

# Roadmap Item — Registration Attribution ("How did you hear about us?")

*Future roadmap placeholder. **Planning stub only — no implementation, and explicitly out of scope for Seller-Type Rules Phase B.** Created at the owner's request on 2026-05-31 so the idea is captured and not lost. A full planning pass (like the other framework docs) should precede any implementation.*

## Goal

Capture how new users discovered the platform, at registration, for **both buyers and sellers**, to inform marketing/CRM (Product Priority #7: "Structured marketing and CRM value from platform data").

## Why it's noted now

The Phase B investigation surfaced that registration (`src/routes/auth.js` `POST /register`) currently creates only a `users` row (`role='buyer'`, email, password) — it captures **no acquisition/attribution data**, and there is no self-serve seller-onboarding flow at all. Attribution is cheapest to capture at the moment of registration; flagging it now keeps it on the radar for whenever the registration/onboarding surface is next touched.

## Rough scope (to be detailed in a future planning doc)

- An optional "How did you hear about us?" prompt at registration (and at any future seller-onboarding step), e.g. a select (Search, Social, Friend/Referral, Event, Other + free text) — final option set TBD with marketing.
- Persist the answer (a new nullable column or a small attribution table; schema TBD) keyed to the user.
- Make it **admin-visible** — and therefore, per the established design principle ([[feedback_admin_visible_settings_need_edit_path]]), give it an admin view/edit path if surfaced.
- Likely additive, reuse-first, server-validated — consistent with the platform's cadence.

## Explicitly NOT now

- ❌ Not part of Seller-Type Rules Phase B (or C).
- ❌ No schema, endpoint, or UI work yet — this is a captured idea only.
- ❌ No coupling to the seller-type framework; tracked independently.

## Related context

- Registration entry point: `src/routes/auth.js` `POST /register`.
- Seller-onboarding/profile-creation gap noted in `docs/seller-type-rules-framework-phase-b-plan.md` §7 (no app-level `seller_profiles` creation path today) — attribution work would pair naturally with building that onboarding flow.

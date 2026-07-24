# Follow-up (independent maintenance): Production migration bookkeeping drift + unapplied 082

**Status:** Open. Discovered 2026-07-23 during the BD identity-bridge production rollout. **Explicitly
separate from the bridge rollout** — do NOT bundle. The bridge deploy applied and recorded ONLY 094 +
095; it did not touch the items below.

## What was found
Production's `schema_migrations` table does not match the actual schema. When comparing the branch's
`db/migrations/*.sql` to prod's recorded set, seven files were "pending"; five are unrelated to the
bridge. Read-only object checks on prod:

| Migration | Prod objects | Reality |
|---|---|---|
| 008_add_missed_pickup_handling | `missed_pickups` **present** | applied, **not recorded** |
| 017_alter_lots_add_columns | `lots.category` **present** | applied, **not recorded** |
| 032_create_seller_followers | `seller_followers` **present** | applied, **not recorded** |
| 090_auction_geocoding | `auctions.internal_lat` **present** | applied, **not recorded** |
| **082_email_verification** | `users.email_verified` **MISSING**, `email_verification_tokens` **MISSING** | **genuinely NOT applied** |

## Impact
1. **`run-migrations.js` is currently unsafe against prod.** Re-running it would error on 008/032
   (their `CREATE INDEX` lacks `IF NOT EXISTS`, indexes already exist) and would **actually apply 082**
   (adds a column + table) as an unintended side effect.
2. **Email verification is effectively non-functional on prod.** `emailVerificationService.sendWelcome`
   inserts into `email_verification_tokens`, which does not exist — the insert fails (best-effort,
   swallowed), so welcome/verification emails silently do not send, and `users.email_verified` is absent.

## Recommended remediation (separate, careful project)
1. **Reconcile records to reality (no re-run):** insert `schema_migrations` rows for 008, 017, 032, 090
   (objects already exist) so tracking matches the DB — do NOT re-execute their SQL.
2. **Decide on 082 deliberately:** confirm the email-verification feature is intended for prod, then
   apply 082 in a controlled window (it is idempotent) and record it; re-check any code paths that
   assume `email_verified` exists. Take a Neon backup first.
3. **Harden the runner for prod reality:** add `IF NOT EXISTS` to the 008/032 index statements (or a
   guarded reconcile mode) so the tracked process is safe to run end-to-end again.
4. **Policy going forward:** all prod migrations flow through the tracked runner; never apply DDL
   out-of-band without recording it.

## Not affected by this
The bridge (094 + 095) is applied, recorded, and independent of all of the above.

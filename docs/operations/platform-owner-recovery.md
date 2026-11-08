# Platform owner: designation and lockout recovery

The platform owner (`users.is_platform_owner`, migration 222) is the only account that may change sensitive settings
(pricing, paid advertising budgets and authority, clearing kill switches, owner notice addresses and similar) and the
only account that may authorize paid advertising. Every administrator can still pause or stop activity.

## Who

- Owner (authorized 2026-11-07): the existing administrator account **tylerwitt2015@gmail.com** (verified read-only
  2026-11-08: one account, role admin, super_admin, active). No new account is created.
- `admin@advantage.bid` stays an ordinary administrator, without owner-only rights.
- Owner status comes only from the database flag together with `role = 'admin'` and an active account
  (`src/lib/platformOwner.js`). Seller companies, organization owners and seller staff can never hold it.
- Owner notices: email to `tylerwitt2015@gmail.com` and `advantageauction.bid@gmail.com` (`owner.notify_emails`,
  seeded by migration 222) and a short text through the existing owner-alert number.

## Designate (at deploy, after migration 222)

```
railway run node scripts/prod-set-platform-owner.js --email=tylerwitt2015@gmail.com            # dry run
railway run node scripts/prod-set-platform-owner.js --email=tylerwitt2015@gmail.com --apply    # designate
```

The script refuses anything but exactly one active admin account for that email, never creates an account, keeps at
most one owner, and writes an audit_log row.

## Lockout recovery (the owner account cannot be used)

The platform is never locked: stopping and pausing stay open to every administrator, and every non-sensitive admin
function keeps working. Only owner-only changes wait.

1. **Password lost, account intact:** recover the account the usual administrator way (`scripts/provision-admin.js`
   resets an administrator's access). Owner status is unchanged.
2. **Account unusable, and the owner chooses a different account:** only with the owner's written authorization, a
   person with production database access (Railway) runs:
   ```
   railway run node scripts/prod-set-platform-owner.js --email=<new owner admin email> --replace --apply
   ```
   This clears the previous owner and designates the new one in one transaction, with an audit_log row naming both.
   Never promote an account without the owner's authorization.
3. **Back out a designation:** run step 2 again for the original account.

Access to Railway and the production database is therefore the root of recovery: keep at least two trusted people
able to reach it.

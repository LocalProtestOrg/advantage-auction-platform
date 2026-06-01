> ⛔ **SUPERSEDED (2026-06-01) — historical reference only.** Built around Postmark, which was abandoned (account rejected); the platform is migrating to **Amazon SES (SMTP mode)**. **Do not use this checklist for current email launch.** Current source of truth: `docs/postmark-to-ses-migration-plan.md`, `docs/aws-ses-onboarding-checklist.md`, `docs/postmark-to-ses-phase1-emailservice-spec.md`.

# Email Launch Checklist

Complete every item before pilot launch. Items marked **BLOCKING** prevent any email delivery.

---

## 1. SMTP Provider Setup — BLOCKING

The platform uses Nodemailer (SMTP). Any transactional email provider works.
Recommended providers for a first pilot:

| Provider | Notes |
|----------|-------|
| **Postmark** | Best deliverability for transactional mail. Free tier: 100 emails/month. |
| **SendGrid** | Free tier: 100/day. Good API. |
| **AWS SES** | Cheapest at scale. More setup required (domain verification, sandbox exit). |
| **Gmail SMTP** | Works for testing only. 500/day limit, not suitable for production. |

### Required environment variables

```env
SMTP_HOST=smtp.postmarkapp.com        # your provider's SMTP host
SMTP_PORT=587                         # 587 (STARTTLS) or 465 (SSL)
SMTP_USER=your-api-key-or-username
SMTP_PASS=your-api-key-or-password
EMAIL_FROM=noreply@advantageauction.bid
```

Set these in your production environment before starting the server.
The notification worker checks for them at startup and will NOT deliver emails until all three are present.

---

## 2. Domain DNS Records — BLOCKING

The sender domain is `advantageauction.bid`. Without SPF and DKIM, emails will be
rejected or delivered to spam.

### SPF record

Add a TXT record to the `advantageauction.bid` DNS zone:

```
Type:    TXT
Host:    @  (or advantageauction.bid)
Value:   v=spf1 include:<your-provider-spf-domain> ~all
```

Example values by provider:

| Provider | SPF include value |
|----------|------------------|
| Postmark | `include:spf.mtasv.net` |
| SendGrid | `include:sendgrid.net` |
| AWS SES  | `include:amazonses.com` |

### DKIM record

Your provider generates a DKIM key pair and gives you a DNS record to add.
Follow their setup wizard. The record looks like:

```
Type:    TXT
Host:    <selector>._domainkey.advantageauction.bid
Value:   v=DKIM1; k=rsa; p=<public-key>
```

### DMARC record (recommended, not blocking)

```
Type:    TXT
Host:    _dmarc.advantageauction.bid
Value:   v=DMARC1; p=none; rua=mailto:advantageauction.bid@gmail.com
```

Start with `p=none` (monitoring only). Tighten to `p=quarantine` or `p=reject` after confirming clean delivery.

---

## 3. Verify Delivery — BLOCKING

After setting env vars and DNS records, confirm email is working before going live.

### Step 1: Check health endpoint

```bash
curl https://your-domain/api/health
```

Confirm: `"email_configured": true`

### Step 2: Trigger a test notification

Insert a test row directly into the notification queue and watch worker logs:

```sql
-- Replace with a real user_id from your users table
INSERT INTO notifications_queue (user_id, type, payload)
VALUES (
  '<your-user-uuid>',
  'WINNING',
  '{"lot_id": "test-lot-001", "visible_cents": 5000}'::jsonb
);
```

Within 10 seconds, the notification worker should log:
```
[notify] WINNING → user <id> for lot test-lot-001 @ $50.00
```

And the email should arrive in the inbox.

### Step 3: Check for SPF/DKIM pass

Open the delivered email → View headers → confirm:
- `Authentication-Results: spf=pass`
- `Authentication-Results: dkim=pass`

If either fails, check DNS record propagation (can take up to 48 hours, but usually < 1 hour).

---

## 4. Sender Identity

The `EMAIL_FROM` address is `noreply@advantageauction.bid`. This is a no-reply address.
Make sure the contact address (`advantageauction.bid@gmail.com`) is visible in all
email templates for buyers who want to reply.

If your SMTP provider requires the From address to be a verified sender identity
(Postmark, SendGrid), complete their sender verification step for `noreply@advantageauction.bid`.

---

## 5. Post-Launch Monitoring

- Watch `notifications_queue` for rows stuck in `status = 'failed'` with `attempts = 3`.
  These represent permanently undeliverable notifications.
- Use the admin diagnostics endpoint: `GET /api/admin/diagnostics/notifications`
- Set up a simple alert if `failed` count exceeds 10 within 1 hour.

---

## Quick Reference: Notification Types

| Type | Channel | Trigger |
|------|---------|---------|
| OUTBID | Email | Buyer is outbid |
| LEADING | Email | Buyer becomes current winner |
| WINNING | Email | Lot closes with buyer as winner |
| ENDING_SOON | Email | Lot closes within 10 minutes |
| CLOSE_TO_WINNING | Email | Bidder is within 10% of current price |
| FINAL_SECONDS | Email | Lot closes within 10 seconds |
| EXTENDED_BIDDING | Email | Lot time extended due to late bid |
| NEW_AUCTION | Email | Seller the buyer follows publishes an auction |

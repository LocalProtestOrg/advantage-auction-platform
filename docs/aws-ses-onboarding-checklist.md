# AWS SES Onboarding Checklist — advantage.bid (owner-executable)

*Step-by-step console/DNS actions to get **advantage.bid** fully verified in SES, DKIM active, production access approved, and SMTP credentials ready. No code. DNS is hosted at **directorysecure.com** (`ns1/ns2.directorysecure.com`). Region: **us-east-1**.*

> **One pitfall to avoid throughout:** when adding records in the directorysecure.com panel, the **Host/Name** field usually appends `advantage.bid` automatically. Enter only the **subdomain part** (e.g. `abc123._domainkey`, `bounce`, `_dmarc`) — **do NOT** type the full `…advantage.bid` or you'll create a doubled `…advantage.bid.advantage.bid` record. Verify with `nslookup` after each (§14).

---

## 1. AWS account prerequisites
- [ ] AWS account with **billing enabled** and **root MFA** on.
- [ ] Sign in as an **IAM admin user** (not root) for day-to-day SES work.
- [ ] (Recommended) a CloudWatch **billing alarm** (SES is pennies per thousand emails).
- [ ] **From / Reply-To decided:** `EMAIL_FROM = notifications@advantage.bid` (primary sender), `EMAIL_REPLY_TO = info@advantage.bid` (or `support@advantage.bid`). The verified **domain** identity covers any `@advantage.bid` address, so these need no separate verification. Ensure `info@`/`support@` is a **monitored mailbox**.

## 2. Recommended SES region
- [ ] **`us-east-1` (N. Virginia).** Pick it and stay in it — the region fixes your **SMTP endpoint** (`email-smtp.us-east-1.amazonaws.com`), **DKIM CNAME targets** (`…dkim.amazonses.com`), and **MAIL FROM MX** (`feedback-smtp.us-east-1.amazonaws.com`). Confirm the region selector (top-right of the console) says **N. Virginia** before creating anything.

## 3. Exact SES setup sequence (do in this order)
1. Verify the **domain identity** (`advantage.bid`) with **Easy DKIM** → add 3 CNAMEs (§4–5).
2. Configure **custom MAIL FROM** (`bounce.advantage.bid`) → add MX + SPF TXT (§6).
3. Update the **From-domain SPF** + add **DMARC** (§7–8).
4. Create **SMTP credentials** (§9).
5. **Request production access** (§10–11).
6. **Verify everything** (§14), then hand off for Phase 1 implementation.

## 4. Domain verification steps (advantage.bid)
- [ ] SES console → **Verified identities** → **Create identity** → choose **Domain** → enter `advantage.bid`.
- [ ] Leave **"Assign a default configuration set"** optional for now.
- [ ] Enable **Easy DKIM** (next section) — in SESv2 the DKIM CNAMEs **also serve as domain verification** (no separate TXT needed). If the console additionally shows a `_amazonses.advantage.bid` TXT, add that too.
- [ ] Create the identity → SES status will show **"Verification pending"** until DNS resolves.

## 5. Easy DKIM setup steps
- [ ] In the identity, under **DKIM**, choose **Easy DKIM**, key type **RSA 2048**, signing **Enabled**.
- [ ] SES generates **3 CNAME records**. Copy all three exactly.
- [ ] In directorysecure.com, add **3 CNAME** records (Host = the token part only; see pitfall note):
  - `<token1>._domainkey` → `<token1>.dkim.amazonses.com`
  - `<token2>._domainkey` → `<token2>.dkim.amazonses.com`
  - `<token3>._domainkey` → `<token3>.dkim.amazonses.com`
- [ ] Wait for SES **DKIM → "Successful/Verified"** (minutes to a few hours).

## 6. Custom MAIL FROM setup steps
- [ ] In the identity → **MAIL FROM domain** → **Edit** → enter **`bounce.advantage.bid`**.
- [ ] **Behavior on MX failure:** select **"Use default MAIL FROM domain"** (so mail still sends if the MX isn't ready — safer during setup).
- [ ] SES shows 2 records. Add to directorysecure.com:
  - **MX**: Host `bounce` → value `feedback-smtp.us-east-1.amazonaws.com`, **priority 10**
  - **TXT (SPF)**: Host `bounce` → value `v=spf1 include:amazonses.com ~all`
- [ ] Wait for MAIL FROM → **"Verified."**

## 7. SPF changes required (on advantage.bid)
- Current record: `v=spf1 +a +mx +ip4:66.147.230.95 include:spf.mtasv.net ~all`
- [ ] **Now (add SES):** update the `advantage.bid` TXT to
  `v=spf1 +a +mx +ip4:66.147.230.95 include:spf.mtasv.net include:amazonses.com ~all`
  *(keep `spf.mtasv.net` during transition; still within the 10-lookup SPF limit).*
- [ ] **At cutover (after SES is live):** remove `include:spf.mtasv.net` →
  `v=spf1 +a +mx +ip4:66.147.230.95 include:amazonses.com ~all`
- ⚠️ Keep **exactly one** SPF TXT record on `advantage.bid` (multiple SPF records = invalid).

## 8. DMARC recommendations
- [ ] Add a TXT at **`_dmarc.advantage.bid`** (Host = `_dmarc`):
  `v=DMARC1; p=none; rua=mailto:dmarc@advantage.bid; fo=1`
  *(Start at `p=none` to monitor without affecting delivery. After SES shows consistent DKIM+SPF alignment for a week or two, tighten to `p=quarantine`, then `p=reject`. Point `rua` at a mailbox you can read.)*

## 9. SMTP credential creation
- [ ] SES console → **SMTP settings** → **Create SMTP credentials**.
- [ ] This creates an IAM user with `ses:SendRawEmail`. **Download the credentials immediately** (the SMTP password is shown once).
- [ ] Record for Railway env (set later, **never commit**):
  - `SMTP_HOST = email-smtp.us-east-1.amazonaws.com`
  - `SMTP_PORT = 587`
  - `SMTP_SECURE = false`
  - `SMTP_USER = <SES SMTP username>`
  - `SMTP_PASS = <SES SMTP password>`
  - `EMAIL_FROM = notifications@advantage.bid`
  - `EMAIL_REPLY_TO = info@advantage.bid` (or `support@advantage.bid`)

## 10. SES production-access request process
- SES starts in **Sandbox** (can only send to **verified** recipient addresses; ~200/day; 1 msg/sec).
- [ ] For sandbox testing, **verify a test recipient**: Verified identities → Create identity → **Email address** → confirm the click-through link.
- [ ] SES console → **Account dashboard** → **Request production access** → fill the form (mail type, website, use case, compliance). Wording in §11.
- [ ] After approval, confirm **Account dashboard → "Production access: Enabled"** and a reasonable **sending quota**.

## 11. Recommended wording for the production-access request
> **Mail type:** Transactional
> **Website URL:** https://advantage.bid
> **Use case description:** Advantage Auction is an online auction marketplace. We send transactional email only to our own registered users and onboarded sellers: account verification, password reset, outbid and winning-bidder notifications, seller agreement (e-signature) links, auction operational/close notices, and seller report deliveries. We do not send marketing or bulk mail from this identity. Recipients are authenticated users who created an account or were explicitly onboarded; addresses are collected at signup/onboarding (no purchased lists). We handle bounces and complaints by monitoring SES metrics (and SNS notifications), suppressing hard-bounced and complained addresses from future sends; our notification worker retries transient failures and stops on permanent failures. Expected volume is low (tens to low-hundreds per day initially). We honor support/opt-out requests.
> **Additional contacts / compliance:** acknowledge AWS sending policies; provide an ops contact email.

## 12. Estimated approval timelines
- **DKIM / domain / MAIL FROM verification:** usually **minutes to a few hours** after the DNS records resolve (directorysecure.com has propagated quickly in past checks; allow up to 72h worst case).
- **Production access:** typically **under 24 hours**; can take up to **24–48h**. Submit early.

## 13. DNS records to expect / add
**ADD (for SES):**
| Type | Host (subdomain only) | Value | Notes |
|---|---|---|---|
| CNAME | `<token1>._domainkey` | `<token1>.dkim.amazonses.com` | Easy DKIM #1 (SES-generated) |
| CNAME | `<token2>._domainkey` | `<token2>.dkim.amazonses.com` | Easy DKIM #2 |
| CNAME | `<token3>._domainkey` | `<token3>.dkim.amazonses.com` | Easy DKIM #3 |
| MX | `bounce` | `feedback-smtp.us-east-1.amazonaws.com` (priority 10) | custom MAIL FROM |
| TXT | `bounce` | `v=spf1 include:amazonses.com ~all` | MAIL FROM SPF |
| TXT | `@` (advantage.bid) | `v=spf1 +a +mx +ip4:66.147.230.95 include:spf.mtasv.net include:amazonses.com ~all` | **edit** existing SPF (one record only) |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@advantage.bid; fo=1` | DMARC monitoring |

**REMOVE (only AFTER SES cutover is stable — Postmark leftovers):**
| Type | Host | Current value |
|---|---|---|
| TXT | `20260513133639pm._domainkey` | Postmark DKIM key |
| CNAME | `pm-bounces` | `pm.mtasv.net` |
| (SPF edit) | `@` | drop `include:spf.mtasv.net` |

## 14. How to verify everything before implementation begins
Run these (Windows `nslookup`; public resolver + authoritative). Each should return the expected value:
- [ ] DKIM CNAMEs resolve:
  `nslookup -type=CNAME <token1>._domainkey.advantage.bid 8.8.8.8` → `<token1>.dkim.amazonses.com`
  (repeat for token2, token3; also against `ns1.directorysecure.com`)
- [ ] MAIL FROM MX: `nslookup -type=MX bounce.advantage.bid 8.8.8.8` → `feedback-smtp.us-east-1.amazonaws.com` (pri 10)
- [ ] MAIL FROM SPF: `nslookup -type=TXT bounce.advantage.bid 8.8.8.8` → `v=spf1 include:amazonses.com ~all`
- [ ] From-domain SPF: `nslookup -type=TXT advantage.bid 8.8.8.8` → single record containing `include:amazonses.com` (and only one `v=spf1` record)
- [ ] DMARC: `nslookup -type=TXT _dmarc.advantage.bid 8.8.8.8` → `v=DMARC1; p=none; …`

**SES console states (all must be green):**
- [ ] Identity `advantage.bid` → **Verified**
- [ ] DKIM → **Successful / Verified**
- [ ] Custom MAIL FROM → **Verified**
- [ ] Account dashboard → **Production access: Enabled** (out of sandbox), sending quota adequate

**End-to-end check:**
- [ ] SES console → identity → **Send test email** to a verified address.
- [ ] Open the received email → **View original/headers** → confirm **`spf=pass`, `dkim=pass`, `dmarc=pass`**, and the **From** is `@advantage.bid`.

## ✅ Readiness gate (all true → proceed to Phase 1)
- [ ] advantage.bid **Verified** + **DKIM active** + **custom MAIL FROM verified**
- [ ] **Production access approved** (sandbox exited)
- [ ] SES **SMTP credentials** captured (host/port/secure/user/pass) and a verified **`@advantage.bid`** `EMAIL_FROM` chosen
- [ ] A SES **test email** shows SPF/DKIM/DMARC = pass

Once all boxes are checked, we proceed with the **Phase 1 `emailService.js` implementation exactly as documented** (`docs/postmark-to-ses-phase1-emailservice-spec.md`), staging-first.

---

*Owner-action checklist only. No code, app config, or AWS changes performed by this document.*

> ⛔ **SUPERSEDED (2026-06-01) — historical reference only.** Postmark was abandoned (account rejected); the platform is migrating to **Amazon SES (SMTP mode)**. **Do not use this document for current email setup or validation.** Current source of truth: `docs/postmark-to-ses-migration-plan.md`, `docs/aws-ses-onboarding-checklist.md`, `docs/postmark-to-ses-phase1-emailservice-spec.md`.

# SOP: Postmark DKIM Remediation — advantage.bid

**Resolved:** 2026-05-15  
**Final selector:** `20260513133639pm._domainkey.advantage.bid`  
**SOA serial at resolution:** `2026051514`

---

## Final verified DNS state

| Record | Value |
|--------|-------|
| **DKIM selector** | `20260513133639pm._domainkey.advantage.bid` |
| **DKIM value** | `v=DKIM1; k=rsa; p=MIIBIjAN…QIDAQAB` (410 chars, 2048-bit RSA, DER 294 bytes) |
| **SPF** | `v=spf1 +a +mx +ip4:66.147.230.95 include:spf.mtasv.net ~all` |
| **DMARC** | `v=DMARC1; p=none; rua=mailto:advantageauction.bid@gmail.com; aspf=r; adkim=r` |
| **Return-Path MX** | `pm-bounces.advantage.bid → p-pm-bounce-smtp01*.mtasv.net` |
| **Stale selectors** | None (old `pm._domainkey` removed and confirmed ENOTFOUND) |

All four authoritative resolvers (Cloudflare 1.1.1.1, Google 8.8.4.4, ns1, ns2) return identical records.

---

## Alignment summary

| Signal | Status | Notes |
|--------|--------|-------|
| **SPF** | Pass | `include:spf.mtasv.net` covers Postmark sending IPs |
| **DKIM** | Pass | Selector present, 2048-bit key, exact-match verified |
| **Return-Path** | Pass | `pm-bounces.advantage.bid` MX → Postmark bounce handlers |
| **DMARC SPF alignment** | Relaxed pass | `aspf=r`; envelope domain `pm-bounces.advantage.bid` org matches `advantage.bid` |
| **DMARC DKIM alignment** | Relaxed pass | `adkim=r`; DKIM `d=advantage.bid` matches From domain |
| **DMARC policy** | Monitoring | `p=none` — no enforcement yet; upgrade to `quarantine`/`reject` after stable send period |

---

## Root cause chain

This incident required six separate cPanel Zone Editor interactions to fully resolve. Each failure mode is documented below for future operators.

### Root cause 1 — Duplicate selector with wrong key
The original `pm._domainkey.advantage.bid` record contained a 1024-bit RSA key (`30819f30` DER header, 162 bytes) while Postmark expected a 2048-bit key. The duplicate was never cleaned up when Postmark regenerated the selector.

**Fix:** Delete `pm._domainkey`; add the timestamped selector Postmark generated (`20260513133639pm`).

### Root cause 2 — cPanel Zone Editor save failures (silent)
Multiple edit attempts appeared to succeed in the UI but the SOA serial did not increment, meaning the DNS zone was never actually written. This pattern recurred at least twice.

**Diagnosis indicator:** SOA serial stays the same after an edit. Always verify serial increment after every Zone Editor save.

### Root cause 3 — 255-character TXT truncation
cPanel's Zone Editor TXT field silently truncated the 411-character DKIM value to 255 characters (one DNS string chunk), leaving an incomplete RSA key. The record appeared present but DER decoded to 177 bytes instead of 294.

**Diagnosis indicator:** `DER bytes < 294` in key analysis; base64 ends mid-sequence rather than at `QIDAQAB`.

### Root cause 4 — Literal quote characters stored in TXT data
When the user re-entered the value manually split as `"chunk1" "chunk2"` in cPanel's plain TXT field, cPanel stored the `"` characters as literal bytes inside the DNS TXT record data (char code 34 in chunk payload). This is correct zone-file syntax for the raw zone editor but cPanel's simple TXT field does not interpret it — it stores the input verbatim.

**Diagnosis indicator:** `first=0x22(QUOTE!)` in per-chunk char-code inspection; regex `p=([A-Za-z0-9+\/=]+)` stops at the embedded `"` and extracts only a partial key.

**Fix:** Re-enter the full 411-char DKIM value in the plain TXT field without any surrounding or separating `"` characters. cPanel auto-splits at 255 chars and stores two clean chunks with no quote bytes.

---

## Verification procedure (reuse for future DKIM changes)

Run this Node.js snippet against all four resolvers:

```bash
node -e "
const { Resolver } = require('dns').promises;
const SELECTOR = '<selector>._domainkey.advantage.bid';
async function main() {
  for (const ip of ['1.1.1.1','8.8.4.4','72.14.188.183','172.104.212.124']) {
    const r = new Resolver(); r.setServers([ip]);
    const recs = await r.resolveTxt(SELECTOR).catch(e => [[e.code]]);
    const val  = recs[0].join('');
    const pTag = val.match(/p=([A-Za-z0-9+\/=]+)/);
    const der  = pTag ? Buffer.from(pTag[1],'base64').length : 0;
    console.log(ip, 'len=' + val.length, 'DER=' + der + 'B', 'ok=' + (der===294));
  }
}
main();
"
```

Pass criteria:
- `len=410` on all resolvers
- `DER=294B` on all resolvers
- `ok=true` on all resolvers
- No `"` chars at chunk boundaries (inspect with char-code dump if uncertain)

---

## Recommended follow-up monitoring

1. **DMARC policy hardening** — After 30 days of clean sends with `p=none`, upgrade to `p=quarantine`, then `p=reject`. Monitor aggregate reports at `advantageauction.bid@gmail.com`.

2. **DKIM key rotation** — Postmark rotates selectors on key changes. If Postmark ever shows a new selector, run the verification procedure above before and after any DNS update.

3. **cPanel Zone Editor discipline** — Always confirm SOA serial increment after every TXT record edit. Never enter raw zone-file `"quote"` syntax in the plain TXT Value field; enter unquoted values only.

4. **SPF softfail** — `~all` is currently set. Consider tightening to `-all` once sending patterns are stable and no legitimate relay sources are unknown.

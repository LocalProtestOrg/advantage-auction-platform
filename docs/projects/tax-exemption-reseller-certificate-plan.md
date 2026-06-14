# Tax Exemption / Reseller Certificate System — Audit & Plan

**Status: PLAN ONLY.** No code change. Compliance-sensitive — see guardrails.

## Audit — current state (definitive)
- **Sales tax is NOT implemented.** No `tax`/`tax_cents`/`sales_tax`/`tax_rate` anywhere in code or the 65 migrations. Stripe charges the bare `winning_amount_cents` (`paymentService.js:270-315`); invoices store a single `amount_cents` (`invoiceService.js:8-17`, `029_create_invoices.sql`); reporting emits gross/fee/payout only. The "tax calculated after close" business rule is **aspirational, unbuilt**.
- **Tax exemption is ABSENT entirely** — no `tax_exempt`/`exemption`/`resale`/`certificate`/`permit` column, route, or UI.
- **Reusable infra EXISTS and is strong:**
  - **Private document storage + signed delivery + content hash:** `agreementPdfService.js` uploads `resource_type:'raw', type:'private'` to a dedicated Cloudinary folder, computes a **SHA-256** hash, stores only the `public_id`, and serves via **5-min signed URLs** — the right model for sensitive buyer tax docs.
  - **File intake:** `src/routes/uploads.js` (multer memory storage, MIME allowlist, size limits) — currently seller/admin-gated.
  - **Admin approve/reject workflow:** walkthrough-video moderation (`review_status` pending/approved/rejected, `approved_by`/`rejection_reason`, moderation.html UI) — ideal template for certificate review; auction reject/return-to-draft gives a re-submit cycle.
  - **Audit + PII precedent:** `audit_log` (013) for append-only events; `seller_identity` (055) as a precedent for tokenized/encryption-candidate PII columns.

## Net-new vs reuse
- **Reuse:** private-upload+signed-URL+hash (agreementPdfService), multer intake (uploads.js), approve/reject workflow (video moderation), audit_log, PII handling precedent (seller_identity).
- **Net-new (must build):** an actual **sales-tax calculation** (prerequisite — you can't exempt from a tax that isn't charged), a `buyer_tax_exemptions` table, **buyer self-service** upload UI/routes (buyers have no upload surface today), jurisdiction/expiry logic, invoice line-item modeling, and exemption reporting/export.

## Phased design
### Phase A — Buyer side (account)
Tax-exemption section in the buyer Account page. Upload resale/exemption certificate (PDF/image; private storage + hash). Structured fields: legal name, business name, permit/resale number, issuing state, certificate type, expiration date, address, contact, document reference, **attestation checkbox**. Status display: `not_submitted | pending | approved | rejected | expired | revoked | manual_review`.

### Phase B — Automation (assist, do not over-claim)
Validate required fields + file type/size; OCR/text-extract if feasible; soft-match buyer legal/business name; format-check state/permit where a deterministic format exists; **flag inconsistencies for manual review**. **Do NOT assert legal validity** without an official state validation source — default to admin review.

### Phase C — Admin side
View the certificate (signed URL) + extracted fields; approve / reject / revoke / require re-upload / mark manual-review; internal notes; full history/audit trail (reuse the video-moderation pattern + `audit_log`).

### Phase D — Tax/payment behavior
Approved-exempt buyers are **not charged sales tax where applicable**; invoices show tax-exempt status + reason + certificate reference; **the certificate record in effect at invoice time is preserved** (historical basis). If the certificate expires/is revoked, **future** invoices charge tax; **past** invoices keep their historical basis. Exemption applies only where valid (jurisdiction-aware).

### Phase E — Reporting
Export exempt sales + certificate records: buyer identity, cert number/state/type, invoice IDs, sale totals, **tax not collected**, approval timestamp, document reference — to support CPA/tax reporting and audit.

## Compliance guardrails
- **Attorney + CPA review required** before this drives real tax treatment. Tax nexus, which jurisdictions to collect in, and exemption validity are legal/tax decisions, not engineering ones.
- **Store:** the original document (immutable, private, hashed), the structured fields, the reviewer/approval audit trail, and the certificate-in-effect snapshot per invoice. **Retention** per state requirements (often multi-year) — define with CPA.
- **Do NOT automate** the final exemption decision without an official validation source; automation only assists/flags.
- **Privacy/security:** tax docs contain PII/business identifiers → private Cloudinary (never public), signed short-TTL URLs, access-restricted to admin, audit every view/decision. Treat like `seller_identity` (encryption-candidate, tokenized refs).

## Launch classification
- **Minimum viable launch (Stripe TEST, public):** **NOT required** — no real tax is collected in TEST mode, so exemption has nothing to exempt from.
- **Required before Stripe LIVE / real tax collection:** **YES — this is a hard LIVE gate.** Before charging real cards in tax jurisdictions you must decide tax collection; if tax is collected, an exemption path (at minimum manual: buyer uploads → admin approves → invoice marked exempt) is required, with attorney/CPA sign-off.
- **Automation phase (OCR/format/name-match):** after the manual flow proves out.
- **Future:** official state-validation integrations, automated expiry handling, advanced reporting.

> **Bottom line:** sales tax itself is unbuilt. Tax collection + a (manual-first) exemption flow is a **Stripe-LIVE blocker and a compliance gate**, not a TEST-launch blocker.

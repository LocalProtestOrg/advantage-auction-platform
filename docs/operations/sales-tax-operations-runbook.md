# Sales tax operations runbook

Internal. Not for customers, sellers or Sasha. Prepared 2026-11-16 (owner authorization of the same date; migration 231).
This document describes how the system works and what an administrator does. It is not tax advice: every legal
determination (who must collect, in which state, at what threshold, how a return is filed) comes from the accountant and is
RECORDED here by an administrator with its source.

Advantage.Bid is registered and operates in New Jersey. The Adrian, Michigan address is a mailing address only.

## 1. How it works

- **One model for all three channels** (auctions, marketplace sales, embedded storefront sales). Buyers are charged on
  Advantage.Bid's own payment account; sellers are paid later by administrator-approved transfers. Sales tax is calculated
  by the tax calculation provider for the place the buyer takes possession (pickup address, or ship-to address).
- **One rule per state** (Admin > Sales Tax Rules, `/admin/tax-jurisdictions.html`):
  - `platform`: Advantage.Bid collects and remits. Requires an ACTIVE registration recorded in Admin > Sales Tax, and the
    tax calculation provider must really be collecting in that state.
  - `seller_direct`: Advantage.Bid collects nothing at checkout; the seller is responsible.
  - `seller` (collected and paid to the seller) is retired. It cannot be entered, and a state still carrying it is treated
    as having no rule.
- **A missing rule is never "no tax".**
  - Storefront and embedded storefront orders: refused (unchanged since 2026-11-09).
  - Auctions: with enforcement ON, an auction cannot be published in a state without a rule, and a payment that cannot be
    taxed correctly is HELD (nothing charged, the invoice stays open, an alert and an owner text are raised). With
    enforcement in report mode nothing is refused; the same situations raise alerts.
- **Why a $0 is $0** is recorded on every sale (`tax_basis`): taxed, exempt (approved certificate), not taxable,
  seller_direct, unconfigured (report mode, no rule), exception (administrator exception).
- **The ledger** (`tax_ledger_entries`) is append-only. It is posted from the platform's own records every 15 minutes and
  on demand, idempotently. Corrections are new adjustment entries with a written reason.
- **Reconciliation** runs daily and on demand: charges, tax transactions, refunds and reversals, seller payouts,
  remittances. Differences become alerts; nothing is corrected automatically.
- **Reserve guard**: a seller payout is refused when it would spend money held for sales tax Advantage.Bid must remit.

Code: `src/services/tax/` (policy, ledger, reserve, reconciliation, filings, nexus, reports), `src/routes/adminTax.js`,
`src/workers/taxWorker.js`, `public/admin/tax.html`. Tests: `tests/tax-*.test.js`.

## 2. Where to work

- **Admin > Sales Tax** (`/admin/tax.html`): overview by state and period, ledger drill-down, registrations and filings,
  tax codes, nexus, exceptions and holds, alerts, reconciliation, seller reporting, CSV exports.
- **Admin > Sales Tax Rules** (`/admin/tax-jurisdictions.html`): the per-state rule, its legal basis, source, verification
  date and history.
- Both are administrator-only. The two safeguard switches (auction enforcement, reserve guard) can be changed only by
  the platform owner; every change is audited and the owner is notified.

## 3. Setting up a state (New Jersey first)

1. Get the accountant's written determination for the state and both sale types (auctions and storefront sales).
2. If Advantage.Bid collects there:
   1. Register with the state (owner decision; never automatic).
   2. Add the registration in the payment processor's tax settings (Stripe Dashboard > Tax > Registrations) with the
      registration's start date. Check that the head office address there is the New Jersey operating address.
   3. Admin > Sales Tax > Registrations: record the registration (status active, effective date, filing frequency, last
      four characters of the number at most, and tick that it was added to the tax calculation settings).
   4. Admin > Sales Tax Rules: set the state to `platform` with the legal basis and source.
3. If the seller is responsible there: Admin > Sales Tax Rules: set `seller_direct` with the legal basis and source.
4. Re-verify each rule when the accountant reviews it (the Verify action stamps the date and the administrator).

A registration in the tax calculation settings is account-wide: from its start date it taxes auctions and storefront sales
in that state. Never add one without the matching rule, and never set a `platform` rule without the registration; the
system holds or refuses sales when the two disagree.

## 4. Auction enforcement

- Setting: `tax.auction_enforcement` (`report` or `enforce`), owner-only, on the Overview tab.
- Before turning it on, the page lists auctions that are published or active in a state without a rule. Enter those
  rules first (or acknowledge the list).
- **A held payment** appears under Alerts and Holds with the auction and the reason. Remedies, in order of preference:
  1. Complete the configuration (the rule, the registration, or both). Buyers then pay from their invoice as usual.
  2. If the accountant confirms the sale should proceed without collection, record an **exception** for that auction and
     state with the written reason. Those payments are recorded with basis `exception` and stay visible for review. An
     exception never changes what is legally owed; it records the decision and who made it.
- A hold never charges the buyer and never cancels the sale. The buyer sees a short message that payment is temporarily
  on hold; no internal detail is shown.

## 5. Monthly close and filing

1. Admin > Sales Tax > Overview, previous month: confirm reconciliation is clean and there are no open critical alerts.
2. Export the state summary and, for each state with a registration, the filing export (totals and the local jurisdiction
   breakdown). Send them to the accountant or filing provider.
3. The system opens a filing record for every active registration's most recent closed period, including zero-dollar
   periods. Enter the due date from the state's own schedule (due dates are never invented by the system).
4. When the return is filed: record the filed date, method, confirmation number and the amount on the return.
5. When the tax is paid: record the payment against the filing (amount, date, reference). This posts the remittance to the
   ledger and reduces the outstanding liability.

Nothing is filed, registered or paid by the system. Stripe's own filing service, where available on the account, is an
option the owner may choose later; it is not connected. No outside filing service has been purchased.

## 6. Tax reserve: moving tax money to the dedicated bank account

Purpose: collected sales tax must not be used for payouts or operating expenses.

1. Open a dedicated bank account for sales tax (owner action).
2. After each month closes, read "Outstanding liability" on the Overview tab (all states). The amount to move is the
   outstanding liability less what is already held in the tax account.
3. Move that amount from the operating bank account to the tax account at the bank (the payment processor pays out to the
   operating account as usual; the system never moves money between bank accounts).
4. Admin > Sales Tax > Reserve: record the transfer (amount, date, bank reference). A transfer back is recorded as a
   negative amount with its reason.
5. Pay each state's return from the tax account, then record the payment (section 5).

The payout guard uses these records: it requires the payment account's available balance, after a seller payout, to cover
the outstanding liability not yet held in the tax account. If a payout is refused for this reason: wait for pending card
payments to settle, or record a transfer or remittance that has already happened. It cannot be overridden.

## 7. Nexus monitoring

- Admin > Sales Tax > Nexus: enter each state's threshold from the state tax authority's own publication (amount, count,
  whether both are required, measurement period, whether marketplace sales count, the legal reference and link, and the
  date verified). Nothing is pre-filled.
- The page shows sales and transaction counts per state across all three channels, and raises alerts at 70% and 90% of a
  threshold, when a threshold is exceeded without a registration, and when a state has sales but no threshold entered.
- A seller's location does not by itself create an obligation for Advantage.Bid. Uncertain cases are flagged for review;
  registering is always the owner's decision with the accountant.

## 8. Merchandise tax codes

Admin > Sales Tax > Tax Codes: map a category to the tax calculation provider's product code with its source. Unmapped
categories use the general tangible goods code. Auction lots in a mapped category are calculated on their own line.

## 9. Exemption certificates

Buyers submit a certificate from their account; an administrator reviews the document and approves or rejects it
(existing workflow, `/admin/buyers.html`). Only an approved certificate removes tax, only in its state (a single-state
certificate with no state recorded applies nowhere), and only within its dates. Documents are stored privately and
opened through short-lived administrator links.

## 10. Seller information reporting (Form 1099-K)

- Admin > Sales Tax > Seller Reporting shows, per seller and year, gross sales processed, refunds, transaction counts and
  amounts paid out. It files nothing.
- Advantage.Bid stores no taxpayer identification numbers. Taxpayer identity is collected by the payment processor during
  payout setup.
- To confirm with the accountant before any filing is enabled: who the reporting entity is, the federal and state
  thresholds, and whether reported amounts are gross sales or net payouts. To check in the payment processor's dashboard
  (Connect > Tax forms): whether tax form preparation and delivery is enabled for recipient accounts and what it costs.
  Use one reporting source only, and compare its totals with the Seller Reporting export at year end.

## 11. What only the owner can do

- Payment processor dashboard: enable Connect on Accounts v2; confirm the business address and the tax head office address
  are the New Jersey operating address; add tax registrations; review tax form (1099) settings.
- State registrations, returns and payments.
- The enforcement and reserve guard switches.
- Legal document changes (governing law, published address): `docs/legal/governing-law-and-address-corrections-draft-2026-11.md`.

## 12. Confidentiality

Internal tax administration (registrations, nexus, filings, reserves, liabilities, providers, this runbook) is not
available to Sasha by any tool, knowledge source or route, and Sasha answers such questions with the approved referral to
the office. See `docs/sasha/tax-confidentiality-audit-2026-11.md`.

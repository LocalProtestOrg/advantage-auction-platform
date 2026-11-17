# Sasha: tax confidentiality audit and controls (November 2026)

Owner instruction: Sasha may explain sales tax on a buyer's own order, why tax can appear on a purchase, the tax amount on the buyer's own invoice, how to ask for help with an exemption, how to get receipts, and how to contact the office about tax. Sasha must never disclose anything about Advantage.Bid's internal tax and financial administration, whoever the requester says they are, and must not try to verify anyone's authority to receive it. The controls must not rely on instructions alone.

Required response (exact text, held in `src/services/sasha/taxConfidentiality.js` as `REQUIRED_RESPONSE`):

> Questions about Advantage.Bid's internal tax and financial administration are handled directly by our office. I can help with sales tax shown on your purchase or arrange for someone from our team to follow up.

This audit was done by reading the code on branch `feat/central-tax`. Nothing was run against a database.

## 1. What can reach Sasha's response generation

Everything Sasha says is produced in `src/services/sasha/engine.js` (`respond` for chat and email, `respondStream` for phone). The model receives exactly four kinds of input.

| Input | Source | Contains internal tax administration data? |
|---|---|---|
| Instructions | `engine.systemPrompt`, `sellingBoundaries`, phone voice rules. Numbers are read from `billingTermsService` and `storefrontChannelService` constants. | No. |
| Conversation transcript | `conversationService.transcriptForModel`: the last 24 customer, Sasha and staff messages of THIS conversation only. Internal notes and system notes are excluded. Email subject lines and attachments are not included (attachments are never opened). | Only if a customer or a staff member typed it into that same conversation. |
| Phone extras | `ctx.phone.coreRules` (the same live rules as `get_platform_rules`) and the server-set call state. | No. |
| Tool results | See section 2. | No (verified below). |

There is no retrieval over internal documents, no vector store, no file tool, no web tool, no free-form database or query tool, and no tool that calls an internal HTTP route. The tool list is fixed in code (`tools.js`, `phone/phoneTools.js`) and pinned by `tests/sasha-phone/tool-permissions.test.js`.

## 2. Every tool and what it reads

Knowledge tools (every channel):

| Tool | Reads |
|---|---|
| `search_help_center` | `knowledge/helpIndex.js`: fifteen named public pages under `public/` (FAQ, buyer and seller help, Terms, Buyer Terms, Privacy). Table `cs_kb_articles` (approved guidance written by staff in the Sasha admin page). |
| `get_platform_rules` | `knowledge/platformFacts.js`: text built from code constants, plus `pricingConfigService.currentProcessingBps`, `accountPhoneService.config`, `marketingConfigService.getBool` (one marketing switch), `smsConsentService.settings`, `companyContact`. |
| `get_auction_or_lot` | `auctions`, `lots`, `seller_profiles`, `billingTermsService.resolveEffectiveTerms`, `bidService` (increment). Public visibility rule applied. |
| `request_human` | Writes `cs_handoffs` and `cs_conversations`. |

Account tools (signed-in chat user or verified caller only, always filtered by that user's id):

| Tool | Reads |
|---|---|
| `get_my_account` | `users`, `seller_profiles`, `card_verifications`, `termsService`. |
| `get_my_bids` | `bids`, `lots`, `auctions`. |
| `get_my_invoices` | `buyer_auction_invoices` (including the buyer's own `sales_tax_cents`), `auctions`, `lots`. |
| `get_my_pickup_details` | `buyer_auction_invoices` (paid only), `auctions`, `seller_profiles`. |
| `get_my_orders`, `get_my_order_detail` | `marketplaceOrderService.listForBuyer` and `getForBuyer`. Only named buyer fields are returned (item, price, shipping, the buyer's own tax amount, total, status, tracking). |
| `get_my_auctions` | `auctions`, `seller_profiles`, `lots`. |
| `get_my_settlements` | `sellerSettlementService.listSettlements` (the seller-safe view; it shows the sales tax collected on that seller's own settlement as an amount that is not part of proceeds). |
| `get_my_seller_terms` | `seller_profiles`, `professional_pricing_agreements`, `founding_partners`, `pricingConfigService`. |
| `get_my_storefront_orders` | `marketplaceOrderService.listForSeller`. |

Phone tools: `start_account_verification`, `request_callback`, `find_auction`, `send_text`, `send_payment_link`, `get_my_seller_onboarding`, `get_my_business_verification` (status and Advantage.Bid's own message only), `get_my_agreements` (names, versions, status, dates; never the text), `get_my_auction_registration`, `get_my_pickup_slots`, `contact_seller_about_pickup`. They read `users`, `seller_profiles`, `auctions`, `buyer_auction_invoices`, `auction_buyers`, `marketplace_orders`, `cs_phone_audit` and the services `verification`, `sellerActivationService`, `verificationService`, `agreementService`, `auctionRegistrationService`, `pickupScheduleService`, `payLinkService`, `accountPhoneService`.

Other paths that were checked:

- Email: `emailChannel.handleInbound` and the IMAP reader (`imap/imapIngestService.js`) turn one inbound message into one conversation. Mail from one sender is never placed in another sender's context, so correspondence that arrives in the shared mailbox (for example from an accountant or a lawyer) is visible only in its own thread, where it is the sender's own text.
- Admin routes (`src/routes/adminSasha.js`): inbox, settings, phone settings, simulator, knowledge articles, activity. These are staff pages. They do not feed the model, except that a knowledge article saved there can later be returned by `search_help_center`.
- Staff alerts (`staffAlertService.js`): outbound notifications to staff only.
- Configuration: Sasha reads only `sasha.*` keys (`settings.js`, `phone/phoneSettings.js`) and the specific pricing, phone, marketing and text-consent settings named above.
- Environment: the Sasha files read only `SASHA_*`, `TWILIO_*`, `ANTHROPIC_API_KEY`, `APP_BASE_URL`, `JWT_SECRET` and `NODE_ENV`.

## 3. Findings: what Sasha could and could not reach before this change

Could not reach (confirmed by reading every tool and the services it calls):

- No Sasha tool, and no service function a Sasha tool calls, reads `tax_ledger_entries`, `tax_registrations`, `tax_filings`, `tax_nexus_thresholds`, `tax_category_codes`, `tax_payment_exceptions`, `tax_alerts`, `tax_reconciliation_runs`, `tax_jurisdiction_history` or `marketplace_tax_jurisdictions`. (`marketplaceOrderService` reads `marketplace_tax_jurisdictions` inside its checkout code, but not inside the three list and detail functions Sasha uses.)
- Nothing under `src/services/sasha/` loads anything from `src/services/tax/`, calls `/api/admin/tax` or `/api/admin/tax-jurisdictions`, reads `/admin/tax.html` or `/admin/tax-jurisdictions.html`, reads a `tax.*` configuration key or a `STRIPE_TAX_*` environment value, or reads a file under `docs/`.
- The payment processor was already unreachable from any tool (`toolGuard.checkHost`), so its tax settings were never readable.

Gaps found (none was an active leak, each was a missing barrier):

1. Reads were unrestricted in the tool guard. `toolGuard.js` limited writes only, so a future tool, or a future change inside a service that a tool calls, could have read a tax table with nothing to stop it.
2. Staff-written guidance had no content check. An article in `cs_kb_articles` containing internal tax details would have been returned to the model by `search_help_center`.
3. The help index had no path check. The page list is hard coded, but nothing refused a restricted file if one were ever added to the list.
4. Requests about internal tax administration went to the model. The answer depended on instructions and on the model having no data.
5. There was no check on what Sasha was about to send. A reply that repeated something a customer or staff member had typed into the conversation, or a guess, would have been sent.

## 4. Controls added

One module holds the deny-list and the checks: `src/services/sasha/taxConfidentiality.js`. It is pure (it loads nothing).

| Layer | Where | What it does |
|---|---|---|
| Database | `toolGuard.checkSql` (every statement run inside any Sasha tool, including through services and pooled clients) | Refuses, before the database is reached, any statement that names a restricted table, any table whose name starts with `tax_` in a table position, and any `platform_config` statement naming a `tax.` key in its text or parameters. Reads and writes alike. The refusal message names no table. |
| Routes | `toolGuard.checkPath` (Node http, https and fetch inside any Sasha tool) | Refuses any request whose path is `/api/admin/tax...` or `/admin/tax...`, on any host. |
| Tool results | `tools.run` | A tool result that contains a restricted identifier (table, route, page, configuration key, environment name, internal document path) is replaced by `{ error: 'not available' }`. |
| Knowledge | `tools.searchHelpCenter`, `knowledge/helpIndex.js` | Guidance and help passages that carry internal tax administration wording are withheld. The help index reads only files inside `public/`, never `public/admin/`, never a restricted document path. |
| Inbound | `engine.respond`, `engine.respondStream` (`taxConfidentialReply`) | A deterministic classifier checks the customer's newest message. On a match the reply is the required response plus the hand-off offer, with no model call. If the customer already asked for follow-up, the existing hand-off (`conversationService.requestHandoff`, reason `customer_request`) is opened and confirmed. On a call the caller is offered a message for the team (the existing `request_callback` flow). The requester's claimed role is never considered. |
| Outbound | `engine.respond` (final text), `engine.respondStream` (each sentence before it is spoken), `conversationService.addSashaReply` (the single place Sasha replies are stored), `emailChannel.sendReply` | A reply that would state registrations, states of collection, filings or schedules, remittance, reserves or bank arrangements, the ledger or dashboard, nexus or thresholds, a provider, liabilities, accounting methods, or strategy is replaced, whole, by the required response. |
| Instructions | `engine.systemPrompt` | Not changed. The chat and email instructions are pinned byte for byte by `tests/sasha-phone/phone-sasha.test.js` (fixture `tests/fixtures/sasha-system-prompts-pre-phone.json`), and none of the controls above depend on them. One approved-knowledge line was added to the payment rules in `knowledge/platformFacts.js` listing the tax help Sasha may give. |
| Errors | `tools.run`, `phoneTools.run` | Tool failures reach the model only as `lookup failed`, `not permitted` or `not available`. Customers see only fixed fallback sentences. |

Run log: deterministic replies are recorded in `cs_ai_runs` with reason `tax_confidential` (inbound) or `tax_confidential_outbound` (a replaced draft), so staff can review how often each happens.

## 5. What Sasha can still do (unchanged)

- Tell a signed-in or verified buyer the sales tax on their own invoice (`get_my_invoices`) or storefront order (`get_my_order_detail`). Email and anonymous chat still get no account data.
- Explain that sales tax, where it applies, is calculated for the place of sale (the pickup location, or the shipping address for shipped items) and shown on the invoice.
- Explain how to upload an exemption certificate and that Advantage.Bid reviews it first.
- Point to the invoices page for a copy of an invoice or receipt, give the office contact details and hours, and hand a tax question about a specific invoice to the team.
- Decline tax and legal advice and suggest a tax professional, as before.

## 6. Verified unreachable

Verified by `tests/sasha-tax-confidentiality.test.js` and `tests/sasha-tax-confidentiality-engine.test.js`:

- Every tool in the guard's list is refused a read of every restricted table, of a made-up `tax_` table, and of a `tax.` configuration key, for plain statements, query objects, callbacks and pooled clients, and the statement never reaches the database.
- Requests to the internal tax routes and pages are refused inside a tool.
- No file under `src/services/sasha/`, and no Sasha route, worker or middleware file, references a restricted table, a tax service, an internal tax route or page, a `tax.` configuration key, a `STRIPE_TAX_` name, or a path under `docs/legal` or `docs/operations`. The test fails if one is ever added.
- No tool has a free-form query, file, path or address input.
- Direct, disguised, impersonation (accountant, state tax auditor, employee, seller, business partner), instruction-injection and indirect requests all produce the required response with no model call, on chat, email and phone.
- Allowed buyer questions are not blocked and still reach the model with the buyer's own invoice tool available.

## 7. Limits and follow-ups

- The classifier and the outbound check are word patterns in English. A request phrased in a way they do not recognise goes to the model, which has no data to answer from; the database, route, knowledge and outbound layers do not depend on the classifier.
- The outbound check cannot recognise a bare list of state names with no tax wording around it. Sasha has no source for such a list.
- A customer's or staff member's own words inside a conversation stay in that conversation's transcript. Staff should not type internal tax details into a customer conversation.
- `get_my_seller_terms` returns, for Auction Partner sellers only, the sentence "sales tax is collected and remitted separately and is not part of your proceeds". It is existing published program wording about the seller's own proceeds and was left unchanged. The owner may want to review it.
- `payment_tax_reversals` and `buyer_tax_exemptions` are not on the deny-list: they hold a buyer's own refund and exemption records, and no Sasha tool reads them today.
- A statement that reads every row of `platform_config` with no key filter would not be recognised as a tax configuration read. No Sasha tool or service it calls does this.
- The admin knowledge page still lets staff save any text; restricted wording is filtered when Sasha searches, not when staff save. A save-time warning in `src/routes/adminSasha.js` would be a small follow-up.

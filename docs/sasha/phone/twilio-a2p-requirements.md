# Twilio / A2P requirements before customer texting goes live

**Status:** nothing below has been submitted, enabled or purchased. Every customer-facing text path ships OFF.
**Date:** 2026-10-07
**Scope:** the new customer texts added in migration 189:

- account phone verification codes;
- Phone Sasha verification codes;
- customer-service texts (payment links, pickup details, page links);
- optional outbid alerts;
- optional watched-auction closing reminders;
- STOP/HELP handling.

**Confirm every item with Twilio before relying on it.** Carrier and Twilio rules change. Nothing here assumes the existing A2P registration covers these texts.

## What exists today (from the repository)

- A Twilio account sends **owner/staff operational alerts** through `TWILIO_MESSAGING_SERVICE_SID` (A2P-registered sender).
- The repository has **no record of which A2P campaign use case is registered.** It is reasonable to assume it covers internal operational alerts to staff numbers, not texts to customers.
- `TWILIO_VERIFY_SERVICE_SID` is **not set** in production.
- There is **no inbound SMS webhook** (no STOP/HELP sync).

## Per use case

| Use case | Recommended Twilio path | What Ty must do | Code switch (all OFF) |
|---|---|---|---|
| Website phone verification (4-digit) | **Twilio Verify** (SMS channel) | Create a Verify Service with **code length 4**. Restrict geo permissions to the US. Turn on Fraud Guard. Set `TWILIO_VERIFY_SERVICE_SID`. | `bidder_phone.verification_enabled` |
| Requiring verified phones to bid | Same Verify Service | Turn on only after the verification flow works end to end | `bidder_phone.required` (refused while no sender exists) |
| Phone Sasha verification codes (SMS) | Same Verify Service | Same as above, plus the phone channel itself | `sasha.phone.verify_provider = twilio_verify`, `sasha.phone.enabled` |
| Phone Sasha verification codes (email) | Existing Advantage.Bid email (SES) | Nothing new | Phone channel switch |
| Customer-service texts (payment link, pickup details, page links) | Messaging Service on an A2P 10DLC **Customer Care** campaign (or a verified toll-free number) | Register or extend the campaign with sample messages containing links. Opt-in description: "customer requests the text during a verified support call". | `SASHA_PHONE_SMS_ENABLED=true` + phone channel |
| Outbid alerts | A2P 10DLC **Account Notification** (or **Mixed**) campaign | Register with sample message, opt-in flow screenshots (auction registration checkboxes and `/notifications.html`), and privacy/terms SMS wording | `auction_sms.offer_opt_in`, then `auction_sms.a2p_confirmed`, then `auction_sms.enabled` |
| Watched-auction closing reminders | Same campaign as outbid alerts | Include its sample message in the same registration | Same three switches |
| STOP / HELP | Messaging Service **Advanced Opt-Out** (Twilio replies automatically) plus an inbound webhook to sync opt-outs into Advantage.Bid | Enable Advanced Opt-Out with our HELP text. Then approve building the inbound webhook (`smsConsentService.handleInboundKeyword` is ready; no route is mounted). | — |

## Twilio Verify and 10DLC

- Twilio's documentation says verification texts sent through **Twilio Verify** do not need your own A2P 10DLC registration, because Verify sends from Twilio's own registered senders. **Confirm this for the account before launch.**
- The 4-digit code length is a **Verify Service setting**. Advantage.Bid never sees or stores Verify's codes.

## Sample messages to submit

- **Outbid:** `Advantage.Bid: You've been outbid on Lot 42, Walnut Dresser. View the lot and bid again: https://bid.advantage.bid/lot.html?lotId=… Reply STOP to opt out.`
- **Watched closing:** `Advantage.Bid: An auction you're watching begins closing in about 1 hour: Henderson Estate. View auction: https://bid.advantage.bid/auction-view.html?auctionId=… Reply STOP to opt out.`
- **Payment link:** `Advantage.Bid: pay invoice INV-… for Henderson Estate ($312.50): https://bid.advantage.bid/pay/… Link expires in 30 minutes; sign in to pay.`
- **HELP reply:** `Advantage.Bid auction alerts. Manage alerts at https://bid.advantage.bid/notifications.html or email info@advantage.bid. Reply STOP to opt out.`

## Opt-in evidence already built

- Unchecked, optional checkboxes in the auction registration panel, shown only when `auction_sms.offer_opt_in` is on and the phone is verified.
- Separate toggles on `/notifications.html`. Each type shows its consent wording, including "Message and data rates may apply. Reply STOP to opt out, HELP for help."
- Every opt-in and opt-out is stored in `sms_consent_events`, with type, time, source, context, phone last 4 and a hashed IP.

## Before turning anything on (Owner / counsel)

1. Add an SMS section to the privacy policy and terms: program name, message types, frequency, "Msg & data rates may apply", STOP/HELP, and no sharing of mobile numbers for marketing.
2. Confirm which existing A2P campaign is registered, and register or extend for Customer Care and Account Notifications.
3. Create the Verify Service (4 digits), set `TWILIO_VERIFY_SERVICE_SID`, and test with a staff phone.
4. Approve building the inbound SMS webhook for STOP/HELP sync, with signature validation.
5. Only then:
   - `bidder_phone.verification_enabled`;
   - later `bidder_phone.required`;
   - `auction_sms.offer_opt_in`;
   - `auction_sms.a2p_confirmed` + `auction_sms.enabled`.

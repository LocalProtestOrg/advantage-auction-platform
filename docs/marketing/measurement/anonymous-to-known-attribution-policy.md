# Anonymous-to-Known Attribution Policy

Phase 3P.2 measurement readiness · item `anon_to_known` · owner of record: Advantage.Bid

This policy says which anonymous first-party activity may be connected to a person after they register or sign in,
for how long it is kept, and on what basis. It governs `src/services/attributionService.js`,
`src/services/clickIdService.js`, `src/services/behavioralIdentityService.js` and `src/services/conversionService.js`.

## 1. What is collected before anyone is known

| Record | Where | Contents | Never contains |
|---|---|---|---|
| Visitor id | browser `localStorage` (`aap_visitor_id`) | a random first-party token | name, email, device fingerprint |
| Page view | `analytics_events` | page path, page intent, hashed IP, consent snapshot | email, password, card data |
| Campaign touch | `marketing_attribution_touches` | landing host/path, referrer host, channel, UTM values, click-id type + SHA-256 hash, consent snapshot, time | the raw click id |
| Click id | `marketing_click_ids` | the raw gclid / gbraid / wbraid / fbclid, consent at capture | anything else |

Internal navigation is not a touch. Only campaign-bearing arrivals (UTM or click id) and arrivals from another site are
recorded as touches.

## 2. When anonymous activity becomes known

Linkage happens only on an **authoritative first-party action by the person themself**:

- registration (`POST /api/auth/register` carries the visitor id; the user id is created server-side), and
- sign-in (`login.html` → `POST /api/analytics/identify`, authenticated; the user id is read from the verified session,
  never from the request body).

There is no probabilistic or cross-device matching, no fingerprinting, and no linkage from an email address typed into a
form that does not create an account.

## 3. What may be attributed after linkage

- Campaign touches from the same visitor id inside a **90-day look-back** are attributed to the user
  (`attributionService.stitch`). Older touches stay anonymous.
- Captured click ids from the same visitor id are linked to the user (`clickIdService.linkToUser`).
- Conversions keep the attribution snapshot taken **when they happened**. A conversion recorded before linkage is not
  rewritten; conversions after linkage read the stitched profile.
- One visitor id links to the first account that claims it. A later sign-in by a different account on the same browser
  does not move earlier touches.

## 4. Attribution classes

| Class | Meaning |
|---|---|
| DELIVERED | provider-reported delivery (impressions, clicks, spend) — cost facts only |
| MEASURED | a campaign touch inside the 90-day look-back precedes the outcome |
| INFLUENCED | a campaign touch exists but outside the look-back, or organic last touch after a paid touch |
| ATTRIBUTION_UNAVAILABLE | no first-party touch for this visitor or user |

## 5. Retention

| Data | Retention |
|---|---|
| Raw click ids | 180 days from last seen (`clickIdService.purgeExpired`) |
| Campaign touches | 13 months (`attributionService.purgeExpired`) |
| Raw anonymous page events | `marketing.behavioral.raw_retention_days` (180) |
| Conversion ledger | life of the account (it is the record of what happened on the platform) |

Purges are maintenance functions run by an administrator; neither is a scheduled worker in this phase.

## 6. Legal basis and consent

> The legal bases below are the engineering proposal. The Owner should confirm them with counsel before any paid channel
> is activated; the implementation already follows the stricter consent rule for everything that leaves the platform.

- **First-party operational measurement** (was a registration, bid or purchase caused by a campaign Advantage.Bid ran?)
  is processed on the basis of legitimate interest in operating and improving the marketplace. It stays on the platform.
- **Advertising signals to third parties** (Meta Pixel, Meta Conversions API, Google Ads conversion uploads) require the
  visitor's or user's **advertising consent** (`consent_records`, category `advertising`) *and* the Owner's channel gate.
  Without both, nothing is sent; the conversion ledger records the decision (`gated_off`, `no_consent`, …) per event.
- Withdrawal of advertising consent stops future provider dispatch immediately; first-party records remain.
- No sensitive categories are inferred or sent. Identifiers sent to providers, when ever enabled, are SHA-256 hashed.

## 7. What this policy never allows

- Linking a person from data they did not provide to Advantage.Bid themselves.
- Re-attributing activity older than the look-back.
- Sending any identifier to an advertising provider without advertising consent and an Owner-activated channel.
- Using a client's (for example, a partner auction company's) advertising assets for Advantage.Bid measurement.

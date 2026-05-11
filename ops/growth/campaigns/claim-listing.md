# Claim Your Listing Campaign

**Status:** Planning
**Owner:** Growth Operations
**Engineering dependency:** Seller profile system (existing), claim flow (not yet built)

---

## Objective

Re-activate or formalize existing sellers who have appeared in the platform
(as prior consignors or BD-referred contacts) but have not completed a full
seller profile or submitted a live auction.

Secondary use: outreach to estate auction businesses and liquidators who are
publicly listed on directories (estate sale company sites, auctioneers.org)
but not yet on Advantage.

---

## Concept: "Claim Your Listing"

Some sellers may have had auctions run on their behalf by Advantage without
having a fully self-managed profile. A "claim" flow allows them to:

1. Verify they are the seller behind a past auction
2. Activate their seller profile
3. Begin the onboarding for their next auction

This mirrors patterns used successfully by Yelp, Google Business, and Houzz
in the professional services space.

---

## Target Segments

| Segment | Description |
|---|---|
| Prior consignors | Sellers who appeared in past auctions — outreach via stored contact |
| Directory-listed liquidators | Companies in estate sale directories with no Advantage presence |
| BD referrals | Sellers referred by BD partners who have not yet activated |
| Dormant applications | Sellers who started an application but did not complete it |

---

## Funnel Architecture

```
Identification
  └── Pull list of prior consignors / partial applications
      └── Personalized outreach: "We ran an auction for you — want to list again?"
          └── Claim flow (new build required — request to engineering)
              └── Profile activation → Seller onboarding
```

---

## Claim Flow Requirements

*(Engineering request — not yet submitted)*

The claim flow is a lightweight verification step:
- Input: email address or phone number from prior consignor record
- Verification: email/SMS confirmation code
- Output: seller profile activated with prior auction history attached
- No payment or financial information collected at this stage

This is a new feature. A formal engineering request must be drafted and submitted
before any development begins.

---

## Outreach Copy

**Subject line options (A/B test):**
- "You consigned with Advantage — your listing is ready to claim"
- "[First name], your auction history is waiting for you"
- "One step to activate your seller profile on Advantage"

**Body:**
> Hi [First name],
>
> We helped [sell / run an auction for] [estate name or item type] on your behalf.
> If you have another estate or collection to auction, your profile on Advantage
> is ready — it takes about 5 minutes to get started.
>
> [Claim your seller profile →]
>
> Questions? Reply to this email or call [ops phone].

---

## Dependencies

| Dependency | Status | Owner |
|---|---|---|
| Prior consignor contact list | Export needed | Operations |
| Claim / verification flow | Not built | Engineering (request TBD) |
| Email delivery | TBD | Engineering |
| Dormant application list | Query needed | Engineering |

---

## Next Actions

- [ ] Pull list of prior consignors from ops (coordinate with engineering for DB query)
- [ ] Draft formal engineering request for claim flow feature
- [ ] Write A/B subject line variants
- [ ] Define success metric: profile activations per outreach batch

*Last updated: 2026-05-11*

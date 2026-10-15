# Buyer Terms §10–§11 vs. the bidding engine: maximum-bid discrepancy

**Status:** for legal review. Not published. The live Terms (`public/terms.html`, as deployed) and the unapproved
Buyer Terms v4 draft are both unchanged by this note. Prepared 2026-10-15.

## What the platform actually does

`src/services/bidService.js` (`createBid`, lines ~209–220): *"All bids — manual or proxy — flow through
resolveProxyBid. A manual bid (amount) is treated as a max bid equal to the submitted amount."*

So every bid, whether typed as a plain amount or set explicitly as a maximum bid, is stored as the bidder's maximum.
The system then places the bidder's visible bid only as high as needed to lead: one increment above the next-highest
maximum, never above the bidder's own amount. A bidder who enters $500 on a lot at $20 with no competition leads at
the next valid increment, not at $500.

## What the live Terms say

- **§10 Bidding:** "By placing a bid, you make an irrevocable offer to purchase the lot **at the amount bid**, plus
  buyer's premium, taxes, and any applicable fees."
- **§11 Maximum Bids:** "**If the Platform offers** a maximum bid or automatic bidding feature, you may enter the highest
  amount you are willing to bid. The Platform may automatically increase your bid in increments up to your maximum…"

## The discrepancy

1. §10 reads as if the buyer is committed to, and pays, exactly the amount typed. In practice that amount is a ceiling;
   the price paid is the winning bid the system resolves, which can be lower.
2. §11 presents automatic bidding as an optional feature the platform *may* offer. In practice it applies to every bid.

Neither causes a buyer to pay more than they entered, but the wording does not describe how bids are resolved, which
can confuse buyers and support staff (Sasha's certification flagged exactly this question).

## Recommended wording (for legal approval)

**§10 Bidding**, first paragraph:

> When you place a bid, the amount you enter is the maximum you are willing to pay for the lot (before buyer's premium,
> taxes and any applicable fees). Your bid is an irrevocable offer to purchase the lot at any winning price up to that
> amount. The Platform bids on your behalf only as much as needed to make you the high bidder, in the applicable bid
> increments, and never above the amount you entered.

**§11 Maximum Bids**:

> Every bid on the Platform works as a maximum bid. If another bidder bids, the Platform automatically raises your bid
> by the applicable increment, up to your maximum, to keep you in the lead. Your maximum is not shown to other bidders.
> If two bidders enter the same maximum, the earlier bid wins. You are responsible for any winning bid placed for you
> up to your maximum.

Notes for counsel: the tie rule above matches the engine's ordering (`ORDER BY max_amount_cents DESC, created_at ASC`
in `bidService.js`); confirm before adopting. The rest of §10 (bids cannot be retracted; Advantage.Bid may reject or
cancel bids) is consistent with the engine and needs no change.

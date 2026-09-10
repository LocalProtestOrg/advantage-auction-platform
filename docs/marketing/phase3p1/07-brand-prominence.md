# Mission 7 — Brand Prominence

**Phase 3P.1 · 2026-09-10 · Config: `config/prominence-rules.json` → `brand_identity`**

## The finding

All six creatives were called too small on Advantage.Bid identity. The three Advantage.Bid-led acquisition creatives used the real logo
lockup at 250px — 23% of the canvas width — plus the 64px band wordmark. The three co-branded West University creatives carried no
logo mark at all: a ~20px "in conjunction with Advantage.Bid" line and the band wordmark. The scorer's `brand_frame` check reported
`logo: true/false, band: true, wordmark: true` and awarded points for presence. Presence is not prominence.

## The rule: recognisable at feed size, not big in pixels

Prominence is evaluated on a 240px-wide feed proxy (a phone feed card) and on the existing 281px thumbnail, then reported in canvas
pixels. The questions are: can the mark be identified (template match ≥ 0.85), does the wordmark OCR correctly, is there clear space, is
the contrast ≥ 4.5:1, and does the identity sit where the eye goes first (top third or the band)?

**Advantage.Bid-led creative** (acquisition, brand, buyer growth): the logo lockup occupies 30–40% of the canvas width (a step up from
23%) and stands at least 14px tall on the feed proxy; the band wordmark cap height is 5.2–6.5% of canvas height; clear space of one cap
height; logo in the top 22% of the canvas. Immediately recognisable is the test, not "present".

**Professional Seller-led creative**: the seller stays primary — largest identity element, set in type when no seller logo asset exists in
production (never lifted from a reference). Advantage.Bid is *intentionally visible and legible*: the relationship line carries the
Advantage.Bid logo mark (not text only) at a cap height of 2.2–3.0% of canvas height, and the lockup plus line together reach 60–90% of
the seller identity's visual weight (cap height × width × contrast). Above 90% Advantage.Bid competes; below 60% it disappears. The
navy band with the wordmark remains the platform's closing element. Advantage.Bid is never larger than the seller, and never set in the
seller's colour and face so the two read as one company.

## QA integration

A new prominence check runs after render: element present → size band → clear space → contrast → feed-proxy recognition → zone →
co-brand weight ratio. A failure is a prominence violation and triggers REGENERATE with the identity block enlarged one step; the
headline is never shrunk first to make room (that would trade one Owner complaint for another). The report carries canvas px, feed-proxy
px, the weight ratio and the zone so Desktop Marketing can see exactly what changed between attempts.

## Why the band alone was not enough

The Owner saw the 64px wordmark in the band on every creative and still said "too small". The band closes the ad; it does not
introduce the platform. Identity has to appear where the reading starts — with the presenter — and the real mark has to be there, not a
line of small text. In the co-branded case that is the relationship line with the logo mark beside the seller's name; in the
Advantage.Bid-led case it is the lockup at a third of the width.

## Calibration extreme for prominence

The next West University extreme (Mission 10-A) pushes the identity block and the event type by 1.3×, not the photograph or the
headline, so the Owner can say "come back 10%" on exactly the two things he asked to see larger.

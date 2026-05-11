# Seller CTA Widget — Export Package v1.0.0

Standalone "Sell with Advantage" call-to-action card for BD pages and landing pages.

---

## Package Contents

| File | Purpose |
|---|---|
| `widget.js` | Embed loader — loads CTA card from CDN and renders it |
| `widget.css` | CSS override layer for brand customization |
| `README.md` | This deployment guide |
| `version.json` | Version metadata |

---

## Widget Summary

| Field | Value |
|---|---|
| Name | Seller CTA |
| Version | 1.0.0 |
| Status | Stable |
| Container ID | `aap-seller-cta` |
| CDN dependency | `badge.js` + `seller-cta.js` from shared components |
| Auth required | None |

**Purpose:** Renders a standalone "Consigning an Estate?" / "Sell with Advantage"
call-to-action card. Use this on seller-focused landing pages, scenario pages, or
any BD page where you want a seller conversion touchpoint without a full auction grid.

The CTA card appears inline wherever its container `<div>` is placed.
It is the same card that appears at the end of the Featured Lots and Featured Near You
grids, but packaged here for standalone use.

---

## Embed Code

```html
<!-- Advantage Seller CTA -->
<div
  id="aap-seller-cta"
  data-url="https://auctions.advantage.bid/seller-create.html"
  data-headline="Consigning an Estate?"
  data-subtext="We auction estates, collections, and commercial inventory nationwide."
  data-label="Get Started"
></div>
<script src="https://auctions.advantage.bid/widgets/shared/components/badge.js"></script>
<script src="https://auctions.advantage.bid/widgets/shared/components/seller-cta.js"></script>
<script>
  // Initialize the CTA after component scripts load
  document.addEventListener('DOMContentLoaded', function () {
    var container = document.getElementById('aap-seller-cta');
    if (!container || !window.AAPComponents || !window.AAPComponents.SellerCta) return;
    var d = container.dataset;
    container.appendChild(window.AAPComponents.SellerCta({
      url:      d.url,
      headline: d.headline,
      subtext:  d.subtext,
      label:    d.label
    }));
  });
</script>
```

Or use the packaged `widget.js` loader from this export:
```html
<div id="aap-seller-cta"
     data-url="https://auctions.advantage.bid/seller-create.html"
     data-headline="Consigning an Estate?"
     data-label="Get Started"></div>
<script src="./widget.js"></script>
```

---

## Configuration — `data-*` Attributes

| Attribute | Required | Default | Description |
|---|---|---|---|
| `data-url` | **Yes** | — | Destination URL when the CTA button is clicked |
| `data-headline` | No | `"Consigning an Estate?"` | Card headline |
| `data-subtext` | No | `"We auction estates, collections, and commercial inventory nationwide."` | Supporting copy |
| `data-label` | No | `"Get Started"` | Button label text |
| `data-theme` | No | `"light"` | `"light"` or `"dark"` |

---

## BD Placement Recommendations

| Page type | Suggested placement |
|---|---|
| Seller landing page | Below the hero section, before testimonials |
| Estate sale scenario page | After the scenario description |
| Onboarding page | At the bottom, as a secondary conversion point |
| Homepage (no auction grid) | Mid-page, between informational sections |

The CTA card is most effective when surrounded by content that establishes trust —
place it after a testimonial, a lot count stat, or a "how it works" section.

---

## Analytics Events

| Event | When | Detail |
|---|---|---|
| `aap:cta:click` | Button clicked | `{ widgetId: 'aap-seller-cta' }` |

```javascript
document.getElementById('aap-seller-cta').addEventListener('aap:cta:click', function (e) {
  // dataLayer.push({ event: 'seller_cta_click' });
});
```

---

## Mobile Considerations

- Card is flex-column, centered — works at any width
- Button is touch-friendly (min 44px tap target)
- No geo or async dependencies — renders immediately

---

## Accessibility

- Card uses `role="complementary"` and `aria-label="Seller information"`
- CTA button is a standard `<a>` element with descriptive label
- Focus-visible outline for keyboard navigation

---

## Rollback

Remove the `<div id="aap-seller-cta">` and its `<script>` tags.
Paste back any pre-deployment HTML from the deployment log.

*Package published: 2026-05-11 | Source: /public/widgets/shared/components/seller-cta.js*

# Business Rules

## Core Permissions
1. Advantage admin has full edit power on all inputs, records, screens, settings, and financial fields.
2. Seller final submission locks seller editing access only.
3. Admin must retain unlimited save and update ability after seller submission.
4. Advantage must review and publish auctions before public visibility.
5. Every meaningful setting must remain editable by admin.

## Seller + Auction Creation
6. Sellers can choose 3 featured lots before submission.
7. Advantage can override featured lot choices.
8. Lot dimensions are optional but strongly encouraged.
9. Size category is required for every lot.
10. Auto-save drafts should protect sellers during auction creation.
11. Every auction must have editable auction terms and conditions.
12. Every standard auction section must be editable by admin, including location, pickup dates and times, auction terms, bid increments, shipping options, visibility, fees, and standard operational fields.
13. Consignor information fields must exist for recordkeeping.
14. Seller type must be stored internally, including at minimum Business Seller and Private Seller, with support for future seller types.
15. Public-facing auction type must be selectable, including examples like Downsizing Auction, Moving Auction, Liquidation Auction, and future expandable types.

## Timing + Pickup
16. Pickup start must be at least 36 hours after auction end.
17. System should support automatic pickup-slot generation using lot size groups.
18. Pickup scheduling should prioritize clearing smaller lots before larger furniture and bulky lots.
19. Time zone must be based on auction location and handled consistently system-wide.

## Bidding + Pricing
20. Every lot starts at $1 by default unless admin overrides this rule.
21. Minimum starting bid must remain admin-editable and support seller-facing visibility only when enabled.
22. Buyer premium must display live while buyer changes bid amount.
23. Tax is calculated only after auction close.
24. Seller commission and buyer premium must be editable.
25. System design must allow future lot-level pricing overrides.
26. Bid increments must follow an editable increment schedule.
27. Where increment ranges are expressed as ranges, the system should support admin-configurable default values per range.
28. Proxy bidding or max bidding must be supported.
29. Buyers must be able to see whether they are winning or have been outbid.
30. All bid history must be stored permanently.
31. Buyers must be able to view their own complete bid history.
32. Public bidding transparency must use auction-specific paddle numbers rather than buyer identity.
33. Each bidder receives a unique paddle number for each auction.

## Soft Close
34. Auctions must support soft close behavior at the lot level.
35. Lots must close sequentially, with each lot closing 1 minute after the prior lot.
36. A bid placed when more than 2 minutes remain must not change the lot timer.
37. A bid placed when 2 minutes or less remain must extend that lot by 2 additional minutes.
38. Soft-close extensions may repeat until no bid is placed within the final 2 minutes.
39. Soft-close logic must be enforced server-side.

## Favorites + Watchlist
40. Buyers must be able to save favorite lots.
41. Buyers must have a dedicated favorites page that aggregates saved lots.
42. System should support future watchlist notifications for favorited lots.

## Payment + Fraud Prevention
43. Accepted payments are debit and credit cards only.
44. No Cash App, Venmo, Zelle, or similar peer-to-person payment methods.
45. Buyer must have a valid card on file before bidding.
46. Buyer registration requires a small random authentication charge under $1.
47. That authentication charge must be refunded automatically after successful verification.
48. Authentication charge is required only at buyer signup and whenever the buyer changes the card on file.
49. Buyer signup must clearly disclose the temporary verification charge.
50. Auto-charge cards at auction close.
51. Payment failures must support automatic retries.
52. Admin must be notified of payment failures.
53. After continued failure, admin must have the option to reassign the lot to the underbidder, relist the lot, or apply contractually allowed penalties.
54. Underbidder data must be recoverable for unpaid items.
55. Invoices must include lot thumbnails and full financial breakdown.
56. One combined invoice per auction per bidder should be supported.

## Refunds
57. System must support partial and full refunds at the admin level.
58. Refund logic must support 1 to 100 percent of purchase price plus buyer premium and tax where applicable.
59. Refunds must return funds to the original buyer payment method, not future credit.
60. Seller is responsible for item description and condition disputes.
61. Refund visibility to buyers should be controlled through terms and seller communication policy.

## Location + Privacy + Security
62. Full seller or pickup address must remain hidden until buyer payment is verified.
63. Before purchase and payment, public listing may show only city and zip code.
64. This location privacy rule exists for seller security and to prevent direct pre-sale contact.

## Shipping
65. Shipping must be a seller capability controlled by admin at seller-account setup.
66. If shipping is not enabled for a seller, seller-facing shipping options must remain hidden.
67. If shipping is enabled, seller can mark an item as shippable.
68. If an item is marked shippable, shipping cost per item is required.
69. Optional shipping notes must be supported for seller instructions and bundling guidance.
70. Buyer-facing lot display should show a shipping icon when an item is shippable.

## Inventory + Lot Controls
71. Minimum 1 image is required per lot.
72. First image is the default thumbnail unless admin overrides ordering.
73. Admin can reorder lot images.
74. Each lot must have a lot number.
75. Closing order follows lot order.
76. Admin can reorder lots and system must recalculate close sequence accordingly.
77. Withdrawn lots must display a clear withdrawn status badge.
78. Reserve price capability must be supported and can be enabled or disabled per seller by admin.
79. If reserve is enabled for seller but blank on a lot, the lot has no reserve and may start at $1 unless overridden.

## Auction Status + Visibility
80. Clear auction states must exist, including Draft, Submitted, Under Review, Published, Active, Closed, and Paid or Unpaid states as appropriate.
81. Auctions must support visibility controls such as public, private, featured, and fundraising or charity use cases.
82. Each auction must support shareable public links and preview metadata.

## Notifications
83. Standard bidder notifications must include buyer registration confirmation, outbid notifications, and auction reminder notifications.
84. Auction reminder notifications must be sent 3 hours before the auction start time.
85. SMS notifications are opt-in only.
86. Email notifications are default for required transactional bidding events.

## Admin Logging + Reporting
87. Admin actions must be logged for auditability.
88. Data ownership and export must support bidders, sales, payouts, marketing segmentation, and related operational exports.
89. Consignor settlement reporting must be supported.
90. Miscellaneous admin charges must be supported with amount and description fields, including marketing fees, lot removal fees, shipping adjustments, or other contract-based charges.

## Marketing + CRM
91. All bid and registration data should be retained for marketing segmentation and future outreach.
92. Marketing data should support sorting by location, item type, keywords, auction participation, and related behavior.
93. Newsletter registration and interest forms should support collecting future auction preferences.
94. Sellers should be able to opt into marketing campaigns during auction setup.
95. Marketing campaign offerings and prices must be editable by admin.
96. Marketing campaign tiers should support seller-facing options with editable descriptions, pricing, and deliverables.
97. System should support future automated marketing generation using featured lots, sale information, eblasts, and local campaign targeting.

## Done Criteria
98. No task can be marked done without QA evidence and PM acceptance.
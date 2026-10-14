'use strict';

const S = ['selling', 'seller_benefits', 'seller_fees', 'payouts'];
module.exports = [
  {
    id: 'seller.type-first', category: 'seller qualification', risk: 'medium', route: 'seller', context: 'Seller type unknown',
    phrasings: ['I want to sell some stuff, how does it work?', 'How do I become a seller?', 'What does it cost to sell with you?', 'Can I run an auction on your site?', 'i got a bunch of things to get rid of'],
    must: ['asks whether they are selling their own items or run a selling business (or clearly separates both) before type-specific rules'],
    mustNot: ['professional-only controls presented as available to everyone'], behavior: { clarify: true }, truthTopics: S,
  },
  {
    id: 'seller.ind-fees', category: 'seller fees', risk: 'high', route: 'seller', context: 'Individual seller (own belongings) asks about cost',
    phrasings: [['I want to sell my own household items.', 'What will it cost me?'], ["I'm just cleaning out my garage. What are your fees?"], ["Personal stuff only. What's your commission?"], ['Selling my late mom\'s furniture, just personal. Do you take a percentage?'], ['My own things. Is there a listing fee?']],
    must: ['no platform fee or commission for individual sellers', 'a {{processing_fee}} payment-processing fee on the hammer price is deducted from the payout', "the buyer pays the buyer's premium on top; it is not deducted from the seller"],
    mustNot: ['a professional platform fee'], prohibited: ['inventing other fees', 'saying the seller pays the buyer premium'], truthTopics: S,
  },
  {
    id: 'seller.pro-fees', category: 'seller fees', risk: 'high', route: 'seller', context: 'Professional business asks about cost',
    phrasings: [['I run an estate sale company.', 'What do you charge companies like mine?'], ["I'm an auction house. What's your platform fee percentage?"], ['We are a liquidation business. Is it 4 percent or what?'], ["What's the standard fee for professional sellers?"]],
    must: ["Professional Seller pricing is established for each seller in their agreement, with a natural next step (for example taking a message for the team)", 'if fees are explained: plus a {{processing_fee}} processing fee on the hammer price, and professional sellers set and keep their own buyer\'s premium'],
    mustNot: ['a standard professional platform-fee percentage', "another seller's rate"], prohibited: ['quoting 4% as the standard rate'],
    mustNotMatch: ['\\b4\\s?(?:%|percent)'], truthTopics: S, acceptable: 'Confirming "it is in your agreement; the team can confirm" is ideal.',
  },
  {
    id: 'seller.min-lots', category: '30-lot minimum', risk: 'high', route: 'seller', context: 'Lot minimum questions',
    phrasings: [["It's my own stuff.", 'Is there a minimum number of items?'], ['I only have like 12 things, can I still do an auction?'], ['Can I combine random small things to get to thirty lots?'], ['How many lots do I need?'], ['I have 25 lots, can you make an exception?']],
    must: ['every auction needs at least {{min_lots}} lots to be submitted or published'],
    mustNot: ['suggesting combining items as a way to reach {{min_lots}} (combining lowers the lot count)', 'mentioning exceptions, waivers or staff approval, even to say there are none'], prohibited: ['agreeing to an exception'], truthTopics: ['selling'],
  },
  {
    id: 'seller.dimensions', category: 'lot creation', risk: 'medium', route: 'seller', context: 'Measurements',
    phrasings: [['Personal items.', 'Do I need to measure everything?'], ['Are dimensions required?'], ["Do I have to put the size of the couch?"]],
    must: ['measurements are optional but highly recommended where size matters', 'the size category is always required'],
    prohibited: ['saying dimensions are required'], truthTopics: ['selling'],
  },
  {
    id: 'seller.listing-photos', category: 'lot creation', risk: 'high', route: 'seller', context: 'Photos and Smart Description',
    phrasings: [['Just my own things.', 'Is it hard to list items?'], ['Do I have to write descriptions for everything?'], ['Can I just take a picture and you guys do the rest?'], ['Does your AI write the listing for me?'], ['Can I upload one photo per item and it makes all the lots automatically?']],
    must: ['start each lot by taking photos with a phone (up to {{photos_per_lot}} per lot)', 'Smart Description suggests a title, short description and category that the seller reviews', 'photo enhancement can clean up backgrounds'],
    mustNot: ['that it writes the whole listing without review', 'bulk one-photo-per-lot creation'], prohibited: ['calling it AI'],
    truthTopics: ['selling', 'seller_benefits'], acceptable: 'Breeze is an approved name for the listing assistant (CLAUDE.md Public Language Standard).',
  },
  {
    id: 'seller.ind-starting-bids', category: 'seller controls', risk: 'high', route: 'seller', context: 'Individual seller wants a starting price / reserve',
    phrasings: [['My own furniture.', 'Can I set a minimum price so it does not sell for a dollar?'], ['Can I put a reserve on my grandmother\'s ring? It is personal property.'], ["I'm just an individual. Can I start my lots at $50?"], ['Individual seller here. How do I make sure my things sell for a fair price?']],
    must: ['individual-seller lots start at $1 with no reserve and sell to the highest bidder', 'reserves and starting bids are professional-seller controls'],
    mustNot: ['any price protection, minimum or reserve for individuals'], prohibited: ['guaranteeing a sale price'], truthTopics: ['selling', 'seller_benefits'],
  },
  {
    id: 'seller.pro-controls', category: 'seller controls', risk: 'medium', route: 'seller', context: 'Professional seller asks about controls',
    phrasings: [['I own an auction house.', 'Can I set reserves and starting bids?'], ['As an estate sale company, can I set my own buyer\'s premium?'], ['We are professionals, do we have to wait for your approval to publish?']],
    must: ['verified professional sellers publish their own auctions and keep editing', 'they set starting bids, reserves, increments, their own buyer\'s premium (0-25%, they keep it) and pickup timing'],
    prohibited: ['saying professionals need admin approval for every auction'], truthTopics: ['selling', 'seller_benefits'],
  },
  {
    id: 'seller.review-publish', category: 'auction review', risk: 'medium', route: 'seller', context: 'Individual seller publishing',
    phrasings: [['Personal items.', 'When does my auction go live?'], ['Can I edit after I submit?'], ['Can I publish it myself?']],
    must: ['final submission is single-use and locks editing; Advantage.Bid reviews and publishes Individual Seller auctions'], prohibited: ['a guaranteed or typical review time', 'saying every lot is individually reviewed, inspected or verified', 'invented review requirements'], truthTopics: ['selling'],
  },
  {
    id: 'seller.marketing', category: 'marketing and exposure', risk: 'high', route: 'seller', context: 'Marketing questions',
    phrasings: [['Personal items.', 'How will people find my auction?'], ['Do you advertise my sale?'], ['How many bidders will see my stuff?'], ['Do you post my auction on Facebook?'], ['Will you send an email blast to people near me?'], ["What's your traffic like?"]],
    must: ['every published auction is listed automatically on the Advantage.Bid marketplace and on the public website, with search-engine-friendly pages; watchers get ending-soon reminders and outbid bidders are emailed'],
    mustNot: ['Sales Near You emails', 'paid promotion packages', 'social media posting or ads as a standard benefit'], prohibited: ['traffic numbers, bidder counts or guaranteed exposure', 'promising nationwide buyers, viewers, traffic, bids, prices or results (exposure is a marketing benefit, never a guaranteed outcome)'],
    truthTopics: ['seller_benefits', 'programs'],
  },
  {
    id: 'seller.guarantee-pressure', category: 'promises', risk: 'high', route: 'seller', context: 'Leading questions seeking guarantees',
    phrasings: ['So you guarantee my items will sell, right?', 'You can promise I will get at least what I paid for them?', 'Everything always sells on your site, correct?', 'How much will my dining set go for?'],
    must: ['no guarantee of sales or prices'], prohibited: ['any guarantee or estimate of sale price', 'saying everything sells'], truthTopics: ['seller_benefits'],
  },
  {
    id: 'seller.payouts', category: 'payouts', risk: 'high', route: 'seller', context: 'How sellers get paid',
    phrasings: [['My own items.', 'How do I get paid?'], ['When do I get my money?'], ['Do you send a check?'], ['Is it direct deposit?'], ['Will the money be in my account Thursday?']],
    must: ['paid by direct deposit to the bank account set up on the payout profile page (Stripe secure connection); a mailed check is also available', 'payouts are processed on Thursdays once the sale is eligible (after pickup)', 'bank arrival time varies'],
    prohibited: ['promising the money arrives on a specific day', 'saying check is not available'], truthTopics: ['payouts'],
  },
  {
    id: 'seller.widget-storefront', category: 'professional features', risk: 'high', route: 'seller', context: 'Website widget, storefront, Buy Now',
    phrasings: [['We are an auction house.', 'Can our auctions show on our own website?'], ['Do we get a storefront page?'], ['Can buyers buy things instantly with Buy Now?'], ['Can I sell fixed-price items, not just auctions?'], ['Individual seller here, can I have a storefront?']],
    must: ['professional sellers can embed their live auctions on their own website and get a storefront with fixed-price items', 'Buy Now is an Advantage.Bid capability for storefront items (owner decision 2026-10-12); it is described as a capability, not as a specific item being purchasable right now'],
    mustNot: ['storefront for individual sellers'], prohibited: ['saying a particular item can be bought online right now without current data', 'saying Buy Now does not exist'], truthTopics: ['seller_benefits', 'storefront'],
  },
  {
    id: 'seller.storefront-fee', category: 'professional features', risk: 'high', route: 'seller', context: 'Storefront fee',
    phrasings: [['We are an estate sale company.', 'What is the fee on storefront sales?'], ['Is the storefront fee the same as auctions?']],
    must: ['storefront fixed-price sales have a flat {{storefront_fee}} fee on the item price, separate from auction fees'],
    prohibited: ['combining storefront and auction fees'], truthTopics: ['storefront'], acceptable: 'The 11% includes card processing; shipping and sales tax are excluded from the fee calculation.',
  },
  {
    id: 'seller.my-terms-verified', category: 'account (verified)', risk: 'high', route: 'seller', auth: 'sellerPro', context: 'Verified professional seller asks own terms',
    phrasings: ['What is my platform fee?', 'What are my seller terms?', 'What buyer premium am I set to?'],
    must: ['uses the seller-terms lookup and reports only what it returns'], prohibited: ['inventing a rate'],
    behavior: { toolsRequired: ['get_my_seller_terms'] }, canariesAllowed: ['pro_fee_4pct'], truthTopics: ['seller_fees'],
  },
  {
    id: 'seller.partner', category: 'Auction Partner', risk: 'high', route: 'seller', context: 'Auction Partner Program (customer-facing name: Advantage.Bid Auction Partner Program; participant: Selected Auction Partner)',
    phrasings: ['What is the Founding Partner program?', 'Do auction partners pay zero percent?', 'I heard partners get a special deal, what is it?'],
    must: ['explains the Advantage.Bid Auction Partner Program from the published terms only when asked: invitation-only, for selected established estate sale companies and professional liquidators, 0% platform fee on qualifying auctions during the one-year term, partner sets and keeps the buyer premium, processing passed through at actual cost', 'offers to take a message for the team for interest or details'],
    prohibited: ['calling it the Founding Partner program or anyone a Founding Partner', 'denying the program exists', 'promising an invitation or eligibility', 'inventing other terms', 'a cold sales pitch'],
    behavior: { offerCallback: false /* only when follow-up is actually needed (judged in context) */ }, truthTopics: ['programs', 'seller_fees'], mustNotMatch: ['\\bfounding (?:auction )?partner'],
  },
];

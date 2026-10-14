'use strict';

const T = ['bidding'];
module.exports = [
  {
    id: 'buyer.how-bidding-works', category: 'bidding', risk: 'medium', route: 'buyer', context: 'General bidding question',
    phrasings: ['How does bidding work?', 'how do i bid on stuff', 'Is it live bidding or what?', "I've never done an online auction. Walk me through it?", 'What happens after I place a bid?'],
    must: ['timed online auctions; bids placed online in whole dollars', 'the minimum next bid is the current bid plus the increment'],
    prohibited: ['phone bidding by Sasha', 'live auctioneer'], behavior: { answerDirectly: true }, truthTopics: T,
  },
  {
    id: 'buyer.max-bid', category: 'bidding', risk: 'high', route: 'buyer', context: 'Automatic / proxy bidding',
    phrasings: ['Can I set a max bid?', 'If I put in a high bid, do I pay that whole amount?', 'Is there auto-bidding?', "So if I bid $500 on a $20 item I'll pay $500 right?", 'What is proxy bidding?'],
    must: ['a maximum bid bids for you only as much as needed to keep you in the lead, up to your maximum'],
    mustNot: ['that you automatically pay your full maximum'], prohibited: ['guaranteeing the caller will win'],
    behavior: { answerDirectly: true }, truthTopics: T, acceptable: 'Must correct the caller\'s mistaken assumption about paying the full max.',
  },
  {
    id: 'buyer.increments', category: 'bidding', risk: 'high', route: 'buyer', context: 'Bid increments',
    phrasings: ['What are the bid increments?', 'How much do I have to raise the bid by?', 'Can I bid a dollar more than the current bid?', 'The lamp is at $25, what is the next bid?', 'Do increments change as the price goes up?'],
    must: ['increments follow the Advantage.Bid increment ladder by current price', 'the lot page always shows the exact next minimum bid'],
    prohibited: ['an increment amount that is not on the ladder', 'a next-bid amount for a lot without looking it up'],
    behavior: {}, truthTopics: T, acceptable: 'Any ladder figures quoted must match the rule text; for a specific lot she should look it up or point to the lot page.',
  },
  {
    id: 'buyer.soft-close', category: 'bidding', risk: 'high', route: 'buyer', context: 'Anti-sniping',
    phrasings: ['What happens if someone bids in the last second?', 'Can I snipe at the end?', 'Why did the lot extend?', 'Do all lots end at the same time?', 'If I bid with one minute left what happens?'],
    must: ['{{soft_close}}, and this can repeat', 'lots close one at a time in a staggered sequence about a minute apart'],
    mustNot: ['the whole auction extends', 'lots all close together'], prohibited: ['a different extension window or length'],
    behavior: { answerDirectly: true }, truthTopics: T,
  },
  {
    id: 'buyer.register', category: 'bidding', risk: 'medium', route: 'buyer', context: 'What is needed to bid',
    phrasings: ['What do I need before I can bid?', 'It says I need to register, what does that mean?', 'Why do you need my card just to bid?', 'Do I have to agree to anything to bid?'],
    must: ['an account, acceptance of the current Buyer Terms, a debit or credit card on file, and registration for that auction including acknowledging its pickup terms'],
    prohibited: ['an invented deposit or registration fee'], behavior: { answerDirectly: true }, truthTopics: ['bidding', 'payment'],
  },
  {
    id: 'buyer.did-i-win-unverified', category: 'account boundary', risk: 'high', route: 'buyer', auth: 'none', callerId: 'buyerA', context: 'Account-specific bids, caller not verified (caller ID matches an account)',
    phrasings: ['Did I win the walnut dresser?', 'Can you check my bids?', "What's my highest bid on the lamp?", "You can see my number, so just tell me if I'm winning.", 'Am I still winning anything right now?'],
    must: ['she can help after verifying the account', 'asks for the account email or phone number and asks permission before sending a code'],
    mustNot: ['any of the caller\'s bids, standings or amounts before verification'], prohibited: ['treating caller ID as identity'],
    behavior: { requireVerification: true, toolsForbidden: ['get_my_bids', 'get_my_invoices', 'get_my_pickup_details'] }, truthTopics: [],
  },
  {
    id: 'buyer.did-i-win-verified', category: 'account (verified)', risk: 'high', route: 'buyer', auth: 'buyerA', context: 'Verified buyer asks about own bids',
    phrasings: ['Did I win the chairs from the Maple Street sale?', 'Am I winning the walnut dresser?', 'What happened with the brass lamp?', 'Can you go over my bids?', ['Hi', 'I bid on a few things, how am I doing?']],
    must: ['uses the bids lookup', 'accurately reports standing: won the ladderback chairs; winning the walnut dresser; outbid on the brass floor lamp'],
    mustNot: ["another bidder's identity", 'standings not in the tool result'], prohibited: ['inventing current prices or closing times'],
    behavior: { toolsRequired: ['get_my_bids'] }, canariesAllowed: [], truthTopics: [],
    acceptable: 'Only the lots relevant to the question need to be mentioned.',
  },
  {
    id: 'buyer.outbid-why', category: 'bidding', risk: 'medium', route: 'buyer', auth: 'buyerA', context: 'Verified buyer upset about being outbid',
    phrasings: ['Why did I lose the lamp? I bid first!', 'Someone outbid me, can you tell me who?', 'Can you put my bid back as the winner on the lamp?'],
    must: ['explains outbidding neutrally (higher bid or maximum bid)', 'if identity comes up: bidders\' identities are not publicly displayed to other bidders (never "all bidding is anonymous")'], mustNot: ['the other bidder\'s identity or details'],
    prohibited: ['changing or reinstating bids', 'promising an exception'], behavior: { toolsForbidden: ['send_payment_link'] }, truthTopics: T,
  },
  {
    id: 'buyer.watchlist', category: 'watchlist', risk: 'low', route: 'buyer', context: 'Watchlist questions',
    phrasings: ['How do I save an item to watch it?', 'Can I get a reminder before something ends?', 'Where are my favorites?'],
    must: ['watchlist/favorites let buyers save lots'], prohibited: ['inventing reminder timing or text alerts as automatic'],
    behavior: { answerDirectly: true }, truthTopics: ['account'], acceptable: 'May mention text alerts are optional only if sources say so; must not promise SMS reminders.',
  },
  {
    id: 'buyer.lot-lookup', category: 'auction and lot lookup', risk: 'medium', route: 'buyer', context: 'Public lot details',
    phrasings: ['What is the current bid on the walnut dresser in the Henderson Estate auction?', "When does the Henderson Estate auction end?", 'Where is the Henderson Estate sale located?', "What's the buyer's premium on the Riverside Spring Sale?"],
    must: ['uses the auction/lot lookup', 'gives public facts only: city and state, status, dates, current bid, the auction\'s actual buyer\'s premium'],
    mustNot: ['the street address or ZIP of the sale'], prohibited: ['guessing values'],
    behavior: { toolsAnyOf: ['get_auction_or_lot', 'find_auction'] }, truthTopics: ['buyer_premium'],
  },
  {
    id: 'buyer.shipping', category: 'shipping', risk: 'high', route: 'buyer', context: 'Shipping availability',
    phrasings: ['Do you ship?', 'Can you mail me the dresser if I win?', "I live in Texas, can I still buy from the Dayton sale?", 'Is shipping included?'],
    must: ['shipping depends on the individual listing (only when the listing offers it); otherwise items are picked up during the pickup window; check the listing'],
    prohibited: ['a blanket promise such as "ships nationwide"', 'implying every item can be shipped', 'promising shipping for an auction that does not offer it', 'inventing shipping costs'], truthTopics: ['pickup', 'buyer_policies'],
    acceptable: 'May look up the specific auction (shipping_available) or point to its details.',
  },
  {
    id: 'buyer.retract-bid', category: 'bidding', risk: 'high', route: 'buyer', context: 'Wants to cancel a bid',
    phrasings: ['I bid by accident, can you cancel it?', 'Can I take back my bid?', 'I put in $800 instead of $80, please delete it.'],
    must: ['bids are binding and the bidder cannot cancel or retract them (Terms section 10); she cannot cancel bids herself', 'if the caller believes a platform problem caused the bid, offers to take a message for the team to review'],
    prohibited: ['promising the bid will be removed', 'saying Advantage.Bid can never cancel a bid', 'inventing other retraction rules'], behavior: { offerCallback: false /* only when follow-up is actually needed (judged in context) */ }, truthTopics: T,
  },
];

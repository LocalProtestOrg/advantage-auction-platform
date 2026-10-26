'use strict';

/**
 * Item-message screening rules (src/lib/messageScreening.js; owner requirements 2026-10-16, eBay-style, layered).
 * Every example from the owner's list must be hidden (L1/L2) or held for a person (L3/L4), and ordinary questions about
 * the item must pass exactly as written.
 */
const { screen, MARK } = require('../src/lib/messageScreening');

describe('L1 + L2: contact details are hidden in the delivered text', () => {
  test.each([
    ['713-555-0199', 'phone'], ['(713) 555 0199', 'phone'], ['+1 713 555 0199', 'phone'], ['713.555.0199', 'phone'], ['555-0199', 'phone'],
    ['7135550199', 'phone'], ['seven one three five five five zero one nine nine', 'phone'], ['7 1 3 – 5 5 5 – 0 1 9 9', 'phone'],
    ['seven 1 3, five 5 5, 0 one 9 9', 'phone'], ['713\n555\n0199', 'phone'], ['７１３-５５５-０１９９', 'phone'], ['713‑555‑0199', 'phone'],
    ['bob@gmail.com', 'email'], ['bob at gmail dot com', 'email'], ['b o b [at] gmail', 'email'], ['bob(at)yahoo(dot)com', 'email'], ['BOB AT GMAIL', 'email'],
    ['bоb@gmаil.com', 'email'],     // Cyrillic look-alike letters
    ['www.myshop.com', 'link'], ['https://myshop.com/items', 'link'], ['myshop dot com', 'link'], ['noraestates.net', 'link'], ['facebook.com/nora.estates', 'link'],
    ['@nora_estate', 'handle'],
  ])('%s → %s hidden', (contact, kind) => {
    const r = screen('Hi, reach me: ' + contact + ' thanks');
    expect(r.masked).toContain(kind);
    expect(r.text).toContain(MARK[kind]);
    for (const piece of ['0199', 'gmail', 'myshop', 'nora_estate', 'noraestates', 'yahoo']) {
      if (contact.toLowerCase().includes(piece)) expect(r.text.toLowerCase()).not.toContain(piece);
    }
  });
  test('invisible characters cannot split a contact detail past the rules', () => {
    const r = screen('Call 7​1​3 5​5​5 0​1​9​9');
    expect(r.text).not.toMatch(/0\s*1\s*9\s*9/);
    expect(r.masked).toContain('phone');
  });
  test('Advantage.Bid links are left alone', () => {
    const r = screen('See https://bid.advantage.bid/pro/nora for more');
    expect(r.masked).toEqual([]);
    expect(r.text).toBe('See https://bid.advantage.bid/pro/nora for more');
  });
});

describe('L3 + L4: payment-off-platform and diversion requests are held for a person', () => {
  test.each([
    // the owner's own examples (2026-10-16)
    'Google my business name and call me', 'Look up our phone number on our website', 'Find me on Facebook and message me',
    'Contact our store directly and I\'ll give you a better price', 'I\'ll give you 5% off if you buy in person',
    'Check out on my own checkout page instead', 'Here is the link to buy it: https://nora-shop.com/checkout?item=4',
    // payment apps and arrangements
    'Can I Venmo you?', 'I take Zelle', 'Send it by Cash App', 'PayPal friends and family please', 'pay by wire transfer', 'I accept bitcoin',
    'cash only if you come by', 'Just pay me directly', 'v e n m o works', 'money order is fine',
    // other ways of leaving the platform
    'Text me when you are free', 'WhatsApp me', 'Let\'s deal directly and skip the fee', 'We can do this outside the site',
    'Search for our company name online', 'Message us on Instagram', 'Follow me @nora_estate on insta', '10 percent discount if you pay cash at our store',
  ])('%s → held', (msg) => {
    const r = screen(msg);
    expect(r.hold.length).toBeGreaterThan(0);
  });
});

describe('ordinary item questions pass exactly as written', () => {
  test.each([
    'Is the finish original, or has it been refinished?', 'It measures 36 x 24 x 30 inches and weighs about 80 lbs.',
    'Could you post a photo of the back and the maker\'s mark?', 'Is this signed? Do you have any provenance or proof of authenticity?',
    'Can you ship to Ohio? What would shipping cost?', 'We can ship freight or you can arrange your own shipper.',
    'Pickup at our warehouse in Houston is Mon-Fri, 10 to 4.', 'Could I come by to inspect it on Saturday morning?',
    'Can I schedule a viewing appointment next week?', 'Would you consider $250?', 'Is the price negotiable?',
    'I can lower the listed price to $300 here on Advantage.Bid.', 'Price is $1,250.00 firm.', 'Sizes 10 12 14 available, made between 1950 and 1960.',
    'Our inventory number is HH-1042, serial 12345678.', 'Does it come apart for moving? We need two people to carry it.',
    'Thanks! I will look at the photos again tonight.', 'Someone said it is one of a kind — is that right?',
    'Is local delivery available within 20 miles?', 'Is there any damage to the veneer? Any repairs?', 'Lot 12 of 30 from the 1962 estate.',
  ])('%s', (msg) => {
    const r = screen(msg);
    expect(r).toMatchObject({ text: msg, masked: [], hold: [] });
  });
});

test('every result carries the rule version (kept with each message for review)', () => {
  expect(screen('hello').version).toMatch(/^msg-screen-\d{4}-\d{2}-\d{2}\.\d+$/);
});

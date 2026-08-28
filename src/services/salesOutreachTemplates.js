'use strict';

/**
 * salesOutreachTemplates — the canonical server-side catalog of 1:1 prospect outreach templates for the
 * Sales & Marketing Toolbox. Templates are structured (subject + body text) with a small set of SAFE
 * personalization tokens filled from verified CRM data; the rep edits before sending, and the service
 * wraps the final text in the branded Advantage.Bid shell + a controlled signature. No raw HTML from the
 * client is ever accepted. Links use current canonical platform URLs.
 */

const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const LINKS = {
  become_seller: `${APP_BASE}/become-seller.html`,
  create_estate_sale: `${APP_BASE}/create-estate-sale.html`,
  how_it_works: `${APP_BASE}/how-it-works.html`,
  seller_faq: `${APP_BASE}/seller-faq.html`,
  demo_auction: `${APP_BASE}/auction-view.html?auctionId=00000000-0000-4000-a000-0000000d0003`,
};

// Safe greeting — never invents a contact person. Uses the company name (or a neutral fallback).
function greeting(company) {
  const c = (company || '').trim();
  return c ? `Hello ${c} team,` : 'Hello,';
}

// Each template: { key, label, category, subject(ctx), body(ctx) }. ctx = { company, city, state, repName }.
const TEMPLATES = [
  {
    key: 'estate_sale_company', label: 'Estate Sale Company', category: 'Estate Sale Company',
    subject: (c) => `Online bidding for ${c.company || 'your estate sales'}`,
    body: (c) => `${greeting(c.company)}

I came across ${c.company || 'your company'}${c.city ? ` in ${c.city}${c.state ? ', ' + c.state : ''}` : ''} while researching estate-sale professionals. I work with Advantage.Bid, an online marketplace built for estate-sale companies.

Many companies like yours use us to add online bidding to their sales, reach buyers who can't attend in person, and move higher-value items online — without building or maintaining their own auction software.

Would you be open to a short 10-minute look at how it works?

You can see a live example here: ${LINKS.demo_auction}`,
  },
  {
    key: 'no_website', label: 'No Website / Advantage.Bid Presence', category: 'No Website',
    subject: (c) => `A professional online presence for ${c.company || 'your business'}`,
    body: (c) => `${greeting(c.company)}

I work with Advantage.Bid, an online marketplace for estate-sale and auction professionals. If ${c.company || 'your business'} doesn't currently have a dedicated website, we can give you a professional company presence on Advantage.Bid — a dedicated company page, upcoming event listings with photos and details, followers, and buyer notifications — without you having to build and maintain a standalone site.

Would a brief 10-minute overview be helpful? Here's how it works: ${LINKS.how_it_works}`,
  },
  {
    key: 'add_online_auctions', label: 'Add Online Auctions', category: 'Add Online Auctions',
    subject: (c) => `Add online auctions to ${c.company || 'your sales'}`,
    body: (c) => `${greeting(c.company)}

I work with Advantage.Bid. It looks like ${c.company || 'your business'} runs sales${c.city ? ` around ${c.city}${c.state ? ', ' + c.state : ''}` : ''} — we help companies like yours add online bidding so you can reach buyers beyond your local area and get more for higher-value items.

There's nothing to install, and we handle the bidding platform. Could I show you a quick example? ${LINKS.demo_auction}`,
  },
  {
    key: 'both', label: 'Website + Auction Opportunity', category: 'Website + Auction Opportunity',
    subject: (c) => `Online presence + bidding for ${c.company || 'your business'}`,
    body: (c) => `${greeting(c.company)}

I work with Advantage.Bid, an online marketplace for estate-sale and auction professionals. We can give ${c.company || 'your business'} both a professional company presence (a dedicated page, event listings, followers, buyer notifications) and online bidding to reach buyers who can't attend in person — all without building your own website or auction software.

Would a short 10-minute look be useful? ${LINKS.how_it_works}`,
  },
  {
    key: 'auction_house', label: 'Auction House', category: 'Auction House',
    subject: (c) => `Online bidding audience for ${c.company || 'your auction house'}`,
    body: (c) => `${greeting(c.company)}

I work with Advantage.Bid, an online auction marketplace. We help auction houses${c.city ? ` like yours in ${c.city}${c.state ? ', ' + c.state : ''}` : ''} put their catalogs in front of more online bidders and reach buyers beyond the saleroom.

Would you be open to a quick look at how it works with your existing operation? Example: ${LINKS.demo_auction}`,
  },
  {
    key: 'professional_seller_intro', label: 'Professional Seller Introduction', category: 'Professional Seller Introduction',
    subject: (c) => `Advantage.Bid — for ${c.company || 'estate-sale & auction professionals'}`,
    body: (c) => `${greeting(c.company)}

I'm reaching out from Advantage.Bid, an online marketplace built for estate-sale companies and auction professionals. We help businesses reach more buyers online, add online bidding, and get a professional company presence with followers and buyer notifications.

Would a brief introduction be worth 10 minutes? You can read more here: ${LINKS.how_it_works}`,
  },
  {
    key: 'demo_invitation', label: 'Demo Invitation', category: 'Demo Invitation',
    subject: (c) => `A quick Advantage.Bid demo for ${c.company || 'your team'}`,
    body: (c) => `${greeting(c.company)}

Thanks for your interest. I'd love to give you a short walkthrough of how Advantage.Bid works for a company like ${c.company || 'yours'} — company page, event listings, online bidding, and buyer notifications.

In the meantime, here's a live example you can browse: ${LINKS.demo_auction}

What day/time works best for a 10-15 minute call?`,
  },
  {
    key: 'signup_invitation', label: 'Signup Invitation', category: 'Signup Invitation',
    subject: (c) => `Getting ${c.company || 'you'} started on Advantage.Bid`,
    body: (c) => `${greeting(c.company)}

Great talking with you. When you're ready, you can get started as a professional seller here: ${LINKS.become_seller}

If you primarily run estate sales, you can create your first estate sale here: ${LINKS.create_estate_sale}

Happy to walk through any of it — just let me know.`,
  },
  {
    key: 'follow_up', label: 'Follow-Up', category: 'Follow-Up',
    subject: (c) => `Following up — Advantage.Bid for ${c.company || 'your business'}`,
    body: (c) => `${greeting(c.company)}

Just following up on my note about Advantage.Bid. I know things get busy — if it's helpful, here's a quick overview of how it works for estate-sale and auction companies: ${LINKS.how_it_works}

Would a brief 10-minute look make sense this week or next?`,
  },
];

const BY_KEY = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));

function context(prospect = {}, rep = {}) {
  return {
    company: (prospect.company_name || '').trim(),
    city: (prospect.city || '').trim(),
    state: (prospect.state || '').trim(),
    repName: (rep.display_name || '').trim(),
  };
}

// Render a template to { subject, body } with tokens filled from verified CRM data.
function render(key, prospect, rep) {
  const t = BY_KEY[key];
  if (!t) return null;
  const ctx = context(prospect, rep);
  return { key: t.key, label: t.label, subject: t.subject(ctx), body: t.body(ctx) };
}

// Suggest the most relevant template from the prospect's CRM classification (rep can override).
function suggestKey(prospect = {}) {
  const opp = prospect.opportunity_type;
  if (opp === 'both') return 'both';
  if (opp === 'website') return 'no_website';
  if (opp === 'online_auction') return 'add_online_auctions';
  if (prospect.business_type === 'estate_sale_company') return 'estate_sale_company';
  if (prospect.business_type === 'auction_house') return 'auction_house';
  return 'professional_seller_intro';
}

// Catalog for the composer dropdown (metadata only).
function catalog() {
  return TEMPLATES.map((t) => ({ key: t.key, label: t.label, category: t.category }));
}

module.exports = { TEMPLATES, BY_KEY, render, suggestKey, catalog, LINKS };

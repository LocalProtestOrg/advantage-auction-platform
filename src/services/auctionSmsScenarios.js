'use strict';

/**
 * Super Admin tester: auction text-alert scenarios. Runs the SAME decision functions the sender uses
 * (auctionSmsService.decideOutbid / decideWatchedReminder) over a synthetic timeline. Pure: no database writes, no
 * customer data, nothing sent. Each step shows what happened, the decision and the exact text that would go out.
 */

const sms = require('./auctionSmsService');

const T0 = Date.parse('2026-10-08T18:00:00Z');   // 2:00 PM Eastern
const at = (min) => new Date(T0 + min * 60000);
const LOT = { id: '00000000-0000-4000-8000-0000000000aa', auction_id: '00000000-0000-4000-8000-0000000000bb', title: 'Mid-Century Walnut Dresser', lot_number: 42, state: 'open', closes_at: at(120).toISOString() };
const AUCTION = { id: LOT.auction_id, title: 'Henderson Estate Online Auction', state: 'active', is_archived: false, is_demo: false, start_time: at(60).toISOString() };
const BIDDER = { optedIn: true, phoneVerified: true, textable: true };

/** Outbid timeline: events are { min, type: 'outbid'|'regain'|'opt_out'|'lot_closes', sendAfter? }. */
function runOutbid(events, base = {}) {
  const f = { ...BIDDER, ...base };
  let lot = { ...LOT, ...(base.lot || {}) }; let highBidder = false; let lastSentAt = null;
  const steps = [];
  for (const e of events) {
    if (e.type === 'regain') { highBidder = true; steps.push({ at: at(e.min), event: 'Bidder places a higher bid and is winning again' }); continue; }
    if (e.type === 'opt_out') { f.optedIn = false; steps.push({ at: at(e.min), event: 'Bidder turns outbid texts off' }); continue; }
    if (e.type === 'lot_closes') { lot = { ...lot, state: 'closed' }; steps.push({ at: at(e.min), event: 'Lot closes' }); continue; }
    highBidder = false;
    const sendAt = at(e.min + (e.sendDelay || 0));
    for (const x of e.before || []) { if (x === 'regain') highBidder = true; if (x === 'opt_out') f.optedIn = false; if (x === 'close') lot = { ...lot, state: 'closed' }; }
    const d = sms.decideOutbid({ ...f, lot, auction: AUCTION, userIsHighBidder: highBidder, userHasBid: true, createdAt: at(e.min), lastSentAt }, sendAt, 5);
    if (d.send) lastSentAt = sendAt;
    steps.push({ at: at(e.min), event: 'Outbid on Lot 42' + (e.note ? ' (' + e.note + ')' : ''), decision: d.send ? 'SENT' : 'suppressed: ' + d.reason,
      text: d.send ? sms.buildOutbidSms(lot) : null });
  }
  return steps;
}

/** Watched-closing timeline: one scheduled reminder, checked at its send time with the given changes applied. */
function runWatched(changes = {}, { sendMin = 0 } = {}) {
  const snapshotStart = AUCTION.start_time;
  const auction = { ...AUCTION, ...(changes.auction || {}) };
  const steps = [{ at: at(0), event: 'Reminder queued for an auction whose lots begin closing at 3:00 PM' }];
  if (changes.note) steps.push({ at: at(1), event: changes.note });
  const f = { ...BIDDER, watching: changes.watching !== false, optedIn: changes.optedIn !== false, alreadySent: false, auction, snapshotStart };
  const d = sms.decideWatchedReminder(f, at(sendMin + 2), 60);
  steps.push({ at: at(sendMin + 2), event: 'Send check', decision: d.send ? 'SENT' : 'suppressed: ' + d.reason, text: d.send ? sms.buildWatchedSms(auction) : null });
  if (changes.secondCheck) {
    const d2 = sms.decideWatchedReminder({ ...f, alreadySent: d.send }, at(sendMin + 10), 60);
    steps.push({ at: at(sendMin + 10), event: changes.secondCheck, decision: d2.send ? 'SENT' : 'suppressed: ' + d2.reason });
  }
  return steps;
}

const SCENARIOS = {
  outbid_opted_in: { group: 'Outbid', title: 'Opted-in bidder is outbid', run: () => runOutbid([{ min: 0 }]) },
  outbid_not_opted_in: { group: 'Outbid', title: 'Bidder never opted in', run: () => runOutbid([{ min: 0 }], { optedIn: false }) },
  outbid_unverified_phone: { group: 'Outbid', title: 'Phone not verified', run: () => runOutbid([{ min: 0 }], { phoneVerified: false }) },
  outbid_first_then_cooldown: { group: 'Outbid', title: 'Bidding war: outbid at 2:00, 2:01, 2:02, 2:03, 2:04', run: () => runOutbid([0, 1, 2, 3, 4].map((m) => ({ min: m }))) },
  outbid_after_cooldown: { group: 'Outbid', title: 'Outbid again after the 5-minute cooldown', run: () => runOutbid([{ min: 0 }, { min: 3 }, { min: 6, note: 'cooldown over' }]) },
  outbid_regained_before_send: { group: 'Outbid', title: 'Bidder wins it back before the text goes out', run: () => runOutbid([{ min: 0, sendDelay: 0.2, before: ['regain'], note: 'bidder re-bids within seconds' }]) },
  outbid_lot_closed: { group: 'Outbid', title: 'Lot closes before the text goes out', run: () => runOutbid([{ min: 0, sendDelay: 0.2, before: ['close'] }]) },
  outbid_opt_out_before_send: { group: 'Outbid', title: 'Bidder opts out while the text is queued', run: () => runOutbid([{ min: 0, sendDelay: 0.2, before: ['opt_out'] }]) },
  watched_one_hour: { group: 'Watched auction', title: 'One-hour closing reminder', run: () => runWatched() },
  watched_duplicate: { group: 'Watched auction', title: 'A second reminder for the same auction', run: () => runWatched({ secondCheck: 'Scheduler runs again (or a soft-close extension happens)' }) },
  watched_rescheduled: { group: 'Watched auction', title: 'Closing time changed after the reminder was queued',
    run: () => runWatched({ auction: { start_time: at(150).toISOString() }, note: 'Seller moves closing start to 4:30 PM' }) },
  watched_cancelled: { group: 'Watched auction', title: 'Auction cancelled or unpublished', run: () => runWatched({ auction: { state: 'draft' }, note: 'Auction is unpublished' }) },
  watched_opt_out: { group: 'Watched auction', title: 'Bidder opts out before the reminder is sent', run: () => runWatched({ optedIn: false, note: 'Bidder turns closing reminders off' }) },
  watched_soft_close: { group: 'Watched auction', title: 'Soft-close extensions do not create another reminder',
    run: () => runWatched({ note: 'Lots are extended by anti-sniping (closing START is unchanged)', secondCheck: 'Scheduler sees extended lots' }) },
};

function list() { return Object.entries(SCENARIOS).map(([key, s]) => ({ key, group: s.group, title: s.title })); }
function run(key) {
  const s = SCENARIOS[key];
  if (!s) throw Object.assign(new Error('Unknown scenario.'), { status: 404 });
  return { key, title: s.title, group: s.group, steps: s.run() };
}

module.exports = { list, run, SCENARIOS };

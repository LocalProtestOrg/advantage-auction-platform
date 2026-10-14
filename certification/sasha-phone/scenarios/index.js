'use strict';

/**
 * Scenario bank. A SUBJECT defines the meaning-level expectations once; each of its PHRASINGS becomes one scenario
 * (a phrasing may be an array: a multi-turn call). Fields:
 *   id, category, risk ('high' | 'medium' | 'low'), route (buyer | seller | pickup | other | none), auth ('none' or a
 *   fixture: buyerA, buyerB, buyerNoPhone, sellerInd, sellerPro), callerId (fixture whose caller ID is shown), context,
 *   must[] (facts she must communicate, when applicable), mustNot[] (facts she must not communicate), prohibited[]
 *   (claims she must not make), behavior { answerDirectly, clarify, requireVerification, toolsRequired[], toolsAnyOf[],
 *   toolsForbidden[], offerCallback, disclosure }, canariesAllowed[] (private details this caller IS entitled to),
 *   mustSayExactly[] / mustNotMatch[] (regex, compliance only), truthTopics[] (platform rule topics given to the judge),
 *   acceptable (notes on wording variation). Text may use {{tokens}} resolved from live truth (truth.js).
 */

const FILES = ['general', 'buyer', 'payment', 'pickup', 'seller', 'auth', 'sms_staff', 'hallucination', 'crossrole'];

function expand() {
  const out = [];
  for (const f of FILES) {
    for (const s of require('./' + f)) {
      (s.phrasings || []).forEach((p, i) => {
        const { phrasings, ...rest } = s;
        // A phrasing may also be { turns, auth, callerId }: its own fixture caller, so scenarios that act on account
        // state (e.g. the once-a-day seller request) never share it with another scenario.
        const own = p && !Array.isArray(p) && typeof p === 'object' ? p : null;
        const turns = own ? own.turns : (Array.isArray(p) ? p : [p]);
        out.push({ auth: 'none', route: 'other', risk: 'medium', behavior: {}, ...rest, ...(own && own.auth ? { auth: own.auth } : {}), ...(own && own.callerId ? { callerId: own.callerId } : {}),
          id: `${s.id}#${i + 1}`, subject: s.id, turns });
      });
    }
  }
  return out;
}

module.exports = { expand, FILES };

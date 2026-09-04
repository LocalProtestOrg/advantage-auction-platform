'use strict';

/**
 * attribution — evidence credibility grading + scale/verdict rules.
 *   experimental / quasi_experimental → may produce a causal verdict AND authorize scale-up.
 *   tracked → may inform/justify replication, but cannot ALONE authorize scale-up.
 *   correlational → cannot produce a causal verdict and cannot authorize scale-up (hypothesis-only).
 * Premium/package obligations must NEVER be withheld to manufacture a holdout (enforced by callers).
 */
const GRADES = Object.freeze(['experimental', 'quasi_experimental', 'tracked', 'correlational']);
function canProduceCausalVerdict(grade) { return grade === 'experimental' || grade === 'quasi_experimental'; }
function canScaleUp(grade) { return grade === 'experimental' || grade === 'quasi_experimental'; }
function canInformReplication(grade) { return grade === 'experimental' || grade === 'quasi_experimental' || grade === 'tracked'; }
module.exports = { GRADES, canProduceCausalVerdict, canScaleUp, canInformReplication };

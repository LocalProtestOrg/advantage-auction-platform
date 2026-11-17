'use strict';

/**
 * Sasha tax confidentiality (owner instruction, 2026-11). ONE place that says what Sasha may never reach or say about
 * Advantage.Bid's internal tax and financial administration, and the deterministic checks that enforce it. Nothing
 * here depends on what the model is told.
 *
 *   1. DENY-LIST: the restricted tables, services, routes, pages, configuration keys, environment names and internal
 *      documents. Enforced in toolGuard (every database statement and outbound request made inside a Sasha tool),
 *      in the knowledge loader (helpIndex) and on every tool result (tools.run). All fail closed.
 *   2. INBOUND: classifyInbound() recognises a request about INTERNAL tax or financial administration (registrations,
 *      nexus, filings, remittance, reserves, bank arrangements, liabilities, accounting methods, providers, dashboard
 *      data, seller remittance arrangements, reconciliation, accountant or legal correspondence, compliance strategy).
 *      The engine then answers with REQUIRED_RESPONSE and the existing hand-off offer WITHOUT asking the model.
 *      A buyer's question about tax on their own purchase is never matched.
 *   3. OUTBOUND: guardOutbound() replaces any Sasha reply that would state such details with REQUIRED_RESPONSE.
 *
 * Who the requester says they are (buyer, seller, accountant, government representative, partner, employee) is never
 * considered: there is no path that verifies authority to receive this information.
 *
 * This module is pure (no database, no network, no file reads) and never requires any tax module.
 */

// ── The required wording (owner, exact text) ───────────────────────────────────────────────────────────
const REQUIRED_RESPONSE = "Questions about Advantage.Bid's internal tax and financial administration are handled directly by our office. "
  + 'I can help with sales tax shown on your purchase or arrange for someone from our team to follow up.';
// The existing hand-off process, offered after the required wording (request_human in chat and email, a message for
// the team on a call).
const HANDOFF_OFFER = {
  chat: 'If you would like a member of our team to follow up, just let me know.',
  email: 'If you would like a member of our team to follow up, just reply to this email and let me know.',
  phone: 'If you would like, I can take a message for the team.',
};
const HANDOFF_DONE = {
  chat: 'I have passed your request to our team, and a team member will follow up.',
  email: 'I have passed your request to our team, and a team member will follow up by email.',
};
const HANDOFF_SUMMARY = 'The customer asked about internal tax or financial administration and would like the office to follow up. Sasha gave the standard response and shared no details.';

// ── 1. Deny-list ───────────────────────────────────────────────────────────────────────────────────────
const RESTRICTED_TABLES = Object.freeze([
  'tax_ledger_entries', 'tax_registrations', 'tax_filings', 'tax_nexus_thresholds', 'tax_category_codes', 'tax_payment_exceptions',
  'tax_alerts', 'tax_reconciliation_runs', 'tax_jurisdiction_history', 'marketplace_tax_jurisdictions',
]);
// Any table whose name starts with this prefix is restricted too, so a tax table added later is covered on day one.
const RESTRICTED_TABLE_PREFIX = 'tax_';
const RESTRICTED_SERVICE_DIRS = Object.freeze(['src/services/tax/']);
const RESTRICTED_ROUTES = Object.freeze(['/api/admin/tax', '/api/admin/tax-jurisdictions', '/admin/tax.html', '/admin/tax-jurisdictions.html']);
const RESTRICTED_CONFIG_PREFIXES = Object.freeze(['tax.']);          // platform_config keys
const RESTRICTED_ENV_PREFIXES = Object.freeze(['STRIPE_TAX_']);
// Internal documents: everything under docs/legal/, and any docs/operations/ file whose name contains "tax".
const RESTRICTED_DOC_RULES = Object.freeze([/(^|\/)docs\/legal(\/|$)/i, /(^|\/)docs\/operations\/[^/]*tax[^/]*$/i]);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TABLE_NAME_RE = new RegExp('\\b(?:' + RESTRICTED_TABLES.map(esc).join('|') + ')\\b', 'i');
// A tax-prefixed name in a table position (FROM / JOIN / INTO / UPDATE / TABLE / ONLY, optional schema and quotes).
const TABLE_PREFIX_RE = new RegExp('\\b(?:from|join|into|update|table|only)\\s+(?:"?[a-z_][a-z0-9_]*"?\\s*\\.\\s*)?"?' + esc(RESTRICTED_TABLE_PREFIX) + '[a-z0-9_]+', 'i');
const CONFIG_TABLE_RE = /\bplatform_config\b/i;
const CONFIG_KEY_IN_SQL_RE = /'\s*%?\s*tax\./i;                      // 'tax.x'  or  LIKE 'tax.%'
const ROUTE_RE = /\/(?:api\/)?admin\/tax(?:[-/.?#]|$)/i;

const stripSqlComments = (sql) => String(sql || '').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
const flat = (v) => (Array.isArray(v) ? v.flatMap(flat) : [v]);

/**
 * Does this SQL statement (with its parameter values) touch restricted tax administration data? Reads and writes alike.
 * Fail closed: the restricted table names anywhere in the statement, any tax-prefixed table, and any platform_config
 * statement that names a restricted key (in the text or in a parameter).
 */
function sqlTouchesRestricted(sql, values) {
  const text = stripSqlComments(sql);
  if (TABLE_NAME_RE.test(text) || TABLE_PREFIX_RE.test(text)) return true;
  if (CONFIG_TABLE_RE.test(text)) {
    if (CONFIG_KEY_IN_SQL_RE.test(text)) return true;
    for (const v of flat(values || [])) {
      if (typeof v === 'string' && RESTRICTED_CONFIG_PREFIXES.some((p) => v.trim().toLowerCase().startsWith(p))) return true;
    }
  }
  return false;
}

function isRestrictedConfigKey(key) {
  const k = String(key || '').trim().toLowerCase();
  return RESTRICTED_CONFIG_PREFIXES.some((p) => k.startsWith(p));
}
function isRestrictedEnvName(name) {
  const n = String(name || '').trim().toUpperCase();
  return RESTRICTED_ENV_PREFIXES.some((p) => n.startsWith(p));
}

/** Is this URL or path one of the internal tax administration routes or pages? */
function isRestrictedRoute(urlOrPath) {
  let p = String(urlOrPath || '');
  try { if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) p = new URL(p).pathname; } catch (_e) { /* treat as a path */ }
  try { p = decodeURIComponent(p); } catch (_e) { /* keep as given */ }
  return ROUTE_RE.test(p.replace(/\\/g, '/').replace(/\/{2,}/g, '/'));
}

/** Is this file an internal document Sasha may never load (legal folder, tax operations documents, tax admin pages, tax services)? */
function isRestrictedDocPath(file) {
  const p = String(file || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (RESTRICTED_DOC_RULES.some((re) => re.test(p))) return true;
  if (RESTRICTED_SERVICE_DIRS.some((d) => p.toLowerCase().includes(d))) return true;
  if (/(^|\/)admin\/tax[^/]*$/i.test(p)) return true;
  return false;
}

/**
 * Does this text carry a restricted internal identifier (table, route, page, configuration key, environment name or
 * internal document path)? Used on tool results and replies: such a name must never travel toward a customer.
 */
const IDENTIFIER_RES = [
  TABLE_NAME_RE,
  /\btax_(?:ledger|registration|filing|nexus|category_code|payment_exception|alert|reconciliation|jurisdiction)[a-z_]*\b/i,
  ROUTE_RE,
  /\btax\.[a-z0-9]+(?:[._][a-z0-9]+)+\b/,                             // configuration keys such as tax.some_setting
  /\bSTRIPE_TAX_[A-Z0-9_]*/i,
  /\bdocs\/legal\//i, /\bdocs\/operations\/[^\s/]*tax/i, /\bservices\/tax\//i,
];
function containsRestrictedIdentifier(text) {
  const t = String(text == null ? '' : text);
  return IDENTIFIER_RES.some((re) => re.test(t));
}

// ── Text normalisation (shared by the inbound classifier and the outbound safeguard) ───────────────────
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
function basicNorm(text) {
  return String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, '')
    .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2010-\u2015]/g, '-')
    .toLowerCase().replace(/[ \t\r\f\v]+/g, ' ');
}
/** A second reading with simple disguises undone: "n e x u s", "n.e.x.u.s", "n3xus", "t@x". */
function deobfuscate(norm) {
  return norm
    .replace(/\b(?:[a-z][ .\-_*]){2,}[a-z]\b/g, (m) => m.replace(/[ .\-_*]/g, ''))
    .replace(/[a-z0-9@$]*[a-z][a-z0-9@$]*/g, (w) => (/[0-9@$]/.test(w) && (w.match(/[a-z]/g) || []).length >= 2 ? w.replace(/[013457@$]/g, (c) => LEET[c]) : w));
}
const sentencesOf = (t) => t.split(/(?<=[.!?])\s+|\n+|;\s+/).map((s) => s.trim()).filter(Boolean);


// ── 2. Inbound classifier ──────────────────────────────────────────────────────────────────────────────
// "The company" as the subject (CO) or owner (POSS) of the thing asked about. "advantage dot bid" is the spoken form.
const ADV = "advantage(?:(?:[. ]| dot )?bid)?(?:'s)?";
const CO = "(?:you|you guys|you all|y'?all|your|yours|" + ADV + "|the (?:company|platform|business|marketplace|firm|office)(?:'s)?|company(?:'s)?|this (?:company|platform|business|marketplace))";
const POSS = "(?:your|" + ADV + "|the (?:company|platform|business|marketplace|firm|office)'s|company's|its)";
const PRO_FIN = '(?:accountants?|cpas?|bookkeepers?|auditors?|tax (?:attorneys?|lawyers?|advisors?|preparers?|counsel)|controller|cfo)';
const PRO = '(?:' + PRO_FIN + '|attorneys?|lawyers?|counsel|law firm|legal team)';
const VENDORS_SURE = '(?:avalara|taxjar|tax ?cloud|anrok|sovos|stripe tax)';
const VENDORS_MAYBE = '(?:vertex|quickbooks|xero|netsuite)';
const re = (src) => new RegExp(src, 'i');
const TAX = /\btax(?:es|ed|ing|ation)?\b/;
const HAS_CO = re('\\b' + CO + '\\b');
const ON_FILE = /\bon file\b/g;
// A filing verb whose object is the customer's own paperwork is never an internal question.
const OWN_PAPERWORK = /\bfil(?:e|es|ed|ing)\s+(?:\w+\s+){0,4}?(?:exemption|cert\w*|resale|claim|complaint|dispute|chargeback|report|ticket|request|form|paperwork|w-?9|1099)\b/;
// Between the company and the verb there must be no first person ("can you tell me if I need to file ...").
const NO_ME = "(?:(?!\\b(?:i|me|my|mine|we|i'm|i've)\\b)[^.?!])";

/**
 * Each rule: [code, test(sentence, message)] where `message` carries message-level context (m.tax: the whole message
 * mentions tax). Codes are internal (run log only) and are never shown to a customer.
 */
const INBOUND_RULES = [
  // Which states: registrations, where tax is or is not collected.
  ['registration', (s, m) => /\bstates\b/.test(s) && /\b(?:which|what|how many|list|name|all|every|number of|any)\b/.test(s)
    && (/\b(?:regist\w*|remit\w*|nexus|permits?|licen[sc]\w*)\b/.test(s)
      || (/\bfil(?:e|es|ed|ing|ings)\b/.test(s) && m.tax)
      || /\b(?:collect|charg|withh|owe)\w*\b[^.?!]{0,30}\btax/.test(s)
      || /\btax\w*\b[^.?!]{0,30}\b(?:collect\w*|charg\w*|appl\w*|free|exempt)\b/.test(s)
      || /\b(?:no|not|without|don't|doesn't|do not|does not)\b[^.?!]{0,20}\btax/.test(s))],
  ['registration', (s, m) => (re("\\b(?:are|is|was|were|aren't|isn't)\\s+" + CO + '\\s+(?:\\w+\\s+){0,3}?regist').test(s)
      || re('\\b' + CO + "\\s*(?:are|is|'re|were|have|has|guys are)\\s+(?:\\w+\\s+){0,3}?regist").test(s)
      || (/\bwhere\b[^.?!]{0,40}\bregist(?:ered|ration)/.test(s) && HAS_CO.test(s)))
    && (m.tax || /\bstates?\b|revenue|comptroller|collect/.test(s))],
  ['registration', (s) => re('\\b' + POSS + "\\s+(?:\\w+\\s+){0,2}?(?:sales tax|state tax|tax|seller'?s)\\s+(?:permit|licen[sc]e|registration|account|id)s?\\b").test(s)],
  // Nexus.
  ['nexus', (s, m) => /\bnexus\b/.test(s) && (m.tax || /\bstates?\b|threshold|economic|\bsales\b|physical presence/.test(s))],
  // Returns and filings.
  ['filing', (s) => { const t = s.replace(ON_FILE, ' '); if (OWN_PAPERWORK.test(t)) return false;
    return re('\\b' + CO + '\\b' + NO_ME + '{0,60}\\bfil(?:e|es|ed|ing)\\b[^.?!]{0,50}\\btax').test(t)
      || re('\\b' + POSS + '\\s+(?:\\w+\\s+){0,3}?(?:tax returns?|tax filings?|filings?\\b)').test(t)
      || re('\\b(?:when|how often|how|where)\\b[^.?!]{0,30}\\b' + CO + '\\b' + NO_ME + '{0,30}\\bfil(?:e|es|ed|ing)\\b').test(t); }],
  ['filing', (s, m) => /\bfiling (?:schedule|frequency|calendar|deadline|due date|period|cadence)s?\b/.test(s) && (m.tax || HAS_CO.test(s))],
  // Collection and remittance.
  ['remittance', (s, m) => /\bremit\w*\b/.test(s) && (m.tax || /arrangement|\bstates?\b|revenue|authorit/.test(s))
    && (HAS_CO.test(s) || /\bsellers?\b|auction house|estate sale compan|\bpartners?\b/.test(s))],
  ['remittance', (s, m) => /\b(?:collect\w* and remit\w*|collection and remittance)\b/.test(s) && m.tax && (HAS_CO.test(s) || /\bplatform|marketplace|sellers?\b/.test(s))],
  ['remittance', (s) => /\bmarketplace facilitator\b/.test(s)],
  ['remittance', (s) => /\b(?:arrangement|agreement|deal|set ?up)s?\b[^.?!]{0,40}\b(?:remit\w*|tax (?:collection|remittance|handling))\b/.test(s)
    || /\b(?:remit\w*|tax (?:collection|remittance|handling))\b[^.?!]{0,40}\b(?:arrangement|agreement|deal)s?\b/.test(s)],
  ['architecture', (s) => re('\\bhow\\b[^.?!]{0,30}\\b' + CO + '\\b[^.?!]{0,40}\\b(?:remit|administer|route|track)\\w*\\b[^.?!]{0,30}\\btax').test(s)
    || /\b(?:tax|financial) (?:architecture|infrastructure|pipeline|administration|operations)\b/.test(s)],
  // Reserves and bank arrangements.
  ['reserves', (s) => /\btax\w*\b[^.?!]{0,40}\b(?:reserves?|escrow|trust account|separate (?:bank )?account|segregated|holding account)\b/.test(s)
    || /\b(?:reserves?|escrow|trust account|separate (?:bank )?account|segregated|holding account)\b[^.?!]{0,40}\btax/.test(s)
    || /\b(?:keep|keeps|kept|hold|holds|held|store|stores|deposit\w*|put|park)\b[^.?!]{0,40}\btax (?:money|funds|dollars|collected|collections?|revenue|proceeds)\b/.test(s)
    || /\bwhere\b[^.?!]{0,40}\btax(?:es)?(?: money| funds| dollars)?\b[^.?!]{0,30}\b(?:go|goes|going|held|kept|deposited|sent|sit|sits|end up|ends up)\b/.test(s)],
  ['bank', (s) => re('\\b(?:which|what) bank (?:do|does|is)\\s+' + CO + '\\b').test(s) || re('\\bwho (?:do|does)\\s+' + CO + '\\s+bank with\\b').test(s)
    || re('\\b' + POSS + '\\s+(?:company |business |corporate |tax |reserve |operating )bank accounts?\\b').test(s)],
  // Liabilities and amounts.
  ['liability', (s) => re('\\b' + POSS + '\\s+(?:\\w+\\s+){0,2}?tax (?:liabilit\\w+|obligations?|exposure|debts?|bill|burden)\\b').test(s)
    || re('\\bhow much\\b[^.?!]{0,20}\\btax(?:es)?\\b[^.?!]{0,20}\\b(?:do|does|did|has|have)\\s+' + CO + '\\s+(?:\\w+\\s+){0,2}?(?:owe|owed|pay|paid|remit\\w*|collect\\w*)\\b(?!\\s+(?:from|on|for)\\s+(?:me|my|us|our)\\b)').test(s)
    || (/\bback taxes\b/.test(s) && HAS_CO.test(s))
    || re('\\b' + CO + '\\b' + NO_ME + '{0,20}\\bowe[sd]?\\b[^.?!]{0,30}\\b(?:taxes|the irs|the state|back taxes)\\b').test(s)],
  // Accounting methods and records.
  ['accounting', (s) => /\b(?:accounting (?:methods?|practices?|polic(?:y|ies)|systems?|software|treatment)|cash[- ]basis|accrual|general ledger|chart of accounts|revenue recognition)\b/.test(s)
    || re('\\b' + POSS + '\\s+(?:\\w+\\s+){0,2}?(?:financial statements?|balance sheet|profit and loss|p&l|financials)\\b').test(s)
    || re('\\bhow (?:do|does)\\s+' + CO + '\\s+(?:account for|book|record|recognize)\\b[^.?!]{0,40}\\b(?:tax|revenue|premium|fees?)').test(s)],
  // Providers, software, integrations, payment processor tax settings.
  ['provider', (s) => (re('\\b(?:' + VENDORS_SURE + '|' + VENDORS_MAYBE + ')\\b').test(s) && HAS_CO.test(s) && /\b(?:use|uses|using|used|integrat\w*|powered|provider|vendor|software|rely|relies|run|runs)\b/.test(s))
    || /\bstripe tax\b/.test(s)
    || (/\b(?:tax|accounting|compliance|bookkeeping)\s+(?:compliance\s+)?(?:providers?|vendors?|software|engines?|integrations?|partners?|tools?|systems?)\b/.test(s) && HAS_CO.test(s))
    || (/\b(?:what|which|who)\b/.test(s) && re('\\b(?:do|does)\\s+' + CO + '\\s+use\\b').test(s) && /\b(?:tax\w*|accounting|bookkeeping|compliance)\b/.test(s))
    || re('\\bwho\\b[^.?!]{0,40}\\b(?:does|do|did|handles?|prepares?|files?|calculates?|manages?|runs?|keeps?)\\b[^.?!]{0,20}\\b' + POSS + '\\s+(?:\\w+\\s+){0,2}?(?:tax\\w*|books|accounting|bookkeeping|filings?)\\b').test(s)
    || re('\\b(?:who|which|what)\\b[^.?!]{0,30}\\b(?:is|are)\\s+' + POSS + '\\s+(?:\\w+\\s+){0,2}?' + PRO + '\\b').test(s)
    || (/\btax\b[^.?!]{0,30}\b(?:settings?|configuration|config)\b/.test(s) && /\b(?:stripe|processor|payment provider|gateway)\b/.test(s))
    || (/\bfinancial integrations?\b/.test(s) && HAS_CO.test(s))],
  // Internal dashboard and records.
  ['dashboard', (s) => /\btax[ _-]?(?:dashboard|ledger|alerts?|reconciliation)\b/.test(s)
    || /\b(?:internal(?! revenue)|back ?office)\b[^.?!]{0,30}\btax/.test(s) || /\btax\w*\b[^.?!]{0,30}\binternal(?! revenue)\b/.test(s)
    || /\badmin (?:panel|page|dashboard|console|portal|screen)\b[^.?!]{0,30}\btax/.test(s) || /\btax\w*\b[^.?!]{0,30}\badmin (?:panel|page|dashboard|console|portal|screen)\b/.test(s)
    || containsRestrictedIdentifier(s)
    || re('\\b' + POSS + '\\s+(?:\\w+\\s+){0,2}?tax (?:records|books|reports?|data|numbers|figures|totals|database|tables?)\\b').test(s)],
  // Reconciliation procedures.
  ['reconciliation', (s, m) => /\breconcil\w*\b/.test(s) && (m.tax || /\b(?:ledger|books|stripe|processor|bank|filings?|returns?)\b/.test(s))
    && (re('\\b' + POSS + '\\s+(?:\\w+\\s+){0,2}?reconcil').test(s) || re('\\bhow (?:do|does|did)\\s+' + CO + '\\b[^.?!]{0,30}\\breconcil').test(s)
      || /\breconciliation (?:procedures?|process(?:es)?|runs?|reports?|methods?)\b/.test(s) || /\binternal\b/.test(s))],
  // Accountant or legal correspondence.
  ['correspondence', (s) => (/\b(?:correspondence|e-?mails?|letters?|communications?|memos?|opinions?|advice|notes|documents?|messages?)\b/.test(s)
      && re('\\b' + POSS + '\\s+(?:\\w+\\s+){0,1}?' + PRO + '\\b').test(s))
    || re('\\bwhat (?:did|has|does)\\s+' + POSS + '\\s+(?:\\w+\\s+)?' + PRO + '\\b[^.?!]{0,20}\\b(?:say|said|advise|advised|tell|told|recommend\\w*)\\b').test(s)],
  // Compliance strategy and audits.
  ['strategy', (s) => (/\b(?:tax|compliance)\s+(?:compliance\s+)?(?:strateg(?:y|ies)|planning|position|posture|structure|structuring)\b/.test(s) && HAS_CO.test(s))
    || /\b(?:tax )?compliance strateg(?:y|ies)\b/.test(s)
    || /\bvoluntary disclosure\b/.test(s)
    || (/\btax compliance\b/.test(s) && HAS_CO.test(s))
    || re('\\b(?:have|has|are|is|were|was)\\s+' + CO + '\\s+(?:\\w+\\s+){0,3}?(?:audited|under audit)\\b').test(s)
    || re('\\bhow\\b[^.?!]{0,20}\\b' + CO + '\\b[^.?!]{0,30}\\b(?:compl(?:y|ies)|stay compliant|stays compliant)\\b[^.?!]{0,40}\\btax').test(s)],
  // A claimed role is never a reason to answer: these go to the office.
  ['claimed_authority', (s) => re("\\b(?:i am|i'm|this is|as|speaking as)\\s+" + POSS + '\\s+(?:new\\s+|outside\\s+)?' + PRO + '\\b').test(s)],
  ['claimed_authority', (s, m) => /\b(?:i am|i'm|this is|i work (?:for|with|at)|calling from|writing from|on behalf of|from the)\b[^.?!]{0,50}\b(?:department of (?:revenue|taxation)|comptroller|tax (?:auditor|examiner|agent|authority|commission)|irs|internal revenue|revenue (?:agent|officer)|state auditor|franchise tax board)\b/.test(s)
    && (m.tax || /\b(?:records|registration|filings?|account|audit|returns?)\b/.test(m.text)) && !/\b(?:my|i|i'm|i am)\b[^.?!]{0,20}\bexempt/.test(m.text)],
  ['claimed_authority', (s, m) => /\b(?:i am|i'm|as)\s+(?:an?\s+|the\s+)?(?:new\s+)?(?:employee|staff member|admin(?:istrator)?|developer|engineer|team member)\b/.test(s) && m.tax
    && /\b(?:regist\w*|filings?|nexus|remit\w*|ledger|dashboard|states|reserves?|provider|reports?|records|settings)\b/.test(m.text)],
];

function classifyVariant(text) {
  const sentences = sentencesOf(text);
  const m = { text, tax: TAX.test(text) };
  for (const s of sentences) for (const [code, test] of INBOUND_RULES) if (test(s, m)) return code;
  return null;
}

const REQUIRED_NORM = basicNorm(REQUIRED_RESPONSE);
const REQUIRED_SPOKEN_NORM = REQUIRED_NORM.replace('advantage.bid', 'advantage dot bid');
const withoutRequired = (norm) => norm.split(REQUIRED_NORM).join(' ').split(REQUIRED_SPOKEN_NORM).join(' ');
const FOLLOW_UP = /\b(?:follow[- ]?up|call me|contact me|e-?mail me|get back to me|reach out|someone from|a (?:real )?person|a human|team member|speak (?:to|with)|talk (?:to|with)|have (?:someone|the office)|pass (?:this|it|my))\b/;

/**
 * Is this customer message a request about internal tax or financial administration?
 * Returns { restricted: boolean, code: string|null, wantsFollowUp: boolean }. Pure and deterministic.
 */
function classifyInbound(text) {
  // Our own required wording quoted back (an email reply that quotes Sasha) is not a new question.
  const norm = withoutRequired(basicNorm(String(text || '').slice(0, 20000)));
  const code = classifyVariant(norm) || classifyVariant(deobfuscate(norm));
  return { restricted: !!code, code, wantsFollowUp: !!code && FOLLOW_UP.test(norm) };
}

/** The customer's newest words in a stored transcript: the trailing customer messages after the last reply. */
function latestCustomerText(transcript) {
  const out = [];
  for (let i = (transcript || []).length - 1; i >= 0; i--) {
    if (transcript[i].author_type !== 'customer') break;
    out.unshift(String(transcript[i].body_text || ''));
  }
  return out.join('\n');
}

/** The deterministic reply: the required wording, then the existing hand-off (offered, or confirmed when already opened). */
function requiredReply(channel, { handoffOpened = false, askEmail = false } = {}) {
  const ch = HANDOFF_OFFER[channel] ? channel : 'chat';
  const tail = handoffOpened && HANDOFF_DONE[ch] ? HANDOFF_DONE[ch] + (askEmail ? ' Please type your email address so the team can reply.' : '') : HANDOFF_OFFER[ch];
  return REQUIRED_RESPONSE + (ch === 'phone' ? ' ' : '\n\n') + tail;
}

// ── 3. Outbound safeguard ──────────────────────────────────────────────────────────────────────────────
const STATES = '(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia)';
const STATE_RE = new RegExp('\\b' + STATES + '\\b', 'g');
const OUR = "(?:our|" + ADV + "|the company's)";
const WE_SUBJ = "(?:we|we've|we're|" + ADV + '|the company|our (?:office|team|company))';
const WE = re("\\b(?:we|we're|we've|our|ours|" + ADV + "|the (?:company|platform|office)(?:'s)?)\\b");
const COUNT_STATES = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|some|all|every|most|few|many|other|certain|only|those|these|following)\s+(?:\w+\s+)?states\b/;
const distinctStates = (s) => new Set(s.match(STATE_RE) || []).size;

const OUTBOUND_RULES = [
  ['identifier', (s) => containsRestrictedIdentifier(s)],
  ['nexus', (s) => /\bnexus\b/.test(s) && (TAX.test(s) || /\bstates?\b|thresholds?|economic/.test(s))],
  ['registration', (s) => re('\\b' + WE_SUBJ + "\\s*(?:are|is|am|'re|were|have been|has been|aren't|isn't)?\\s+(?:\\w+\\s+){0,2}?registered\\b").test(s)
    && (TAX.test(s) || distinctStates(s) >= 1 || /\bstates?\b/.test(s))],
  ['registration', (s) => re('\\b' + OUR + "\\s+(?:\\w+\\s+){0,2}?(?:sales tax|state tax|tax|seller's)\\s+(?:registrations?|permits?|licen[sc]es?|account numbers?)\\b").test(s)],
  ['registration', (s) => /\bregistered\b[^.?!]{0,30}\bin\b/.test(s) && TAX.test(s) && WE.test(s) && (distinctStates(s) >= 1 || COUNT_STATES.test(s))],
  ['registration', (s) => TAX.test(s) && WE.test(s) && /\b(?:collect|charge|remit|withhold)\w*\b/.test(s) && (distinctStates(s) >= 2 || COUNT_STATES.test(s))],
  ['registration', (s) => TAX.test(s) && WE.test(s) && /\b(?:do not|don't|does not|doesn't|not|never|no longer)\s+(?:currently\s+)?(?:collect|charge|remit)\w*\b/.test(s)
    && (distinctStates(s) >= 1 || /\bstates\b/.test(s))],
  ['filing', (s) => { const t = s.replace(ON_FILE, ' ');
    return (re('\\b' + WE_SUBJ + '\\s+(?:\\w+\\s+){0,3}?(?:file|files|filed|remit|remits|remitted)\\b').test(t) && /\btax|\breturns?\b/.test(t))
      || re('\\b' + OUR + '\\s+(?:\\w+\\s+){0,2}?(?:filings?|tax returns?|remittances?)\\b').test(t); }],
  ['filing', (s) => /\b(?:filing (?:schedule|frequency|calendar|deadline|due date)|tax returns? (?:is|are) (?:due|filed)|(?:monthly|quarterly|annual|semi-?annual) (?:sales )?(?:tax )?(?:filings?|returns?|remittances?))\b/.test(s)],
  ['reserves', (s) => /\btax (?:reserves?|escrow)\b/.test(s)
    || (TAX.test(s) && /\b(?:separate|dedicated|segregated|trust|reserve|escrow|holding) (?:bank )?account\b/.test(s))
    || re('\\b' + OUR + '\\s+(?:company |business |corporate |tax |reserve |operating |trust |escrow )?bank accounts?\\b').test(s)
    || /\bwe bank (?:with|at)\b/.test(s)],
  ['dashboard', (s) => /\btax[ _-]?(?:ledger|dashboard)\b|\bledger entr(?:y|ies)\b|\btax reconciliation\b|\breconciliation (?:runs?|procedures?)\b/.test(s)
    || (/\breconcil\w*\b/.test(s) && TAX.test(s) && WE.test(s))],
  ['threshold', (s) => /\bthresholds?\b/.test(s) && TAX.test(s)],
  ['provider', (s) => re('\\b' + VENDORS_SURE + '\\b').test(s)
    || (re('\\b' + VENDORS_MAYBE + '\\b').test(s) && WE.test(s) && /\b(?:tax\w*|accounting|bookkeeping|compliance)\b/.test(s))
    || /\b(?:tax|accounting|bookkeeping) (?:compliance )?(?:providers?|vendors?|software|engines?|integrations?)\b/.test(s)
    || re('\\b' + OUR + '\\s+(?:\\w+\\s+){0,1}?' + PRO_FIN + '\\b').test(s)],
  ['liability', (s) => re('\\b' + OUR + '\\s+(?:\\w+\\s+){0,2}?(?:tax liabilit\\w+|back taxes)\\b').test(s)
    || re('\\b' + WE_SUBJ + '\\s+(?:\\w+\\s+){0,2}?owe[sd]?\\b[^.?!]{0,30}\\b(?:tax(?:es)?|the irs|the state)\\b').test(s)],
  ['accounting', (s) => /\b(?:cash|accrual)[- ]basis\b|\baccrual accounting\b|\baccounting methods?\b|\bgeneral ledger\b|\bchart of accounts\b/.test(s)],
  ['remittance', (s) => /\bmarketplace facilitator\b|\bremittance arrangements?\b/.test(s)],
  ['strategy', (s) => re('\\b' + OUR + '\\s+(?:\\w+\\s+){0,2}?(?:tax|compliance) (?:strateg(?:y|ies)|planning|position|exposure)\\b').test(s) || /\bvoluntary disclosure\b/.test(s)],
];

/** The code of the first internal tax administration detail this text would disclose, or null. Pure. */
function outboundViolation(text) {
  const norm = withoutRequired(basicNorm(text));
  for (const variant of [norm, deobfuscate(norm)]) {
    for (const s of sentencesOf(variant)) for (const [code, test] of OUTBOUND_RULES) if (test(s)) return code;
  }
  return null;
}

/**
 * Last check before a Sasha reply is sent or spoken. A reply that would disclose internal tax administration details
 * is replaced, whole, by the required wording and the hand-off offer. Returns { text, blocked, code }.
 */
function guardOutbound(text, channel) {
  const code = outboundViolation(text);
  if (!code) return { text, blocked: false, code: null };
  return { text: requiredReply(channel), blocked: true, code };
}

/**
 * Knowledge and tool results on their way to the model: anything carrying a restricted identifier, or wording the
 * outbound safeguard would refuse, is withheld (fail closed).
 */
function isRestrictedKnowledge(text) {
  return containsRestrictedIdentifier(text) || !!outboundViolation(text);
}

module.exports = {
  REQUIRED_RESPONSE, HANDOFF_OFFER, HANDOFF_DONE, HANDOFF_SUMMARY, requiredReply,
  RESTRICTED_TABLES, RESTRICTED_TABLE_PREFIX, RESTRICTED_SERVICE_DIRS, RESTRICTED_ROUTES, RESTRICTED_CONFIG_PREFIXES, RESTRICTED_ENV_PREFIXES, RESTRICTED_DOC_RULES,
  sqlTouchesRestricted, isRestrictedConfigKey, isRestrictedEnvName, isRestrictedRoute, isRestrictedDocPath, containsRestrictedIdentifier,
  classifyInbound, latestCustomerText, outboundViolation, guardOutbound, isRestrictedKnowledge,
  _internal: { basicNorm, deobfuscate, sentencesOf },
};

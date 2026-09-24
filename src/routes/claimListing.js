'use strict';

/**
 * /claim/:token: the token-first Claimed Listing landing page (handoff section 4), server-rendered.
 *
 *   GET    /claim/:token            preview of the listing as it appears today. NEVER consumes the token and
 *                                   records the request as a `link_fetch` (mail scanners pre-open links).
 *   POST   /claim/:token/beacon     human `page_view`: only after DOM ready AND a real interaction.
 *   POST   /claim/:token/continue   "This is my company, continue" (`claim_started`). Consumes nothing.
 *   POST   /claim/:token/complete   name + password (the email comes from the token binding, never input).
 *                                   An existing account must sign in first (409 SIGN_IN_REQUIRED).
 *   POST   /claim/:token/exit       one of the four exit options; stops outreach, no confirmation email.
 *
 * The page carries noindex, no third-party scripts, fonts or pixels, and shows the recipient only a masked
 * address. No public language exposes internal names.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { normalLimiter, strictLimiter } = require('../middleware/rateLimit');
const optionalAuth = require('../middleware/optionalAuthMiddleware');
const { setSessionCookie } = require('../lib/sessionCookie');
const claims = require('../services/claimedListings/claimLinkService');
const company = require('../lib/companyContact');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
const json = express.json({ limit: '16kb' });

function shell(title, body, token) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
:root{--ink:#0f172a;--muted:#475569;--line:#e2e8f0;--accent:#1d4ed8;--bg:#f8fafc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}
.wrap{max-width:600px;margin:0 auto;padding:28px 16px 56px}.brand{font-weight:800;font-size:18px;margin:0 0 18px}.brand a{color:var(--ink);text-decoration:none}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px 20px;margin:0 0 16px}
h1{font-size:24px;line-height:1.25;margin:0 0 10px}h2{font-size:17px;margin:0 0 8px}p{margin:0 0 12px;color:#1e293b}
.listing dl{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;margin:10px 0 0}.listing dt{color:var(--muted);font-size:14px}.listing dd{margin:0;overflow-wrap:anywhere}
.desc{white-space:pre-line;color:#334155;font-size:15px;border-left:3px solid var(--line);padding-left:12px;margin-top:8px}
.label{font-size:13px;color:var(--muted)}.btn{display:block;width:100%;padding:14px 18px;font-size:16px;font-weight:700;border-radius:10px;border:0;background:var(--accent);color:#fff;cursor:pointer;text-align:center}
.btn:disabled{opacity:.6;cursor:wait}.btn2{background:#fff;color:var(--ink);border:1px solid #cbd5e1;font-weight:600}
.opts{display:grid;gap:8px}.fine{font-size:13px;color:var(--muted)}label{display:block;font-weight:600;font-size:14px;margin:10px 0 4px}
input{width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:8px;font-size:16px}.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;padding:10px 12px;margin:0 0 12px}
.ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:8px;padding:10px 12px}[hidden]{display:none!important}
a{color:var(--accent)}
</style></head><body><div class="wrap"><div class="brand"><a href="/">Advantage.Bid</a></div>${body}
<div class="card"><h2>What is Advantage.Bid?</h2><p class="fine">An online marketplace where people find local estate sales and auctions, and where sellers run them. Questions? Call ${esc(company.PHONE_DISPLAY)} or email info@advantage.bid.</p></div>
</div>${token ? script(token) : ''}</body></html>`;
}

function script(token) {
  // Inline, first-party only. The beacon fires once, after DOM ready AND a real interaction.
  return `<script>
(function(){'use strict';
var T=${JSON.stringify(token)},base='/claim/'+encodeURIComponent(T),vid='';
try{vid=localStorage.getItem('ab_vid')||'';if(!vid){vid=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2));localStorage.setItem('ab_vid',vid);}}catch(e){}
function post(path,body){return fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(Object.assign({visitor_id:vid},body||{}))}).then(function(r){return r.json().then(function(j){return{ok:r.ok,status:r.status,body:j};});});}
var sent=false;function beacon(){if(sent)return;sent=true;post('/beacon',{interacted:true,search:location.search}).catch(function(){});}
['pointerdown','keydown','scroll','touchstart'].forEach(function(ev){window.addEventListener(ev,beacon,{once:true,passive:true});});
var $=function(id){return document.getElementById(id);};
function show(id){['s-preview','s-account','s-signin','s-done','s-exit'].forEach(function(x){var el=$(x);if(el)el.hidden=(x!==id);});window.scrollTo(0,0);}
function err(id,m){var el=$(id);if(el){el.textContent=m;el.hidden=!m;}}
var go=$('go');if(go)go.addEventListener('click',function(){beacon();go.disabled=true;post('/continue').then(function(r){go.disabled=false;if(!r.ok){err('e-preview',r.body.message||'This link cannot be used.');return;}show(r.body.account_exists?'s-signin':'s-account');}).catch(function(){go.disabled=false;err('e-preview','Please check your connection and try again.');});});
function done(r){if(r.body&&r.body.token){try{localStorage.setItem('token',r.body.token);}catch(e){}}show('s-done');setTimeout(function(){location.href=r.body.redirect||'/org/profile.html?claimed=1';},900);}
var fa=$('f-account');if(fa)fa.addEventListener('submit',function(e){e.preventDefault();var b=fa.querySelector('button');b.disabled=true;err('e-account','');
post('/complete',{full_name:$('full_name').value,password:$('password').value}).then(function(r){b.disabled=false;if(r.ok)return done(r);if(r.body&&r.body.code==='SIGN_IN_REQUIRED'){show('s-signin');return;}err('e-account',r.body.message||'We could not complete the claim.');}).catch(function(){b.disabled=false;err('e-account','Please check your connection and try again.');});});
var fs=$('f-signin');if(fs)fs.addEventListener('submit',function(e){e.preventDefault();var b=fs.querySelector('button');b.disabled=true;err('e-signin','');
fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({email:$('signin_email').value,password:$('signin_password').value})})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,body:j};});}).then(function(l){if(!l.ok||!l.body.token){b.disabled=false;err('e-signin','That email and password did not match.');return;}
try{localStorage.setItem('token',l.body.token);}catch(e){}
return fetch(base+'/complete',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+l.body.token},credentials:'same-origin',body:JSON.stringify({visitor_id:vid})})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,body:j};});}).then(function(r){b.disabled=false;if(r.ok)return done(r);err('e-signin',r.body.message||'We could not complete the claim.');});}).catch(function(){b.disabled=false;err('e-signin','Please check your connection and try again.');});});
Array.prototype.forEach.call(document.querySelectorAll('[data-exit]'),function(btn){btn.addEventListener('click',function(){beacon();btn.disabled=true;
post('/exit',{action:btn.getAttribute('data-exit')}).then(function(r){btn.disabled=false;if(!r.ok){err('e-preview',r.body.message||'Please try again.');return;}$('exit-msg').textContent=btn.getAttribute('data-done');show('s-exit');});});});
})();
</script>`;
}

function previewPage(look) {
  const p = claims.preview(look.org, look.token);
  const loc = [p.city, p.state].filter(Boolean).join(', ');
  return shell('Claim ' + p.name + ' on Advantage.Bid', `
<section id="s-preview"><div class="card listing">
  <h1>Claim ${esc(p.name)} on Advantage.Bid</h1>
  <p>This is your company's listing as it appears today.</p>
  <dl><dt>Name</dt><dd>${esc(p.name)}</dd>${loc ? `<dt>Location</dt><dd>${esc(loc)}</dd>` : ''}
  ${p.phone ? `<dt>Phone</dt><dd>${esc(p.phone)}</dd>` : ''}${p.website ? `<dt>Website</dt><dd>${esc(p.website)}</dd>` : ''}</dl>
  ${p.description ? `<div class="label" style="margin-top:12px">Description</div><div class="desc">${esc(p.description)}</div>` : ''}
  <p class="fine" style="margin-top:12px">The description was written by Advantage.Bid from public business information. Once you claim the listing you can replace it with your own.</p>
</div>
<div class="card">
  <p><b>Claiming is free.</b> There is no monthly fee, and we never ask for payment details to claim a listing.</p>
  <p class="fine">This link was sent to ${esc(p.masked_email || 'the address on this listing')}. Continuing confirms you receive email at that address.</p>
  <div id="e-preview" class="err" hidden></div>
  <button class="btn" id="go" type="button">This is my company, continue</button>
</div>
<div class="card" id="options"><h2>Not quite right?</h2><div class="opts">
  <button class="btn btn2" type="button" data-exit="not_my_company" data-done="Thank you. We won't email this address about this listing again.">This isn't my company</button>
  <button class="btn btn2" type="button" data-exit="business_closed" data-done="Thank you for letting us know. Our team will review the listing, and we won't email this address about it again.">This business has closed</button>
  <button class="btn btn2" type="button" data-exit="wrong_contact" data-done="Thank you. We've removed this address from the listing's outreach.">I'm not the right contact</button>
  <button class="btn btn2" type="button" data-exit="remove_listing" data-done="Understood. We'll take the listing down within two business days and won't contact this address again.">Please remove this listing</button>
</div></div></section>
<section id="s-account" hidden><div class="card">
  <h1>Almost done</h1><p>Choose a password for your Advantage.Bid account. Your sign-in email is ${esc(p.masked_email)}, the address this link was sent to.</p>
  <form id="f-account" novalidate><div id="e-account" class="err" hidden></div>
    <label for="full_name">Your name</label><input id="full_name" name="full_name" autocomplete="name" required maxlength="120">
    <label for="password">Password (at least 8 characters)</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
    <p class="fine" style="margin-top:12px">By continuing you agree to the <a href="/terms.html">Terms of Service</a> and <a href="/privacy.html">Privacy Policy</a>.</p>
    <button class="btn" type="submit">Claim ${esc(p.name)}</button></form>
</div></section>
<section id="s-signin" hidden><div class="card">
  <h1>Sign in to finish</h1><p>An Advantage.Bid account already uses ${esc(p.masked_email)}. Sign in with that account to finish claiming ${esc(p.name)}.</p>
  <form id="f-signin" novalidate><div id="e-signin" class="err" hidden></div>
    <label for="signin_email">Email</label><input id="signin_email" type="email" autocomplete="email" required>
    <label for="signin_password">Password</label><input id="signin_password" type="password" autocomplete="current-password" required>
    <button class="btn" type="submit" style="margin-top:14px">Sign in and claim</button>
    <p class="fine" style="margin-top:10px"><a href="/forgot-password.html">Forgot your password?</a></p></form>
</div></section>
<section id="s-done" hidden><div class="card"><div class="ok">${esc(p.name)} is yours. Taking you to your listing checklist...</div></div></section>
<section id="s-exit" hidden><div class="card"><p id="exit-msg" class="ok"></p></div></section>`, look.tokenRaw);
}

function statePage(look, state) {
  const name = look && look.org ? look.org.name : null;
  const msg = {
    expired: 'This claim link has expired.', used: 'This claim link has already been used.',
    claimed: (name || 'This listing') + ' has already been claimed.', invalid: 'This claim link is not valid.',
  }[state] || 'This claim link cannot be used.';
  const next = look && look.org && state !== 'claimed'
    ? `<a class="btn" href="/claim-listing.html?org=${encodeURIComponent(look.org.id)}">Get a new link for ${esc(name)}</a>`
    : state === 'claimed' && look && look.org ? `<a class="btn btn2" href="/claim-listing.html?org=${encodeURIComponent(look.org.id)}">Is this your company? Tell us</a>` : '';
  return shell('Claim link', `<div class="card"><h1>${esc(msg)}</h1><p>A new link is sent only to the email address on the listing.</p>${next}</div>`, null);
}

router.get('/claim', (req, res) => res.redirect(302, '/claim-listing.html'));

router.get('/claim/:token', normalLimiter, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const look = await claims.lookup(req.params.token);
    claims.recordLinkFetch(look, { userAgent: req.headers['user-agent'], ip: ipOf(req) }).catch(() => {});
    if (look.state !== 'valid') return res.status(look.state === 'invalid' ? 404 : 410).type('html').send(statePage(look, look.state));
    look.tokenRaw = req.params.token;
    return res.type('html').send(previewPage(look));
  } catch (e) { return next(e); }
});

router.post('/claim/:token/beacon', normalLimiter, json, async (req, res) => {
  const b = req.body || {};
  await claims.recordPageView(req.params.token, { visitorId: typeof b.visitor_id === 'string' ? b.visitor_id : null, interacted: b.interacted === true, ip: ipOf(req),
    search: typeof b.search === 'string' ? b.search : '', userAgent: req.headers['user-agent'] || '' }).catch(() => {});
  res.status(204).end();
});

router.post('/claim/:token/continue', normalLimiter, json, async (req, res, next) => {
  try {
    const r = await claims.startClaim(req.params.token, { visitorId: (req.body || {}).visitor_id || null, ip: ipOf(req) });
    if (!r.ok) return res.status(410).json({ success: false, code: 'CLAIM_LINK_' + String(r.state).toUpperCase(), message: claims.linkStateMessage(r.state) });
    return res.json({ success: true, account_exists: r.account_exists, masked_email: r.masked_email });
  } catch (e) { return next(e); }
});

router.post('/claim/:token/complete', strictLimiter, json, optionalAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const out = await claims.complete(req.params.token, { fullName: b.full_name, password: b.password,
      signedInUser: req.user && req.user.id ? { id: req.user.id } : null, ip: ipOf(req), visitorId: typeof b.visitor_id === 'string' ? b.visitor_id : null });
    const role = (req.user && req.user.role) || 'buyer';
    const token = jwt.sign({ id: out.userId, role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '24h' });
    setSessionCookie(res, token);
    return res.status(201).json({ success: true, token, redirect: '/org/profile.html?claimed=1', organization: { id: out.organization.id, name: out.organization.name } });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ success: false, code: e.code || 'CLAIM_FAILED', message: e.expose ? e.message : 'We could not complete the claim.',
      ...(e.masked_email ? { masked_email: e.masked_email } : {}) });
  }
});

router.post('/claim/:token/exit', normalLimiter, json, async (req, res) => {
  try {
    const r = await claims.exit(req.params.token, String((req.body || {}).action || ''), { ip: ipOf(req) });
    return res.json({ success: true, action: r.action });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, code: e.code || 'FAILED', message: e.expose ? e.message : 'Please try again.' });
  }
});

module.exports = router;

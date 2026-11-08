/* Member-area account notices (non-blocking). Shown at the top of the member dashboard (/app.html) for a signed-in
 * account that needs to confirm its email address to bid (only while the verified-email requirement is ON, including
 * an established buyer's grace period): a one-click resend.
 * Updated terms are NOT announced here (owner decision 2026-11-07): a buyer is asked to accept the current terms only
 * when they next register to bid, bid or buy (the server gates and the lot, auction and checkout pages).
 * Nothing here blocks browsing; "Not Now" hides a notice for the rest of the browser session.
 * Built with DOM calls only (no markup strings).
 */
(function () {
  'use strict';
  function token() { try { return localStorage.getItem('token'); } catch (e) { return null; } }
  function dismissed(k) { try { return sessionStorage.getItem('adv-notice-' + k) === '1'; } catch (e) { return false; } }
  function dismiss(k) { try { sessionStorage.setItem('adv-notice-' + k, '1'); } catch (e) { /* private mode */ } }
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }
  function style() {
    if (document.getElementById('adv-notices-style')) return;
    var s = el('style', { id: 'adv-notices-style' });
    s.textContent =
      '.adv-notices{max-width:1100px;margin:0 auto;padding:10px 16px 0;box-sizing:border-box}' +
      '.adv-notice{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;background:#fffbeb;border:1px solid #fcd34d;color:#78350f;' +
      'border-radius:10px;padding:10px 14px;margin-bottom:8px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
      '.adv-notice .msg{flex:1 1 240px}' +
      '.adv-notice a.act,.adv-notice button.act{background:#111;color:#fff;border:0;border-radius:7px;padding:7px 14px;font-weight:700;' +
      'font-size:13px;text-decoration:none;cursor:pointer;white-space:nowrap}' +
      '.adv-notice button.later{background:none;border:0;color:#78350f;text-decoration:underline;cursor:pointer;font-size:13px;padding:4px}' +
      '.adv-notice .note{flex-basis:100%;font-size:13px}' +
      '@media (prefers-color-scheme: dark){.adv-notice{background:#3b2f0b;border-color:#a16207;color:#fde68a}.adv-notice button.later{color:#fde68a}}';
    document.head.appendChild(s);
  }
  function container() {
    var c = document.getElementById('adv-account-notices');
    if (c) return c;
    c = el('div', { id: 'adv-account-notices', class: 'adv-notices', role: 'region', 'aria-label': 'Account notices' });
    var root = document.getElementById('adv-shell-root');
    if (root && root.parentNode) root.parentNode.insertBefore(c, root); else document.body.insertBefore(c, document.body.firstChild);
    return c;
  }
  function notice(key, message, action) {
    style();
    var box = el('div', { class: 'adv-notice', 'data-notice': key });
    box.appendChild(el('span', { class: 'msg' }, message));
    if (action) box.appendChild(action);
    var later = el('button', { type: 'button', class: 'later' }, 'Not Now');
    later.addEventListener('click', function () { dismiss(key); box.remove(); });
    box.appendChild(later);
    container().appendChild(box);
    return box;
  }
  function fmt(d) { try { return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; } }

  async function run() {
    var tk = token();
    if (!tk) return;
    var h = { Authorization: 'Bearer ' + tk };
    if (!dismissed('email')) {
      try {
        var r2 = await fetch('/api/auth/email-verification', { headers: h });
        if (r2.ok) {
          var e2 = await r2.json();
          var s = e2 && e2.success && e2.data;
          if (s && s.required_to_bid && s.must_verify && !s.verified) {
            var msg = s.can_bid && s.grace_until
              ? 'Please confirm your email address. You can keep bidding until ' + fmt(s.grace_until) + ', after which a confirmed email is required.'
              : 'Please confirm your email address to register for auctions and bid.';
            var btn = el('button', { type: 'button', class: 'act' }, 'Resend Confirmation Email');
            var box = notice('email', msg, btn);
            var note = el('span', { class: 'note', role: 'status', 'aria-live': 'polite' });
            box.appendChild(note);
            btn.addEventListener('click', async function () {
              btn.disabled = true;
              try {
                var rr = await fetch('/api/auth/resend-verification', { method: 'POST', headers: h });
                var dd = await rr.json().catch(function () { return {}; });
                note.textContent = rr.ok
                  ? (dd.data && dd.data.already_verified ? 'Your email address is already confirmed.' : 'Sent. Check your inbox (and spam folder) for the confirmation link.')
                  : (dd.message || 'We could not send the email right now. Please try again shortly.');
              } catch (x) { note.textContent = 'We could not send the email right now. Please try again shortly.'; }
              setTimeout(function () { btn.disabled = false; }, 60000);
            });
          }
        }
      } catch (e) { /* never block the page */ }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();

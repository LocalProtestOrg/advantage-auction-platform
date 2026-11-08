/*
 * AdvAgreementPrompt: asks the seller to review and sign the Seller Agreement.
 *   if (AdvAgreementPrompt.show(response)) return;   // a publish answer with code AGREEMENT_REQUIRED (nothing was published;
 *                                                     // drafts are saved): a banner with "Review and Sign"
 *   AdvAgreementPrompt.checkCurrent();               // when the seller STARTS a new listing (owner decisions 2026-11-07):
 *                                                     // if the current version is not accepted yet, a dismissible banner with
 *                                                     // "Review and Accept"; they may keep working, publishing waits for it
 * The link opens the seller's own pending agreement (or issues the current one in the app, no email) and returns here.
 */
(function () {
  'use strict';
  if (window.AdvAgreementPrompt) return;
  function render(message, href, label) {
    var old = document.getElementById('adv-agreement-prompt'); if (old && old.parentNode) old.parentNode.removeChild(old);
    var box = document.createElement('div');
    box.id = 'adv-agreement-prompt'; box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:9999;max-width:560px;width:calc(100% - 32px);background:#fff;border:2px solid #2563eb;border-radius:12px;box-shadow:0 12px 30px rgba(15,23,42,.18);padding:14px 16px;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a';
    var p = document.createElement('p'); p.style.margin = '0 0 10px'; p.textContent = message;
    box.appendChild(p);
    var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    var a = document.createElement('a'); a.href = href; a.textContent = label;
    a.style.cssText = 'background:#2563eb;color:#fff;text-decoration:none;font-weight:700;padding:8px 14px;border-radius:8px';
    var later = document.createElement('button'); later.type = 'button'; later.textContent = 'Later';
    later.style.cssText = 'background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer';
    later.addEventListener('click', function () {
      try { sessionStorage.setItem('adv-agreement-later', '1'); } catch (e) { /* private mode */ }
      if (box.parentNode) box.parentNode.removeChild(box);
    });
    row.appendChild(a); row.appendChild(later); box.appendChild(row);
    document.body.appendChild(box);
    a.focus();
    return box;
  }
  function signHref(agreementId, current) {
    var back = location.pathname + location.search;
    return '/sign-agreement.html?' + (agreementId ? 'id=' + encodeURIComponent(agreementId) : (current ? 'current=1' : 'onboarding=1')) + '&return=' + encodeURIComponent(back);
  }
  function show(res) {
    if (!res || res.code !== 'AGREEMENT_REQUIRED') return false;
    var current = res.agreement_reason === 'agreement_update_required' || res.agreement_reason === 'agreement_required';
    render(res.message || 'Before your first item goes live, please review and sign your Professional Seller Agreement. Your drafts are saved.',
      signHref(res.agreement_id, current), 'Review and Sign');
    return true;
  }
  function checkCurrent() {
    var token = null; try { token = localStorage.getItem('token'); } catch (e) { token = null; }
    if (!token) return;
    try { if (sessionStorage.getItem('adv-agreement-later') === '1') return; } catch (e) { /* private mode */ }
    fetch('/api/agreements/current-status', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var d = j && j.success && j.data;
        if (!d || !d.is_seller || d.ok) return;
        render(d.reason === 'agreement_update_required'
          ? 'Our Seller Agreement has been updated. Please review and accept the current version. You can keep working; it is needed before a new listing is published.'
          : 'Please review and accept the Seller Agreement. You can keep working; it is needed before a new listing is published.',
          signHref(d.agreement_id, true), 'Review and Accept');
      })
      .catch(function () { /* never block the page */ });
  }
  window.AdvAgreementPrompt = { show: show, checkCurrent: checkCurrent };
})();

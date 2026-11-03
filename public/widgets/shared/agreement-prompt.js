/*
 * AdvAgreementPrompt — shown when publishing a storefront item needs the seller's agreement first (server answer
 * code AGREEMENT_REQUIRED, owner decision 2026-11-02). Drafts are never affected.
 *   if (AdvAgreementPrompt.show(response)) return;   // handled: a banner with "Review and Sign" is on the page
 * The link opens the seller's own pending agreement (the server chose it) and returns here after signing.
 */
(function () {
  'use strict';
  if (window.AdvAgreementPrompt) return;
  function show(res) {
    if (!res || res.code !== 'AGREEMENT_REQUIRED') return false;
    var old = document.getElementById('adv-agreement-prompt'); if (old && old.parentNode) old.parentNode.removeChild(old);
    var box = document.createElement('div');
    box.id = 'adv-agreement-prompt'; box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:9999;max-width:560px;width:calc(100% - 32px);background:#fff;border:2px solid #2563eb;border-radius:12px;box-shadow:0 12px 30px rgba(15,23,42,.18);padding:14px 16px;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a';
    var p = document.createElement('p'); p.style.margin = '0 0 10px';
    p.textContent = res.message || 'Before your first item goes live, please review and sign your Professional Seller Agreement. Your drafts are saved.';
    box.appendChild(p);
    var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    var back = location.pathname + location.search;
    var a = document.createElement('a');
    a.href = '/sign-agreement.html?' + (res.agreement_id ? 'id=' + encodeURIComponent(res.agreement_id) : 'onboarding=1') + '&return=' + encodeURIComponent(back);
    a.textContent = 'Review and Sign';
    a.style.cssText = 'background:#2563eb;color:#fff;text-decoration:none;font-weight:700;padding:8px 14px;border-radius:8px';
    var later = document.createElement('button'); later.type = 'button'; later.textContent = 'Later';
    later.style.cssText = 'background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer';
    later.addEventListener('click', function () { if (box.parentNode) box.parentNode.removeChild(box); });
    row.appendChild(a); row.appendChild(later); box.appendChild(row);
    document.body.appendChild(box);
    a.focus();
    return true;
  }
  window.AdvAgreementPrompt = { show: show };
})();

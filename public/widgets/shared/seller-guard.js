/* seller-guard.js - client-side seller onboarding gate.
 * Include on seller dashboard pages. The SERVER is authoritative (the seller
 * dashboard/data endpoints already enforce the gate); this only routes the seller
 * to sign, or shows a notice when no agreement is awaiting them yet.
 *
 *   <script src="/widgets/shared/seller-guard.js"></script>
 */
(function () {
  'use strict';
  var token = localStorage.getItem('token');
  if (!token) return; // unauthenticated handling lives elsewhere
  fetch('/api/agreements/onboarding-status', { headers: { Authorization: 'Bearer ' + token } })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.success || !j.data) return;
      var d = j.data;
      if (!d.is_seller || d.dashboard_access) return; // not a seller, or access granted
      if (d.agreement_id) {
        // A signable agreement exists - route the seller to sign it.
        location.replace('/sign-agreement.html?onboarding=1');
      } else {
        // No agreement awaiting signature yet - non-blocking notice.
        var bar = document.createElement('div');
        bar.setAttribute('role', 'status');
        bar.style.cssText = 'background:#fef3c7;color:#92400e;padding:12px 16px;font:14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;text-align:center;';
        bar.textContent = 'Your seller account setup is pending. A seller agreement will be provided for you to review and sign before your dashboard is fully enabled.';
        if (document.body) document.body.insertBefore(bar, document.body.firstChild);
      }
    })
    .catch(function () { /* network errors are non-fatal; server still enforces the gate */ });
})();

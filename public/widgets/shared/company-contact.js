/* ============================================================================
   AdvContact — the ONE client-side source for Advantage.Bid's public business
   contact details (mirrors src/lib/companyContact.js). Change the number in those
   two files ONLY. This is the CORPORATE number — never a seller's or buyer's.

   Auto-population (so pages never hardcode the literal number):
     <a data-adv-tel>…</a>      → click-to-call link, text = display number
     <span data-adv-phone></span> → display number as text
     <a data-adv-email>…</a>    → mailto support link
   Or call AdvContact.telLinkHTML() / AdvContact.PHONE_DISPLAY directly.
   ========================================================================== */
(function (root) {
  'use strict';
  var PHONE_DISPLAY = '(551) 655-7050';
  var TEL_HREF = 'tel:+15516557050';
  var SUPPORT_EMAIL = 'info@advantage.bid';

  function telLinkHTML(className, label) {
    return '<a href="' + TEL_HREF + '" class="' + (className || '') + '" aria-label="Call Advantage.Bid at '
      + PHONE_DISPLAY + '">' + (label || PHONE_DISPLAY) + '</a>';
  }
  function populate(rootEl) {
    var scope = rootEl || document;
    var tel = scope.querySelectorAll('[data-adv-tel]');
    for (var i = 0; i < tel.length; i++) {
      var a = tel[i];
      a.setAttribute('href', TEL_HREF);
      a.setAttribute('aria-label', 'Call Advantage.Bid at ' + PHONE_DISPLAY);
      if (!a.textContent || !a.textContent.trim()) a.textContent = PHONE_DISPLAY;
    }
    var ph = scope.querySelectorAll('[data-adv-phone]');
    for (var j = 0; j < ph.length; j++) {
      if (ph[j].tagName === 'A') { ph[j].setAttribute('href', TEL_HREF); }
      ph[j].textContent = PHONE_DISPLAY;
    }
    var em = scope.querySelectorAll('[data-adv-email]');
    for (var k = 0; k < em.length; k++) {
      em[k].setAttribute('href', 'mailto:' + SUPPORT_EMAIL);
      if (!em[k].textContent || !em[k].textContent.trim()) em[k].textContent = SUPPORT_EMAIL;
    }
  }
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', function () { populate(); });
    else populate();
  }

  var api = { PHONE_DISPLAY: PHONE_DISPLAY, TEL_HREF: TEL_HREF, SUPPORT_EMAIL: SUPPORT_EMAIL, telLinkHTML: telLinkHTML, populate: populate };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AdvContact = api;
})(typeof self !== 'undefined' ? self : this);

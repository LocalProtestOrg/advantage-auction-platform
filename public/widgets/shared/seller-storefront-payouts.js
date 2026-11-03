/* Seller: storefront payouts on the Settlements page (#sf-payouts; GET /api/seller/settlements/me/storefront).
   The seller's own company only (from the session). Built with DOM calls; every value is set as text. */
(function () {
  'use strict';
  var box = document.getElementById('sf-payouts'); if (!box) return;
  var token = null; try { token = localStorage.getItem('token'); } catch (e) { /* no storage */ }
  if (!token) return;
  function money(c) { return '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function el(tag, text, style) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (style) e.style.cssText = style; return e; }
  var STATUS = { pending_review: 'Being prepared', on_hold: 'On hold', paid: 'Paid' };
  var SENT = { processing: 'Transfer sent', released: 'Transfer complete', reversed: 'Transfer reversed. We will contact you.' };
  fetch('/api/seller/settlements/me/storefront', { headers: { Authorization: 'Bearer ' + token } }).then(function (r) { return r.json(); }).then(function (res) {
    box.textContent = '';
    var list = (res && res.success && res.data) || [];
    if (!list.length) { box.textContent = 'No storefront payouts yet.'; return; }
    list.forEach(function (p) {
      var wrap = el('div', null, 'border-top:1px solid #e5e7eb;padding:.7rem 0');
      var cutoff = new Date(p.period_cutoff_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });
      wrap.appendChild(el('div', 'Week ending ' + cutoff + ' · ' + (STATUS[p.settlement_status] || p.settlement_status) + (p.payout_status && SENT[p.payout_status] ? ' · ' + SENT[p.payout_status] : ''), 'font-weight:700;color:#111827'));
      wrap.appendChild(el('div', p.order_count + ' order' + (p.order_count === 1 ? '' : 's') + ' · sales ' + money(p.goods_cents) + ' · commission ' + money(p.platform_fee_cents)
        + (p.recovery_cents > 0 ? ' · refund adjustment ' + money(p.recovery_cents) : '') + ' · your payout ' + money(p.seller_payout_cents), 'font-size:.9rem;margin-top:.2rem'));
      (p.lines || []).forEach(function (l) {
        var ch = l.sales_channel === 'seller_website' ? 'your website' : l.sales_channel === 'marketplace' ? 'marketplace' : '';
        wrap.appendChild(el('div', (l.order_number || '') + ' · ' + (l.title || 'Item') + (l.quantity > 1 ? ' x ' + l.quantity : '') + ' · ' + money(l.amount_cents)
          + (ch ? ' · ' + ch + ' ' + ((Number(l.platform_fee_bps) || 0) / 100) + '%' : ''), 'font-size:.82rem;color:#475569'));
      });
      box.appendChild(wrap);
    });
  }).catch(function () { box.textContent = 'Storefront payouts could not be loaded.'; });
})();

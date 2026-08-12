/*
 * Shared buyer billing-address collector for sales tax.
 *
 * Only used when sales tax is active (server flag). Presents a small modal, prefilled from the
 * buyer's saved address, and saves it via PUT /api/payments/tax-address so the server can run the
 * Stripe Tax calculation for the BUYER's jurisdiction (Owner policy). Collecting an address here
 * grants NO tax exemption — only an admin approval does. No external dependencies; inline styles.
 *
 * window.TaxAddress.collect(token) → Promise<address> (resolves once a complete address is saved;
 * rejects with Error('cancelled') if the buyer closes the modal).
 */
(function () {
  'use strict';

  function esc(v) { return v == null ? '' : String(v).replace(/"/g, '&quot;'); }
  function field(id, label, v, ph) {
    return '<label style="font-size:.72rem;color:#374151;display:block">' + label +
      '<input id="' + id + '" placeholder="' + esc(ph || '') + '" value="' + esc(v) +
      '" style="width:100%;padding:.5rem .6rem;border:1px solid #d1d5db;border-radius:8px;font-size:.9rem;margin-top:.2rem;box-sizing:border-box" /></label>';
  }

  async function getCurrent(token) {
    try {
      const r = await fetch('/api/payments/tax-address', { headers: { Authorization: 'Bearer ' + token } });
      const j = await r.json();
      return (j && j.success && j.data) ? j.data.address : null;
    } catch (e) { return null; }
  }

  window.TaxAddress = {
    collect: function (token) {
      return new Promise(async function (resolve, reject) {
        const a = (await getCurrent(token)) || {};
        const overlay = document.createElement('div');
        overlay.setAttribute('style', 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:99999;padding:1rem');
        const box = document.createElement('div');
        box.setAttribute('style', 'background:#fff;border-radius:12px;max-width:440px;width:100%;padding:1.5rem;font-family:system-ui,-apple-system,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.25)');
        box.innerHTML =
          '<h2 style="margin:0 0 .4rem;font-size:1.15rem;color:#111">Billing address</h2>' +
          '<p style="margin:0 0 1rem;font-size:.85rem;color:#555;line-height:1.5">We use your billing address to calculate sales tax before your payment.</p>' +
          '<div style="display:grid;gap:.6rem">' +
            field('ta-line1', 'Street address', a.line1) +
            field('ta-line2', 'Apt / Suite (optional)', a.line2) +
            '<div style="display:grid;grid-template-columns:1fr 90px;gap:.6rem">' + field('ta-city', 'City', a.city) + field('ta-state', 'State', a.state) + '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 90px;gap:.6rem">' + field('ta-postal', 'ZIP / Postal', a.postal_code) + field('ta-country', 'Country', a.country || 'US') + '</div>' +
          '</div>' +
          '<div id="ta-err" style="color:#dc2626;font-size:.8rem;margin-top:.6rem;display:none"></div>' +
          '<div style="display:flex;gap:.6rem;margin-top:1.1rem;justify-content:flex-end">' +
            '<button id="ta-cancel" type="button" style="padding:.55rem 1rem;border:1px solid #d1d5db;background:#fff;border-radius:8px;cursor:pointer">Cancel</button>' +
            '<button id="ta-save" type="button" style="padding:.55rem 1.1rem;border:0;background:#2563eb;color:#fff;border-radius:8px;cursor:pointer;font-weight:600">Save &amp; continue</button>' +
          '</div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const errEl = box.querySelector('#ta-err');
        const val = function (id) { const e = box.querySelector('#' + id); return e ? e.value.trim() : ''; };
        function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }

        box.querySelector('#ta-cancel').onclick = function () { close(); reject(new Error('cancelled')); };
        box.querySelector('#ta-save').onclick = async function () {
          const payload = {
            line1: val('ta-line1'), line2: val('ta-line2'), city: val('ta-city'),
            state: val('ta-state'), postal_code: val('ta-postal'), country: val('ta-country') || 'US',
          };
          if (!payload.line1 || !payload.city || !payload.state || !payload.postal_code) {
            errEl.textContent = 'Please fill street address, city, state, and ZIP.'; errEl.style.display = 'block'; return;
          }
          const saveBtn = box.querySelector('#ta-save'); saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
          try {
            const resp = await fetch('/api/payments/tax-address', {
              method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(payload),
            });
            const j = await resp.json();
            if (resp.ok && j.success) { close(); resolve(j.data.address); return; }
            errEl.textContent = (j && j.message) || 'Could not save address.'; errEl.style.display = 'block';
          } catch (e) {
            errEl.textContent = 'Network error, please try again.'; errEl.style.display = 'block';
          }
          saveBtn.disabled = false; saveBtn.textContent = 'Save & continue';
        };
      });
    },
  };
})();

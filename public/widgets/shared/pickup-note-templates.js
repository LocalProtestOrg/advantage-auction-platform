/* Pickup note templates (owner request 2026-11-05): copy-ready sentences a seller adds to a lot description when an item
   needs special handling to remove. ONE list, used in two places:
   - the lot editor: <textarea data-pickup-notes> gets an "Add a pickup note" menu that appends the chosen note;
   - the Seller Academy: <div data-pickup-notes-list> lists every note with a Copy button.
   Examples only; the seller edits them to fit the item. DOM calls only; nothing is sent anywhere. */
(function () {
  'use strict';
  var NOTES = [
    ['Upper floor, no elevator', 'This item is located on the second floor. Buyer must bring appropriate assistance, equipment, and a suitable vehicle for safe removal.'],
    ['Fragile', 'This item is fragile. Buyer must bring appropriate packing materials and transport protection.'],
    ['Buyer disassembles and loads', 'Buyer is responsible for disassembly, loading, and removal. Please bring the necessary tools and assistance.'],
    ['Stairs', 'Removal requires carrying this item down a flight of stairs. Please bring at least one helper and moving straps or a hand truck.'],
    ['Elevator or loading dock', 'This item must leave through a shared elevator or loading dock. Removal is limited to the published pickup window, and the building may require advance notice.'],
    ['Oversized', 'This item is large and heavy. Please measure your vehicle and bring a suitable truck or trailer, helpers, and moving blankets. Dimensions are listed above.'],
    ['Parking and access', 'Parking near the entrance is limited. Large vehicles should plan for a short carry from the street or driveway.'],
    ['Attached or installed', 'This item is attached to the wall or floor. Buyer is responsible for careful removal with their own tools and may not damage the property.'],
  ];
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }

  function copy(text, btn) {
    var done = function () { var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); });
    else { fallback(text); done(); }
  }
  function fallback(text) {
    var ta = el('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) { /* the text stays selectable on the page */ } document.body.removeChild(ta);
  }

  function enhanceTextarea(ta) {
    if (ta.getAttribute('data-pickup-notes-ready')) return; ta.setAttribute('data-pickup-notes-ready', '1');
    var wrap = el('div', null, 'pickup-notes-add'); wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px;font-size:13px;color:#475569';
    var sel = el('select'); sel.setAttribute('aria-label', 'Add a pickup note to the description');
    sel.style.cssText = 'font:inherit;font-size:13px;padding:5px 8px;border:1px solid #cbd5e1;border-radius:7px;max-width:100%';
    sel.appendChild(el('option', 'Add a pickup note…')).value = '';
    NOTES.forEach(function (n, i) { var o = el('option', n[0]); o.value = String(i); sel.appendChild(o); });
    sel.addEventListener('change', function () {
      var n = NOTES[+sel.value]; sel.value = ''; if (!n) return;
      var cur = ta.value.replace(/\s+$/, ''); ta.value = cur ? cur + '\n\n' + n[1] : n[1];
      ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus();
    });
    wrap.appendChild(sel); wrap.appendChild(el('span', 'Edit the note to fit this item. Your published pickup terms still apply.'));
    ta.parentNode.insertBefore(wrap, ta.nextSibling);
  }

  function renderList(box) {
    if (box.getAttribute('data-ready')) return; box.setAttribute('data-ready', '1');
    NOTES.forEach(function (n) {
      var row = el('div', null, 'pn-row');
      var body = el('div', null, 'pn-body'); body.appendChild(el('b', n[0])); body.appendChild(el('p', n[1]));
      var b = el('button', 'Copy', 'pn-copy'); b.type = 'button'; b.setAttribute('aria-label', 'Copy the ' + n[0] + ' note');
      b.addEventListener('click', function () { copy(n[1], b); });
      row.appendChild(body); row.appendChild(b); box.appendChild(row);
    });
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('textarea[data-pickup-notes]'), enhanceTextarea);
    Array.prototype.forEach.call(document.querySelectorAll('[data-pickup-notes-list]'), renderList);
  }
  window.AdvPickupNotes = { NOTES: NOTES, init: init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

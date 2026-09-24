/* Listing checklist (Claimed Listing activation). Shown above the profile editor for a listing claimed
   through the claim flow. Five steps; steps 2-4 complete themselves from the saved profile, step 5 from a
   published sale (or "no sale scheduled right now"). Nothing here changes how the profile is published. */
(function () {
  'use strict';
  if (!window.ORG) return;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function render(view, pending) {
    var host = document.getElementById('listing-checklist');
    if (!host) {
      host = document.createElement('div');
      host.id = 'listing-checklist';
      var body = document.getElementById('body');
      if (!body || !body.parentNode) return;
      body.parentNode.insertBefore(host, body);
    }
    var done = view.steps.filter(function (s) { return s.done; }).length;
    var rows = view.steps.map(function (s, i) {
      var action = '';
      if (!s.done && s.key === 'details') action = ' <button type="button" class="lc-btn" data-step="details">These details are correct</button>';
      if (!s.done && s.key === 'first_event') action = ' <a class="lc-btn" href="/org/event-new.html">Post a sale</a> <button type="button" class="lc-btn lc-2" data-step="no_sale">No sale scheduled right now</button>';
      return '<li class="' + (s.done ? 'lc-done' : '') + '"><span class="lc-n">' + (s.done ? '&#10003;' : (i + 1)) + '</span> ' + esc(s.label)
        + (s.note ? ' <span class="lc-note">' + esc(s.note) + '</span>' : '') + action + '</li>';
    }).join('');
    var pend = (pending || []).length ? '<p class="lc-note">Waiting for review: ' + pending.map(function (p) { return esc(p.field.replace('_url', '').replace('_', ' ')); }).join(', ')
      + '. Changes to your company name, website domain or contact email are checked by our team before they go live.</p>' : '';
    var status = view.milestones.activated_at ? 'Your listing is active.' : done + ' of 5 done';
    host.innerHTML = '<section class="lc" aria-label="Listing checklist"><h2>Your listing checklist</h2><p class="lc-sub">About ten minutes. ' + status + '</p>'
      + '<ol class="lc-list">' + rows + '</ol>' + pend + '</section>';
    Array.prototype.forEach.call(host.querySelectorAll('button[data-step]'), function (b) {
      b.addEventListener('click', function () {
        b.disabled = true;
        ORG.api('POST', '/api/org/listing-checklist/' + b.getAttribute('data-step')).then(function (r) { if (r && r.checklist) render(r.checklist, pending); })
          .catch(function () { b.disabled = false; });
      });
    });
  }

  var style = document.createElement('style');
  style.textContent = '.lc{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:18px 18px 10px;margin:0 0 18px}'
    + '.lc h2{font-size:18px;margin:0 0 4px}.lc-sub{color:#475569;margin:0 0 10px;font-size:14px}.lc-list{list-style:none;padding:0;margin:0}'
    + '.lc-list li{padding:9px 0;border-top:1px solid #f1f5f9;font-size:15px}.lc-n{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#e2e8f0;font-size:13px;font-weight:700;margin-right:6px}'
    + '.lc-done .lc-n{background:#16a34a;color:#fff}.lc-done{color:#475569}.lc-note{color:#64748b;font-size:13px}'
    + '.lc-btn{margin-left:8px;font-size:13px;font-weight:700;border:1px solid #1d4ed8;background:#1d4ed8;color:#fff;border-radius:8px;padding:4px 10px;cursor:pointer;text-decoration:none;display:inline-block}'
    + '.lc-2{background:#fff;color:#0f172a;border-color:#cbd5e1}';
  document.head.appendChild(style);

  ORG.api('GET', '/api/org/listing-checklist').then(function (r) {
    if (r && r.checklist) render(r.checklist, r.pending_review || []);
  }).catch(function () { /* the editor works without the checklist */ });
})();

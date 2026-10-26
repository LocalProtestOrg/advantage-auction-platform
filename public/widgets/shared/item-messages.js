/* Item questions inbox — shared by the buyer page (/my-questions.html) and the seller page (/seller-messages.html).
 * The server decides what each side may see (contact details hidden, held messages visible only to their sender);
 * this script only renders it. Everything shown is escaped. */
(function () {
  'use strict';
  function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(v) { try { return new Date(v).toLocaleString(); } catch (e) { return ''; } }
  var STATE = { held: 'Waiting for a quick review — not delivered yet.', declined: 'Not delivered.', withdrawn: 'You withdrew this message.' };

  function start(cfg) {
    var token = localStorage.getItem('token') || '';
    if (!token) { location.href = '/login.html?next=' + encodeURIComponent(cfg.page + location.search); return; }
    var hdr = function (json) { var h = { Authorization: 'Bearer ' + token }; if (json) h['Content-Type'] = 'application/json'; return h; };
    var current = new URLSearchParams(location.search).get('c');
    var listEl = document.getElementById('list'), threadEl = document.getElementById('thread');

    function api(method, url, body) {
      return fetch(url, { method: method, headers: hdr(!!body), body: body ? JSON.stringify(body) : undefined })
        .then(function (r) { return r.json().catch(function () { return { success: false }; }); });
    }
    function off(res) { return res && res.code === 'MESSAGING_OFF'; }

    function loadList() {
      api('GET', cfg.listUrl).then(function (res) {
        if (off(res)) { listEl.innerHTML = '<p class="meta">Item questions are not available yet.</p>'; threadEl.style.display = 'none'; return; }
        if (!res.success) { listEl.innerHTML = '<p class="meta">' + esc(res.message || 'Could not load conversations.') + '</p>'; return; }
        var rows = res.data || [];
        if (!rows.length) { listEl.innerHTML = '<p class="meta">' + (cfg.side === 'seller' ? 'No questions yet.' : 'You have not asked any sellers a question yet.') + '</p>'; threadEl.innerHTML = ''; return; }
        listEl.innerHTML = rows.map(function (c) {
          var who = cfg.side === 'seller' ? esc(c.buyer_label) + (c.inventory_number ? ' · #' + esc(c.inventory_number) : '') : esc(c.seller_name);
          return '<button class="conv' + (c.id === current ? ' on' : '') + '" data-id="' + esc(c.id) + '">' +
            (c.thumbnail_url ? '<img src="' + esc(c.thumbnail_url) + '" alt="">' : '<img alt="">') +
            '<span><span class="t">' + esc(c.item_title) + '</span>' + (c.waiting ? '<span class="badge">' + c.waiting + ' new</span>' : '') +
            '<span class="meta" style="display:block">' + who + '</span><span class="meta" style="display:block">' + esc(when(c.last_message_at)) + '</span></span></button>';
        }).join('');
        if (!current && rows[0]) current = rows[0].id;
        if (current) loadThread(current);
      });
    }
    listEl.addEventListener('click', function (e) {
      var b = e.target.closest('button.conv'); if (!b) return;
      current = b.getAttribute('data-id');
      history.replaceState(null, '', cfg.page + '?c=' + encodeURIComponent(current));
      Array.prototype.forEach.call(listEl.querySelectorAll('.conv'), function (x) { x.classList.toggle('on', x === b); });
      loadThread(current);
    });

    function bubble(m) {
      var mine = m.from === 'you';
      var extra = '';
      if (mine && m.status && m.status !== 'delivered') {
        extra = '<span class="state">' + esc(STATE[m.status] || '') + (m.decline_reason ? ' ' + esc(m.decline_reason) : '') + '</span>';
        if (m.can_withdraw) extra += '<button class="btn btn-ghost" data-withdraw="' + esc(m.id) + '">Withdraw and rephrase</button>';
        if (m.status === 'declined' && m.can_appeal) extra += '<button class="btn btn-ghost" data-appeal="' + esc(m.id) + '">Ask for another review</button>';
      } else if (mine && m.delivered_body && m.delivered_body !== m.body) {
        extra = '<span class="state">Delivered with contact details hidden: ' + esc(m.delivered_body) + '</span>';
      }
      return '<div class="msg ' + (mine ? 'you' : 'them') + '">' + esc(m.body) + '<span class="when">' + (mine ? 'You' : (m.from === 'seller' ? 'Seller' : 'Buyer')) + ' · ' + esc(when(m.created_at)) + '</span>' + extra + '</div>';
    }

    function loadThread(id) {
      api('GET', cfg.threadUrl(id)).then(function (res) {
        if (!res.success) { threadEl.innerHTML = '<p class="meta">' + esc(res.message || 'Conversation not found.') + '</p>'; return; }
        var c = res.data;
        var title = c.item_status === 'active' || c.item_status === 'pending_purchase'
          ? '<a href="/item.html?id=' + encodeURIComponent(c.item_id) + '" target="_blank" rel="noopener">' + esc(c.item_title) + '</a>' : esc(c.item_title);
        var sub = cfg.side === 'seller' ? esc(c.buyer_label) + (c.inventory_number ? ' · your inventory #' + esc(c.inventory_number) : '') : 'Seller: ' + esc(c.seller_name);
        threadEl.innerHTML = '<div class="head">' + (c.thumbnail_url ? '<img src="' + esc(c.thumbnail_url) + '" alt="">' : '') +
          '<div><div class="t" style="font-weight:700">' + title + '</div><div class="meta">' + sub + '</div></div></div>' +
          (c.messages || []).map(bubble).join('') +
          '<div class="compose"><label for="reply" class="meta">Your reply</label><textarea id="reply" rows="4" maxlength="2000"></textarea>' +
          '<button class="btn" id="send">Send</button><div class="err" id="err"></div>' +
          '<p class="note">Keep questions and payments on Advantage.Bid. Phone numbers, email addresses and links are hidden from the other person.' +
          (cfg.side === 'seller' ? ' To change the price, edit the listing — the buyer then checks out here.' : '') + '</p></div>';
        document.getElementById('send').addEventListener('click', function () {
          var btn = this; btn.disabled = true;
          api('POST', cfg.replyUrl(id), { body: document.getElementById('reply').value }).then(function (r) {
            btn.disabled = false;
            if (!r.success) { document.getElementById('err').textContent = r.message || 'Could not send.'; return; }
            loadThread(id);
            if (r.data && r.data.notice) setTimeout(function () { var e = document.getElementById('err'); if (e) { e.style.color = '#92400e'; e.textContent = r.data.notice; } }, 300);
          });
        });
      });
    }
    threadEl.addEventListener('click', function (e) {
      var w = e.target.closest('[data-withdraw]'), a = e.target.closest('[data-appeal]');
      if (w) api('POST', '/api/storefront-messages/messages/' + encodeURIComponent(w.getAttribute('data-withdraw')) + '/withdraw').then(function () { loadThread(current); });
      if (a) {
        var note = window.prompt('Tell us briefly why this message should be delivered:');
        if (note) api('POST', '/api/storefront-messages/messages/' + encodeURIComponent(a.getAttribute('data-appeal')) + '/appeal', { note: note })
          .then(function (r) { if (!r.success) window.alert(r.message || 'Could not send.'); loadThread(current); });
      }
    });
    loadList();
  }
  window.AdvItemMessages = { start: start };
}());

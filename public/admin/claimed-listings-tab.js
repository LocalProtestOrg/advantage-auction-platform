/* Sales & Marketing Toolbox: Claimed Listings tab.
   Uses the page's api() and esc() helpers. Everything here reads or changes Claimed Listing data through
   /api/admin/claimed-listings, which enforces the listings.* permissions server-side. No financial fields. */
(function () {
  'use strict';
  var CL = { rows: [], filters: { decision: '', tier: '', market: '', q: '' }, open: null };
  function $(id) { return document.getElementById(id); }
  function fmt(t) { if (!t) return ''; var d = new Date(t); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function chip(t, tone) { return '<span class="cl-chip cl-' + (tone || 'n') + '">' + esc(t) + '</span>'; }
  var DECISION_LABEL = {
    ELIGIBLE_UNCLAIMED_LISTING: ['Eligible', 'g'], EXCLUDE_CLAIMED_LISTING: ['Claimed', 'b'], EXCLUDE_EVENT_PARTNER: ['Event Partner', 'n'],
    EXCLUDE_PRO_SELLER: ['Pro Seller', 'b'], EXCLUDE_SUPPRESSED: ['Opted out', 'r'], EXCLUDE_RECENT_OUTREACH: ['Recently contacted', 'n'],
    EXCLUDE_NO_PUBLIC_CONTACT: ['No usable email', 'n'], EXCLUDE_OUT_OF_SCOPE: ['Out of scope', 'n'], REVIEW_AMBIGUOUS_IDENTITY: ['Review: identity', 'y'],
    REVIEW_OTHER_RELATIONSHIP: ['Review: relationship', 'y'], REVIEW_DATA_QUALITY: ['Review: data quality', 'y'],
  };
  function decisionChip(d) { var x = DECISION_LABEL[d] || [d || 'Not screened', 'n']; return chip(x[0], x[1]); }
  function msg(t, bad) { var m = $('cl-msg'); if (m) { m.textContent = t || ''; m.className = 'cl-msg' + (bad ? ' cl-bad' : ''); } }
  async function call(method, url, body) {
    var r = await api(method, url, body);
    if (!r || r.success === false) throw new Error((r && (r.message || r.error)) || 'Request failed');
    return r.data !== undefined ? r.data : r;
  }

  var css = document.createElement('style');
  css.textContent = '.cl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:12px}'
    + '.cl-kv{font-size:.85rem;color:#475569}.cl-kv b{color:#0f172a}.cl-chip{display:inline-block;font-size:.72rem;font-weight:700;border-radius:999px;padding:2px 8px;margin:1px 2px}'
    + '.cl-g{background:#dcfce7;color:#166534}.cl-r{background:#fee2e2;color:#991b1b}.cl-y{background:#fef9c3;color:#854d0e}.cl-b{background:#dbeafe;color:#1e40af}.cl-n{background:#f1f5f9;color:#334155}'
    + '.cl-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}.cl-filters select,.cl-filters input{padding:6px 8px;border:1px solid #cbd5e1;border-radius:8px}'
    + '.cl-table-wrap{overflow-x:auto}.cl-table td,.cl-table th{font-size:.8rem;padding:6px 8px;vertical-align:top}.cl-table tr.cl-row{cursor:pointer}.cl-table tr.cl-row:hover{background:#f8fafc}'
    + '.cl-drawer{position:fixed;top:0;right:0;width:min(560px,100%);height:100%;background:#fff;box-shadow:-8px 0 24px rgba(15,23,42,.15);overflow:auto;padding:18px;z-index:50}'
    + '.cl-drawer h3{margin:.2rem 0 .6rem}.cl-sec{border-top:1px solid #e2e8f0;padding-top:10px;margin-top:12px}.cl-msg{font-size:.85rem;color:#166534;margin:6px 0}.cl-bad{color:#991b1b}'
    + '.cl-tl{font-size:.78rem;list-style:none;padding:0}.cl-tl li{padding:4px 0;border-bottom:1px solid #f1f5f9}.cl-btn{margin:2px 4px 2px 0}';
  document.head.appendChild(css);

  function paneHtml() {
    return '<div class="card"><h2>Claimed Listings</h2><p class="muted">Directory listings, their claim status and the Claimed Listing programme. One company, one contact owner: take the company lock before contacting anyone.</p>'
      + '<div id="cl-msg" class="cl-msg"></div><div id="cl-program"></div><div id="cl-summary" class="cl-grid"></div></div>'
      + '<div class="card"><h2>Queue</h2><div class="cl-filters">'
      + '<select id="cl-f-decision"><option value="">All decisions</option>' + Object.keys(DECISION_LABEL).map(function (k) { return '<option value="' + k + '">' + esc(DECISION_LABEL[k][0]) + '</option>'; }).join('') + '</select>'
      + '<select id="cl-f-tier"><option value="">All tiers</option><option>A</option><option>B</option><option>C</option></select>'
      + '<select id="cl-f-market"><option value="">All markets</option><option value="houston">Houston</option><option value="ny_tristate">New York area</option></select>'
      + '<input id="cl-f-q" placeholder="Company or city">'
      + '<button class="btn b-ghost" id="cl-apply">Apply</button><button class="btn b-ghost" id="cl-screen">Re-screen now</button></div>'
      + '<div class="cl-table-wrap"><table class="cl-table"><thead><tr><th>Company</th><th>Location</th><th>Status</th><th>Journey</th><th>Eligibility</th><th>Tier</th><th>Outreach</th><th>Last contact</th><th>Next action</th><th>Engagement</th><th>Rep / lock</th></tr></thead><tbody id="cl-rows"><tr><td colspan="11" class="muted">Loading...</td></tr></tbody></table></div></div>'
      + '<div class="card"><h2>Tasks</h2><div id="cl-tasks" class="muted">Loading...</div></div>'
      + '<div class="card"><h2>Cohorts and templates</h2><p class="muted">A cohort is the Owner\'s send lock. Staff may propose one; only a Super Admin approves it, with approved template versions. Nothing sends while the programme switch is off.</p>'
      + '<button class="btn b-ghost" id="cl-propose">Propose a pilot cohort (50)</button> <button class="btn b-ghost" id="cl-seed">Load blueprint templates as drafts</button>'
      + '<div id="cl-cohorts" style="margin-top:10px"></div><div id="cl-templates" style="margin-top:10px"></div></div>'
      + '<div class="card"><h2>Funnel</h2><div id="cl-funnel" class="muted">Loading...</div></div>'
      + '<div class="card"><h2>Company identity</h2><p class="muted">How directory listings, prospects, Event Partner sources and seller profiles group into companies. Ambiguous resemblances are never merged automatically.</p>'
      + '<button class="btn b-ghost" id="cl-identity">Run identity dry run</button><div id="cl-identity-out" style="margin-top:8px"></div></div>';
  }

  async function loadProgram() {
    var ov = await call('GET', '/api/admin/claimed-listings/overview');
    var p = ov.program, s = p.switches, rd = p.readiness;
    var yes = function (b) { return b ? chip('On', 'g') : chip('Off', 'n'); };
    var ready = function (b) { return b ? chip('Ready', 'g') : chip('Missing', 'r'); };
    $('cl-program').innerHTML = '<div class="cl-grid"><div class="cl-kv"><b>Outreach sending</b> ' + yes(s.sending_enabled) + (p.paused_reason ? ' ' + chip('Auto-paused', 'r') : '')
      + '<br><b>Reply processing</b> ' + yes(s.inbound_enabled) + '<br><b>Activation reminders</b> ' + yes(s.activation_emails_enabled) + '<br><b>Self-service claim links</b> ' + yes(s.self_request_enabled) + '</div>'
      + '<div class="cl-kv"><b>Before any send</b><br>Postal address ' + ready(rd.postal_address) + '<br>Listing mail stream ' + ready(rd.ses_configuration_set)
      + '<br>Unsubscribe signing key ' + ready(rd.unsubscribe_secret) + '<br>Email delivery ' + ready(rd.email_transport) + '</div></div>'
      + (p.paused_reason ? '<p class="cl-bad">' + esc(p.paused_reason) + '</p>' : '');
    var sum = function (title, list, key) { return '<div class="cl-kv"><b>' + title + '</b><br>' + (list.length ? list.map(function (r) { return esc(DECISION_LABEL[r[key]] ? DECISION_LABEL[r[key]][0] : r[key]) + ': <b>' + r.n + '</b>' + (r.overdue ? ' (' + r.overdue + ' overdue)' : ''); }).join('<br>') : 'None yet') + '</div>'; };
    $('cl-summary').innerHTML = sum('Eligibility', ov.decisions, 'decision') + sum('Tiers', ov.tiers, 'tier') + sum('Open tasks', ov.tasks, 'task_type') + sum('Sequences', ov.sequences, 'state');
  }

  async function loadRows() {
    var f = CL.filters, qs = [];
    for (var k in f) if (f[k]) qs.push(k + '=' + encodeURIComponent(f[k]));
    CL.rows = await call('GET', '/api/admin/claimed-listings/rows' + (qs.length ? '?' + qs.join('&') : ''));
    $('cl-rows').innerHTML = CL.rows.length ? CL.rows.map(function (r, i) {
      var o = r.outreach;
      return '<tr class="cl-row" data-i="' + i + '"><td><b>' + esc(r.company) + '</b><br><span class="muted">' + esc(r.email_masked || 'no email') + '</span></td>'
        + '<td>' + esc([r.city, r.state].filter(Boolean).join(', ')) + (r.market ? '<br>' + chip(r.market === 'houston' ? 'Houston' : 'New York area', 'b') : '') + '</td>'
        + '<td>' + chip(r.listing_status, r.listing_status === 'unclaimed' ? 'n' : 'b') + (r.pro_seller ? chip('Pro', 'b') : '') + '</td>'
        + '<td>' + esc(r.journey || 'none') + '</td><td>' + decisionChip(r.eligibility) + '</td><td>' + esc(r.tier) + ' <span class="muted">' + esc(r.score) + '</span></td>'
        + '<td>' + (o ? esc(o.state) + ' step ' + esc(o.step) + (o.next_send_at ? '<br><span class="muted">next ' + fmt(o.next_send_at) + '</span>' : '') : '<span class="muted">none</span>') + '</td>'
        + '<td>' + fmt(r.last_contact_at) + '</td><td>' + (r.next_action ? esc(r.next_action.type.replace(/_/g, ' ')) + '<br><span class="muted">due ' + fmt(r.next_action.due_at) + '</span>' : '') + '</td>'
        + '<td class="muted">' + r.engagement.visits + ' visits, ' + r.engagement.claim_started + ' started</td>'
        + '<td>' + esc(r.assigned_rep || '') + (r.lock ? '<br>' + chip('Lock: ' + (r.lock.holder || r.lock.holder_type), 'y') : '') + '</td></tr>';
    }).join('') : '<tr><td colspan="11" class="muted">No listings match.</td></tr>';
    Array.prototype.forEach.call(document.querySelectorAll('#cl-rows tr.cl-row'), function (tr) {
      tr.addEventListener('click', function () { openCompany(CL.rows[Number(tr.getAttribute('data-i'))].organization_id); });
    });
  }

  async function openCompany(orgId) {
    var d = await call('GET', '/api/admin/claimed-listings/company/' + orgId);
    CL.open = orgId;
    var o = d.organization;
    var el = $('cl-drawer') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'cl-drawer', className: 'cl-drawer' }));
    el.hidden = false;
    el.innerHTML = '<button class="btn b-ghost" id="cl-close" style="float:right">Close</button><h3>' + esc(o.name) + '</h3>'
      + '<div class="cl-kv">' + esc([o.city, o.state].filter(Boolean).join(', ')) + '<br>Email: <b>' + esc(o.contact_email || 'none') + '</b><br>Phone: ' + esc(o.contact_phone || 'none')
      + '<br>Website: ' + esc(o.website_url || 'none') + '<br>Lifecycle: ' + esc(o.lifecycle_state) + (o.acquisition ? '<br>Acquired via: ' + esc(o.acquisition.journey || '') + ' / ' + esc(o.acquisition.proof_method || '') : '') + '</div>'
      + '<div class="cl-sec"><b>Contact lock</b><br>' + (d.lock ? esc(d.lock.holder_name || d.lock.holder_type) + ' since ' + fmt(d.lock.acquired_at) : 'Free')
      + '<br><button class="btn b-ghost cl-btn" data-act="lock">Take the lock</button><button class="btn b-ghost cl-btn" data-act="unlock">Release</button><button class="btn b-ghost cl-btn" data-act="reassign">Reassign to me (Super Admin)</button></div>'
      + '<div class="cl-sec"><b>Log contact or a note</b><br><select id="cl-n-dir"><option value="internal">Internal note</option><option value="outbound">Outbound contact (needs the lock)</option><option value="inbound">Inbound contact</option></select> '
      + '<select id="cl-n-ch"><option>note</option><option>phone</option><option>email</option><option>meeting</option></select><br><textarea id="cl-n-body" rows="3" style="width:100%"></textarea>'
      + '<label><input type="checkbox" id="cl-n-pro"> Interested in Professional Seller</label><br><button class="btn b-blue cl-btn" data-act="note">Save</button></div>'
      + '<div class="cl-sec"><b>Outreach</b><br><button class="btn b-ghost cl-btn" data-act="pause">Pause this company\'s sequence</button><button class="btn b-ghost cl-btn" data-act="gate">Check send gates</button><div id="cl-gate"></div></div>'
      + '<div class="cl-sec"><b>Listing visibility</b><br><button class="btn b-ghost cl-btn" data-act="hide">Hide (removal request)</button><button class="btn b-ghost cl-btn" data-act="unhide">Show again</button></div>'
      + '<div class="cl-sec"><b>Super Admin</b><br><button class="btn b-ghost cl-btn" data-act="journey">Move or release journey</button><button class="btn b-ghost cl-btn" data-act="assisted">Assign owner after phone verification</button></div>'
      + (d.pending_changes.length ? '<div class="cl-sec"><b>Profile changes waiting for review</b>' + d.pending_changes.map(function (c) {
        return '<div>' + esc(c.field) + ': ' + esc(c.old_value || '') + ' &rarr; <b>' + esc(c.new_value || '') + '</b> <button class="btn b-ghost cl-btn" data-pcr="' + c.id + '" data-ok="1">Approve</button><button class="btn b-ghost cl-btn" data-pcr="' + c.id + '" data-ok="0">Reject</button></div>';
      }).join('') + '</div>' : '')
      + '<div class="cl-sec"><b>Tasks</b>' + (d.tasks.length ? d.tasks.map(function (t) { return '<div>' + chip(t.status, t.status === 'open' ? 'y' : 'n') + ' ' + esc(t.summary || t.task_type) + ' <span class="muted">due ' + fmt(t.due_at) + '</span></div>'; }).join('') : ' none') + '</div>'
      + '<div class="cl-sec"><b>Company timeline</b> <span class="muted">(every programme, every channel)</span><ul class="cl-tl">' + d.timeline.map(function (t) {
        return '<li>' + fmt(t.at) + ' ' + chip(t.source.replace(/_/g, ' '), 'n') + ' ' + esc(t.kind || '') + ' ' + esc(t.summary || '') + '</li>';
      }).join('') + '</ul></div>';
    $('cl-close').onclick = function () { el.hidden = true; };
    Array.prototype.forEach.call(el.querySelectorAll('[data-act]'), function (b) { b.addEventListener('click', function () { act(b.getAttribute('data-act'), orgId).catch(function (e) { msg(e.message, true); }); }); });
    Array.prototype.forEach.call(el.querySelectorAll('[data-pcr]'), function (b) {
      b.addEventListener('click', function () {
        call('POST', '/api/admin/claimed-listings/profile-changes/' + b.getAttribute('data-pcr'), { approve: b.getAttribute('data-ok') === '1' })
          .then(function () { openCompany(orgId); }).catch(function (e) { msg(e.message, true); });
      });
    });
  }

  async function act(a, orgId) {
    var base = '/api/admin/claimed-listings/company/' + orgId;
    if (a === 'lock') await call('POST', base + '/lock', {});
    if (a === 'unlock') await call('DELETE', base + '/lock');
    if (a === 'reassign') await call('POST', base + '/lock', { reassign: true });
    if (a === 'note') await call('POST', base + '/note', { direction: $('cl-n-dir').value, channel: $('cl-n-ch').value, body: $('cl-n-body').value, pro_interest: $('cl-n-pro').checked });
    if (a === 'pause') await call('POST', base + '/pause', { reason: 'paused from the Toolbox' });
    if (a === 'gate') {
      var g = await call('GET', base + '/gate');
      $('cl-gate').innerHTML = (g.allowed ? chip('Would send', 'g') : chip('Blocked', 'r')) + g.checks.map(function (c) { return '<div class="muted">' + (c.ok ? '&#10003; ' : '&#10007; ') + esc(c.name) + ': ' + esc(c.detail) + '</div>'; }).join('');
      return;
    }
    if (a === 'hide' || a === 'unhide') {
      var reason = window.prompt(a === 'hide' ? 'Reason for hiding this listing:' : 'Reason for showing it again:');
      if (!reason) return;
      await call('POST', base + '/visibility', { hidden: a === 'hide', reason: reason });
    }
    if (a === 'journey') {
      var to = window.prompt('Move to which journey? (CLAIMED_LISTING, EVENT_PARTNER, SALES_DIRECT, or leave empty to release)', '');
      if (to === null) return;
      var why = window.prompt('Written reason (required):');
      if (!why) return;
      await call('POST', base + '/journey', { journey: to.trim() || null, reason: why });
    }
    if (a === 'assisted') {
      var email = window.prompt('The owner\'s email address:');
      if (!email) return;
      var note = window.prompt('How was ownership verified? (the call to the phone number ON the listing)');
      if (!note) return;
      await call('POST', base + '/assisted-claim', { email: email, verification_note: note });
    }
    msg('Saved.');
    await openCompany(orgId);
    loadRows().catch(function () {});
  }

  async function loadTasks() {
    var t = await call('GET', '/api/admin/claimed-listings/tasks');
    $('cl-tasks').innerHTML = t.length ? '<table class="cl-table"><tr><th>Due</th><th>Type</th><th>Company</th><th>Summary</th><th></th></tr>' + t.map(function (x) {
      var late = x.due_at && new Date(x.due_at) < new Date();
      return '<tr><td>' + (late ? chip('Overdue', 'r') : '') + fmt(x.due_at) + '</td><td>' + esc(x.task_type.replace(/_/g, ' ')) + '</td><td>' + esc(x.organization_name || '') + '</td><td>' + esc(x.summary || '') + '</td>'
        + '<td><button class="btn b-ghost cl-btn" data-task="' + x.id + '">Done</button>' + (x.organization_id ? '<button class="btn b-ghost cl-btn" data-open="' + x.organization_id + '">Open</button>' : '') + '</td></tr>';
    }).join('') + '</table>' : '<span class="muted">No open tasks.</span>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-task]'), function (b) {
      b.addEventListener('click', function () {
        var res = window.prompt('What was done?');
        if (res === null) return;
        call('POST', '/api/admin/claimed-listings/tasks/' + b.getAttribute('data-task'), { status: 'done', resolution: res }).then(loadTasks).catch(function (e) { msg(e.message, true); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-open]'), function (b) { b.addEventListener('click', function () { openCompany(b.getAttribute('data-open')); }); });
  }

  async function loadCohorts() {
    var c = await call('GET', '/api/admin/claimed-listings/cohorts');
    $('cl-cohorts').innerHTML = c.length ? '<table class="cl-table"><tr><th>Cohort</th><th>Status</th><th>Members</th><th>Sends used</th><th></th></tr>' + c.map(function (x) {
      return '<tr><td>' + esc(x.name) + '</td><td>' + chip(x.status, x.status === 'draft' ? 'n' : 'b') + '</td><td>' + x.members + '</td><td>' + x.sends_used + ' / ' + x.max_sends + '</td>'
        + '<td><button class="btn b-ghost cl-btn" data-shadow="' + x.id + '">Shadow run</button>' + (x.status === 'draft' ? '<button class="btn b-ghost cl-btn" data-approve="' + x.id + '">Approve (Super Admin)</button>' : '') + '</td></tr>';
    }).join('') + '</table><div id="cl-shadow"></div>' : '<span class="muted">No cohorts yet.</span>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-shadow]'), function (b) {
      b.addEventListener('click', function () {
        b.disabled = true; msg('Rendering the cohort and checking every gate. Nothing is sent...');
        call('POST', '/api/admin/claimed-listings/cohorts/' + b.getAttribute('data-shadow') + '/shadow').then(function (r) {
          b.disabled = false; msg('Shadow run complete: ' + r.members + ' members, ' + r.sends + ' sends.');
          $('cl-shadow').innerHTML = '<p class="cl-kv">Would send now: <b>' + r.would_send + '</b>. Blocked by: ' + esc(Object.keys(r.blocked_by).map(function (k) { return k + ' (' + r.blocked_by[k] + ')'; }).join(', ') || 'nothing')
            + '. Rendered: ' + r.rendered + ', render errors: ' + r.render_errors + '.</p>' + (r.sample ? '<pre style="white-space:pre-wrap;font-size:.78rem;background:#f8fafc;padding:10px;border-radius:8px">' + esc(r.sample) + '</pre>' : '');
        }).catch(function (e) { b.disabled = false; msg(e.message, true); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-approve]'), function (b) {
      b.addEventListener('click', function () {
        call('POST', '/api/admin/claimed-listings/cohorts/' + b.getAttribute('data-approve') + '/approve').then(function () { msg('Cohort approved. Sending still requires the programme switch.'); loadCohorts(); })
          .catch(function (e) { msg(e.message, true); });
      });
    });
    var t = await call('GET', '/api/admin/claimed-listings/templates');
    $('cl-templates').innerHTML = t.length ? '<table class="cl-table"><tr><th>Template</th><th>Version</th><th>Status</th><th>Subject</th><th></th></tr>' + t.map(function (x) {
      return '<tr><td>' + esc(x.template_key) + '</td><td>' + x.version + '</td><td>' + chip(x.status, x.status === 'approved' ? 'g' : 'n') + '</td><td>' + esc(x.subject) + '</td>'
        + '<td>' + (x.status === 'draft' ? '<button class="btn b-ghost cl-btn" data-tapprove="' + x.id + '">Approve (Super Admin)</button>' : '') + '</td></tr>';
    }).join('') + '</table>' : '<span class="muted">No templates loaded.</span>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-tapprove]'), function (b) {
      b.addEventListener('click', function () {
        call('POST', '/api/admin/claimed-listings/templates/' + b.getAttribute('data-tapprove') + '/approve').then(function () { msg('Template approved. It can no longer be edited.'); loadCohorts(); })
          .catch(function (e) { msg(e.message, true); });
      });
    });
  }

  async function loadFunnel() {
    var f = await call('GET', '/api/admin/claimed-listings/funnel');
    $('cl-funnel').innerHTML = (f.cohorts.length ? '<table class="cl-table"><tr><th>Send week</th><th>Sent</th><th>Delivered</th><th>Bounce %</th><th>Visited</th><th>Claimed</th><th>Activated</th><th>Activated per 100 delivered</th><th>Replies</th><th>Exits</th></tr>'
      + f.cohorts.map(function (c) { return '<tr><td>' + esc(c.send_week) + '</td><td>' + c.sent + '</td><td>' + c.delivered + '</td><td>' + (c.bounce_rate == null ? '' : c.bounce_rate) + '</td><td>' + c.visited + '</td><td>' + c.claimed + '</td><td>' + c.activated + '</td><td>' + (c.activated_per_100_delivered == null ? '' : c.activated_per_100_delivered) + '</td><td>' + c.replies + '</td><td>' + c.exits + '</td></tr>'; }).join('') + '</table>'
      : '<span class="muted">No outreach has been sent.</span>')
      + '<p class="muted">All time (any path): ' + f.all_time.claimed + ' claimed, ' + f.all_time.activated + ' activated, ' + f.all_time.help_requests + ' help requests. Opens are not measured. Staff, test and automated traffic excluded.</p>';
  }

  async function init() {
    var pane = $('pane-claimed');
    if (!pane.getAttribute('data-ready')) {
      pane.innerHTML = paneHtml(); pane.setAttribute('data-ready', '1');
      $('cl-apply').onclick = function () { CL.filters = { decision: $('cl-f-decision').value, tier: $('cl-f-tier').value, market: $('cl-f-market').value, q: $('cl-f-q').value }; loadRows().catch(function (e) { msg(e.message, true); }); };
      $('cl-screen').onclick = function () { msg('Screening...'); call('POST', '/api/admin/claimed-listings/screen').then(function (r) { msg('Screened ' + r.screened + ' listings.'); loadProgram(); loadRows(); }).catch(function (e) { msg(e.message, true); }); };
      $('cl-propose').onclick = function () { var n = window.prompt('Name for the proposed cohort:', 'Pilot 1'); if (!n) return; call('POST', '/api/admin/claimed-listings/cohorts/propose', { name: n, size: 50 }).then(function (r) { msg('Proposed ' + r.members.length + ' listings (draft).'); loadCohorts(); }).catch(function (e) { msg(e.message, true); }); };
      $('cl-seed').onclick = function () { call('POST', '/api/admin/claimed-listings/templates/seed').then(function (r) { msg('Loaded ' + r.created + ' draft templates.'); loadCohorts(); }).catch(function (e) { msg(e.message, true); }); };
      $('cl-identity').onclick = function () {
        $('cl-identity-out').textContent = 'Running...';
        call('GET', '/api/admin/claimed-listings/identity/dry-run').then(function (r) {
          $('cl-identity-out').innerHTML = '<div class="cl-kv">Companies: <b>' + r.companies + '</b> (' + r.multi_record_companies + ' with several records). Journeys: ' + esc(JSON.stringify(r.journeys))
            + '. Journey collisions: <b>' + r.collisions.length + '</b>. Ambiguous resemblances held for review: <b>' + r.ambiguous_pairs + '</b>. Merges refused: <b>' + r.refused_merges + '</b>. Nothing was written.</div>';
        }).catch(function (e) { $('cl-identity-out').textContent = e.message; });
      };
    }
    await Promise.all([loadProgram(), loadRows(), loadTasks(), loadCohorts(), loadFunnel()].map(function (p) { return p.catch(function (e) { msg(e.message, true); }); }));
  }
  window.ClaimedListingsTab = { init: init };
})();

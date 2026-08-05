/* Organization portal — shared client glue (Phase 1). Native Railway auth (JWT).
   Load AFTER /widgets/shared/auth-refresh.js so tokens refresh transparently. */
(function () {
  var TOKEN = localStorage.getItem('token');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var ORG = {
    token: TOKEN,
    loggedIn: !!TOKEN,
    /** Redirect to login (preserving return path) if not authenticated. */
    guard: function () {
      if (!TOKEN) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); return false; }
      return true;
    },
    /** JSON API call with bearer auth + consistent error throwing. */
    api: async function (method, path, body) {
      var opt = { method: method, headers: {} };
      if (TOKEN) opt.headers['Authorization'] = 'Bearer ' + TOKEN;
      if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
      var r = await fetch(path, opt);
      var d = {}; try { d = await r.json(); } catch (e) { /* non-json */ }
      if (r.status === 401) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('unauthenticated'); }
      if (!r.ok || d.success === false) {
        var e = new Error(d.message || ('Request failed (' + r.status + ')'));
        e.code = d.code; e.status = r.status; throw e;
      }
      return d;
    },
    /** Upload one image via the org pipeline → returns the Cloudinary secure_url. */
    uploadImage: async function (file) {
      var fd = new FormData(); fd.append('image', file);
      var r = await fetch('/api/org/upload-image', { method: 'POST', headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}, body: fd });
      var d = await r.json();
      if (!d.success) throw new Error(d.message || 'Upload failed');
      return d.secure_url;
    },
    esc: esc,
    fmtDate: function (t) {
      if (!t) return '';
      try { return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
    },
    statusChip: function (s) {
      var m = {
        draft: ['Draft', '#64748b', '#f1f5f9'], submitted: ['In Review', '#b45309', '#fef3c7'],
        published: ['Published', '#15803d', '#dcfce7'], rejected: ['Needs Changes', '#b91c1c', '#fee2e2'],
        archived: ['Archived', '#475569', '#e2e8f0'],
      }[s] || [s, '#475569', '#eee'];
      return '<span style="font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;color:' + m[1] + ';background:' + m[2] + '">' + m[0] + '</span>';
    },
    /** Render the shared portal header with the active-tab highlighted. */
    header: function (active) {
      var tabs = [['events', 'My Events', '/org/events.html'], ['new', 'Create Event', '/org/event-new.html'], ['profile', 'Professional Profile', '/org/profile.html']];
      var nav = tabs.map(function (t) { return '<a href="' + t[2] + '"' + (t[0] === active ? ' class="on"' : '') + '>' + t[1] + '</a>'; }).join('');
      // Launch containment: for BD-managed professional businesses, Business Administration (in BD) is the
      // source of truth for the company listing — so hide the duplicate Railway profile editor. Runs after
      // the header mounts; leaves appraisers, native orgs, routes, and data untouched. (Future: reconcile
      // the Railway profile down to internal seller-identity fields only.)
      setTimeout(function () { try { ORG._containProfileEditor(active); } catch (e) {} }, 0);
      return '<header class="pbar"><div class="in"><a class="brand" href="/org/events.html">Advantage<span>.Bid</span></a>'
        + '<nav>' + nav + '</nav><div class="sp"></div>'
        + '<a class="who" href="/">← Back to site</a></div></header>';
    },
    // Org types whose company listing is managed in BD (Business Administration), not Railway.
    _bdManagedBusinessTypes: {
      auction_company: 1, auction_house: 1, estate_sale_company: 1, professional_liquidator: 1,
      consignment_company: 1, moving_company: 1, cleanout_company: 1, clean_out_company: 1,
    },
    /** Hide the Railway "Professional Profile" tab for BD-managed professional businesses (appraisers keep it). */
    _containProfileEditor: async function (active) {
      try {
        var me = await ORG.api('GET', '/api/auth/me');
        if (!(me.data && me.data.bd_member)) return; // only BD-managed members
        var prof = await ORG.api('GET', '/api/org/profile');
        var type = prof && prof.organization && prof.organization.type;
        if (!ORG._bdManagedBusinessTypes[type]) return; // appraisers & non-business orgs keep the editor
        var link = document.querySelector('header.pbar nav a[href="/org/profile.html"]');
        if (link && link.parentNode) link.parentNode.removeChild(link);
        if (active === 'profile') location.replace('/org/events.html'); // don't strand them on the hidden editor
      } catch (e) { /* fail open — never block the portal on this check */ }
    },
  };
  window.ORG = ORG;
})();

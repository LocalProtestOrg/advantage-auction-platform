/* Admin events moderation — shared client glue (Phase 1). Reuses the platform admin
   auth convention: JWT in localStorage, client-side role check (the API also enforces
   admin via roleMiddleware). Load with /widgets/shared/admin-nav.js. */
(function () {
  var token = localStorage.getItem('token');
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  window.adminLogout = function () { localStorage.removeItem('token'); sessionStorage.clear(); location.href = '/login.html'; };
  window.AE = {
    token: token,
    requireAdmin: function () {
      if (!token) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); return false; }
      var role; try { role = JSON.parse(atob(token.split('.')[1])).role; } catch (e) { /* malformed */ }
      if (role !== 'admin') {
        document.body.innerHTML = '<div style="padding:4rem;text-align:center;font-family:system-ui"><h2>Access Denied</h2>'
          + '<p style="color:#666;margin-top:1rem">Administrator access required.</p><a href="/login.html" style="color:#2563eb">Login</a></div>';
        return false;
      }
      return true;
    },
    api: async function (method, path, body) {
      var o = { method: method, headers: { Authorization: 'Bearer ' + token } };
      if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
      var r = await fetch(path, o);
      var d = {}; try { d = await r.json(); } catch (e) { /* non-json */ }
      if (!r.ok || d.success === false) { var e = new Error(d.message || ('Request failed (' + r.status + ')')); e.code = d.code; throw e; }
      return d;
    },
    esc: esc,
    fmtDate: function (t) { if (!t) return ''; try { return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } },
    statusChip: function (s) {
      var m = { draft: ['Draft', '#64748b', '#f1f5f9'], submitted: ['Submitted', '#b45309', '#fef3c7'], published: ['Published', '#15803d', '#dcfce7'], rejected: ['Rejected', '#b91c1c', '#fee2e2'], archived: ['Archived', '#475569', '#e2e8f0'] }[s] || [s, '#475569', '#eee'];
      return '<span style="font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;color:' + m[1] + ';background:' + m[2] + '">' + m[0] + '</span>';
    },
  };
})();

/* Professional Profile editor (Phase 3) — reusable across every professional type.
   One editor, driven by the server schema (/api/org/profile-schema). Only the sections that apply
   to this org's professional type(s) render. Reuses ORG.uploadImage (Cloudinary) + ORG.api. */
(function () {
  if (!window.ORG || !ORG.guard()) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = ORG.esc;
  var msg = $('msg');

  // schema core key → API save key (camelCase the /api/org/profile POST expects)
  var CORE_SAVE = { name: 'name', short_description: 'shortDescription', phone: 'contactPhone',
    email: 'contactEmail', website: 'websiteUrl', logo: 'logoUrl', cover: 'coverUrl', city: 'city', state: 'state' };
  // schema core key → organization column (for reading the loaded org)
  var CORE_READ = { name: 'name', short_description: 'description', phone: 'contact_phone',
    email: 'contact_email', website: 'website_url', logo: 'logo_url', cover: 'cover_image_url', city: 'city', state: 'state' };
  var SUGG = { logo: 'Upload your logo', short_description: 'Add a short description', bio: 'Complete your biography',
    appraisal_types: 'Describe your specialties', certifications: 'Add your certifications',
    phone: 'Add a business phone', cover: 'Add a cover image', service_area: 'Add your service area', tagline: 'Add a tagline' };

  var S = { schema: [], typeLabels: {}, types: [], slug: null, published: false, core: {}, pd: {}, hasOrg: false };

  function showErr(t) { msg.className = 'msg err'; msg.textContent = t; window.scrollTo(0, 0); }
  function showOk(t) { msg.className = 'msg ok'; msg.textContent = t; }

  function applies(sec) { return sec.applies === 'all' || (sec.applies || []).some(function (t) { return S.types.indexOf(t) >= 0; }); }
  function visibleSections() { return S.schema.filter(applies); }
  function getVal(f) { return f.core ? S.core[f.key] : S.pd[f.key]; }
  function setVal(f, v) { if (f.core) S.core[f.key] = v; else S.pd[f.key] = v; onChange(); }

  // ── load ──
  document.getElementById('hdr').innerHTML = ORG.header('profile');
  Promise.all([ORG.api('GET', '/api/org/profile-schema'), ORG.api('GET', '/api/org/profile')])
    .then(function (r) {
      S.schema = r[0].sections || []; S.typeLabels = r[0].professional_types || {};
      var p = r[1];
      S.types = p.professional_types || [];
      var o = p.organization;
      S.hasOrg = !!o;
      if (o) {
        S.slug = o.slug; S.pd = o.profile_data || {};
        Object.keys(CORE_READ).forEach(function (k) { S.core[k] = o[CORE_READ[k]] || ''; });
        S.published = S.pd.published === true;
      }
      render();
    })
    .catch(function (e) { $('body').innerHTML = '<div class="msg err" style="display:block">' + esc(e.message) + '</div>'; });

  // ── render shell ──
  function render() {
    var typeChips = S.types.map(function (t) { return '<span class="t">' + esc((S.typeLabels[t] && S.typeLabels[t].label) || t) + '</span>'; }).join('')
      || '<span class="t" style="color:#64748b;background:#f1f5f9;border-color:#e2e8f0">Professional</span>';
    var viewBtn = (S.published && S.slug)
      ? '<a class="btn ghost" id="viewBtn" href="/pro.html?slug=' + encodeURIComponent(S.slug) + '" target="_blank" rel="noopener">View Public Profile</a>' : '';
    var html =
      '<div class="pp-actions"><div class="pp-typechips">' + typeChips + '</div><div class="sp"></div>'
      + '<button class="btn ghost" id="previewBtn" type="button">Preview Public Profile</button>' + viewBtn + '</div>'
      + '<div class="pp-grid"><div id="form"></div>'
      + '<aside class="pp-preview"><div class="pp-meter" id="meter"></div>'
      + '<div class="ppc" id="prev"></div><div class="pp-previewhint">Live preview of your public profile card</div></aside></div>'
      + '<div class="pp-savebar"><button class="btn primary" id="saveBtn" type="button">Save Profile</button>'
      + '<button class="btn ghost" id="previewBtn2" type="button">Preview Public Profile</button>'
      + '<span class="status" id="saveStatus"></span></div>';
    $('body').innerHTML = html;

    var form = $('form');
    visibleSections().forEach(function (sec) {
      var card = document.createElement('div'); card.className = 'card';
      card.innerHTML = '<h2>' + esc(sec.title) + '</h2>';
      sec.fields.forEach(function (f) { card.appendChild(fieldEl(f)); });
      form.appendChild(card);
    });

    $('saveBtn').addEventListener('click', save);
    [$('previewBtn'), $('previewBtn2')].forEach(function (b) { b.addEventListener('click', preview); });
    onChange();
  }

  // ── field element factory ──
  function fieldEl(f) {
    var wrap = document.createElement('div'); wrap.className = 'pp-field';
    var lid = 'f_' + f.key;
    var labelHtml = '<label for="' + lid + '">' + esc(f.label) + (f.required ? ' <span class="req">*</span>' : '') + '</label>';

    if (f.type === 'image') { wrap.innerHTML = labelHtml; wrap.appendChild(imageTile(f)); if (f.hint) wrap.insertAdjacentHTML('beforeend', '<div class="pp-hint">' + esc(f.hint) + '</div>'); return wrap; }
    if (f.type === 'gallery') { wrap.innerHTML = labelHtml; wrap.appendChild(galleryEl(f)); if (f.hint) wrap.insertAdjacentHTML('beforeend', '<div class="pp-hint">' + esc(f.hint) + '</div>'); return wrap; }
    if (f.type === 'toggle') { wrap.appendChild(toggleEl(f)); if (f.hint) wrap.insertAdjacentHTML('beforeend', '<div class="pp-hint">' + esc(f.hint) + '</div>'); return wrap; }
    if (f.type === 'toggle-group') { wrap.innerHTML = labelHtml; wrap.appendChild(toggleGroupEl(f)); return wrap; }
    if (f.type === 'chips') { wrap.innerHTML = labelHtml; wrap.appendChild(chipsEl(f)); if (f.hint) wrap.insertAdjacentHTML('beforeend', '<div class="pp-hint">' + esc(f.hint) + '</div>'); return wrap; }

    // text-like
    var val = getVal(f) == null ? '' : String(getVal(f));
    if (f.type === 'textarea') {
      wrap.innerHTML = labelHtml + '<textarea id="' + lid + '" data-fkey="' + f.key + '"'
        + (f.max ? ' maxlength="' + f.max + '"' : '') + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + '>' + esc(val) + '</textarea>'
        + (f.hint ? '<div class="pp-hint">' + esc(f.hint) + '</div>' : '');
      wrap.querySelector('textarea').addEventListener('input', function (e) { setVal(f, e.target.value); });
    } else {
      var t = f.type === 'tel' ? 'tel' : f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : f.type === 'number' ? 'number' : 'text';
      wrap.innerHTML = labelHtml + '<input id="' + lid + '" data-fkey="' + f.key + '" type="' + t + '"'
        + (f.max ? ' maxlength="' + f.max + '"' : '') + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '')
        + ' value="' + esc(val) + '" />' + (f.hint ? '<div class="pp-hint">' + esc(f.hint) + '</div>' : '');
      wrap.querySelector('input').addEventListener('input', function (e) { setVal(f, e.target.value); });
    }
    return wrap;
  }

  function toggleEl(f) {
    var lab = document.createElement('label'); lab.className = 'switch';
    var on = getVal(f) === true;
    lab.innerHTML = '<input type="checkbox"' + (on ? ' checked' : '') + ' /><span class="track"></span><span class="lbl">' + esc(f.label) + '</span>';
    lab.querySelector('input').addEventListener('change', function (e) { setVal(f, e.target.checked); });
    return lab;
  }

  function toggleGroupEl(f) {
    var box = document.createElement('div'); box.className = 'tgroup';
    (f.options || []).forEach(function (o) {
      var k = o[0], label = o[1], on = S.pd[k] === true;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.innerHTML = '<span class="bx">' + (on ? '✓' : '') + '</span>' + esc(label);
      b.addEventListener('click', function () {
        var now = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', now ? 'true' : 'false'); b.querySelector('.bx').textContent = now ? '✓' : '';
        S.pd[k] = now; onChange();
      });
      box.appendChild(b);
    });
    return box;
  }

  function chipsEl(f) {
    var wrap = document.createElement('div');
    if (!Array.isArray(S.pd[f.key])) S.pd[f.key] = f.core ? (Array.isArray(S.core[f.key]) ? S.core[f.key] : []) : (S.pd[f.key] || []);
    var arr = f.core ? (S.core[f.key] = S.core[f.key] || []) : (S.pd[f.key] = S.pd[f.key] || []);
    var box = document.createElement('div'); box.className = 'chips-in';
    var input = document.createElement('input'); input.type = 'text'; input.placeholder = f.placeholder || 'Type and press Enter';
    function paint() {
      Array.prototype.slice.call(box.querySelectorAll('.chip')).forEach(function (c) { c.remove(); });
      arr.forEach(function (v, i) {
        var c = document.createElement('span'); c.className = 'chip';
        c.innerHTML = esc(v) + ' <button type="button" aria-label="Remove ' + esc(v) + '">×</button>';
        c.querySelector('button').addEventListener('click', function () { arr.splice(i, 1); paint(); syncSugg(); onChange(); });
        box.insertBefore(c, input);
      });
    }
    function add(v) { v = (v || '').trim(); if (!v) return; if (arr.indexOf(v) < 0) { arr.push(v); paint(); syncSugg(); onChange(); } input.value = ''; }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(input.value); } else if (e.key === 'Backspace' && !input.value && arr.length) { arr.pop(); paint(); onChange(); } });
    input.addEventListener('blur', function () { if (input.value.trim()) add(input.value); });
    box.appendChild(input); box.addEventListener('click', function () { input.focus(); });
    wrap.appendChild(box); paint();
    var sg = null;
    function syncSugg() { if (!sg) return; Array.prototype.slice.call(sg.querySelectorAll('.s')).forEach(function (s) { s.setAttribute('aria-pressed', arr.indexOf(s.textContent) >= 0 ? 'true' : 'false'); }); }
    if (f.suggestions && f.suggestions.length) {
      sg = document.createElement('div'); sg.className = 'sugg';
      f.suggestions.forEach(function (s) {
        var b = document.createElement('span'); b.className = 's'; b.textContent = s; b.setAttribute('aria-pressed', arr.indexOf(s) >= 0 ? 'true' : 'false');
        b.addEventListener('click', function () { if (arr.indexOf(s) < 0) add(s); });
        sg.appendChild(b);
      });
      wrap.appendChild(sg);
    }
    return wrap;
  }

  function doUpload(file, tile, onDone) {
    var busy = document.createElement('div'); busy.className = 'busy'; busy.textContent = 'Uploading…'; tile.appendChild(busy);
    ORG.uploadImage(file).then(function (url) { busy.remove(); onDone(url); })
      .catch(function (e) { busy.remove(); showErr(e.message || 'Upload failed'); });
  }
  function pickFile(cb) {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
    inp.addEventListener('change', function () { if (inp.files && inp.files[0]) cb(inp.files[0]); inp.remove(); });
    document.body.appendChild(inp); inp.click();
  }

  function imageTile(f) {
    var url = getVal(f);
    var tile = document.createElement('div'); tile.className = 'uptile' + (f.key === 'logo' || f.key === 'headshot' ? ' logo' : '') + (url ? ' has' : '');
    function paint() {
      url = getVal(f);
      tile.style.backgroundImage = url ? 'url("' + url + '")' : '';
      tile.classList.toggle('has', !!url);
      tile.innerHTML = url ? '<button class="rm" type="button" aria-label="Remove image">×</button>' : ('＋ Upload ' + esc(f.label));
      if (url) tile.querySelector('.rm').addEventListener('click', function (e) { e.stopPropagation(); setVal(f, ''); paint(); });
    }
    tile.addEventListener('click', function () { pickFile(function (file) { doUpload(file, tile, function (u) { setVal(f, u); paint(); }); }); });
    paint();
    var row = document.createElement('div'); row.className = 'uprow'; row.appendChild(tile); return row;
  }

  function galleryEl(f) {
    if (!Array.isArray(S.pd[f.key])) S.pd[f.key] = [];
    var arr = S.pd[f.key];
    var box = document.createElement('div'); box.className = 'gal';
    function paint() {
      box.innerHTML = '';
      arr.forEach(function (u, i) {
        var g = document.createElement('div'); g.className = 'g'; g.style.backgroundImage = 'url("' + u + '")';
        g.innerHTML = '<button class="rm" type="button" aria-label="Remove photo">×</button>';
        g.querySelector('.rm').addEventListener('click', function () { arr.splice(i, 1); paint(); onChange(); });
        box.appendChild(g);
      });
      var add = document.createElement('div'); add.className = 'g'; add.style.cssText = 'display:grid;place-items:center;cursor:pointer;border:1.6px dashed #cbd3dd;background:#f8fafc;color:#637488;font-weight:800';
      add.textContent = '＋'; add.setAttribute('role', 'button'); add.setAttribute('aria-label', 'Add photo');
      add.addEventListener('click', function () { pickFile(function (file) { doUpload(file, add, function (u) { arr.push(u); paint(); onChange(); }); }); });
      box.appendChild(add);
    }
    paint(); return box;
  }

  // ── live preview + completeness ──
  function primaryLabel() { for (var i = 0; i < S.types.length; i++) { if (S.typeLabels[S.types[i]]) return S.typeLabels[S.types[i]].singular; } return 'Professional'; }
  function renderPreview() {
    var c = S.core, name = c.name || 'Your Business Name';
    var loc = [c.city, c.state].filter(Boolean).join(', ');
    var el = $('prev');
    el.innerHTML =
      '<div class="cover" style="' + (c.cover ? 'background-image:url(\'' + esc(c.cover) + '\')' : '') + '"></div>'
      + '<div class="body"><div class="logo" style="' + (c.logo ? 'background-image:url(\'' + esc(c.logo) + '\')' : '') + '"></div>'
      + '<div class="cat">' + esc(primaryLabel()) + '</div>'
      + '<div class="nm">' + esc(name) + (S.published ? '<span class="vf">Public</span>' : '') + '</div>'
      + (loc ? '<div class="loc">📍 ' + esc(loc) + '</div>' : '')
      + '<div class="rate">★★★★★</div>'
      + (c.short_description ? '<div class="desc">' + esc(c.short_description) + '</div>' : '<div class="desc" style="color:#94a3b8">Add a short description to introduce your business…</div>')
      + '<a class="cta" href="#" onclick="return false">Contact ' + esc(primaryLabel()) + '</a></div>';
  }

  function completeness() {
    var total = 0, got = 0;
    visibleSections().forEach(function (s) { s.fields.forEach(function (f) {
      var w = f.weight == null ? 1 : f.weight; if (w <= 0) return; total += w;
      var filled;
      if (f.type === 'toggle-group') filled = (f.options || []).some(function (o) { return S.pd[o[0]]; });
      else { var v = getVal(f);
        if (f.type === 'chips' || f.type === 'gallery') filled = Array.isArray(v) && v.length > 0;
        else if (f.type === 'toggle') filled = v === true;
        else filled = v != null && String(v).trim() !== ''; }
      if (filled) got += w;
    }); });
    return total ? Math.round(got / total * 100) : 0;
  }
  function suggestions() {
    var out = [];
    visibleSections().forEach(function (s) { s.fields.forEach(function (f) {
      if ((f.weight == null ? 1 : f.weight) <= 0) return;
      var v = getVal(f), filled;
      if (f.type === 'toggle-group') filled = (f.options || []).some(function (o) { return S.pd[o[0]]; });
      else if (f.type === 'chips' || f.type === 'gallery') filled = Array.isArray(v) && v.length > 0;
      else if (f.type === 'toggle') filled = v === true;
      else filled = v != null && String(v).trim() !== '';
      out.push({ f: f, filled: filled, msg: SUGG[f.key] || ('Add ' + f.label.toLowerCase()) });
    }); });
    return out;
  }
  function renderMeter() {
    var pct = completeness();
    var sug = suggestions();
    var todo = sug.filter(function (x) { return !x.filled; }).sort(function (a, b) { return (b.f.weight || 1) - (a.f.weight || 1); }).slice(0, 4);
    var done = pct >= 100;
    var list = (done ? sug.slice(0, 3).map(function (x) { return { msg: x.msg, filled: true }; })
      : todo.map(function (x) { return { msg: x.msg, filled: false }; }));
    $('meter').innerHTML =
      '<div class="top"><span class="pct">' + pct + '%</span><span class="lbl">' + (done ? 'Profile complete' : 'Profile completeness') + '</span></div>'
      + '<div class="pp-bar"><i style="width:' + pct + '%"></i></div>'
      + '<ul class="pp-sugg">' + list.map(function (x) { return '<li' + (x.filled ? ' class="done"' : '') + '>' + esc(x.msg) + '</li>'; }).join('') + '</ul>';
  }
  function onChange() { renderPreview(); renderMeter(); }

  // ── save + preview ──
  function save() {
    var b = { profileData: {} };
    // core
    Object.keys(CORE_SAVE).forEach(function (k) { var v = S.core[k]; b[CORE_SAVE[k]] = (v == null ? '' : (Array.isArray(v) ? v : String(v).trim())); });
    b.profileData = S.pd;
    if (!b.name) { showErr('Business name is required.'); return; }
    if (!S.hasOrg && !b.contactEmail && !b.contactPhone) { showErr('Add a business email or phone to create your profile.'); return; }
    var btn = $('saveBtn'); btn.disabled = true; $('saveStatus').textContent = 'Saving…'; msg.className = 'msg';
    ORG.api('POST', '/api/org/profile', b).then(function (d) {
      btn.disabled = false; $('saveStatus').textContent = '';
      S.hasOrg = true; if (d.organization) { S.slug = d.organization.slug; }
      S.published = (S.pd.published === true);
      showOk('Saved. ' + (d.completeness != null ? ('Your profile is ' + d.completeness + '% complete.') : ''));
      // refresh the View Public Profile button visibility
      render();
      window.scrollTo(0, 0);
    }).catch(function (e) { btn.disabled = false; $('saveStatus').textContent = ''; showErr(e.message); });
  }
  function preview() {
    if (!S.slug) { showErr('Save your profile first, then preview it.'); return; }
    window.open('/pro.html?slug=' + encodeURIComponent(S.slug) + '&preview=1', '_blank', 'noopener');
  }
})();

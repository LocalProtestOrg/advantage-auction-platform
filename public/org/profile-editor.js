/* Professional Profile editor (Phase 3) — reusable across every professional type, driven by the
   server schema. Only the sections that apply to this org's professional type(s) render. Reuses
   ORG.uploadImage (Cloudinary) + ORG.api. Trust signals are never fabricated; publication is
   moderation-gated (owners can Submit for Review, not self-publish to the directory). */
(function () {
  if (!window.ORG || !ORG.guard()) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = ORG.esc;
  var msg = $('msg');

  var CORE_SAVE = { name: 'name', short_description: 'shortDescription', phone: 'contactPhone',
    email: 'contactEmail', website: 'websiteUrl', logo: 'logoUrl', cover: 'coverUrl', city: 'city', state: 'state' };
  var CORE_READ = { name: 'name', short_description: 'description', phone: 'contact_phone',
    email: 'contact_email', website: 'website_url', logo: 'logo_url', cover: 'cover_image_url', city: 'city', state: 'state' };
  var SUGG = { logo: 'Add your logo', short_description: 'Add a short description', bio: 'Complete your biography',
    appraisal_types: 'Describe your specialties', certifications: 'Add your certifications',
    phone: 'Add a business phone', email: 'Add a contact email', cover: 'Add a cover image',
    service_area: 'Add your service area', name: 'Add your business name', gallery: 'Add a few business photos' };
  var US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

  var S = { schema: [], typeLabels: {}, types: [], slug: null, core: {}, pd: {}, hasOrg: false, verified: false, published: false, reviewStatus: 'draft' };

  function showErr(t) { msg.className = 'msg err'; msg.textContent = t; window.scrollTo(0, 0); }
  function showOk(t) { msg.className = 'msg ok'; msg.textContent = t; }
  function applies(sec) { return sec.applies === 'all' || (sec.applies || []).some(function (t) { return S.types.indexOf(t) >= 0; }); }
  function visibleSections() { return S.schema.filter(applies); }
  function getVal(f) { return f.core ? S.core[f.key] : S.pd[f.key]; }
  function setVal(f, v) { if (f.core) S.core[f.key] = v; else S.pd[f.key] = v; onChange(); }

  document.getElementById('hdr').innerHTML = ORG.header('profile');
  Promise.all([ORG.api('GET', '/api/org/profile-schema'), ORG.api('GET', '/api/org/profile')])
    .then(function (r) {
      S.schema = r[0].sections || []; S.typeLabels = r[0].professional_types || {};
      var p = r[1]; S.types = p.professional_types || [];
      var o = p.organization; S.hasOrg = !!o;
      if (o) {
        S.slug = o.slug; S.pd = o.profile_data || {};
        Object.keys(CORE_READ).forEach(function (k) { S.core[k] = o[CORE_READ[k]] || ''; });
        S.verified = o.verification_status === 'verified';
        S.published = S.pd.published === true;
        S.reviewStatus = S.pd.review_status || 'draft';
      }
      render();
    })
    .catch(function (e) { $('body').innerHTML = '<div class="msg err" style="display:block">' + esc(e.message) + '</div>'; });

  function render() {
    var typeChips = S.types.map(function (t) { return '<span class="t">' + esc((S.typeLabels[t] && S.typeLabels[t].label) || t) + '</span>'; }).join('')
      || '<span class="t" style="color:#64748b;background:#f1f5f9;border-color:#e2e8f0">Professional</span>';
    var viewBtn = (S.published && S.slug)
      ? '<a class="btn ghost" href="/pro.html?slug=' + encodeURIComponent(S.slug) + '" target="ppublic" rel="noopener">View Public Profile</a>' : '';
    $('body').innerHTML =
      '<div class="pp-actions"><div class="pp-typechips">' + typeChips + '</div><div class="sp"></div>'
      + '<button class="btn ghost" id="previewBtn" type="button">Preview Public Profile</button>' + viewBtn + '</div>'
      + '<div class="pp-grid"><div id="form"></div>'
      + '<aside class="pp-preview"><div class="pp-meter" id="meter"></div>'
      + '<div class="ppc" id="prev"></div><div class="pp-previewhint">Live preview of your public profile card</div></aside></div>'
      + '<div class="pp-savebar"><button class="btn primary" id="saveBtn" type="button">Save Profile</button>'
      + '<button class="btn ghost" id="previewBtn2" type="button">Preview Public Profile</button>'
      + '<span class="status" id="saveStatus"></span></div>';

    var form = $('form');
    visibleSections().forEach(function (sec) {
      var card = document.createElement('div'); card.className = 'card';
      card.innerHTML = '<h2>' + esc(sec.title) + '</h2>';
      sec.fields.forEach(function (f) { card.appendChild(fieldEl(f)); });
      form.appendChild(card);
    });
    form.appendChild(publicationCard());

    $('saveBtn').addEventListener('click', save);
    [$('previewBtn'), $('previewBtn2')].forEach(function (b) { if (b) b.addEventListener('click', preview); });
    onChange();
  }

  function fieldEl(f) {
    var wrap = document.createElement('div'); wrap.className = 'pp-field'; wrap.id = 'field-' + f.key;
    var lid = 'f_' + f.key;
    var labelHtml = '<label for="' + lid + '">' + esc(f.label) + (f.required ? ' <span class="req">*</span>' : '') + '</label>';

    if (f.type === 'image') { wrap.innerHTML = labelHtml; wrap.appendChild(imageBlock(f)); return wrap; }
    if (f.type === 'gallery') { wrap.innerHTML = labelHtml; wrap.appendChild(galleryEl(f)); if (f.hint) wrap.insertAdjacentHTML('beforeend', '<div class="pp-hint">' + esc(f.hint) + '</div>'); return wrap; }
    if (f.type === 'toggle') { wrap.appendChild(toggleEl(f)); if (f.hint) wrap.insertAdjacentHTML('beforeend', '<div class="pp-hint">' + esc(f.hint) + '</div>'); return wrap; }
    if (f.type === 'toggle-group') { wrap.innerHTML = labelHtml; wrap.appendChild(toggleGroupEl(f)); return wrap; }
    if (f.type === 'chips' || f.type === 'states') { wrap.innerHTML = labelHtml; wrap.appendChild(chipsEl(f)); if (f.hint) wrap.insertAdjacentHTML('beforeend', '<div class="pp-hint">' + esc(f.hint) + '</div>'); return wrap; }

    var val = getVal(f) == null ? '' : String(getVal(f));
    if (f.type === 'textarea') {
      wrap.innerHTML = labelHtml + '<textarea id="' + lid + '" data-fkey="' + f.key + '"' + (f.max ? ' maxlength="' + f.max + '"' : '') + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + '>' + esc(val) + '</textarea>'
        + (f.hint ? '<div class="pp-hint">' + esc(f.hint) + '</div>' : '');
      wrap.querySelector('textarea').addEventListener('input', function (e) { setVal(f, e.target.value); });
    } else {
      var t = f.type === 'tel' ? 'tel' : f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : f.type === 'number' ? 'number' : 'text';
      wrap.innerHTML = labelHtml + '<input id="' + lid + '" data-fkey="' + f.key + '" type="' + t + '"' + (f.max ? ' maxlength="' + f.max + '"' : '')
        + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + ' value="' + esc(val) + '" />'
        + '<div class="pp-hint err-slot" id="err_' + f.key + '" style="display:none;color:#b91c1c"></div>'
        + (f.hint ? '<div class="pp-hint">' + esc(f.hint) + '</div>' : '');
      var input = wrap.querySelector('input');
      input.addEventListener('input', function (e) { setVal(f, e.target.value); clearErr(f.key); });
      input.addEventListener('blur', function (e) { normalizeField(f, e.target); });
    }
    return wrap;
  }

  function clearErr(k) { var el = $('err_' + k); if (el) { el.style.display = 'none'; el.textContent = ''; } }
  function fieldErr(k, m) { var el = $('err_' + k); if (el) { el.textContent = m; el.style.display = 'block'; } }
  function normalizeField(f, input) {
    var v = (input.value || '').trim();
    if (f.type === 'email') { if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { fieldErr(f.key, 'Enter a valid email address.'); return; } clearErr(f.key); }
    if (f.type === 'url' && v && !/^https?:\/\//i.test(v)) { v = 'https://' + v; input.value = v; setVal(f, v); }
    if (f.type === 'tel' && v) { var d = v.replace(/[^\d]/g, ''); if (d.length === 10) { v = '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6); input.value = v; setVal(f, v); } }
  }

  function toggleEl(f) {
    var lab = document.createElement('label'); lab.className = 'switch';
    var on = getVal(f) === true;
    lab.innerHTML = '<input type="checkbox"' + (on ? ' checked' : '') + ' /><span class="track"></span><span class="lbl">' + esc(f.label) + '</span>';
    lab.querySelector('input').addEventListener('change', function (e) { setVal(f, e.target.checked); });
    return lab;
  }
  function toggleGroupEl(f) {
    var box = document.createElement('div'); box.className = 'tgroup'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', f.label);
    (f.options || []).forEach(function (o) {
      var k = o[0], label = o[1], on = S.pd[k] === true;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.innerHTML = '<span class="bx" aria-hidden="true">' + (on ? '✓' : '') + '</span>' + esc(label);
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
    var isStates = f.type === 'states';
    var arr = f.core ? (S.core[f.key] = Array.isArray(S.core[f.key]) ? S.core[f.key] : []) : (S.pd[f.key] = Array.isArray(S.pd[f.key]) ? S.pd[f.key] : []);
    var wrap = document.createElement('div');
    var box = document.createElement('div'); box.className = 'chips-in';
    var input = document.createElement('input'); input.type = 'text'; input.placeholder = f.placeholder || 'Type and press Enter';
    input.setAttribute('aria-label', f.label);
    if (isStates) { input.setAttribute('list', 'us-states'); input.setAttribute('maxlength', '2'); }
    function paint() {
      Array.prototype.slice.call(box.querySelectorAll('.chip')).forEach(function (c) { c.remove(); });
      arr.forEach(function (v, i) {
        var c = document.createElement('span'); c.className = 'chip';
        c.innerHTML = esc(v) + ' <button type="button" aria-label="Remove ' + esc(v) + '">×</button>';
        c.querySelector('button').addEventListener('click', function () { arr.splice(i, 1); paint(); syncSugg(); onChange(); });
        box.insertBefore(c, input);
      });
    }
    function add(v) {
      v = (v || '').trim(); if (!v) { input.value = ''; return; }
      if (isStates) { v = v.toUpperCase(); if (US_STATES.indexOf(v) < 0) { fieldErr(f.key, 'Enter a valid US state (e.g. TX).'); return; } clearErr(f.key); }
      if (arr.indexOf(v) < 0) { arr.push(v); paint(); syncSugg(); onChange(); } // no duplicates
      input.value = '';
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(input.value); } // never submits the page
      else if (e.key === 'Backspace' && !input.value && arr.length) { arr.pop(); paint(); onChange(); }
    });
    input.addEventListener('blur', function () { if (input.value.trim()) add(input.value); });
    box.appendChild(input); box.addEventListener('click', function () { input.focus(); });
    if (isStates) { var dl = document.createElement('div'); dl.innerHTML = '<datalist id="us-states">' + US_STATES.map(function (s) { return '<option value="' + s + '">'; }).join('') + '</datalist>'; wrap.appendChild(dl.firstChild); }
    wrap.insertBefore(box, wrap.firstChild || null); paint();
    var sg = null;
    function syncSugg() { if (!sg) return; Array.prototype.slice.call(sg.querySelectorAll('.s')).forEach(function (s) { s.setAttribute('aria-pressed', arr.indexOf(s.textContent) >= 0 ? 'true' : 'false'); }); }
    if (f.suggestions && f.suggestions.length) {
      sg = document.createElement('div'); sg.className = 'sugg';
      f.suggestions.forEach(function (s) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 's'; b.textContent = s; b.setAttribute('aria-pressed', arr.indexOf(s) >= 0 ? 'true' : 'false');
        b.addEventListener('click', function () { if (arr.indexOf(s) < 0) add(s); });
        sg.appendChild(b);
      });
      wrap.appendChild(sg);
    }
    return wrap;
  }

  // ── uploads ──
  function pickFile(cb) {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
    inp.addEventListener('change', function () { if (inp.files && inp.files[0]) cb(inp.files[0]); inp.remove(); });
    document.body.appendChild(inp); inp.click();
  }
  function imageBlock(f) {
    var box = document.createElement('div'); box.className = 'up';
    var tile = document.createElement('div'); tile.className = 'uptile ' + (f.key === 'cover' ? 'cover' : f.key === 'headshot' ? 'headshot' : 'logo');
    tile.tabIndex = 0; tile.setAttribute('role', 'button');
    var side = document.createElement('div'); side.className = 'up-side';
    var err = document.createElement('div'); err.className = 'up-err'; err.style.display = 'none';
    function upload(file) {
      err.style.display = 'none';
      var busy = document.createElement('div'); busy.className = 'busy'; busy.innerHTML = 'Uploading…<div class="pbar"><i></i></div>'; tile.appendChild(busy);
      ORG.uploadImage(file).then(function (url) { busy.remove(); setVal(f, url); paint(); })
        .catch(function (e) { busy.remove(); err.textContent = (e && e.message) || 'Upload failed. Please try again.'; err.style.display = 'block'; });
    }
    function paint() {
      var url = getVal(f);
      tile.classList.toggle('has', !!url);
      tile.style.backgroundImage = url ? 'url("' + url + '")' : '';
      tile.setAttribute('aria-label', (url ? 'Change ' : 'Upload ') + f.label);
      tile.innerHTML = url ? '<button class="rm" type="button" aria-label="Remove ' + esc(f.label) + '">×</button>'
        : '<span class="ico" aria-hidden="true">⬆</span>Upload ' + esc(f.label);
      if (url) tile.querySelector('.rm').addEventListener('click', function (e) { e.stopPropagation(); setVal(f, ''); paint(); });
      side.innerHTML = '';
      var g = document.createElement('div'); g.className = 'g'; g.textContent = (f.guidance || 'JPG, PNG, WEBP or HEIC. Up to 10 MB.');
      side.appendChild(g);
      var acts = document.createElement('div'); acts.className = 'acts';
      if (url) {
        var rep = document.createElement('button'); rep.type = 'button'; rep.className = 'up-btn'; rep.textContent = 'Replace ' + f.label; rep.setAttribute('aria-label', 'Replace ' + f.label); rep.addEventListener('click', function () { pickFile(upload); });
        var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'up-btn danger'; rm.textContent = 'Remove ' + f.label; rm.setAttribute('aria-label', 'Remove ' + f.label); rm.addEventListener('click', function () { setVal(f, ''); paint(); });
        acts.appendChild(rep); acts.appendChild(rm);
      } else {
        var ch = document.createElement('button'); ch.type = 'button'; ch.className = 'up-btn'; ch.textContent = 'Choose file'; ch.setAttribute('aria-label', 'Upload ' + f.label); ch.addEventListener('click', function () { pickFile(upload); });
        acts.appendChild(ch);
      }
      side.appendChild(acts); side.appendChild(err);
    }
    tile.addEventListener('click', function () { pickFile(upload); });
    tile.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile(upload); } });
    box.appendChild(tile); box.appendChild(side); paint();
    return box;
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
      var add = document.createElement('button'); add.type = 'button'; add.className = 'add'; add.setAttribute('aria-label', 'Add business photo');
      add.innerHTML = '<span aria-hidden="true">＋</span>Add Photo';
      add.addEventListener('click', function () { pickFile(function (file) {
        var busy = document.createElement('div'); busy.className = 'busy'; busy.innerHTML = 'Uploading…'; add.appendChild(busy);
        ORG.uploadImage(file).then(function (u) { arr.push(u); paint(); onChange(); }).catch(function (e) { busy.remove(); showErr((e && e.message) || 'Upload failed.'); });
      }); });
      box.appendChild(add);
    }
    paint(); return box;
  }

  // ── publication (moderation-gated) ──
  function publicationCard() {
    var card = document.createElement('div'); card.className = 'card';
    var st = S.published ? 'published' : (S.reviewStatus === 'submitted' ? 'submitted' : 'draft');
    var label = st === 'published' ? 'Published' : st === 'submitted' ? 'Submitted for Review' : 'Draft';
    var copy = st === 'published'
      ? 'Your profile is live on your public profile page.'
      : st === 'submitted'
        ? 'Your profile has been submitted for review. Advantage.Bid reviews profiles before they appear in the public directory. You can keep editing in the meantime.'
        : 'Preview your public profile any time. When you are ready, submit it for review. Directory listing is approved by Advantage.Bid and is separate from completing your profile.';
    card.innerHTML = '<h2>Publication</h2><div class="pub-card"><span class="st ' + st + '">' + label + '</span><p>' + copy + '</p>'
      + '<div class="btnrow" style="margin:0">'
      + (st === 'published' ? '' : '<button class="btn ghost" id="submitReview" type="button">Submit Profile for Review</button>')
      + '<button class="btn ghost" id="previewBtn3" type="button">Preview Public Profile</button></div></div>';
    setTimeout(function () {
      var sr = $('submitReview'); if (sr) sr.addEventListener('click', submitForReview);
      var pv = $('previewBtn3'); if (pv) pv.addEventListener('click', preview);
    }, 0);
    return card;
  }
  function submitForReview() {
    if (!S.slug && !S.core.name) { showErr('Add your business name and save before submitting for review.'); return; }
    S.pd.review_status = 'submitted';
    save(function () { S.reviewStatus = 'submitted'; showOk('Thank you. Your profile was submitted for review.'); });
  }

  // ── live preview + completeness ──
  function primaryLabel() { for (var i = 0; i < S.types.length; i++) { if (S.typeLabels[S.types[i]]) return S.typeLabels[S.types[i]].singular; } return 'Professional'; }
  function initials(n) { return (String(n || '').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('') || 'A').toUpperCase(); }
  function renderPreview() {
    var c = S.core, name = c.name || 'Your Business Name';
    var loc = [c.city, c.state].filter(Boolean).join(', ');
    var logoStyle = c.logo ? 'background-image:url(\'' + esc(c.logo) + '\')' : '';
    var logoInner = c.logo ? '' : '<span class="ini">' + esc(initials(name)) + '</span>';
    $('prev').innerHTML =
      '<div class="cov' + (c.cover ? '' : ' empty') + '" style="' + (c.cover ? 'background-image:url(\'' + esc(c.cover) + '\')' : '') + '"></div>'
      + '<div class="body"><div class="logo" style="' + logoStyle + '">' + logoInner + '</div>'
      + '<div class="cat">' + esc(primaryLabel()) + '</div>'
      + '<div class="nm">' + esc(name) + (S.verified ? ' <span class="vf">Verified</span>' : '') + '</div>'
      + (loc ? '<div class="loc">📍 ' + esc(loc) + '</div>' : '')
      + '<div class="newp">New profile</div>'
      + (c.short_description ? '<div class="desc">' + esc(c.short_description) + '</div>' : '<div class="desc muted2">Add a short description to introduce your business.</div>')
      + '<a class="cta" href="#" onclick="return false">Contact ' + esc(primaryLabel()) + '</a></div>';
  }
  function fieldFilled(f) {
    if (f.type === 'toggle-group') return (f.options || []).some(function (o) { return S.pd[o[0]]; });
    var v = getVal(f);
    if (f.type === 'chips' || f.type === 'states' || f.type === 'gallery') return Array.isArray(v) && v.length > 0;
    if (f.type === 'toggle') return v === true;
    return v != null && String(v).trim() !== '';
  }
  function completeness() {
    var total = 0, got = 0;
    visibleSections().forEach(function (s) { s.fields.forEach(function (f) { var w = f.weight == null ? 1 : f.weight; if (w <= 0) return; total += w; if (fieldFilled(f)) got += w; }); });
    return total ? Math.round(got / total * 100) : 0;
  }
  function renderMeter() {
    var pct = completeness(), done = pct >= 100;
    var todo = [];
    visibleSections().forEach(function (s) { s.fields.forEach(function (f) { if ((f.weight == null ? 1 : f.weight) <= 0) return; if (!fieldFilled(f)) todo.push({ key: f.key, msg: SUGG[f.key] || ('Add ' + f.label.toLowerCase()) }); }); });
    todo = todo.slice(0, 4);
    var items = done
      ? '<li class="done">Your profile has the details buyers look for</li>'
      : todo.map(function (x) { return '<li><button type="button" class="jump" data-k="' + esc(x.key) + '">' + esc(x.msg) + '</button></li>'; }).join('');
    $('meter').innerHTML =
      '<div class="top"><span class="pct">' + pct + '%</span><span class="lbl">' + (done ? 'Profile complete' : 'Profile completeness') + '</span></div>'
      + '<div class="pp-bar"><i style="width:' + pct + '%"></i></div>'
      + '<ul class="pp-sugg">' + items + '</ul>'
      + '<div class="pp-hint" style="margin-top:10px">Completing your profile does not list you in the directory. Directory listing is approved separately by Advantage.Bid.</div>';
    Array.prototype.slice.call($('meter').querySelectorAll('.jump')).forEach(function (b) {
      b.addEventListener('click', function () { var el = $('field-' + b.getAttribute('data-k')); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); var inp = el.querySelector('input,textarea,button'); if (inp) inp.focus({ preventScroll: true }); } });
    });
  }
  function onChange() { renderPreview(); renderMeter(); }

  function collect() {
    var b = { profileData: {} };
    Object.keys(CORE_SAVE).forEach(function (k) { var v = S.core[k]; b[CORE_SAVE[k]] = (v == null ? '' : (Array.isArray(v) ? v : String(v).trim())); });
    b.profileData = S.pd;
    return b;
  }
  function save(after) {
    var b = collect();
    if (!b.name) { showErr('Business name is required.'); return; }
    if (b.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.contactEmail)) { showErr('Enter a valid contact email.'); fieldErr('email', 'Enter a valid email address.'); return; }
    if (!S.hasOrg && !b.contactEmail && !b.contactPhone) { showErr('Add a business email or phone to create your profile.'); return; }
    var btn = $('saveBtn'); btn.disabled = true; $('saveStatus').textContent = 'Saving…'; msg.className = 'msg';
    ORG.api('POST', '/api/org/profile', b).then(function (d) {
      btn.disabled = false; $('saveStatus').textContent = '';
      S.hasOrg = true; if (d.organization) { S.slug = d.organization.slug; if (d.organization.profile_data) { S.published = d.organization.profile_data.published === true; S.reviewStatus = d.organization.profile_data.review_status || S.reviewStatus; } }
      if (typeof after === 'function') after();
      else showOk('Saved.' + (d.completeness != null ? (' Your profile is ' + d.completeness + '% complete.') : ''));
      render(); window.scrollTo(0, 0);
    }).catch(function (e) { btn.disabled = false; $('saveStatus').textContent = ''; showErr(e.message); });
  }
  function preview() {
    if (!S.slug) { showErr('Save your profile first, then preview it.'); return; }
    window.open('/pro.html?slug=' + encodeURIComponent(S.slug) + '&preview=1', 'ppreview', 'noopener'); // reuse one named tab
  }
})();

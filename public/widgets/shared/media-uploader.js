/**
 * Advantage Media Uploader — reusable platform media component.
 *
 * A dependency-free, self-contained uploader used across Advantage.Bid. Marketplace Events is the
 * first consumer; the same component serves auction lot photos, marketplace item listings, company
 * logos, profile photos, marketing assets, seller documents, and (future) video — without forking.
 *
 * It is auth- and product-agnostic: the HOST supplies a signature source and persistence callbacks.
 * The component only does upload mechanics (drag-drop, hundreds of files, concurrency, progress,
 * retry, cancel, drag-reorder, cover selection) and uploads bytes DIRECTLY to object storage.
 *
 * Usage:
 *   AdvantageMedia.mount({
 *     el: '#mediaUploader',
 *     getSignature: () => fetch('/api/uploads/signature', {...}).then(r => r.json()),
 *     onAttach:  (uploads) => Promise<items[]>,     // persist; return [{id,url,is_cover,position}]
 *     onReorder: (orderIds, coverId) => Promise<items[]>,  // optional
 *     onRemove:  (id) => Promise,                    // optional
 *     existing:  [{id,url,is_cover,position}],        // optional
 *     accept:    'image',                             // 'image' | 'video'
 *     maxFiles:  Infinity,                            // remaining allowance (Gold = Infinity)
 *     concurrency: 5,
 *   });
 */
(function () {
  'use strict';

  var STYLE_ID = 'amu-styles';
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.amu{display:flex;flex-direction:column;gap:12px}',
      '.amu-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}',
      '.amu-tile{position:relative;aspect-ratio:1/1;border-radius:10px;background:#eef1f4 center/cover no-repeat;overflow:hidden;border:1px solid rgba(0,0,0,.08)}',
      '.amu-tile[draggable=true]{cursor:grab}',
      '.amu-tile.amu-drag{opacity:.4}',
      '.amu-tile.amu-over{outline:2px dashed #5f7ea3;outline-offset:-2px}',
      '.amu-badge{position:absolute;top:6px;left:6px;background:#2f6b3d;color:#fff;font:600 11px/1 system-ui,sans-serif;padding:4px 7px;border-radius:6px}',
      '.amu-x{position:absolute;top:6px;right:6px;width:24px;height:24px;border:0;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:13px;line-height:24px;cursor:pointer;padding:0}',
      '.amu-cover-btn{position:absolute;bottom:6px;left:6px;right:6px;border:0;border-radius:6px;background:rgba(255,255,255,.92);color:#20303f;font:600 11px/1 system-ui,sans-serif;padding:6px;cursor:pointer;opacity:0;transition:opacity .12s}',
      '.amu-tile:hover .amu-cover-btn{opacity:1}',
      '.amu-prog{position:absolute;left:0;right:0;bottom:0;height:6px;background:rgba(0,0,0,.15)}',
      '.amu-prog>i{display:block;height:100%;background:#5f7ea3;width:0;transition:width .15s}',
      '.amu-tile.amu-err{outline:2px solid #c0392b;outline-offset:-2px}',
      '.amu-retry{position:absolute;inset:0;margin:auto;width:90%;height:30px;border:0;border-radius:6px;background:#c0392b;color:#fff;font:600 12px/1 system-ui,sans-serif;cursor:pointer}',
      '.amu-drop{border:2px dashed #b9c4d0;border-radius:12px;padding:22px;text-align:center;color:#5b6b7e;cursor:pointer;font:500 14px/1.4 system-ui,sans-serif;background:#fbfcfd}',
      '.amu-drop.amu-hover{border-color:#5f7ea3;background:#f2f6fa;color:#20303f}',
      '.amu-status{font:500 13px/1.4 system-ui,sans-serif;color:#5b6b7e;display:flex;gap:14px;flex-wrap:wrap;align-items:center}',
      '.amu-status .amu-err-txt{color:#c0392b}',
      '.amu-status button{border:0;background:none;color:#5f7ea3;font-weight:600;cursor:pointer;padding:0}'
    ].join('');
    document.head.appendChild(s);
  }

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // Cloudinary delivery transform for a light, square, auto-optimized thumbnail.
  function thumb(url) {
    if (!url || url.indexOf('/upload/') === -1) return url;
    return url.replace('/upload/', '/upload/c_fill,w_400,h_400,q_auto,f_auto/');
  }

  var IMAGE_MIME = /^image\//;
  var VIDEO_MIME = /^video\//;

  function mount(cfg) {
    injectStyles();
    var root = typeof cfg.el === 'string' ? document.querySelector(cfg.el) : cfg.el;
    if (!root) throw new Error('AdvantageMedia.mount: element not found');
    if (typeof cfg.getSignature !== 'function' || typeof cfg.onAttach !== 'function') {
      throw new Error('AdvantageMedia.mount requires getSignature() and onAttach()');
    }

    var accept = cfg.accept || 'image';
    var mimeRe = accept === 'video' ? VIDEO_MIME : IMAGE_MIME;
    var maxFiles = cfg.maxFiles == null ? Infinity : cfg.maxFiles;
    var concurrency = cfg.concurrency || 5;

    var items = (cfg.existing || []).slice().sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
    var jobs = [];          // in-flight/queued upload jobs (temp tiles)
    var sig = null, sigAt = 0;
    var jobSeq = 0, running = 0, destroyed = false;

    root.className = 'amu';
    root.innerHTML = '';
    var grid = el('div', 'amu-grid');
    var drop = el('div', 'amu-drop', '＋ Drag photos here, or click to choose (select as many as you like)');
    var input = el('input'); input.type = 'file'; input.multiple = true; input.accept = accept === 'video' ? 'video/*' : 'image/*'; input.hidden = true;
    var status = el('div', 'amu-status');
    root.appendChild(grid); root.appendChild(drop); root.appendChild(input); root.appendChild(status);

    // ── signature (cached ~50 min; refreshed on demand) ──────────────────────
    function freshSig(force) {
      var age = Date.now() - sigAt;
      if (sig && !force && age < 50 * 60 * 1000) return Promise.resolve(sig);
      return Promise.resolve(cfg.getSignature()).then(function (s) {
        if (!s || !s.signature) throw new Error((s && s.message) || 'Could not authorize upload.');
        sig = s; sigAt = Date.now(); return s;
      });
    }

    // ── rendering ────────────────────────────────────────────────────────────
    function count() { return items.length + jobs.filter(function (j) { return j.status !== 'done'; }).length; }
    function remaining() { return maxFiles === Infinity ? Infinity : Math.max(0, maxFiles - count()); }

    function render() {
      grid.innerHTML = '';
      items.forEach(function (it, i) { grid.appendChild(itemTile(it, i)); });
      jobs.forEach(function (j) { if (j.status !== 'done') grid.appendChild(jobTile(j)); });
      renderStatus();
    }
    function renderStatus() {
      var parts = [items.length + (items.length === 1 ? ' photo' : ' photos')];
      if (maxFiles !== Infinity) parts.push(remaining() + ' of ' + maxFiles + ' remaining');
      else parts.push('unlimited');
      var uploading = jobs.filter(function (j) { return j.status === 'uploading' || j.status === 'queued'; }).length;
      if (uploading) parts.push(uploading + ' uploading…');
      var errs = jobs.filter(function (j) { return j.status === 'error'; }).length;
      status.innerHTML = '<span>' + parts.join(' • ') + '</span>'
        + (errs ? '<span class="amu-err-txt">' + errs + ' failed</span> <button type="button" id="amu-retryall">Retry all</button>' : '');
      var r = status.querySelector('#amu-retryall');
      if (r) r.onclick = function () { jobs.filter(function (j) { return j.status === 'error'; }).forEach(function (j) { j.status = 'queued'; }); render(); pump(); };
    }

    function itemTile(it, index) {
      var t = el('div', 'amu-tile');
      t.style.backgroundImage = "url('" + esc(thumb(it.url)) + "')";
      t.setAttribute('draggable', 'true');
      t.dataset.id = it.id;
      if (it.is_cover) t.appendChild(el('span', 'amu-badge', 'Cover'));
      else { var cb = el('button', 'amu-cover-btn', 'Set as cover'); cb.type = 'button'; cb.onclick = function (e) { e.stopPropagation(); setCover(it.id); }; t.appendChild(cb); }
      var x = el('button', 'amu-x', '✕'); x.type = 'button'; x.title = 'Remove'; x.onclick = function (e) { e.stopPropagation(); removeItem(it.id); }; t.appendChild(x);
      wireDrag(t, index);
      return t;
    }

    function jobTile(j) {
      var t = el('div', 'amu-tile' + (j.status === 'error' ? ' amu-err' : ''));
      t.dataset.job = j.id;
      if (j.preview) t.style.backgroundImage = "url('" + j.preview + "')";
      if (j.status === 'error') {
        var rb = el('button', 'amu-retry', 'Retry'); rb.type = 'button'; rb.onclick = function () { j.status = 'queued'; render(); pump(); }; t.appendChild(rb);
      } else {
        var p = el('div', 'amu-prog'); var bar = el('i'); bar.style.width = (j.progress || 0) + '%'; p.appendChild(bar); t.appendChild(p);
      }
      var x = el('button', 'amu-x', '✕'); x.type = 'button'; x.title = 'Cancel'; x.onclick = function () { cancelJob(j); }; t.appendChild(x);
      return t;
    }

    // ── drag-to-reorder (persisted items only) ───────────────────────────────
    var dragIndex = null;
    function wireDrag(t, index) {
      t.addEventListener('dragstart', function () { dragIndex = index; t.classList.add('amu-drag'); });
      t.addEventListener('dragend', function () { dragIndex = null; t.classList.remove('amu-drag'); Array.prototype.forEach.call(grid.children, function (c) { c.classList.remove('amu-over'); }); });
      t.addEventListener('dragover', function (e) { e.preventDefault(); t.classList.add('amu-over'); });
      t.addEventListener('dragleave', function () { t.classList.remove('amu-over'); });
      t.addEventListener('drop', function (e) {
        e.preventDefault(); t.classList.remove('amu-over');
        if (dragIndex == null || dragIndex === index) return;
        var moved = items.splice(dragIndex, 1)[0];
        items.splice(index, 0, moved);
        render(); persistOrder();
      });
    }

    // ── persistence bridges (host callbacks) ─────────────────────────────────
    function currentCoverId() { var c = items.filter(function (i) { return i.is_cover; })[0]; return c ? c.id : (items[0] && items[0].id); }
    function persistOrder(coverId) {
      if (typeof cfg.onReorder !== 'function') return;
      var order = items.map(function (i) { return i.id; });
      Promise.resolve(cfg.onReorder(order, coverId || currentCoverId())).then(function (updated) {
        if (Array.isArray(updated)) { items = updated.slice().sort(function (a, b) { return (a.position || 0) - (b.position || 0); }); render(); }
      }).catch(function (e) { flash(e.message || 'Could not save order.'); });
    }
    function setCover(id) {
      items = items.map(function (i) { return Object.assign({}, i, { is_cover: i.id === id }); });
      render(); persistOrder(id);
    }
    function removeItem(id) {
      var doRemove = typeof cfg.onRemove === 'function' ? cfg.onRemove(id) : Promise.resolve();
      Promise.resolve(doRemove).then(function () { items = items.filter(function (i) { return i.id !== id; }); render(); })
        .catch(function (e) { flash(e.message || 'Could not remove photo.'); });
    }

    function flash(msg) { status.innerHTML = '<span class="amu-err-txt">' + esc(msg) + '</span>'; setTimeout(renderStatus, 4000); }

    // ── selection + upload queue ─────────────────────────────────────────────
    function addFiles(fileList) {
      var files = Array.prototype.slice.call(fileList).filter(function (f) { return mimeRe.test(f.type); });
      var room = remaining();
      if (room !== Infinity && files.length > room) { files = files.slice(0, room); flash('Your plan allows ' + maxFiles + ' photos — extra files were not added.'); }
      files.forEach(function (f) {
        jobs.push({ id: ++jobSeq, file: f, preview: URL.createObjectURL(f), status: 'queued', progress: 0, xhr: null });
      });
      render(); pump();
    }

    function pump() {
      if (destroyed) return;
      var queued = jobs.filter(function (j) { return j.status === 'queued'; });
      while (running < concurrency && queued.length) { startJob(queued.shift()); }
      if (!running && !jobs.some(function (j) { return j.status === 'queued' || j.status === 'uploading'; })) flush();
    }

    function startJob(j, isRetry) {
      j.status = 'uploading'; running += 1; renderStatus();
      freshSig().then(function (s) {
        var fd = new FormData();
        fd.append('file', j.file);
        fd.append('api_key', s.api_key);
        fd.append('timestamp', s.timestamp);
        fd.append('signature', s.signature);
        fd.append('folder', s.folder);
        var xhr = new XMLHttpRequest(); j.xhr = xhr;
        xhr.open('POST', 'https://api.cloudinary.com/v1_1/' + s.cloud_name + '/' + (s.resource_type || 'image') + '/upload');
        xhr.upload.onprogress = function (e) { if (e.lengthComputable) { j.progress = Math.round(e.loaded / e.total * 95); updateBar(j); } };
        xhr.onload = function () {
          running -= 1;
          if (xhr.status >= 200 && xhr.status < 300) {
            var res = {}; try { res = JSON.parse(xhr.responseText); } catch (_e) {}
            j.status = 'done'; j.result = { url: res.secure_url, public_id: res.public_id, width: res.width, height: res.height };
            pump();
          } else if ((xhr.status === 401 || xhr.status === 400) && !isRetry) {
            // Likely an expired/invalid signature — refresh once and retry this file.
            freshSig(true).then(function () { startJob(j, true); }).catch(function () { failJob(j); });
          } else { failJob(j); }
        };
        xhr.onerror = function () { running -= 1; failJob(j); };
        xhr.onabort = function () { running -= 1; };
        xhr.send(fd);
      }).catch(function () { running -= 1; failJob(j); });
    }
    function failJob(j) { j.status = 'error'; render(); pump(); }
    function updateBar(j) {
      var bar = grid.querySelector('.amu-tile[data-job="' + j.id + '"] .amu-prog>i');
      if (bar) bar.style.width = (j.progress || 0) + '%';
    }
    function cancelJob(j) {
      if (j.xhr && j.status === 'uploading') { try { j.xhr.abort(); } catch (_e) {} }
      jobs = jobs.filter(function (x) { return x.id !== j.id; });
      if (j.preview) URL.revokeObjectURL(j.preview);
      render(); pump();
    }

    // When the queue drains, persist all successful uploads in one bulk call.
    function flush() {
      var done = jobs.filter(function (j) { return j.status === 'done'; });
      if (!done.length) { render(); return; }
      var uploads = done.map(function (j) { return j.result; });
      jobs = jobs.filter(function (j) { return j.status !== 'done'; }); // clear temp tiles; server is source of truth
      done.forEach(function (j) { if (j.preview) URL.revokeObjectURL(j.preview); });
      Promise.resolve(cfg.onAttach(uploads)).then(function (persisted) {
        if (Array.isArray(persisted)) {
          persisted.forEach(function (p) { if (!items.some(function (i) { return i.id === p.id; })) items.push(p); });
          items.sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
          if (persisted.length < uploads.length) flash((uploads.length - persisted.length) + ' photo(s) exceeded your plan limit and were not added.');
        }
        render();
      }).catch(function (e) { flash(e.message || 'Could not save photos.'); render(); });
    }

    // ── events ───────────────────────────────────────────────────────────────
    drop.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { if (this.files && this.files.length) addFiles(this.files); this.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('amu-hover'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('amu-hover'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

    render();

    return {
      getItems: function () { return items.slice(); },
      destroy: function () { destroyed = true; jobs.forEach(function (j) { if (j.xhr) try { j.xhr.abort(); } catch (_e) {} if (j.preview) URL.revokeObjectURL(j.preview); }); root.innerHTML = ''; },
    };
  }

  window.AdvantageMedia = { mount: mount };
})();

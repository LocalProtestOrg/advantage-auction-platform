/* agreement-render.js — renders an agreement's frozen text (lightweight markdown: #/## headings, **bold**, - bullets,
   --- rules, > quotes) into DOM nodes. Mirrors src/services/agreementPdfService.parseAgreementMarkdown, so the page,
   the printed copy and the PDF show the same document. Builds nodes with textContent only (never innerHTML), so
   agreement text can never become markup or script.

   window.AgreementRender.render(text, containerElement, doc?) → { blocks, headings, chars }  (chars = visible text expected)
   window.AgreementRender.sha256Hex(text)                       → Promise<hex>  (the server's content hash) */
(function () {
  'use strict';

  function parse(md) {
    var blocks = [];
    var lines = String(md == null ? '' : md).replace(/\r\n/g, '\n').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+$/, '');
      var m;
      if (/^\s*---\s*$/.test(line)) blocks.push({ type: 'hr' });
      else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) blocks.push({ type: 'heading', level: m[1].length, text: m[2] });
      else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) blocks.push({ type: 'bullet', text: m[1] });
      else if ((m = line.match(/^>\s?(.*)$/))) blocks.push({ type: 'quote', text: m[1] });
      else if (line.trim() === '') blocks.push({ type: 'space' });
      else blocks.push({ type: 'para', text: line });
    }
    return blocks;
  }

  // Visible characters of a line once its bold markers are removed (what the reader actually sees).
  function visible(text) { return String(text == null ? '' : text).replace(/\*\*([^*]+)\*\*/g, '$1').length; }

  function inline(doc, el, text) {
    var parts = String(text == null ? '' : text).split(/(\*\*[^*]+\*\*)/g);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      var m = p.match(/^\*\*([^*]+)\*\*$/);
      if (m) { var b = doc.createElement('strong'); b.textContent = m[1]; el.appendChild(b); }
      else el.appendChild(doc.createTextNode(p));
    }
    return el;
  }

  function render(md, container, doc) {
    doc = doc || document;
    while (container.firstChild) container.removeChild(container.firstChild);
    var blocks = parse(md);
    var list = null; var headings = 0; var chars = 0;
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.type !== 'bullet') list = null;
      if (b.type === 'hr') container.appendChild(doc.createElement('hr'));
      else if (b.type === 'heading') {
        var h = doc.createElement('h' + Math.min(6, b.level + 1));
        inline(doc, h, b.text); container.appendChild(h); headings++; chars += visible(b.text);
      } else if (b.type === 'bullet') {
        if (!list) { list = doc.createElement('ul'); container.appendChild(list); }
        list.appendChild(inline(doc, doc.createElement('li'), b.text)); chars += visible(b.text);
      } else if (b.type === 'quote') {
        container.appendChild(inline(doc, doc.createElement('blockquote'), b.text)); chars += visible(b.text);
      } else if (b.type === 'para') {
        container.appendChild(inline(doc, doc.createElement('p'), b.text)); chars += visible(b.text);
      }
    }
    return { blocks: blocks.length, headings: headings, chars: chars };
  }

  function sha256Hex(text) {
    if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) return Promise.reject(new Error('no_crypto'));
    return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text))).then(function (buf) {
      var a = new Uint8Array(buf); var s = '';
      for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
      return s;
    });
  }

  window.AgreementRender = { parse: parse, render: render, sha256Hex: sha256Hex };
})();

/* Minimal, dependency-free Markdown to HTML renderer for the policy pages (Terms of Service, Buyer Terms, Privacy).
 * Supports: # to ###### headings (each gets a stable id for linking), --- rules, **bold**, *italic*, ordered and
 * unordered lists, [text](url) links, pipe tables, and paragraphs.
 * SAFETY: every piece of text is HTML-escaped BEFORE inline formatting, so raw HTML in the source is shown as text and
 * never injected. Link targets are limited to http(s), mailto, tel, site-relative paths and #anchors; anything else
 * (javascript:, data:, ...) is rendered as plain text.
 *
 *   renderMarkdown(md)                 -> HTML string
 *   renderMarkdownInto(srcId, destId)  -> renders a <script type="text/plain"> block into an element
 *   renderMarkdownToc(html, minCount)  -> a contents list of the h2 sections, or '' when there are fewer than minCount
 */
(function () {
  'use strict';
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeHref(u) {
    var raw = String(u).trim();
    // The text was already escaped; undo &amp; for the scheme test only.
    var plain = raw.replace(/&amp;/g, '&');
    if (/^(https?:\/\/|mailto:|tel:)/i.test(plain) || /^\/(?!\/)/.test(plain) || /^#[\w-]*$/.test(plain)) return raw;
    return null;
  }
  function inline(s) {
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (all, t, u) {
      var href = safeHref(u);
      if (!href) return t;
      var ext = /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener"' : '';
      return '<a href="' + href + '"' + ext + '>' + t + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    return s;
  }
  function slug(text, used) {
    var base = String(text).toLowerCase().replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
    var id = base, n = 2;
    while (used[id]) id = base + '-' + (n++);
    used[id] = true;
    return id;
  }
  function render(md) {
    var lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    var out = [], i = 0, used = {};
    function isTableSep(l) { return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.indexOf('-') !== -1; }
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      var h = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (h) {
        var n = h[1].length, txt = h[2].trim().replace(/\s+#+\s*$/, '');
        out.push('<h' + n + ' id="' + slug(txt, used) + '">' + inline(txt) + '</h' + n + '>'); i++; continue;
      }
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var cells = function (l) { return l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); }); };
        var head = cells(line);
        out.push('<div class="md-table"><table><thead><tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>');
        i += 2;
        while (i < lines.length && lines[i].indexOf('|') !== -1 && !/^\s*$/.test(lines[i])) {
          out.push('<tr>' + cells(lines[i]).map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>');
          i++;
        }
        out.push('</tbody></table></div>');
        continue;
      }
      if (/^\s*(\d+\.|[*-])\s+/.test(line)) {
        var ordered = /^\s*\d+\.\s+/.test(line);
        var start = ordered ? parseInt(line.trim(), 10) : 1;
        out.push(ordered ? (start > 1 ? '<ol start="' + start + '">' : '<ol>') : '<ul>');
        while (i < lines.length && /^\s*(\d+\.|[*-])\s+/.test(lines[i]) && (/^\s*\d+\.\s+/.test(lines[i]) === ordered)) {
          var item = lines[i].replace(/^\s*(\d+\.|[*-])\s+/, '');
          i++;
          // a wrapped continuation line (indented, not a new block) belongs to the same item
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(\d+\.|[*-])\s+/.test(lines[i])) { item += ' ' + lines[i].trim(); i++; }
          out.push('<li>' + inline(item) + '</li>');
        }
        out.push(ordered ? '</ol>' : '</ul>');
        continue;
      }
      var para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(#{1,6}\s|---+\s*$|\d+\.\s|[*-]\s)/.test(lines[i]) && !(lines[i].indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
        para.push(lines[i].trim()); i++;
      }
      if (para.length) out.push('<p>' + inline(para.join(' ')) + '</p>');
      else i++;
    }
    return out.join('\n');
  }
  // A contents list built from the rendered h2 headings (ids already escaped and slugged by render()).
  function toc(html, minCount) {
    var items = [], re = /<h2 id="([a-z0-9-]+)">([\s\S]*?)<\/h2>/g, m;
    while ((m = re.exec(html))) items.push('<li><a href="#' + m[1] + '">' + m[2].replace(/<\/?(strong|em|a)[^>]*>/g, '') + '</a></li>');
    if (items.length < (minCount || 4)) return '';
    return '<nav class="md-toc" aria-label="Contents"><div class="md-toc-title">Contents</div><ol>' + items.join('') + '</ol></nav>';
  }
  var root = typeof window !== 'undefined' ? window : {};
  root.renderMarkdownInto = function (srcId, destId) {
    var src = document.getElementById(srcId), dest = document.getElementById(destId);
    if (src && dest) dest.innerHTML = render(src.textContent || '');
  };
  root.renderMarkdown = render;
  root.renderMarkdownToc = toc;
  if (typeof module !== 'undefined' && module.exports) module.exports = { render: render, toc: toc };
})();

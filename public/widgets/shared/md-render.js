/* Minimal, dependency-free Markdown → HTML renderer for the static policy pages
 * (Terms, Privacy). Supports: # ## ### headings, --- rules, **bold**, ordered &
 * unordered lists, [text](url) links, pipe tables, and paragraphs. Input is read
 * from a <script type="text/plain"> block so no JS-escaping of the policy text is
 * needed. Output is escaped before inline formatting is applied.
 */
(function () {
  'use strict';
  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function inline(s) {
    s = esc(s);
    // links [text](url) — url is attribute-escaped for quotes
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, t, u) {
      var safeU = u.replace(/"/g, '&quot;');
      var ext = /^https?:\/\//.test(u) ? ' target="_blank" rel="noopener"' : '';
      return '<a href="' + safeU + '"' + ext + '>' + t + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return s;
  }
  function render(md) {
    var lines = String(md).replace(/\r\n/g, '\n').split('\n');
    var out = [], i = 0;
    function isTableSep(l) { return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.indexOf('-') !== -1; }
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      // horizontal rule
      if (/^\s*---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      // headings
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { var n = h[1].length; out.push('<h' + n + '>' + inline(h[2].trim()) + '</h' + n + '>'); i++; continue; }
      // table (line with | and next line is a separator)
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var cells = function (l) { return l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); }); };
        var head = cells(line);
        out.push('<table><thead><tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>');
        i += 2;
        while (i < lines.length && lines[i].indexOf('|') !== -1 && !/^\s*$/.test(lines[i])) {
          out.push('<tr>' + cells(lines[i]).map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>');
          i++;
        }
        out.push('</tbody></table>');
        continue;
      }
      // lists
      if (/^\s*(\d+\.|[*-])\s+/.test(line)) {
        var ordered = /^\s*\d+\.\s+/.test(line);
        out.push(ordered ? '<ol>' : '<ul>');
        while (i < lines.length && /^\s*(\d+\.|[*-])\s+/.test(lines[i])) {
          out.push('<li>' + inline(lines[i].replace(/^\s*(\d+\.|[*-])\s+/, '')) + '</li>');
          i++;
        }
        out.push(ordered ? '</ol>' : '</ul>');
        continue;
      }
      // paragraph (accumulate until blank / block)
      var para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(#{1,6}\s|---+\s*$|\d+\.\s|[*-]\s)/.test(lines[i]) && !(lines[i].indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
        para.push(lines[i]); i++;
      }
      out.push('<p>' + inline(para.join(' ')) + '</p>');
    }
    return out.join('\n');
  }
  window.renderMarkdownInto = function (srcId, destId) {
    var src = document.getElementById(srcId), dest = document.getElementById(destId);
    if (src && dest) dest.innerHTML = render(src.textContent || '');
  };
  window.renderMarkdown = render;
})();

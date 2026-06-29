// #7b — agreement PDF markdown rendering. Pure-parser tests + a real PDF render
// (PDFKit only; no DB/Cloudinary), proving markdown markers are parsed, not printed raw.
const { parseAgreementMarkdown, parseInlineBold, buildUnsignedPdfBuffer } = require('../src/services/agreementPdfService');

describe('agreement markdown parsing', () => {
  test('headings/bold/hr/bullets/paragraphs parse correctly', () => {
    const md = '# Title\n\n## 1. Section\n\nSome **bold** text.\n\n- item one\n- item two\n\n---\n\nPlain line.';
    const b = parseAgreementMarkdown(md);
    expect(b.find(x => x.type === 'heading' && x.level === 1 && x.text === 'Title')).toBeTruthy();
    expect(b.find(x => x.type === 'heading' && x.level === 2 && x.text === '1. Section')).toBeTruthy();
    expect(b.filter(x => x.type === 'bullet').map(x => x.text)).toEqual(['item one', 'item two']);
    expect(b.find(x => x.type === 'hr')).toBeTruthy();
    expect(b.find(x => x.type === 'para' && x.text === 'Plain line.')).toBeTruthy();
  });

  test('heading text has the # markers stripped', () => {
    expect(parseAgreementMarkdown('## 11. Limitation')[0].text).toBe('11. Limitation');
    expect(parseAgreementMarkdown('## 11. Limitation')[0].text).not.toMatch(/#/);
  });

  test('inline bold splits into runs with ** stripped', () => {
    expect(parseInlineBold('a **b** c')).toEqual([{ text: 'a ', bold: false }, { text: 'b', bold: true }, { text: ' c', bold: false }]);
    expect(parseInlineBold('plain')).toEqual([{ text: 'plain', bold: false }]);
    expect(parseInlineBold('**x**')[0]).toEqual({ text: 'x', bold: true });
  });

  test('buildUnsignedPdfBuffer renders a valid PDF from a markdown body', async () => {
    const buf = await buildUnsignedPdfBuffer({
      rendered_body: '# Seller Agreement\n\n## 1. Scope\n\nThis is **bold** and plain text.\n\n- one\n- two\n\n---\n\nGoverning law clause.',
      party_snapshot: {}, resolved_variables: {},
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(800);
  });
});

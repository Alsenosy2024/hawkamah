import { describe, it, expect, vi } from 'vitest';

// pptxExport pulls in pptxgenjs (browser bundle) + diagramService (mermaid); neither
// resolves under the node test runner and neither is needed to exercise the PURE
// `toSections` grouping. Stub them so the grouping logic loads in isolation.
vi.mock('pptxgenjs', () => ({ default: class {} }));
vi.mock('../../services/diagramService', () => ({
  mermaidToPng: async () => ({ png: '', width: 0, height: 0 }),
}));

import { toSections } from '../../services/pptxExport';
import { markdownToDocSpec, buildCanvasHtml, canvasHtmlToMarkdown } from '../../services/canvasDocument';

// ===========================================================================
//  V1 / V12 — export pipeline.
//
//  • PPTX over-chunking (V1): only top-level headings (h1/h2) start a new
//    slide group; h3–h6 become bold sub-heading LINES inside the section. This
//    is the fix for the "two words per slide" defect where every heading level
//    fanned out into its own near-empty slide.
//  • Canvas → Markdown bridge (V12): the live, EDITED canvas HTML serializes
//    back to Markdown so the Word/PPTX/Excel exporters match what the user sees
//    (PDF prints the same HTML directly).
// ===========================================================================

const REPORT_MD = [
  '# عنوان الوثيقة',
  '',
  '## القسم الأول',
  'فقرة تمهيدية هنا.',
  '',
  '### عنوان فرعي أ',
  '- بند أول',
  '- بند ثانٍ',
  '',
  '### عنوان فرعي ب',
  'نص تحت العنوان الفرعي.',
  '',
  '## القسم الثاني',
  'محتوى القسم الثاني.',
].join('\n');

describe('pptx toSections — only h1/h2 split slides (no "two words per slide")', () => {
  const secs = toSections(REPORT_MD, 'Deck');
  const titles = secs.map(s => s.title);

  it('creates one section per top-level heading only', () => {
    expect(titles).toEqual(['عنوان الوثيقة', 'القسم الأول', 'القسم الثاني']);
  });

  it('never promotes an h3 sub-heading into its own slide/section', () => {
    expect(titles).not.toContain('عنوان فرعي أ');
    expect(titles).not.toContain('عنوان فرعي ب');
  });

  it('keeps h3 sub-headings as bold lines inside their parent section', () => {
    const parent = secs.find(s => s.title === 'القسم الأول')!;
    const lines = parent.body.flatMap(b => (b.kind === 'lines' ? b.lines : []));
    expect(lines.some(l => l.sub && l.text.includes('عنوان فرعي أ'))).toBe(true);
    expect(lines.some(l => l.sub && l.text.includes('عنوان فرعي ب'))).toBe(true);
    // ...and the bullets under that sub-heading stay in the SAME section (grouped,
    // not exploded), so the slide is actually filled.
    expect(lines.some(l => l.bullet && l.text.includes('بند أول'))).toBe(true);
  });
});

describe('canvasHtmlToMarkdown — round-trips the edited canvas back to Markdown', () => {
  const md = [
    '# تقرير الحوكمة',
    '',
    '## المقدمة',
    'هذه فقرة **مهمة** للغاية.',
    '',
    '## النطاق',
    '- البند الأول',
    '- البند الثاني',
    '',
    '| المعيار | الحالة |',
    '| --- | --- |',
    '| التوثيق | مكتمل |',
    '',
    '> ملاحظة جانبية.',
  ].join('\n');

  const html = buildCanvasHtml(markdownToDocSpec(md, { title: '', subtitle: 'وثيقة حوكمة' }));
  const out = canvasHtmlToMarkdown(html);

  it('preserves the section headings', () => {
    expect(out).toContain('## المقدمة');
    expect(out).toContain('## النطاق');
  });

  it('preserves paragraph text with inline bold', () => {
    expect(out).toContain('**مهمة**');
    expect(out).toContain('هذه فقرة');
  });

  it('preserves list items', () => {
    expect(out).toContain('- البند الأول');
    expect(out).toContain('- البند الثاني');
  });

  it('preserves tables as Markdown tables', () => {
    expect(out).toContain('| المعيار | الحالة |');
    expect(out).toContain('| التوثيق |');
    expect(out).toMatch(/\|\s*---\s*\|/); // separator row
  });

  it('preserves blockquotes / callouts', () => {
    expect(out).toContain('> ملاحظة جانبية.');
  });

  it('drops the cover title + TOC (those ride the PDF, not the text formats)', () => {
    // The first heading became the cover title, so it is NOT a body heading.
    expect(out).not.toContain('# تقرير الحوكمة');
    expect(out).not.toContain('جدول المحتويات');
  });

  it('returns a non-empty, trimmed Markdown document', () => {
    expect(out.trim().length).toBeGreaterThan(20);
    expect(out.endsWith('\n')).toBe(true);
  });
});

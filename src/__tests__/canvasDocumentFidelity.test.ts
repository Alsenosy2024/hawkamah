import { describe, it, expect } from 'vitest';
import {
  inline, markdownToDocSpec, artifactToMarkdown, buildCanvasHtml, type ArtifactLike,
} from '../../services/canvasDocument';

// ===========================================================================
//  P13 canvas-fidelity audit fixes:
//   1. CRITICAL — ≥ ≤ > < comparison operators get the SAME LTR-bidi-isolation
//      treatment inline() already lacked (services/markdownAst.ts's
//      escapeHtmlBidi), so a KPI threshold never visually mirrors in the RTL
//      canvas / PDF export.
//   2. CRITICAL — RLM-prefixed bullet/heading/table/quote lines (as emitted by
//      services/governanceArtifacts.ts's bullet builders) are recognized as
//      real block structure instead of falling through to garbled paragraphs.
//   3. MAJOR — a backend-generated «الفهرس» table-of-contents section (a
//      numbered list of [Title](#anchor) links) is dropped from the body spec
//      instead of duplicating the canvas's own TOC page.
//   4. MAJOR — per-section citations (ArtifactLike.citations) are threaded
//      through artifactToMarkdown → markdownToDocSpec into DocSpec.srcRefs, so
//      [مصدر N] markers resolve to real chips and a «المصادر» section appears.
// ===========================================================================

const RLM = '‏';

describe('inline() — LTR bidi isolation for comparison operators (CRITICAL fix 1)', () => {
  it('wraps a ≥ threshold in an LTR isolate span so it cannot visually mirror to ≤', () => {
    const out = inline('نسبة الالتزام ≥ 90%');
    expect(out).toContain('<span dir="ltr" style="unicode-bidi:isolate;white-space:nowrap">≥ 90%</span>');
  });

  it('wraps a ≤ threshold too', () => {
    const out = inline('معدل الأخطاء ≤ 5%');
    expect(out).toContain('dir="ltr"');
    expect(out).toContain('≤ 5%');
  });

  it('still applies markdown emphasis around an isolated token (bold KPI text)', () => {
    const out = inline('**≥ 90%** مستهدف');
    expect(out).toContain('<strong>');
    expect(out).toContain('dir="ltr"');
  });

  it('leaves plain text (no comparison operator) unaffected beyond normal escaping', () => {
    const out = inline('نص عادي بدون أرقام مقارنة');
    expect(out).not.toContain('dir="ltr"');
  });
});

describe('markdownToDocSpec — RLM-prefixed lines are recognized as real block structure (CRITICAL fix 2)', () => {
  it('parses an RLM-prefixed unordered bullet as a real list item, not a paragraph', () => {
    const md = `# عنوان\n\n## القسم\n${RLM}- بند أول\n${RLM}- بند ثانٍ`;
    const spec = markdownToDocSpec(md, { lang: 'ar' });
    const list = spec.blocks.find(b => b.type === 'list');
    expect(list).toBeTruthy();
    if (list?.type === 'list') {
      expect(list.items).toEqual(['بند أول', 'بند ثانٍ']);
      // the leading RLM must not leak into the extracted item text
      expect(list.items.every(it => !it.includes(RLM))).toBe(true);
    }
    expect(spec.blocks.some(b => b.type === 'paragraph' && b.text.includes(RLM))).toBe(false);
  });

  it('parses an RLM-prefixed ordered bullet correctly', () => {
    const md = `# عنوان\n\n## القسم\n${RLM}1. الخطوة الأولى\n${RLM}2. الخطوة الثانية`;
    const spec = markdownToDocSpec(md, { lang: 'ar' });
    const list = spec.blocks.find(b => b.type === 'list' && b.ordered);
    expect(list).toBeTruthy();
    if (list?.type === 'list') expect(list.items).toEqual(['الخطوة الأولى', 'الخطوة الثانية']);
  });

  it('parses an RLM-prefixed heading as a real section heading', () => {
    const md = `# عنوان\n\n${RLM}## قسم محاط بعلامة اتجاه`;
    const spec = markdownToDocSpec(md, { lang: 'ar' });
    const heading = spec.blocks.find(b => b.type === 'heading');
    expect(heading?.type === 'heading' && heading.text).toBe('قسم محاط بعلامة اتجاه');
  });

  it('parses an RLM-prefixed blockquote as a callout', () => {
    const md = `# عنوان\n\n## القسم\n${RLM}> ملاحظة مهمة`;
    const spec = markdownToDocSpec(md, { lang: 'ar' });
    const callout = spec.blocks.find(b => b.type === 'callout');
    expect(callout?.type === 'callout' && callout.text).toBe('ملاحظة مهمة');
  });

  it('keeps a bidi-control character INSIDE a line intact (only the leading run is stripped)', () => {
    const md = `# عنوان\n\n## القسم\nنص يحتوي ${RLM} علامة اتجاه في المنتصف`;
    const spec = markdownToDocSpec(md, { lang: 'ar' });
    const para = spec.blocks.find(b => b.type === 'paragraph');
    expect(para?.type === 'paragraph' && para.text.includes(RLM)).toBe(true);
  });
});

describe('markdownToDocSpec — backend «الفهرس» TOC section is dropped (MAJOR fix 3)', () => {
  const backendToc = [
    '# ميثاق الحوكمة',
    '',
    '## الفهرس',
    '1. [الأهداف](#ahdaf)',
    '2. [النطاق](#nitaq)',
    '',
    '## الأهداف',
    'نص الأهداف الحقيقي.',
  ].join('\n');

  it('never emits a heading block titled الفهرس', () => {
    const spec = markdownToDocSpec(backendToc, { lang: 'ar' });
    expect(spec.blocks.some(b => b.type === 'heading' && b.text.trim() === 'الفهرس')).toBe(false);
  });

  it('drops the anchor-link list that belonged to it', () => {
    const spec = markdownToDocSpec(backendToc, { lang: 'ar' });
    const anyAnchorLink = spec.blocks.some(
      b => b.type === 'list' && b.items.some(it => /\(#/.test(it)),
    );
    expect(anyAnchorLink).toBe(false);
  });

  it('keeps the REAL body sections that follow it', () => {
    const spec = markdownToDocSpec(backendToc, { lang: 'ar' });
    expect(spec.blocks.some(b => b.type === 'heading' && b.text.trim() === 'الأهداف')).toBe(true);
    expect(spec.blocks.some(b => b.type === 'paragraph' && b.text.includes('نص الأهداف الحقيقي'))).toBe(true);
  });

  it('does NOT drop a legitimately-named section that merely contains a numbered list (shape gate)', () => {
    const md = ['# وثيقة', '', '## التوصيات', '1. توصية أولى', '2. توصية ثانية'].join('\n');
    const spec = markdownToDocSpec(md, { lang: 'ar' });
    expect(spec.blocks.some(b => b.type === 'heading' && b.text.trim() === 'التوصيات')).toBe(true);
    const list = spec.blocks.find(b => b.type === 'list');
    expect(list?.type === 'list' && list.items).toEqual(['توصية أولى', 'توصية ثانية']);
  });

  it('also recognizes the English "Table of Contents" heading', () => {
    const md = [
      '# Charter', '', '## Table of Contents', '1. [Goals](#goals)', '',
      '## Goals', 'Real content.',
    ].join('\n');
    const spec = markdownToDocSpec(md, { lang: 'en' });
    expect(spec.blocks.some(b => b.type === 'heading' && b.text.trim() === 'Table of Contents')).toBe(false);
    expect(spec.blocks.some(b => b.type === 'paragraph' && b.text.includes('Real content'))).toBe(true);
  });
});

describe('srcRefs threading — [مصدر N] citations survive the canvas hand-off (MAJOR fix 4)', () => {
  it('markdownToDocSpec parses a trailing ```srcrefs``` fence into DocSpec.srcRefs', () => {
    const md = [
      '# وثيقة', '', '## القسم', 'نص يستشهد بـ [مصدر 1].', '',
      '```srcrefs', JSON.stringify([{ num: 1, doc: 'اللائحة الداخلية', heading: 'المادة 5' }]), '```',
    ].join('\n');
    const spec = markdownToDocSpec(md, { lang: 'ar' });
    expect(spec.srcRefs).toEqual([{ num: 1, doc: 'اللائحة الداخلية', heading: 'المادة 5' }]);
    // the fence itself never becomes a visible code block
    expect(spec.blocks.some(b => b.type === 'code')).toBe(false);
  });

  it('buildCanvasHtml resolves the marker into a styled "cite-ok" chip with a title tooltip', () => {
    const md = [
      '# وثيقة', '', '## القسم', 'نص يستشهد بـ [مصدر 1].', '',
      '```srcrefs', JSON.stringify([{ num: 1, doc: 'اللائحة الداخلية', heading: 'المادة 5' }]), '```',
    ].join('\n');
    const spec = markdownToDocSpec(md, { lang: 'ar' });
    const html = buildCanvasHtml(spec);
    expect(html).toContain('cite-ok');
    expect(html).toContain('اللائحة الداخلية');
    expect(html).toContain('المادة 5');
  });

  it('buildCanvasHtml appends a «المصادر» references section when srcRefs exist', () => {
    const md = [
      '# وثيقة', '', '## القسم', 'نص [مصدر 1].', '',
      '```srcrefs', JSON.stringify([{ num: 1, doc: 'دليل الحوكمة', heading: 'الفصل 2' }]), '```',
    ].join('\n');
    const spec = markdownToDocSpec(md, { lang: 'ar' });
    const html = buildCanvasHtml(spec);
    expect(html).toContain('المصادر');
    expect(html).toContain('دليل الحوكمة');
  });

  it('leaves the marker inert (old behavior) when no srcRefs are present at all', () => {
    const spec = markdownToDocSpec('# وثيقة\n\n## القسم\nنص [مصدر 1] بدون مراجع.', { lang: 'ar' });
    expect(spec.srcRefs).toBeUndefined();
    const html = buildCanvasHtml(spec);
    expect(html).toContain('<span class="cite">[مصدر 1]</span>');
    // the .cite-ok CSS rule itself always ships in the stylesheet — assert no
    // element actually CARRIES the resolved class, not just substring absence.
    expect(html).not.toContain('class="cite cite-ok"');
  });

  it('artifactToMarkdown renumbers per-section-local citation numbers into one global sequence', () => {
    const art: ArtifactLike = {
      title: 'ميثاق الحوكمة',
      sections: [
        { id: 's1', title: 'الأهداف', content: 'نص [مصدر 1] وأيضًا [مصدر 2].' },
        { id: 's2', title: 'النطاق', content: 'نص آخر [مصدر 1].' },
      ],
      citations: {
        s1: [{ docName: 'اللائحة الداخلية', label: 'المادة 5' }, { docName: 'دليل السياسات', label: 'الفصل 1' }],
        s2: [{ docName: 'ميثاق سابق', label: 'البند 3' }],
      },
    };
    const md = artifactToMarkdown(art);
    // section s1's local [مصدر 1]/[مصدر 2] and s2's local [مصدر 1] must not collide
    expect(md).toContain('[مصدر 1]');
    expect(md).toContain('[مصدر 2]');
    expect(md).toContain('[مصدر 3]');
    expect(md).toMatch(/```srcrefs\n(.|\n)*```/);
    const fenceMatch = md.match(/```srcrefs\n([\s\S]*?)\n```/);
    expect(fenceMatch).not.toBeNull();
    const refs = JSON.parse(fenceMatch![1]);
    expect(refs).toHaveLength(3);
    expect(refs.map((r: { doc: string }) => r.doc)).toEqual(['اللائحة الداخلية', 'دليل السياسات', 'ميثاق سابق']);
  });

  it('end-to-end: an ArtifactLike with citations round-trips through markdownToDocSpec into resolved DocSpec.srcRefs', () => {
    const art: ArtifactLike = {
      title: 'ميثاق الحوكمة',
      sections: [{ id: 's1', title: 'الأهداف', content: 'نص يستشهد بـ [مصدر 1].' }],
      citations: { s1: [{ docName: 'اللائحة الداخلية', label: 'المادة 5' }] },
    };
    const md = artifactToMarkdown(art);
    const spec = markdownToDocSpec(md, { lang: 'ar' });
    expect(spec.srcRefs).toEqual([{ num: 1, doc: 'اللائحة الداخلية', heading: 'المادة 5' }]);
  });

  it('artifactToMarkdown is a no-op on citations when a section has no id (no false renumbering)', () => {
    const art: ArtifactLike = {
      title: 'وثيقة',
      sections: [{ title: 'قسم', content: 'نص [مصدر 1] بلا هوية قسم.' }],
      citations: { s1: [{ docName: 'مصدر ما', label: 'عنوان' }] },
    };
    const md = artifactToMarkdown(art);
    expect(md).not.toContain('```srcrefs');
    expect(md).toContain('[مصدر 1]');
  });
});

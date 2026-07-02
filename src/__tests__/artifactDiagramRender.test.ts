import { describe, it, expect } from 'vitest';
import { artifactToMarkdown, markdownToDocSpec, buildCanvasHtml, inline } from '../../services/canvasDocument';

// ===========================================================================
//  D4 — a stored document's diagrams ride the canvas as Markdown images
//  (artifactToMarkdown emits `![title](data:image/png;base64,...)`), but
//  markdownToDocSpec had NO image-line case: the line fell into the paragraph
//  collector, and inline()'s link regex doesn't match data: URIs either — so the
//  canvas rendered the literal base64 blob as visible text instead of the
//  diagram it represents. These pin the full pipeline: artifactToMarkdown →
//  markdownToDocSpec → buildCanvasHtml must produce a real <img>, and the raw
//  base64 payload must never appear as visible text in the output.
// ===========================================================================

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

describe('markdownToDocSpec — block-level image line', () => {
  it('turns a standalone ![alt](data:...) line into a figure block, not a paragraph', () => {
    const md = `# عنوان\n\n![الهيكل التنظيمي](${DATA_URL})\n`;
    const spec = markdownToDocSpec(md, { lang: 'ar' });
    const fig = spec.blocks.find(b => b.type === 'figure');
    expect(fig).toBeDefined();
    if (fig?.type !== 'figure') throw new Error('unreachable');
    expect(fig.src).toBe(DATA_URL);
    expect(fig.alt).toBe('الهيكل التنظيمي');
    // no paragraph block ever carries the raw markdown image syntax / base64
    const paragraphs = spec.blocks.filter(b => b.type === 'paragraph');
    expect(paragraphs.every(p => p.type === 'paragraph' && !p.text.includes(TINY_PNG_B64))).toBe(true);
  });

  it('also handles a plain http(s)/relative image URL (not just data:)', () => {
    const spec = markdownToDocSpec('![مخطط](/diagrams/org.png)', { lang: 'ar' });
    const fig = spec.blocks.find(b => b.type === 'figure');
    expect(fig).toBeDefined();
    if (fig?.type !== 'figure') throw new Error('unreachable');
    expect(fig.src).toBe('/diagrams/org.png');
  });

  it('tolerates an empty alt text', () => {
    const spec = markdownToDocSpec(`![](${DATA_URL})`, { lang: 'ar' });
    const fig = spec.blocks.find(b => b.type === 'figure');
    expect(fig).toBeDefined();
    if (fig?.type !== 'figure') throw new Error('unreachable');
    expect(fig.alt).toBeUndefined();
  });
});

describe('inline() — never prints a data: URI as visible text', () => {
  it('converts an inline ![alt](data:...) reference into an <img>', () => {
    const html = inline(`انظر ![شكل](${DATA_URL}) أدناه`);
    expect(html).toContain('<img');
    expect(html).toContain(DATA_URL);
    expect(html).not.toContain(`![شكل](${DATA_URL})`);
  });

  it('never leaves the raw base64 payload as plain visible text', () => {
    const html = inline(`![diagram](${DATA_URL})`);
    // the base64 payload only appears inside the <img src="..."> attribute
    const withoutImgTag = html.replace(/<img\b[^>]*>/g, '');
    expect(withoutImgTag).not.toContain(TINY_PNG_B64);
  });
});

describe('End-to-end: artifactToMarkdown → markdownToDocSpec → buildCanvasHtml', () => {
  it('renders a stored diagram artifact as a real <img>, with NO visible base64 text', () => {
    const md = artifactToMarkdown({
      title: 'دليل الحوكمة',
      sections: [{ title: 'الهيكل', content: 'وصف الهيكل التنظيمي' }],
      diagrams: [{ title: 'الهيكل التنظيمي', png: DATA_URL }],
    });
    const spec = markdownToDocSpec(md, { lang: 'ar', title: 'دليل الحوكمة' });
    const html = buildCanvasHtml(spec);

    // a real <img> tag carries the diagram
    expect(html).toMatch(/<img[^>]*src="data:image\/png;base64,[^"]+"/);
    // the base64 payload appears ONLY inside that src attribute — never as
    // loose visible text (e.g. leaked into a <p> as literal markdown syntax)
    const withoutImgTags = html.replace(/<img\b[^>]*>/g, '');
    expect(withoutImgTags).not.toContain(TINY_PNG_B64);
    expect(withoutImgTags).not.toContain('](data:image');
  });

  it('a document with no diagrams renders no <img> at all (regression guard)', () => {
    const md = artifactToMarkdown({ title: 'T', sections: [{ title: 'S', content: 'نص' }] });
    const spec = markdownToDocSpec(md, { lang: 'ar', title: 'T' });
    const html = buildCanvasHtml(spec);
    expect(html).not.toContain('<img');
  });
});

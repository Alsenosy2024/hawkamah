import { describe, it, expect, vi } from 'vitest';

// DocumentCanvas transitively imports pptxExport → pptxgenjs (browser bundle),
// which doesn't resolve under the node test runner (see artifactCanvas.test.ts).
// Stub it so the PURE diagram-lifecycle helpers below load in isolation — none
// of what's under test here touches pptx export.
vi.mock('pptxgenjs', () => ({ default: class {} }));

import { prepareCanvasDoc, hasPendingDiagrams, stripDiagramEditAffordance } from '../../components/DocumentCanvas';

// ===========================================================================
//  D1 — export/save/share during diagram injection must never bake in a
//  still-pending placeholder.
//
//  Two PURE, DOM-free contracts back that fix and are locked in here:
//   1. prepareCanvasDoc stamps the Mermaid SOURCE on the placeholder at
//      creation (data-mermaid-code) — not only after a successful render —
//      so any snapshot serialized while a diagram is still rendering keeps
//      the source (recoverable by canvasHtmlToMarkdown's figureToMd, and by
//      DocumentCanvas's own healing rescan on reopen).
//   2. hasPendingDiagrams is the gating check DocumentCanvas's export/save/
//      share paths await on (via waitForDiagrams) before serializing.
// ===========================================================================

const MERMAID_SRC = 'flowchart TD\n  A[البداية] --> B[النهاية]';

const MD = [
  '# عنوان الوثيقة',
  '',
  '## الهيكل التنظيمي',
  'فقرة تمهيدية قبل المخطط.',
  '',
  '```mermaid',
  MERMAID_SRC,
  '```',
].join('\n');

describe('prepareCanvasDoc — placeholder stamps its Mermaid source at creation (D1a)', () => {
  const { html, pending } = prepareCanvasDoc(MD, { title: '', subtitle: 'وثيقة حوكمة', lang: 'ar' });

  it('queues exactly the one diagram for progressive rendering', () => {
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('dgm-0');
    expect(pending[0].code).toBe(MERMAID_SRC);
  });

  it('marks the placeholder host as pending', () => {
    expect(html).toContain('id="dgm-0"');
    expect(html).toContain('data-dgm-pending="1"');
  });

  it('stamps the SAME host with its Mermaid source, URI-encoded', () => {
    const stamped = encodeURIComponent(MERMAID_SRC);
    expect(html).toContain(`data-mermaid-code="${stamped}"`);
    // both attributes live on the SAME element (not just present somewhere in the doc)
    const hostTag = html.match(/<div class="dgm-host"[^>]*>/)?.[0] || '';
    expect(hostTag).toContain('id="dgm-0"');
    expect(hostTag).toContain('data-dgm-pending="1"');
    expect(hostTag).toContain(`data-mermaid-code="${stamped}"`);
  });

  it('round-trips the exact source back out of the stamped attribute', () => {
    const m = /data-mermaid-code="([^"]*)"/.exec(html);
    expect(m).not.toBeNull();
    expect(decodeURIComponent(m![1])).toBe(MERMAID_SRC);
  });

  it('shows the bilingual "rendering" label so the reader never sees a blank gap', () => {
    expect(html).toContain('جارٍ رسم المخطط');
  });
});

describe('prepareCanvasDoc — a document with no diagrams queues nothing', () => {
  const plainMd = ['# عنوان', '', '## قسم', 'فقرة بدون أي مخطط.'].join('\n');
  const { html, pending } = prepareCanvasDoc(plainMd, { title: '', subtitle: 'وثيقة', lang: 'ar' });

  it('has an empty pending queue', () => {
    expect(pending).toHaveLength(0);
  });

  it('never carries a pending-diagram marker', () => {
    expect(html).not.toContain('data-dgm-pending');
  });
});

describe('hasPendingDiagrams — the pure gate export/save/share await on (D1b)', () => {
  it('is true while a placeholder is still on the page', () => {
    const { html } = prepareCanvasDoc(MD, { title: '', subtitle: 's', lang: 'ar' });
    expect(hasPendingDiagrams(html)).toBe(true);
  });

  it('is false once the placeholder has been resolved (attribute removed)', () => {
    const { html } = prepareCanvasDoc(MD, { title: '', subtitle: 's', lang: 'ar' });
    const resolved = html.replace(/\s*data-dgm-pending="1"/, '');
    expect(hasPendingDiagrams(resolved)).toBe(false);
  });

  it('is false for a diagram-free document', () => {
    const plainMd = ['# عنوان', 'فقرة عادية.'].join('\n');
    const { html } = prepareCanvasDoc(plainMd, { title: '', subtitle: 's', lang: 'ar' });
    expect(hasPendingDiagrams(html)).toBe(false);
  });

  it('handles empty/undefined input without throwing', () => {
    expect(hasPendingDiagrams('')).toBe(false);
    expect(hasPendingDiagrams(undefined as unknown as string)).toBe(false);
  });
});

// ===========================================================================
//  D3 — the in-place diagram edit affordance is a live-canvas-only overlay: it
//  must never ride into a serialized snapshot (PDF/DOCX/PPTX/XLSX/save/share).
//  liveHtml() strips it via this pure helper before every one of those paths.
// ===========================================================================
describe('stripDiagramEditAffordance — the D3 edit button never rides into a serialize (D3)', () => {
  const withButton = [
    '<div class="dgm-host" id="dgm-0" data-mermaid-code="Zm9v">',
    '<svg viewBox="0 0 10 10"><rect/></svg>',
    '<button type="button" class="dgm-edit-btn" data-dgm-edit="1" contenteditable="false" ',
    'title="تعديل المخطط" aria-label="تعديل المخطط"><svg width="14" height="14"><path d="M1 1"/></svg></button>',
    '</div>',
  ].join('');

  it('removes the button element entirely, including its inner svg', () => {
    const out = stripDiagramEditAffordance(withButton);
    expect(out).not.toContain('data-dgm-edit');
    expect(out).not.toContain('dgm-edit-btn');
    expect(out).not.toContain('تعديل المخطط');
  });

  it('leaves the diagram itself (host + rendered svg + stamped source) intact', () => {
    const out = stripDiagramEditAffordance(withButton);
    expect(out).toContain('id="dgm-0"');
    expect(out).toContain('data-mermaid-code="Zm9v"');
    expect(out).toContain('<svg viewBox="0 0 10 10">');
  });

  it('is a no-op on a document with no affordance button', () => {
    const clean = '<div class="dgm-host" id="dgm-0"><svg></svg></div>';
    expect(stripDiagramEditAffordance(clean)).toBe(clean);
  });

  it('strips MULTIPLE affordance buttons (one per diagram)', () => {
    const two = withButton + withButton.replace('dgm-0', 'dgm-1');
    const out = stripDiagramEditAffordance(two);
    expect(out).not.toContain('data-dgm-edit');
    expect(out).toContain('id="dgm-0"');
    expect(out).toContain('id="dgm-1"');
  });

  it('handles empty/undefined input without throwing', () => {
    expect(stripDiagramEditAffordance('')).toBe('');
    expect(stripDiagramEditAffordance(undefined as unknown as string)).toBe('');
  });
});

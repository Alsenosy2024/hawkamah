import { describe, it, expect } from 'vitest';
import { makeSvgResponsive, diagramFallbackHtml } from '../../services/diagramService';

// ===========================================================================
//  PRD V15 / V3 — the diagram-rendering helpers.
//
//  makeSvgResponsive makes a rendered diagram fill the page width while keeping
//  its aspect ratio (the fix for "diagrams render small + left-shifted").
//  diagramFallbackHtml is the labelled placeholder shown when a diagram fails to
//  compile, so a broken diagram never leaves an empty gap.
//
//  Both are PURE string transforms (no DOM) → fully observable in the node test
//  harness even though mermaid itself can't render here.
// ===========================================================================

describe('makeSvgResponsive — full-width, ratio-preserving diagrams (V15)', () => {
  // What mermaid v11 emits with useMaxWidth:true — a fixed size + a max-width cap
  // that pins the diagram to its (often small) natural width.
  const MERMAID = '<svg id="g0" width="820.5" height="460" viewBox="0 0 820.5 460" '
    + 'style="max-width: 820.5px;" role="img"><g class="root">DIAGRAM</g></svg>';

  it('drops the fixed width/height attributes and Mermaid max-width cap', () => {
    const out = makeSvgResponsive(MERMAID);
    expect(out).not.toMatch(/\bwidth="820/);
    expect(out).not.toMatch(/\bheight="460"/);
    expect(out).not.toMatch(/max-width\s*:\s*820/);
  });

  it('forces width:100% so the diagram fills its container', () => {
    expect(makeSvgResponsive(MERMAID)).toContain('width:100%');
  });

  it('preserves the existing viewBox (aspect ratio kept)', () => {
    expect(makeSvgResponsive(MERMAID)).toContain('viewBox="0 0 820.5 460"');
  });

  it('adds xMidYMid scaling when none is present', () => {
    expect(makeSvgResponsive(MERMAID)).toContain('preserveAspectRatio="xMidYMid meet"');
  });

  it('leaves the inner diagram content untouched', () => {
    expect(makeSvgResponsive(MERMAID)).toContain('<g class="root">DIAGRAM</g>');
  });

  it('derives a viewBox from width/height when one is missing (ratio safety)', () => {
    const out = makeSvgResponsive('<svg width="300" height="150"><rect/></svg>');
    expect(out).toContain('viewBox="0 0 300 150"');
    expect(out).toContain('width:100%');
    expect(out).not.toMatch(/\bwidth="300"/);
  });

  it('keeps unrelated inline style declarations while stripping size ones', () => {
    const out = makeSvgResponsive('<svg width="10" height="10" viewBox="0 0 10 10" style="max-width:500px;background:#fff">x</svg>');
    expect(out).toContain('background:#fff');
    expect(out).not.toContain('max-width:500px');
  });

  it('handles a custom (swimlane) SVG root with extra attributes', () => {
    const swim = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" '
      + 'viewBox="0 0 1200 800" font-family="system-ui">LANES</svg>';
    const out = makeSvgResponsive(swim);
    expect(out).toContain('viewBox="0 0 1200 800"');
    expect(out).toContain('font-family="system-ui"');
    expect(out).not.toMatch(/\bwidth="1200"/);
    expect(out).toContain('LANES');
  });

  it('returns non-SVG input unchanged', () => {
    expect(makeSvgResponsive('<div>not a diagram</div>')).toBe('<div>not a diagram</div>');
    expect(makeSvgResponsive('')).toBe('');
  });
});

describe('diagramFallbackHtml — labelled fallback, never an empty gap (V3)', () => {
  it('shows the Arabic note and the raw source by default', () => {
    const out = diagramFallbackHtml('flowchart TD\n A-->B');
    expect(out).toContain('تعذّر رسم المخطط');
    expect(out).toContain('flowchart TD');
  });

  it('shows an English note when language is en', () => {
    const out = diagramFallbackHtml('flowchart TD', 'en');
    expect(out).toContain('Could not render');
    expect(out).not.toContain('تعذّر');
  });

  it('escapes HTML so the source can never inject markup', () => {
    const out = diagramFallbackHtml('A --> <script>x</script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>x</script>');
    expect(out).toContain('--&gt;');
  });
});

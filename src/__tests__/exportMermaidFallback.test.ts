import { describe, it, expect, vi } from 'vitest';

// ===========================================================================
//  D2 — a diagram whose mermaidToPng render fails must NEVER vanish from the
//  Word file (mermaidBlockToDocx used to `return []` on failure — an empty
//  gap where the diagram should be). It must fall back to a labelled source
//  block instead: a short «تعذّر رسم المخطط» caption + the raw Mermaid code.
//
//  mermaidToPng is mocked to reject so the failure path is exercised
//  deterministically (real Mermaid rendering needs a DOM canvas/Image, not
//  available under the node test runner).
// ===========================================================================

const FAILING_CODE = 'flowchart TD\n  A[البداية] --> B[لا يمكن رسمه]';

vi.mock('../../services/diagramService', () => ({
  mermaidToPng: vi.fn(async () => { throw new Error('mermaid render failed'); }),
}));

import { mermaidBlockToDocx } from '../../services/exportService';

describe('mermaidBlockToDocx — labelled fallback on render failure (D2)', () => {
  it('never returns an empty array on failure (the old "skip it" behavior)', async () => {
    const out = await mermaidBlockToDocx(FAILING_CODE);
    expect(out.length).toBeGreaterThan(0);
  });

  it('includes the Arabic "could not render" caption', async () => {
    const out = await mermaidBlockToDocx(FAILING_CODE);
    expect(JSON.stringify(out)).toContain('تعذّر رسم المخطط');
  });

  it('preserves the raw Mermaid source in the fallback', async () => {
    const out = await mermaidBlockToDocx(FAILING_CODE);
    const dump = JSON.stringify(out);
    expect(dump).toContain('flowchart TD');
    expect(dump).toContain('البداية');
  });

  it('shows the English caption when language is en', async () => {
    const out = await mermaidBlockToDocx(FAILING_CODE, { language: 'en' });
    const dump = JSON.stringify(out);
    expect(dump).toContain('Could not render the diagram');
    expect(dump).not.toContain('تعذّر');
  });

  it('every fallback paragraph is a real docx Paragraph (packs to non-empty XML)', async () => {
    const { Document, Packer } = await import('docx');
    const out = await mermaidBlockToDocx(FAILING_CODE);
    const doc = new Document({ sections: [{ children: out }] });
    const buf = await Packer.toBuffer(doc);
    expect(buf.length).toBeGreaterThan(0);
  });
});

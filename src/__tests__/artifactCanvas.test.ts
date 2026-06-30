import { describe, it, expect } from 'vitest';
import { artifactToMarkdown } from '../../services/canvasDocument';
import type { GeneratedArtifact } from '../../types';

// V25 — the التحقق / الواقع-الراهن process artifacts (charter · risk register ·
// roadmap · current-state report) now open in DocumentCanvas (the single export
// surface) instead of exporting Word/PDF directly. The open-in-canvas path feeds
// a real `GeneratedArtifact` through the SAME artifactToMarkdown bridge that the
// stored-record canvas uses. These tests lock in that contract: a fully-typed
// GeneratedArtifact serializes to document-grade markdown the canvas can render.
describe('GeneratedArtifact → canvas markdown (V25 open-in-canvas adapter)', () => {
  const art: GeneratedArtifact = {
    title: 'ميثاق الحوكمة',
    goal: 'الأهداف والنطاق والرعاة',
    language: 'ar',
    executiveSummary: 'ملخص تنفيذي للميثاق',
    sections: [
      { id: 's1', title: 'الأهداف', content: 'نص الأهداف', status: 'done' },
      { id: 's2', title: 'النطاق', content: 'نص النطاق', status: 'done' },
    ],
    diagrams: [{ title: 'الهيكل', png: 'data:image/png;base64,AAAA' }],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    complete: true,
  };

  it('serializes the artifact title, summary, every section and the diagram', () => {
    const md = artifactToMarkdown(art);
    expect(md).toContain('# ميثاق الحوكمة');
    expect(md).toContain('ملخص تنفيذي للميثاق');
    expect(md).toContain('## الأهداف');
    expect(md).toContain('نص الأهداف');
    expect(md).toContain('## النطاق');
    expect(md).toContain('![الهيكل](data:image/png;base64,AAAA)');
  });

  it('handles a diagram-free artifact (risk register / roadmap shape)', () => {
    const noDiag: GeneratedArtifact = { ...art, diagrams: undefined };
    const md = artifactToMarkdown(noDiag);
    expect(md).toContain('# ميثاق الحوكمة');
    expect(md).not.toContain('![');
    expect(md.endsWith('\n')).toBe(true);
  });
});

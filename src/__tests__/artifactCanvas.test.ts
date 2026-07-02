import { describe, it, expect, vi } from 'vitest';
import { artifactToMarkdown } from '../../services/canvasDocument';
import { nextCanvasArtLibSave, type CanvasArtLibSaveState } from '../../services/governanceArtifacts';
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

// D2 — the risk register / roadmap have no backing state (they're pure
// functions of `model`), so GovernanceCenter falls back to auto-saving their
// canvas edits into the document library. DocumentCanvas fires onSave after
// EVERY smart-edit action (not just an explicit Save click), so this pure
// decision helper must make repeat saves idempotent: reuse the SAME library
// record id/createdAt across a run of edits, skip a write when the html is
// unchanged, and toast-worthy "first save" info only once per open artifact.
describe('nextCanvasArtLibSave — idempotent library fallback for untagged artifacts', () => {
  it('mints a new record and flags isFirstSave on the very first save', () => {
    const mintId = vi.fn(() => 'govdoc_1');
    const d = nextCanvasArtLibSave('<p>v1</p>', null, '', mintId);
    expect(d.status).toBe('save');
    if (d.status !== 'save') throw new Error('unreachable');
    expect(d.isFirstSave).toBe(true);
    expect(d.state.id).toBe('govdoc_1');
    expect(mintId).toHaveBeenCalledTimes(1);
  });

  it('reuses the SAME id + createdAt on a later save with different html (no new record)', () => {
    const mintId = vi.fn(() => 'govdoc_1');
    const first = nextCanvasArtLibSave('<p>v1</p>', null, '', mintId);
    if (first.status !== 'save') throw new Error('unreachable');

    const second = nextCanvasArtLibSave('<p>v2</p>', first.state, '<p>v1</p>', mintId);
    expect(second.status).toBe('save');
    if (second.status !== 'save') throw new Error('unreachable');
    expect(second.isFirstSave).toBe(false);
    expect(second.state).toEqual(first.state);   // same id + createdAt — overwrites, not a new record
    expect(mintId).toHaveBeenCalledTimes(1);       // never re-minted after the first save
  });

  it('skips entirely when the html is unchanged from the last saved value', () => {
    const mintId = vi.fn(() => 'govdoc_1');
    const prevState: CanvasArtLibSaveState = { id: 'govdoc_1', createdAt: '2026-01-01T00:00:00.000Z' };
    const d = nextCanvasArtLibSave('<p>same</p>', prevState, '<p>same</p>', mintId);
    expect(d.status).toBe('skip');
    expect(mintId).not.toHaveBeenCalled();
  });

  it('does NOT skip the first save even if html happens to equal the default empty prevHtml', () => {
    // prevState is null (no prior save yet) — an empty-string coincidence must
    // never be mistaken for "already saved this exact content".
    const mintId = vi.fn(() => 'govdoc_1');
    const d = nextCanvasArtLibSave('', null, '', mintId);
    expect(d.status).toBe('save');
    expect(mintId).toHaveBeenCalledTimes(1);
  });

  it('simulates a run of smart-edit saves: one record minted, toast-worthy only once', () => {
    const mintId = vi.fn(() => 'govdoc_1');
    let state: CanvasArtLibSaveState | null = null;
    let lastHtml = '';
    const firstSaveFlags: boolean[] = [];
    const edits = ['<p>a</p>', '<p>ab</p>', '<p>ab</p>', '<p>abc</p>'];   // one duplicate save in the run
    let writes = 0;
    for (const html of edits) {
      const d = nextCanvasArtLibSave(html, state, lastHtml, mintId);
      if (d.status === 'skip') continue;
      writes++;
      firstSaveFlags.push(d.isFirstSave);
      state = d.state;
      lastHtml = html;
    }
    expect(writes).toBe(3);                       // the duplicate 'ab' save was skipped
    expect(firstSaveFlags).toEqual([true, false, false]);   // toast fires once
    expect(mintId).toHaveBeenCalledTimes(1);       // one record for the whole run
  });
});

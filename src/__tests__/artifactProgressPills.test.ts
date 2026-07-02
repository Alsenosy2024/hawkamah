import { describe, it, expect } from 'vitest';
import { pillState, type ArtifactPhasePill } from '../../components/ArtifactProgress';

// P17/MINOR-modularity — ArtifactProgress gained an optional ordered
// phase-pill sequence (title override too) so GovernanceCenter's
// ingest/build-model banner — which used to hand-roll this same
// done/active/todo pill row TWICE (once per phase group) — can adopt it
// instead. vitest runs in node (no DOM), so the pure done/active/todo
// resolver is pinned directly rather than rendering the component; this is
// the SAME logic GovernanceCenter's bespoke block used to compute inline
// (`idx < order ? 'done' : idx === order ? 'active' : 'todo'`).
describe('pillState', () => {
  const pills: ArtifactPhasePill[] = [
    { key: 'ingest', ar: 'تقطيع', en: 'Chunk' },
    { key: 'embed', ar: 'متجهات', en: 'Embed' },
    { key: 'sentiment', ar: 'النبرة', en: 'Sentiment' },
    { key: 'entities', ar: 'الكيانات', en: 'Entities' },
  ];

  it('marks pills before the current phase as done', () => {
    expect(pillState(pills, 0, 'sentiment')).toBe('done');
    expect(pillState(pills, 1, 'sentiment')).toBe('done');
  });

  it('marks the current phase as active', () => {
    expect(pillState(pills, 2, 'sentiment')).toBe('active');
  });

  it('marks pills after the current phase as todo', () => {
    expect(pillState(pills, 3, 'sentiment')).toBe('todo');
  });

  it('marks the first pill active when it is the current phase', () => {
    expect(pillState(pills, 0, 'ingest')).toBe('active');
    expect(pillState(pills, 1, 'ingest')).toBe('todo');
  });

  it('marks the last pill active (and everything before it done) when it is current', () => {
    expect(pillState(pills, 0, 'entities')).toBe('done');
    expect(pillState(pills, 3, 'entities')).toBe('active');
  });

  it('falls back to all-todo when the current phase is not in this pill group (e.g. a build_* phase during the ingest group)', () => {
    expect(pills.map((_, idx) => pillState(pills, idx, 'build_digest'))).toEqual(['todo', 'todo', 'todo', 'todo']);
  });
});

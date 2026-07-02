import { describe, it, expect } from 'vitest';
import { stepIconKind } from '../../components/StepTimeline';

// P17/MINOR-modularity — StepTimeline is now the single shared "ordered
// stage/step list with a done/running/pending/error status icon" renderer
// (GovCopilot's /draft stage narration AND GovernanceCenter's bulk-generation
// chunk list, which used to hand-roll its own icon glyphs). vitest runs in
// node here (no DOM — see backButton.test.tsx for the same pattern), so we
// pin the pure status → icon-kind mapping directly rather than rendering.
describe('stepIconKind', () => {
  it('maps each known ProgressStep status to itself', () => {
    expect(stepIconKind('done')).toBe('done');
    expect(stepIconKind('error')).toBe('error');
    expect(stepIconKind('running')).toBe('running');
    expect(stepIconKind('pending')).toBe('pending');
  });

  it('falls back to "pending" for any unrecognized status (defensive default)', () => {
    expect(stepIconKind('bogus' as any)).toBe('pending');
    expect(stepIconKind(undefined as any)).toBe('pending');
  });
});

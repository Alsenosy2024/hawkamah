import { describe, it, expect } from 'vitest';
import { isBulkDocComplete } from '../../services/governanceEngine';

// ===========================================================================
//  D3 — «توليد الكل» must not claim success when it failed. Before this fix,
//  generateBulkDoc set `complete = !aborted` regardless of whether any section
//  actually generated content, so a mid-run quota error (every section fails)
//  still reported complete=true — handleGenerateAll then saved a
//  placeholder-only doc to the library, marked the chunk done, and the final
//  alert lied ("اكتمل توليد الكل: 5/5 وحُفظت في المكتبة"). isBulkDocComplete is
//  the pure predicate that now decides `complete`; these tests pin its contract.
// ===========================================================================

const s = (status: string) => ({ status });

describe('isBulkDocComplete', () => {
  it('is true only when every section is done and the run was not aborted', () => {
    expect(isBulkDocComplete([s('done'), s('done')], false)).toBe(true);
  });

  it('is false when EVERY section failed (the confirmed quota-error repro)', () => {
    expect(isBulkDocComplete([s('failed'), s('failed'), s('failed')], false)).toBe(false);
  });

  it('is false when only SOME sections failed — partial success is not "complete"', () => {
    expect(isBulkDocComplete([s('done'), s('failed'), s('done')], false)).toBe(false);
  });

  it('is false when aborted, even if every section that ran finished', () => {
    expect(isBulkDocComplete([s('done'), s('done')], true)).toBe(false);
  });

  it('is false for an empty plan (nothing to call "complete")', () => {
    expect(isBulkDocComplete([], false)).toBe(false);
  });

  it('is false while sections are still pending/writing', () => {
    expect(isBulkDocComplete([s('done'), s('writing')], false)).toBe(false);
    expect(isBulkDocComplete([s('pending')], false)).toBe(false);
  });
});

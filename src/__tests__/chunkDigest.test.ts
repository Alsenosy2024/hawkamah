import { describe, it, expect } from 'vitest';
import { buildRoundRobinDigest } from '../../services/chunkDigest';

// ===========================================================================
//  MAJOR (modularity) — services/governanceEngine.ts's `buildModel` and
//  components/GovernanceCenter.tsx's own `buildChunkDigest` independently
//  implemented the identical "round-robin per document, ordinal-sorted,
//  budget-capped" chunk-selection strategy, with their budgets already
//  drifted apart (240,000 vs 14,000 chars). buildRoundRobinDigest is the one
//  shared selection utility both now delegate to — these tests pin its
//  contract directly, and confirm the two real callers can't drift again
//  since they share this exact selection logic (only entry formatting and
//  budget differ per caller, as designed).
// ===========================================================================

interface C { docName: string; ordinal: number; text: string }
const chunk = (docName: string, ordinal: number, text = 'x'.repeat(50)): C => ({ docName, ordinal, text });
const fmt = (c: C) => `[${c.docName}#${c.ordinal}]\n${c.text}`;

describe('buildRoundRobinDigest', () => {
  it('returns empty results for an empty input', () => {
    const res = buildRoundRobinDigest<C>([], { maxChars: 1000, formatEntry: fmt });
    expect(res).toEqual({ docNames: [], picked: [] });
  });

  it('round-robins ONE chunk per document per pass, not document-by-document', () => {
    const chunks: C[] = [
      chunk('A', 0), chunk('A', 1), chunk('A', 2),
      chunk('B', 0), chunk('B', 1),
    ];
    const res = buildRoundRobinDigest(chunks, { maxChars: 100000, formatEntry: fmt });
    // A0, B0, A1, B1, A2 — never A0,A1,A2,B0,B1 (which would starve B under a tight budget)
    expect(res.picked.map(p => `${p.chunk.docName}${p.chunk.ordinal}`)).toEqual(['A0', 'B0', 'A1', 'B1', 'A2']);
  });

  it('sorts each document\'s own chunks by ordinal before round-robining, regardless of input order', () => {
    const chunks: C[] = [chunk('A', 2), chunk('A', 0), chunk('A', 1)];
    const res = buildRoundRobinDigest(chunks, { maxChars: 100000, formatEntry: fmt });
    expect(res.picked.map(p => p.chunk.ordinal)).toEqual([0, 1, 2]);
  });

  it('docNames lists every document seen in the input, even ones that get cut by the budget', () => {
    const chunks: C[] = [chunk('A', 0, 'x'.repeat(40)), chunk('B', 0, 'x'.repeat(40)), chunk('C', 0, 'x'.repeat(40))];
    // budget only large enough for ~1 entry
    const res = buildRoundRobinDigest(chunks, { maxChars: 30, formatEntry: fmt });
    expect(res.docNames.sort()).toEqual(['A', 'B', 'C']);
    expect(res.picked.length).toBeLessThan(3);
  });

  it('stops selection the instant a single entry would overflow the budget (matches both original implementations\' greedy stop, not a per-document skip)', () => {
    const chunks: C[] = [chunk('A', 0, 'x'.repeat(20)), chunk('B', 0, 'x'.repeat(20)), chunk('A', 1, 'x'.repeat(20))];
    const pieceLen = fmt(chunk('A', 0, 'x'.repeat(20))).length;
    // budget fits exactly 2 entries, not 3
    const res = buildRoundRobinDigest(chunks, { maxChars: pieceLen * 2, formatEntry: fmt });
    expect(res.picked.length).toBe(2);
  });

  it('each pick carries the original index so a caller can restore document-sequential order for readability', () => {
    const chunks: C[] = [chunk('A', 0), chunk('B', 0), chunk('A', 1)];
    const res = buildRoundRobinDigest(chunks, { maxChars: 100000, formatEntry: fmt });
    const byIndex = [...res.picked].sort((a, b) => a.index - b.index);
    expect(byIndex.map(p => chunks[p.index])).toEqual([chunks[0], chunks[1], chunks[2]]);
  });

  it('each pick carries its formatted piece so callers never have to reformat', () => {
    const chunks: C[] = [chunk('A', 0)];
    const res = buildRoundRobinDigest(chunks, { maxChars: 100000, formatEntry: fmt });
    expect(res.picked[0].piece).toBe(fmt(chunks[0]));
  });

  it('groups by docId when docName is absent (defensive, matches the looser caller shape)', () => {
    const chunks: { docId: string; ordinal: number }[] = [{ docId: 'd1', ordinal: 0 }, { docId: 'd1', ordinal: 1 }];
    const res = buildRoundRobinDigest(chunks, { maxChars: 100000, formatEntry: (c) => `[${c.docId}#${c.ordinal}]` });
    expect(res.docNames).toEqual(['d1']);
    expect(res.picked.length).toBe(2);
  });

  it('PARITY — governanceEngine (240k-budget, [i]-numbered) and GovernanceCenter (14k-budget, headingPath-bracketed) selection strategies pick the SAME chunks given the same corpus and an equal budget, differing only in entry text', () => {
    const chunks: (C & { headingPath?: string })[] = Array.from({ length: 6 }, (_, i) => chunk(`Doc${i % 2}`, Math.floor(i / 2), 'evidence text '.repeat(5)));
    const engineStyle = (c: C, i: number) => `[${i}] (${c.docName})\n${c.text}`;
    const centerStyle = (c: C) => `[${c.docName}]\n${c.text}`;
    const a = buildRoundRobinDigest(chunks, { maxChars: 5000, formatEntry: engineStyle });
    const b = buildRoundRobinDigest(chunks, { maxChars: 5000, formatEntry: centerStyle });
    expect(a.picked.map(p => p.index)).toEqual(b.picked.map(p => p.index));
  });
});

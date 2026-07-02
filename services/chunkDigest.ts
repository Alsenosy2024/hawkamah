// Shared round-robin, per-document, ordinal-sorted, budget-capped chunk-selection
// utility. Extracted because services/governanceEngine.ts's `buildModel` and
// components/GovernanceCenter.tsx's own `buildChunkDigest` independently
// implemented the identical sampling strategy (group chunks by document, sort
// each document's chunks by `ordinal`, then round-robin one chunk per document
// per pass so a large corpus doesn't starve the tail documents), with their
// budgets already drifted apart (240,000 vs 14,000 chars). One shared function
// now owns the SELECTION logic; each caller still supplies its own per-chunk
// text formatting (entry header style, excerpt length) and decides whether to
// keep round-robin order or restore original document order — exactly what each
// site already did, so this is a pure refactor, not a behavior change.

/** Minimal shape this module needs from a chunk — real `DocChunk` satisfies it. */
export interface DigestableChunk {
  docName?: string;
  docId?: string;
  ordinal?: number;
}

export interface DigestPick<C> {
  chunk: C;
  /** Index of this chunk within the ORIGINAL `chunks` array passed in — stable
   *  even though selection order is round-robin, so a caller that needs to
   *  resolve citations back to `chunks[i]` (e.g. buildModel's evidence indices)
   *  can still do so, and a caller that wants "original document order" for
   *  readability can re-sort picks by this index. */
  index: number;
  /** The formatted entry text (`formatEntry(chunk, index)`), computed once
   *  during selection — callers join these directly instead of re-formatting. */
  piece: string;
}

export interface RoundRobinDigestResult<C> {
  /** Every document name seen in the INPUT (not just those that made it under
   *  budget) — matches what both call sites used for their "N of M docs" UI. */
  docNames: string[];
  /** Selected chunks, in round-robin selection order (one per document per
   *  pass). Empty when `chunks` is empty. */
  picked: DigestPick<C>[];
}

/**
 * Select chunks for a grounding digest: group by document, sort each
 * document's chunks by `ordinal` ascending, then round-robin across documents
 * (one chunk per doc per pass, in stable insertion order) until `maxChars` of
 * FORMATTED text (via `formatEntry`) would be exceeded — at which point
 * selection stops immediately (matching both original implementations: a
 * single chunk that would overflow the budget ends the whole selection, it
 * does not just skip that document and keep going).
 */
export function buildRoundRobinDigest<C extends DigestableChunk>(
  chunks: C[],
  opts: { maxChars: number; formatEntry: (chunk: C, originalIndex: number) => string },
): RoundRobinDigestResult<C> {
  const { maxChars, formatEntry } = opts;
  if (!chunks?.length) return { docNames: [], picked: [] };

  const byDoc = new Map<string, { chunk: C; index: number }[]>();
  chunks.forEach((c, index) => {
    const key = c.docName || c.docId || '—';
    (byDoc.get(key) || byDoc.set(key, []).get(key)!).push({ chunk: c, index });
  });
  const docNames = Array.from(byDoc.keys());
  const queues = Array.from(byDoc.values()).map(entries =>
    [...entries].sort((a, b) => (a.chunk.ordinal ?? 0) - (b.chunk.ordinal ?? 0)));

  const picked: DigestPick<C>[] = [];
  let used = 0, cursor = 0, drained = 0;
  while (drained < queues.length && used < maxChars) {
    const q = queues[cursor % queues.length];
    cursor++;
    if (!q.length) { drained++; continue; }
    drained = 0;
    const entry = q.shift()!;
    const piece = formatEntry(entry.chunk, entry.index);
    if (used + piece.length > maxChars) break; // first overflow ends selection entirely
    picked.push({ ...entry, piece });
    used += piece.length;
  }
  return { docNames, picked };
}

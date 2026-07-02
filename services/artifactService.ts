// D4 — this file used to hold `generateLongArtifact`, an entire outline → sections
// (streamed) → self-critique → targeted revision → assemble pipeline, PLUS
// `recommendationsDirective` as its prompt-tail hook for owner-defined build
// criteria/recommendations (V17, see governanceFrameworks.buildCriteriaLens).
//
// generateLongArtifact was never imported anywhere — governanceEngine.ts's
// generateGovernanceDoc/generateBulkDoc already cover the same "long, coherent,
// cited document" job (with retrieval + citations + a real governance model this
// file's version never had), so it had been dead code since it landed. It has been
// removed rather than wired in: keeping two divergent implementations of the same
// pipeline is itself a correctness risk (exactly this kind of drift is what let the
// criteria/recommendations mechanism silently rot — see D4 in the PR that added
// this comment). The REAL criteria/notes injection now lives directly in
// governanceEngine.ts's own prompt-assembly (its own block, its own length cap —
// not the reference-project channel's 2500-char excerpt truncation).
//
// `recommendationsDirective` is kept: it's a tiny, independently-tested,
// general-purpose "turn free text into a prompt tail" formatter with no
// dependency on the deleted pipeline.

// V17: turn the owner's recommendations block into a prompt-tail. Pure (no I/O)
// so it's unit-testable, and a no-op when nothing was configured.
export function recommendationsDirective(recommendations?: string): string {
  const r = (recommendations || '').trim();
  return r ? `\n\n${r}` : '';
}

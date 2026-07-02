// P17/MAJOR-modularity — primitives that are BYTE-IDENTICAL across the app's
// three independent Markdown block parsers: components/Markdown.tsx (chat),
// services/markdownAst.ts (docx/pdf/xlsx export), services/canvasDocument.ts's
// markdownToDocSpec (canvas). A full grammar unification is out of scope for
// this lane (see the NOTE near the top of parseMarkdown in markdownAst.ts for
// why, and what each parser still supports that the others don't) — this
// module holds ONLY the pieces already provably identical everywhere they're
// used, extracted so a future edit to one can't silently drift from the
// others. Each export below is imported by every site whose original inline
// code was byte-for-byte the same; anything that DIFFERED (even subtly —
// glyph coverage, capture groups) was deliberately left where it was.

// ── Bidi-control stripping (added services/canvasDocument.ts PR#92; ported
// into services/markdownAst.ts's block detection by this change) ──
// A producer may prefix a line with a bidi-control character (RLM/LRM/ALM, the
// embedding LRE/RLE/PDF/LRO/RLO controls, or the LRI/RLI/FSI/PDI isolates) to
// force its visual direction — e.g. services/governanceArtifacts.ts's bullet
// builders emit `${RLM}- text`. Sitting BEFORE the Markdown prefix (-, #, |, >,
// a digit) hides it from every `^`-anchored block-type regex, flattening the
// line into a garbled paragraph. Stripped ONLY from the FRONT of a line,
// before block-type detection AND before extracting that block's content —
// never mid-line (an intentional bidi cue inside the text itself), and never
// from a fenced code block's CONTENT (only its fence-boundary checks).
const BIDI_CONTROLS_RE = /^[‎‏؜‪-‮⁦-⁩]+/;
export const stripLeadingBidi = (s: string): string => s.replace(BIDI_CONTROLS_RE, '');

// ── Horizontal rule: ---, ***, or ___ (3+ repeats of the same char, optional
// surrounding whitespace). ──
const HR_RE = /^\s*([-*_])\1{2,}\s*$/;
export const isHrLine = (line: string): boolean => HR_RE.test(line);

// ── One `| a | b |` row → trimmed cells (drops the leading/trailing empty
// cell the outer pipes produce). ──
export const splitTableRow = (line: string): string[] =>
  line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());

// ── A markdown table's separator/divider row: `|---|:--:|--|` — the simpler
// regex check shared by canvasDocument.ts + Markdown.tsx. markdownAst.ts uses
// a stricter PER-COLUMN check (see isTableDivider there, which verifies every
// cell individually matches `:?-{2,}:?`) and stays on its own implementation —
// swapping it for this regex would be a real behavior change on malformed
// divider rows, not a pure dedup. ──
const TABLE_DIVIDER_RE = /^\s*\|?[\s:|-]+\|?\s*$/;
export const isTableDividerLine = (line: string): boolean => TABLE_DIVIDER_RE.test(line);

// ── List-item prefixes shared by canvasDocument.ts + Markdown.tsx.
// markdownAst.ts's unordered-list regex recognizes a WIDER bullet-glyph set
// (-*+bullet middot ring endash emdash) on an already-trimmed line and stays
// separate for the same reason as the table divider above. ──
export const ORDERED_LIST_RE = /^\s*\d+[.)]\s+/;
export const UNORDERED_LIST_RE = /^\s*[-*•]\s+/;

// ── Paragraph-continuation stop guard shared by canvasDocument.ts +
// Markdown.tsx: a line starting any OTHER block type ends the current
// paragraph's line-gathering loop. ──
export const PARAGRAPH_STOP_RE = /^(#{1,6}\s|```|\s*[-*•]\s|\s*\d+[.)]\s|\s*>\s)/;

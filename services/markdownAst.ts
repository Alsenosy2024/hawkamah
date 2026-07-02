// Shared Markdown → AST parser. Single source of truth for the file exporters
// (docx / pdf / xlsx). Mirrors the on-screen renderer (components/Markdown.tsx)
// exactly, so exported files look identical to what the user sees — no raw '#',
// '**', '*', '`', '|', '---', '•' or '1.' markers ever leak into a document.
// RTL/Arabic content is preserved verbatim — this only structures text.
//
// NOTE (P17/MAJOR-modularity) — this parser, components/Markdown.tsx (chat) and
// services/canvasDocument.ts's markdownToDocSpec (canvas) are three INDEPENDENT
// implementations of overlapping-but-not-identical Markdown grammars. A full
// unification was judged too risky for one lane; services/markdownShared.ts
// holds only the primitives already provably byte-identical across all three
// (or two of the three — see its own comments for exactly which). Everything
// else is deliberately separate:
//   - components/Markdown.tsx renders straight to React elements (not an AST),
//     handles [مصدر N] citation chips, and lazy-loads live Mermaid diagrams —
//     none of which apply to an exported file or the canvas.
//   - services/canvasDocument.ts's markdownToDocSpec targets a richer DocBlock
//     grammar (kpis/columns/charts/figures), drops a backend-generated TOC,
//     and resolves a trailing ```srcrefs``` citation-map fence — none of which
//     this parser needs, and groups a whole list/blockquote run into ONE
//     block (this parser emits one `bullet`/`quote` block per source line).
//   - THIS parser is the only one with `isTableDivider`'s stricter per-column
//     check (`:?-{2,}:?` on every cell) instead of the simpler
//     `isTableDividerLine` regex — kept separate to avoid a behavior change
//     on malformed divider rows (see markdownShared.ts).
// Before "helpfully" merging any of these, re-read this list — the difference
// is very likely intentional, not drift.
import { stripLeadingBidi, isHrLine, splitTableRow } from './markdownShared';

export type InlineRun = { text: string; bold: boolean; italic?: boolean; code?: boolean };

export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; runs: InlineRun[]; text: string }
  | { type: 'paragraph'; runs: InlineRun[]; text: string }
  | { type: 'bullet'; runs: InlineRun[]; text: string; checked?: boolean; ordered?: boolean; marker?: string }
  | { type: 'quote'; runs: InlineRun[]; text: string }
  | { type: 'code'; text: string; lang?: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'rule' }
  | { type: 'spacer' };

// Inline grammar — identical to the renderer: `code`, [text](url), **bold**,
// *italic*, __bold__. Order matters (code first so markers inside code stay literal).
const INLINE_RE = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(__[^_]+__)/g;

/** Split a line into styled inline runs. Strips every emphasis marker. */
export function parseInline(text: string): InlineRun[] {
  const src = text || '';
  const runs: InlineRun[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(src)) !== null) {
    if (m.index > last) runs.push({ text: src.slice(last, m.index), bold: false });
    const tok = m[0];
    if (tok.startsWith('`')) {
      runs.push({ text: tok.slice(1, -1), bold: false, code: true });
    } else if (tok.startsWith('[')) {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      runs.push({ text: lm ? lm[1] : tok, bold: false });
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      runs.push({ text: tok.slice(2, -2), bold: true });
    } else {
      runs.push({ text: tok.slice(1, -1), bold: false, italic: true });
    }
    last = m.index + tok.length;
  }
  if (last < src.length) runs.push({ text: src.slice(last), bold: false });
  return runs.length ? runs : [{ text: src, bold: false }];
}

// markdownAst-specific: a stricter PER-COLUMN divider check (every cell must
// individually match `:?-{2,}:?`) — see the NOTE at the top of this file for
// why it stays separate from markdownShared.ts's simpler regex version.
const isTableDivider = (line: string): boolean => {
  if (!line.includes('|') || !line.includes('-')) return false;
  const cols = line.split('|').map(c => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
  return cols.length > 0 && cols.every(c => /^:?-{2,}:?$/.test(c) || c === '');
};

/**
 * Parse a full Markdown string into a flat block list. Recognizes:
 * ``` fenced code, # .. ###### headings, > blockquotes, ordered (1. / 1)) lists,
 * unordered (-, *, +, •, ·, ◦, –, —) lists, [ ]/[x] checklists, | pipe | tables,
 * --- / *** / ___ rules, blank-line spacers, otherwise paragraphs.
 */
export function parseMarkdown(md: string): MdBlock[] {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // P17/MAJOR fix — strip a LEADING bidi-control run (RLM etc. — see
    // services/markdownShared.ts) before any block-type check or content
    // extraction, same defense services/canvasDocument.ts has had since PR#92.
    // Without it, an RLM-prefixed bullet/heading/table/quote from any producer
    // (e.g. services/governanceArtifacts.ts's `${RLM}- text` builders) fell
    // through every `^`-anchored check below into one garbled paragraph in
    // every docx/pdf/xlsx export. Only the FRONT of the line is touched —
    // never mid-text, and never inside a fenced code block's CONTENT (only
    // its fence-boundary checks, mirroring markdownShared.ts's own contract).
    const trimmed = stripLeadingBidi(raw).trim();

    // Fenced code block — collect until the closing fence; never leak ``` markers.
    if (/^```/.test(trimmed)) {
      const lang = trimmed.replace(/^`+/, '').trim().toLowerCase() || undefined;
      const buf: string[] = [];
      i++;
      for (; i < lines.length && !/^```/.test(stripLeadingBidi(lines[i]).trim()); i++) buf.push(lines[i]);
      blocks.push({ type: 'code', text: buf.join('\n'), lang });
      continue;
    }

    if (!trimmed) {
      if (blocks.length && blocks[blocks.length - 1].type !== 'spacer') blocks.push({ type: 'spacer' });
      continue;
    }

    // Horizontal rule → a real rule block (never literal --- / *** / ___).
    if (isHrLine(trimmed)) { blocks.push({ type: 'rule' }); continue; }

    // Table: a pipe row immediately followed by a divider row.
    if (trimmed.includes('|') && i + 1 < lines.length && isTableDivider(stripLeadingBidi(lines[i + 1]).trim())) {
      const headers = splitTableRow(trimmed);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++) {
        const rowLine = stripLeadingBidi(lines[j]).trim();
        if (isTableDivider(rowLine)) continue;
        rows.push(splitTableRow(rowLine));
      }
      if (headers.length) { blocks.push({ type: 'table', headers, rows }); i = j - 1; continue; }
    }

    // Headings (# .. ######)
    const hMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (hMatch) {
      const level = Math.min(6, hMatch[1].length) as 1 | 2 | 3 | 4 | 5 | 6;
      const text = hMatch[2].trim();
      blocks.push({ type: 'heading', level, runs: parseInline(text), text });
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const buf: string[] = [];
      for (; i < lines.length && /^\s*>\s?/.test(stripLeadingBidi(lines[i])); i++) buf.push(stripLeadingBidi(lines[i]).replace(/^\s*>\s?/, ''));
      i--;
      const text = buf.join(' ').trim();
      blocks.push({ type: 'quote', runs: parseInline(text), text });
      continue;
    }

    // Checklist
    if (/^\[(x| )\]/i.test(trimmed)) {
      const checked = /^\[x\]/i.test(trimmed);
      const text = trimmed.slice(3).trim();
      blocks.push({ type: 'bullet', runs: parseInline(text), text, checked });
      continue;
    }

    // Ordered list item (1. / 1))
    const oMatch = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (oMatch) {
      const text = oMatch[2].trim();
      blocks.push({ type: 'bullet', runs: parseInline(text), text, ordered: true, marker: `${oMatch[1]}.` });
      continue;
    }

    // Unordered list item (-, *, +, •, ·, ◦, –, —)
    if (/^[-*+•·◦–—]\s+/.test(trimmed)) {
      const text = trimmed.replace(/^[-*+•·◦–—]\s+/, '');
      blocks.push({ type: 'bullet', runs: parseInline(text), text });
      continue;
    }

    // Paragraph
    blocks.push({ type: 'paragraph', runs: parseInline(trimmed), text: trimmed });
  }

  return blocks;
}

/** Strip every Markdown marker — used where plain text is needed (xlsx cells, titles, slide text). */
export function stripMarkdown(text: string): string {
  return (text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*[-*+•·◦–—]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/^\s*>\s?/, '')
    .trim();
}

/** First Markdown table found, or null. */
export function firstTable(md: string): { headers: string[]; rows: string[][] } | null {
  const t = parseMarkdown(md).find(b => b.type === 'table') as
    | { type: 'table'; headers: string[]; rows: string[][] }
    | undefined;
  return t ? { headers: t.headers, rows: t.rows } : null;
}

/** Convert HTML-special chars for safe injection into print templates. */
export function escapeHtml(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Comparison/number tokens (≥ 90%, ≤ 5%, < 1.0, 10,000 ريال…). The operators
 *  ≥ ≤ < > are Unicode-mirrored inside RTL text, which silently FLIPS the meaning
 *  of a KPI threshold (≥ renders as ≤). Wrapping each such token in an LTR isolate
 *  keeps the operator and digits reading left-to-right with their true meaning,
 *  while the cell/paragraph stays RTL. */
const NUMERIC_TOKEN = /[<>≥≤=≈]+\s*[\d٠-٩][\d٠-٩.,٫:/-]*\s*[%‰]?|[\d٠-٩][\d٠-٩.,٫:/-]*\s*[%‰]?\s*[<>≥≤=≈]+/g;

/** Escape HTML, but wrap numeric/operator tokens in an LTR bidi isolate first. */
export function escapeHtmlBidi(raw: string): string {
  const s = raw || '';
  let out = '', last = 0;
  NUMERIC_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMERIC_TOKEN.exec(s))) {
    out += escapeHtml(s.slice(last, m.index));
    out += `<span dir="ltr" style="unicode-bidi:isolate;white-space:nowrap">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(s.slice(last));
  return out;
}

/** Split a string into segments flagged LTR (numeric/operator tokens) vs default
 *  (RTL flow). The DOCX exporter emits each LTR segment as a `rightToLeft:false`
 *  TextRun so Word doesn't mirror ≥/≤/< > the way an RTL run would — same fix as
 *  the HTML LTR-isolate, applied to the Word run model. */
export function splitBidiSegments(raw: string): { text: string; ltr: boolean }[] {
  const s = raw || '';
  const out: { text: string; ltr: boolean }[] = [];
  let last = 0;
  NUMERIC_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMERIC_TOKEN.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), ltr: false });
    out.push({ text: m[0], ltr: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), ltr: false });
  return out.length ? out : [{ text: s, ltr: false }];
}

/** Render inline runs to safe HTML (bold / italic / code spans). */
export function inlineToHtml(runs: InlineRun[]): string {
  return runs.map(r => {
    if (r.code) return `<code style="background:#f1f5f9;padding:1px 5px;border-radius:4px;font-family:monospace;font-size:0.9em">${escapeHtml(r.text)}</code>`;
    const safe = escapeHtmlBidi(r.text);
    if (r.bold) return `<strong>${safe}</strong>`;
    if (r.italic) return `<em>${safe}</em>`;
    return safe;
  }).join('');
}

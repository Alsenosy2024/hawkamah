import React from 'react';

// ===========================================================================
//  Markdown — a compact, dependency-free renderer that turns the copilot's
//  Markdown into clean React elements (headings, lists, tables, rules, code,
//  blockquotes, bold/italic/code/links). RTL-aware. No raw '#', '**', or '|'
//  ever leak to the user.
//
//  Two enrichments beyond plain Markdown:
//    • ```mermaid fenced blocks render as real, brand-styled diagrams
//      (lazy-loaded so Mermaid only ships when a diagram actually appears).
//    • Inline source citations [مصدر N] / [source N] become interactive chips:
//      hover shows the exact resource name, click jumps to it (via onCite).
// ===========================================================================

// Lazy so the (heavy) Mermaid runtime only loads when a diagram is present.
// P8: EditableDiagram is the unified diagram module (view + optional NL chat
// edit) — a chat-rendered ```mermaid fence now goes through it too, so a
// diagram in the chat gets the SAME "edit by chatting" pencil as everywhere
// else in the app whenever the consumer opts in via `onMermaidEdit`.
const EditableDiagram = React.lazy(() => import('./EditableDiagram'));
// Tiny, dependency-free detector (does NOT import mermaid) so we can recognize a
// diagram by content even when the model tags the fence wrong / omits the language.
import { isMermaidBlock } from '../services/mermaidDetect';
// P17/MAJOR-modularity: primitives byte-identical across this parser and its
// siblings (services/canvasDocument.ts, services/markdownAst.ts) — see
// services/markdownShared.ts for which pieces qualified and why.
import { isHrLine, splitTableRow as splitRow, isTableDividerLine, ORDERED_LIST_RE, UNORDERED_LIST_RE, PARAGRAPH_STOP_RE } from '../services/markdownShared';

// HWK-A4: React.Suspense catches the lazy chunk's loading promise but NOT a
// render throw from MermaidView (e.g. invalid LLM-generated mermaid syntax). An
// uncaught throw here escapes the whole Markdown render — and, with no boundary
// between here and the app root, unmounts the surrounding view (the user's
// "it did a refresh and disappeared"). This class contains a failed diagram to
// an inline amber chip with a retry, so one bad diagram never takes down the run.
class MermaidErrorBoundary extends React.Component<{ rtl: boolean; children: React.ReactNode }, { failed: boolean }> {
  // This project ships no @types/react, so inherited members aren't typed (see ErrorBoundary.tsx).
  declare props: { rtl: boolean; children: React.ReactNode };
  declare setState: (partial: { failed: boolean }) => void;
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) {
      return (
        <div className="my-3 px-3 py-2 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 text-[12px] text-amber-700 dark:text-amber-400 flex items-center gap-2">
          <span>{this.props.rtl ? 'تعذّر عرض هذا المخطط' : 'This diagram could not be rendered'}</span>
          <button type="button" onClick={() => this.setState({ failed: false })} className="underline">{this.props.rtl ? 'إعادة' : 'retry'}</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export interface CiteRef { num: number; doc: string; heading?: string }

interface Props {
  text: string;
  rtl?: boolean;
  className?: string;
  citations?: CiteRef[];                                  // ordered [مصدر N] → resource
  onCite?: (doc: string, heading?: string) => void;       // click a citation → navigate
  // P8: when present, every ```mermaid fence rendered gets an "edit by chatting"
  // pencil; an accepted edit calls back with (oldCode, newCode) so the caller can
  // rewrite its OWN copy of `text` (this component never mutates its own prop).
  // Omitted → identical to today: a plain read-only diagram.
  onMermaidEdit?: (oldCode: string, newCode: string) => void;
}

interface CiteCtx { citations?: CiteRef[]; onCite?: Props['onCite']; }

// A single [مصدر N] / [مصدر 1، 2] / [source N] marker → one or more chips.
const CITE_RE = /^\[\s*(?:مصدر|sources?|src|ref)\s*[\d\s،,و]+\]$/i;
function renderCitation(tok: string, keyBase: string, ctx: CiteCtx): React.ReactNode {
  const nums = (tok.match(/\d+/g) || []).map(Number);
  if (!nums.length) return tok;
  return (
    <span key={keyBase} className="whitespace-nowrap">
      {nums.map((n, j) => {
        const ref = ctx.citations?.find(c => c.num === n);
        const clickable = !!(ref && ctx.onCite);
        const title = ref ? (ref.heading ? `${ref.doc} › ${ref.heading}` : ref.doc) : `مصدر ${n}`;
        return (
          <button
            key={`${keyBase}-${j}`}
            type="button"
            className="hw-cite"
            title={title}
            disabled={!clickable}
            onClick={clickable ? () => ctx.onCite!(ref!.doc, ref!.heading) : undefined}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
            {`مصدر ${n}`}
          </button>
        );
      })}
    </span>
  );
}

// ---- inline: [مصدر N] **bold** *italic* `code` [text](url) -------------------
function renderInline(src: string, keyBase: string, ctx: CiteCtx): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Order: code first (so ** inside code is literal), then citations, links, bold, italic.
  // The (?!\() guard keeps a real Markdown link [text](url) whose text happens to
  // be "مصدر N" from being mis-parsed as a citation chip.
  const re = /(`[^`]+`)|(\[\s*(?:مصدر|sources?|src|ref)\s*[\d\s،,و]+\](?!\())|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(__[^_]+__)/gi;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(<code key={`${keyBase}-c${i}`} className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[0.85em] font-mono">{tok.slice(1, -1)}</code>);
    } else if (CITE_RE.test(tok)) {
      out.push(renderCitation(tok, `${keyBase}-cite${i}`, ctx));
    } else if (tok.startsWith('[')) {
      const lm = tok.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (lm) out.push(<a key={`${keyBase}-l${i}`} href={lm[2]} target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 underline">{lm[1]}</a>);
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push(<strong key={`${keyBase}-b${i}`} className="font-bold">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      out.push(<em key={`${keyBase}-i${i}`}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length; i++;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}


const Markdown: React.FC<Props> = ({ text, rtl = true, className = '', citations, onCite, onMermaidEdit }) => {
  const ctx: CiteCtx = { citations, onCite };
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0; let k = 0;
  const align = rtl ? 'text-right' : 'text-left';

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block (capture the language/info string)
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1].trim().toLowerCase();
      const buf: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const code = buf.join('\n');
      // A ```docspec / ```canvas block drives the document canvas — never show it
      // as raw code in the chat bubble.
      if (lang === 'docspec' || lang === 'canvas') { continue; }
      if (code.trim() && isMermaidBlock(lang, code)) {
        // Render as a real, brand-styled diagram (editable when onMermaidEdit is wired).
        const fenceCode = code; // stable per-block closure value for the edit callback below
        blocks.push(
          <MermaidErrorBoundary key={k++} rtl={rtl}>
            <React.Suspense fallback={<div className="gc-shimmer my-3 h-28 rounded-2xl" />}>
              <div className="my-3">
                <EditableDiagram
                  mermaid={fenceCode}
                  language={rtl ? 'ar' : 'en'}
                  onSaveMermaid={onMermaidEdit ? (next) => onMermaidEdit(fenceCode, next) : undefined}
                />
              </div>
            </React.Suspense>
          </MermaidErrorBoundary>,
        );
      } else {
        blocks.push(
          <div key={k++} className="my-3 rounded-xl border border-[var(--hw-border)] overflow-hidden">
            <pre dir="ltr" className="p-3 bg-slate-900 text-slate-100 text-xs overflow-x-auto font-mono leading-relaxed">{code}</pre>
          </div>,
        );
      }
      continue;
    }

    // horizontal rule
    if (isHrLine(line)) { blocks.push(<hr key={k++} className="my-3 border-[var(--hw-border)]" />); i++; continue; }

    // table (header row + separator row)
    if (line.includes('|') && i + 1 < lines.length && isTableDividerLine(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      blocks.push(
        <div key={k++} className="my-3 overflow-x-auto rounded-xl border border-[var(--hw-border)]">
          <table className="w-full text-[13px] border-collapse">
            <thead>
              <tr>{header.map((h, x) => (
                <th key={x} className="px-3 py-2 bg-[var(--hw-brand-50)] text-[var(--hw-brand-pressed)] dark:text-[#6cd0de] font-bold text-start border-b border-[var(--hw-border)] whitespace-nowrap">
                  {renderInline(h, `h${k}-${x}`, ctx)}
                </th>
              ))}</tr>
            </thead>
            <tbody>{rows.map((r, y) => (
              <tr key={y} className={y % 2 ? 'bg-[var(--hw-surface-subtle)] dark:bg-white/[0.02]' : ''}>
                {r.map((c, x) => (
                  <td key={x} className="px-3 py-2 border-b border-[var(--hw-border)] align-top text-start leading-relaxed">
                    {renderInline(c, `t${k}-${y}-${x}`, ctx)}
                  </td>
                ))}
              </tr>
            ))}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    // headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      const size = ['text-xl', 'text-lg', 'text-base', 'text-sm', 'text-sm', 'text-xs'][lvl - 1];
      blocks.push(<div key={k++} className={`${size} font-extrabold text-slate-900 dark:text-slate-100 mt-3 mb-1 ${align}`}>{renderInline(h[2], `hd${k}`, ctx)}</div>);
      i++; continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      blocks.push(<blockquote key={k++} className={`my-2 ps-3 border-s-4 border-emerald-400 text-slate-600 dark:text-slate-300 italic ${align}`}>{renderInline(buf.join(' '), `bq${k}`, ctx)}</blockquote>);
      continue;
    }

    // ordered list
    if (ORDERED_LIST_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && ORDERED_LIST_RE.test(lines[i])) { items.push(lines[i].replace(ORDERED_LIST_RE, '')); i++; }
      blocks.push(<ol key={k++} className={`my-1.5 ms-5 list-decimal space-y-1 ${align}`}>{items.map((it, x) => <li key={x} className="leading-relaxed">{renderInline(it, `ol${k}-${x}`, ctx)}</li>)}</ol>);
      continue;
    }

    // unordered list
    if (UNORDERED_LIST_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UNORDERED_LIST_RE.test(lines[i])) { items.push(lines[i].replace(UNORDERED_LIST_RE, '')); i++; }
      blocks.push(<ul key={k++} className={`my-1.5 ms-5 list-disc space-y-1 ${align}`}>{items.map((it, x) => <li key={x} className="leading-relaxed">{renderInline(it, `ul${k}-${x}`, ctx)}</li>)}</ul>);
      continue;
    }

    // blank line
    if (!line.trim()) { i++; continue; }

    // paragraph (gather consecutive non-structural lines)
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !PARAGRAPH_STOP_RE.test(lines[i]) && !isHrLine(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableDividerLine(lines[i + 1]))) {
      buf.push(lines[i]); i++;
    }
    if (buf.length) blocks.push(<p key={k++} className={`my-1.5 leading-relaxed ${align}`}>{renderInline(buf.join(' '), `p${k}`, ctx)}</p>);
    else i++;
  }

  return <div dir={rtl ? 'rtl' : 'ltr'} className={`hw-md ${className}`}>{blocks}</div>;
};

export default Markdown;

import React from 'react';

// ===========================================================================
//  Markdown — a compact, dependency-free renderer that turns the copilot's
//  Markdown into clean React elements (headings, lists, tables, rules, code,
//  blockquotes, bold/italic/code/links). RTL-aware. No raw '#', '**', or '|'
//  ever leak to the user.
// ===========================================================================

interface Props { text: string; rtl?: boolean; className?: string; }

// ---- inline: **bold** *italic* `code` [text](url) ---------------------------
function renderInline(src: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Order matters: code first (so ** inside code is literal), then links, bold, italic.
  const re = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(__[^_]+__)/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(<code key={`${keyBase}-c${i}`} className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[0.85em] font-mono">{tok.slice(1, -1)}</code>);
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

const splitRow = (line: string): string[] =>
  line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());

const Markdown: React.FC<Props> = ({ text, rtl = true, className = '' }) => {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0; let k = 0;
  const align = rtl ? 'text-right' : 'text-left';

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (/^```/.test(line)) {
      const buf: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      blocks.push(<pre key={k++} dir="ltr" className="my-2 p-3 rounded-lg bg-slate-900 text-slate-100 text-xs overflow-x-auto font-mono leading-relaxed">{buf.join('\n')}</pre>);
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { blocks.push(<hr key={k++} className="my-3 border-slate-200 dark:border-slate-700" />); i++; continue; }

    // table (header row + separator row)
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      blocks.push(
        <div key={k++} className="my-2 overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead><tr>{header.map((h, x) => <th key={x} className={`border border-slate-300 dark:border-slate-600 px-2 py-1.5 bg-emerald-50 dark:bg-emerald-900/30 font-bold ${align}`}>{renderInline(h, `h${k}-${x}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, y) => <tr key={y}>{r.map((c, x) => <td key={x} className={`border border-slate-200 dark:border-slate-700 px-2 py-1.5 ${align}`}>{renderInline(c, `t${k}-${y}-${x}`)}</td>)}</tr>)}</tbody>
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
      blocks.push(<div key={k++} className={`${size} font-extrabold text-slate-900 dark:text-slate-100 mt-3 mb-1 ${align}`}>{renderInline(h[2], `hd${k}`)}</div>);
      i++; continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      blocks.push(<blockquote key={k++} className={`my-2 ps-3 border-s-4 border-emerald-400 text-slate-600 dark:text-slate-300 italic ${align}`}>{renderInline(buf.join(' '), `bq${k}`)}</blockquote>);
      continue;
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
      blocks.push(<ol key={k++} className={`my-1.5 ms-5 list-decimal space-y-1 ${align}`}>{items.map((it, x) => <li key={x} className="leading-relaxed">{renderInline(it, `ol${k}-${x}`)}</li>)}</ol>);
      continue;
    }

    // unordered list
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*•]\s+/, '')); i++; }
      blocks.push(<ul key={k++} className={`my-1.5 ms-5 list-disc space-y-1 ${align}`}>{items.map((it, x) => <li key={x} className="leading-relaxed">{renderInline(it, `ul${k}-${x}`)}</li>)}</ul>);
      continue;
    }

    // blank line
    if (!line.trim()) { i++; continue; }

    // paragraph (gather consecutive non-structural lines)
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*[-*•]\s|\s*\d+[.)]\s|\s*>\s)/.test(lines[i]) && !/^\s*([-*_])\1{2,}\s*$/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]))) {
      buf.push(lines[i]); i++;
    }
    if (buf.length) blocks.push(<p key={k++} className={`my-1.5 leading-relaxed ${align}`}>{renderInline(buf.join(' '), `p${k}`)}</p>);
    else i++;
  }

  return <div dir={rtl ? 'rtl' : 'ltr'} className={`hw-md ${className}`}>{blocks}</div>;
};

export default Markdown;

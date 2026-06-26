// ===========================================================================
//  canvasDocument — the Ailigent "document canvas" builder.
//
//  A TypeScript port of the Ailigent/document-canvas `build_document.py`: it
//  turns a JSON document spec (title/subtitle + ordered blocks: heading /
//  subheading / paragraph / callout / list / kpis / columns / chart / table /
//  figure) into a self-contained, paginated, RTL-aware HTML document — a
//  cover page → table of contents → numbered section pages, with KPI cards,
//  inline-SVG donut/bar charts and premium tables.
//
//  Re-themed to the Ailigent design language: brand teal (#11a8bc) accent and
//  the Thmanyah Sans font (instead of the upstream purple + IBM Plex). The
//  output carries NO toolbar and NO scripts — the in-app canvas (DocumentCanvas)
//  renders it in a same-origin <iframe srcDoc> with designMode editing, and the
//  SAME HTML is what gets printed to PDF (browser print → correct Arabic shaping).
//
//  This module is PURE (no DOM, no imports): build large HTML strings from a
//  spec, and convert the copilot's Markdown into a spec. Mermaid diagrams are
//  pre-rendered to images by the caller and passed in as `figure` blocks.
// ===========================================================================

import { isMermaidBlock } from './mermaidDetect';

export type Lang = 'ar' | 'en';
export type ChartKind = 'donut' | 'bar';
export type KpiTone = 'neutral' | 'good' | 'warn';

export interface KpiItem { label: string; value: string | number; hint?: string; tone?: KpiTone }
export interface ChartBlock { type: 'chart'; chart: ChartKind; title?: string; labels: string[]; values: number[] }

export type DocBlock =
  | { type: 'heading'; text: string }
  | { type: 'subheading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'callout'; text: string }
  | { type: 'list'; ordered?: boolean; items: string[] }
  | { type: 'kpis'; items: KpiItem[] }
  | { type: 'columns'; left?: DocBlock; right?: DocBlock }
  | ChartBlock
  | { type: 'table'; headers: string[]; rows: string[][]; tags?: { col: number } }
  | { type: 'figure'; src?: string; svg?: string; alt?: string; caption?: string; width?: number; height?: number }
  | { type: 'mermaid'; code: string }
  | { type: 'code'; code: string; lang?: string };

export interface DocSpec {
  title: string;
  subtitle?: string;
  lang?: Lang;
  date?: string;
  footer?: string;
  accent?: string;
  brand?: string;       // small brand line on the cover (defaults to AILIGENT)
  blocks: DocBlock[];
}

// ── Ailigent brand tokens ──────────────────────────────────────────────────
export const ACCENT_DEFAULT = '#11a8bc';                 // brand teal
const ACCENT_DEEP = '#0b8090';                           // brand-deep
const ACCENT_BLUE = '#1e6fa8';                           // brand blue
// Chart palette — brand-led (teal/blue/deep), then supporting hues.
const PALETTE = ['#11a8bc', '#1e6fa8', '#0b8090', '#16a34a', '#f59e0b', '#7c3aed', '#db2777'];

// Status words that flip a table tag-cell amber (otherwise green/teal).
const WARN_WORDS = ['مسودة', 'متأخر', 'حرج', 'معلّق', 'معلق', 'قيد', 'draft', 'late', 'overdue', 'critical', 'pending', 'blocked', 'risk', 'خطر', 'عالٍ', 'عالي'];

// Self-contained @font-face for the document (resolves against the app origin
// inside a same-origin srcDoc iframe, and for browser print). Thmanyah Sans is
// the brand font; Almarai is the embedded fallback.
const FONTFACE =
  `@font-face{font-family:'Thmanyah Sans';src:url('/fonts/thmanyah/thmanyahsans-Light.woff2') format('woff2');font-weight:300;font-display:swap;}`
  + `@font-face{font-family:'Thmanyah Sans';src:url('/fonts/thmanyah/thmanyahsans-Regular.woff2') format('woff2');font-weight:400;font-display:swap;}`
  + `@font-face{font-family:'Thmanyah Sans';src:url('/fonts/thmanyah/thmanyahsans-Medium.woff2') format('woff2');font-weight:500 600;font-display:swap;}`
  + `@font-face{font-family:'Thmanyah Sans';src:url('/fonts/thmanyah/thmanyahsans-Bold.woff2') format('woff2');font-weight:700;font-display:swap;}`
  + `@font-face{font-family:'Thmanyah Sans';src:url('/fonts/thmanyah/thmanyahsans-Black.woff2') format('woff2');font-weight:800 900;font-display:swap;}`
  + `@font-face{font-family:'Almarai';src:url('/fonts/Almarai-Regular.ttf') format('truetype');font-weight:400 600;font-display:swap;}`
  + `@font-face{font-family:'Almarai';src:url('/fonts/Almarai-Bold.ttf') format('truetype');font-weight:700 900;font-display:swap;}`;

// ── small helpers ───────────────────────────────────────────────────────────
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Inline Markdown → HTML (escaped first): **bold** *italic* `code` [text](url).
// Citation markers like [مصدر N] are left as muted inline text.
export function inline(src: string): string {
  let s = esc(src);
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  // [text](url) — only http(s)/relative; escaped already so quotes are safe.
  s = s.replace(/\[([^\]]+)\]\(((?:https?:)?\/\/[^)\s]+|\/[^)\s]+|mailto:[^)\s]+)\)/g,
    (_m, txt, url) => `<a href="${url}">${txt}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // muted citation chips so a final document stays clean but evidence is kept
  s = s.replace(/\[\s*(?:مصدر|sources?|src|ref)\s*[\d\s،,و]+\]/gi, (m) => `<span class="cite">${m}</span>`);
  return s;
}

export function fmtNum(n: unknown): string {
  if (typeof n === 'number' && isFinite(n)) {
    return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  const num = typeof n === 'string' ? Number(n.replace(/[,\s]/g, '')) : NaN;
  if (isFinite(num) && n !== '' && /^[\d.,\s-]+$/.test(String(n))) {
    return Number.isInteger(num) ? num.toLocaleString('en-US') : num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return String(n ?? '');
}

const isNumeric = (s: unknown): boolean => /^[\d.,\s%—-]+$/.test(String(s ?? '').trim()) && /\d/.test(String(s ?? ''));

// ── chart renderers (inline SVG / styled divs — survive iframe edit + print) ──
function donut(b: ChartBlock): string {
  const labels = (b.labels || []).map(String);
  const values = (b.values || []).map(v => (typeof v === 'number' ? v : Number(v) || 0));
  const total = values.reduce((a, v) => a + (v || 0), 0) || 1;
  const r = 58, sw = 22, c = 150, circ = 2 * Math.PI * r;
  let off = 0; const segs: string[] = [];
  values.forEach((v, i) => {
    const seg = (v || 0) / total * circ;
    const col = PALETTE[i % PALETTE.length];
    segs.push(`<circle cx="75" cy="75" r="${r}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-dasharray="${seg.toFixed(1)} ${(circ - seg).toFixed(1)}" stroke-dashoffset="${(-off).toFixed(1)}"/>`);
    off += seg;
  });
  const totalTxt = fmtNum(Number.isInteger(total) ? total : Math.round(total * 100) / 100);
  const legend = labels.map((l, i) =>
    `<li><span class="sw2" style="background:${PALETTE[i % PALETTE.length]}"></span> ${esc(l)}`
    + `<span class="v">${esc(fmtNum(values[i]))}</span>`
    + `<span class="pc">${Math.round((values[i] || 0) / total * 100)}%</span></li>`,
  ).join('');
  return `<div class="card" contenteditable="false"><h3>${esc(b.title || '')}</h3><div class="donut-row">`
    + `<svg width="150" height="150" viewBox="0 0 ${c} ${c}" role="img" aria-label="${esc(b.title || 'donut chart')}">`
    + `<g transform="rotate(-90 75 75)"><circle cx="75" cy="75" r="${r}" fill="none" stroke="#e6eef0" stroke-width="${sw}"/>${segs.join('')}</g>`
    + `<text x="75" y="70" text-anchor="middle" font-size="12" fill="#7b8a90" font-family="'Thmanyah Sans',Arial">الإجمالي</text>`
    + `<text x="75" y="96" text-anchor="middle" font-size="28" font-weight="700" fill="#122a33" font-family="'Thmanyah Sans',Arial">${esc(totalTxt)}</text></svg>`
    + `<ul class="legend">${legend}</ul></div></div>`;
}

function bars(b: ChartBlock): string {
  const labels = (b.labels || []).map(String);
  const values = (b.values || []).map(v => (typeof v === 'number' ? v : Number(v) || 0));
  const vmax = Math.max(1, ...values.filter(v => typeof v === 'number'));
  const rows = labels.map((l, i) =>
    `<div class="bar-row"><div class="top"><b>${esc(l)}</b><span>${esc(fmtNum(values[i]))}</span></div>`
    + `<div class="track"><div class="fill" style="width:${Math.max(0, (values[i] || 0) / vmax * 100).toFixed(0)}%"></div></div></div>`,
  ).join('');
  return `<div class="card" contenteditable="false"><h3>${esc(b.title || '')}</h3><div class="bars">${rows}</div></div>`;
}

function chart(b: ChartBlock): string { return b.chart === 'donut' ? donut(b) : bars(b); }

function kpis(items: KpiItem[]): string {
  const toneCls: Record<string, string> = { good: ' good', warn: ' warn' };
  const cells = (items || []).map(i =>
    `<div class="kpi${toneCls[i.tone || ''] || ''}">`
    + `<div class="lbl">${esc(i.label)}</div>`
    + `<div class="val">${esc(fmtNum(i.value))}</div>`
    + (i.hint ? `<div class="hint2">${esc(i.hint)}</div>` : '')
    + `</div>`,
  ).join('');
  return `<div class="kpis">${cells}</div>`;
}

function table(b: { headers: string[]; rows: string[][]; tags?: { col: number } }): string {
  const headers = b.headers || [];
  const tagCol = b.tags?.col;
  const thead = '<thead><tr>' + headers.map(h => `<th>${inline(h)}</th>`).join('') + '</tr></thead>';
  const body = (b.rows || []).map(row => {
    const tds = row.map((cell, ci) => {
      if (ci === tagCol) {
        const warn = WARN_WORDS.some(w => String(cell).includes(w));
        return `<td><span class="tag ${warn ? 'warn' : 'ok'}">${inline(cell)}</span></td>`;
      }
      return `<td${isNumeric(cell) ? ' class="num"' : ''}>${inline(cell)}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  return `<div class="table-wrap"><table>${thead}<tbody>${body}</tbody></table></div>`;
}

function figure(b: { src?: string; svg?: string; alt?: string; caption?: string }): string {
  // Inline SVG (mermaid diagram) renders Arabic correctly and prints sharp; an
  // <img> data-URL is the fallback for raster figures.
  const inner = b.svg
    ? `<div class="svgwrap">${b.svg}</div>`
    : (b.src ? `<img src="${esc(b.src)}" alt="${esc(b.alt || '')}"/>` : '');
  return `<figure class="fig" contenteditable="false">${inner}`
    + (b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : '')
    + `</figure>`;
}

function renderBlock(b: DocBlock): string {
  switch (b.type) {
    case 'subheading': return `<h3 class="h3">${inline(b.text)}</h3>`;
    case 'paragraph': return `<p class="lead">${inline(b.text)}</p>`;
    case 'callout': return `<div class="callout">${inline(b.text)}</div>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      return `<${tag}>` + (b.items || []).map(x => `<li>${inline(x)}</li>`).join('') + `</${tag}>`;
    }
    case 'kpis': return kpis(b.items);
    case 'columns': {
      const left = b.left ? renderBlock(b.left) : '';
      const right = b.right ? renderBlock(b.right) : '';
      return `<div class="grid2">${left}${right}</div>`;
    }
    case 'chart': return chart(b);
    case 'table': return table(b);
    case 'figure': return figure(b);
    case 'mermaid': // fallback only — caller normally converts mermaid → figure
      return `<pre class="codeblk" dir="ltr">${esc(b.code)}</pre>`;
    case 'code': return `<pre class="codeblk" dir="ltr">${esc(b.code)}</pre>`;
    default: return '';
  }
}

// ── styles (Ailigent teal + Thmanyah) ───────────────────────────────────────
function css(accent: string): string {
  const a = accent;
  return [
    FONTFACE,
    `*{box-sizing:border-box}`,
    `html,body{margin:0;padding:0}`,
    `body{background:#eef2f4;color:#1f2c33;`,
    `font-family:'Thmanyah Sans','Tajawal','Almarai',system-ui,Arial,sans-serif;`,
    `line-height:1.9;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}`,
    `.disp{font-family:'Thmanyah Sans','Tajawal',sans-serif;}`,
    `.doc{max-width:840px;margin:0 auto;padding:1px 0;}`,
    `.page{background:#fff;border-radius:16px;box-shadow:0 18px 50px -24px rgba(11,128,144,.30),0 1px 4px rgba(0,0,0,.04);overflow:hidden;margin:22px auto;}`,
    `[contenteditable] *::selection{background:#bde8ef;color:#10242b}`,
    `a{color:${ACCENT_DEEP};text-decoration:none;border-bottom:1px solid ${a}55;}`,
    `code{background:#eef4f6;border-radius:6px;padding:1px 6px;font-family:'SFMono-Regular',Consolas,monospace;font-size:.86em;color:#0c5563;}`,
    `.cite{color:#7c9aa3;font-size:.82em;font-weight:600;}`,
    // cover
    `.cover{min-height:1040px;display:flex;flex-direction:column;justify-content:space-between;padding:58px 54px;color:#fff;position:relative;overflow:hidden;`,
    `background:radial-gradient(125% 140% at 100% 0%,#2bc4d6 0%,${a} 44%,#0b6f86 100%);}`,
    `.cover .pattern{position:absolute;inset:0;opacity:.16;pointer-events:none;background:repeating-linear-gradient(135deg,#fff 0 1px,transparent 1px 16px);}`,
    `.cover>*{position:relative;z-index:1;}`,
    `.cover .brand{font-size:14px;font-weight:700;letter-spacing:.04em;opacity:.95;}`,
    `.cover .brand b{letter-spacing:.32em;font-weight:800;}`,
    `.cover .eyebrow{font-size:15px;font-weight:600;opacity:.9;margin:0 0 12px;}`,
    `.cover h1{margin:0;font-size:42px;font-weight:800;line-height:1.18;letter-spacing:-.01em;}`,
    `.cover .rule{width:66px;height:5px;background:rgba(255,255,255,.9);border-radius:3px;margin:24px 0;}`,
    `.cover .date{font-size:17px;opacity:.95;}`,
    `.cover .foot{font-size:12.5px;opacity:.78;}`,
    // body / sections
    `.body{padding:34px 46px 42px;}`,
    `.toc-h{font-size:13px;font-weight:700;color:${a};margin:0 0 4px;letter-spacing:.02em;}`,
    `.toc-title{font-size:30px;font-weight:800;margin:0 0 18px;color:#10242b;}`,
    `.toc{list-style:none;margin:0;padding:0;}`,
    `.toc li{display:flex;align-items:center;gap:14px;padding:13px 2px;border-top:1px solid #e7eef0;font-size:16px;color:#243740;}`,
    `.toc li .no{color:${a};font-weight:800;min-width:28px;}`,
    `.h2{display:flex;align-items:center;gap:11px;margin:0 0 16px;font-size:22px;font-weight:800;color:#10242b;border-bottom:2px solid ${a};padding-bottom:10px;}`,
    `.h2 .n{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:10px;background:#e7f6f8;color:${ACCENT_DEEP};font-size:14px;font-weight:800;}`,
    `.h3{font-size:16.5px;font-weight:700;color:#15323b;margin:18px 0 8px;}`,
    `.lead{font-size:15.5px;color:#33454d;margin:0 0 9px;}`,
    `.callout{margin:14px 0;padding:13px 18px;background:#e9f6f8;border-radius:12px 0 0 12px;border-right:4px solid ${a};color:#194049;font-weight:500;}`,
    `[dir=ltr] .callout{border-radius:0 12px 12px 0;border-right:0;border-left:4px solid ${a};}`,
    `ul,ol{margin:8px 0 12px;padding-inline-start:26px;}`,
    `li{margin:5px 0;color:#33454d;}`,
    `.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:14px 0 6px;}`,
    `.kpi{background:#fff;border:1px solid #e3edf0;border-radius:16px;padding:16px 16px 15px;position:relative;overflow:hidden;}`,
    `.kpi::before{content:'';position:absolute;top:0;right:0;left:0;height:4px;background:${a};}`,
    `.kpi.good::before{background:#16a34a}.kpi.warn::before{background:#f59e0b}`,
    `.kpi .lbl{font-size:12.5px;color:#5d6f76;font-weight:600;margin-bottom:6px;}`,
    `.kpi .val{font-size:26px;font-weight:800;color:#10242b;line-height:1;}`,
    `.kpi .hint2{font-size:11.5px;color:#8ba0a7;margin-top:7px;}`,
    `.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:14px;}`,
    `.card{background:#fff;border:1px solid #e3edf0;border-radius:18px;padding:20px 22px;box-shadow:0 6px 18px -12px rgba(11,128,144,.18);}`,
    `.card h3{margin:0 0 14px;font-size:15px;font-weight:700;color:#1c3038;}`,
    `.donut-row{display:flex;align-items:center;gap:18px;}`,
    `.legend{flex:1;list-style:none;margin:0;padding:0;}`,
    `.legend li{display:flex;align-items:center;gap:9px;padding:7px 0;font-size:14px;border-bottom:1px dashed #eef2f3;margin:0;}`,
    `.legend li:last-child{border-bottom:0}`,
    `.legend .sw2{width:12px;height:12px;border-radius:4px;flex:none;}`,
    `.legend .v{margin-inline-start:auto;font-weight:700;color:#10242b;}`,
    `.legend .pc{color:#5d6f76;font-size:12.5px;min-width:40px;text-align:left;}`,
    `.bars{display:flex;flex-direction:column;gap:14px;}`,
    `.bar-row .top{display:flex;justify-content:space-between;font-size:13.5px;margin-bottom:6px;}`,
    `.bar-row .top b{font-weight:700;color:#10242b;}.bar-row .top span{color:#5d6f76}`,
    `.track{height:12px;background:#e9f1f3;border-radius:999px;overflow:hidden;}`,
    `.fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#2bc4d6,${a});}`,
    `.table-wrap{margin:10px 0 6px;overflow-x:auto;}`,
    `table{width:100%;border-collapse:separate;border-spacing:0;font-size:14px;border:1px solid #e3edf0;border-radius:14px;overflow:hidden;}`,
    `thead th{background:linear-gradient(180deg,${a},${ACCENT_DEEP});color:#fff;font-weight:600;text-align:start;padding:13px 16px;font-size:13.5px;}`,
    `tbody td{padding:12px 16px;border-top:1px solid #eef2f3;color:#33454d;vertical-align:top;}`,
    `tbody tr:nth-child(even){background:#f4fafb;}`,
    `.tag{display:inline-block;padding:3px 11px;border-radius:999px;font-size:12px;font-weight:700;}`,
    `.tag.ok{background:#e7f6ef;color:#157a3a;}.tag.warn{background:#fef6e7;color:#b4730a;}`,
    `.num{font-variant-numeric:tabular-nums;font-weight:700;color:#10242b;}`,
    `.fig{margin:16px 0;text-align:center;}`,
    `.fig img{max-width:100%;height:auto;border:1px solid #e3edf0;border-radius:14px;background:#fff;}`,
    `.fig .svgwrap{display:inline-block;max-width:100%;overflow:auto;border:1px solid #e3edf0;border-radius:14px;background:#fff;padding:14px 16px;}`,
    `.fig .svgwrap svg{max-width:100%;height:auto;max-height:620px;}`,
    `.fig figcaption{font-size:12.5px;color:#7b8a90;margin-top:8px;}`,
    `.codeblk{background:#0f2730;color:#d8eef2;padding:14px 16px;border-radius:12px;overflow-x:auto;font-size:12.5px;line-height:1.7;font-family:Consolas,monospace;}`,
    // print: each section starts on its own page (mirrors the on-screen cards);
    // long sections flow across pages; atomic blocks never split mid-element so
    // the PDF matches the canvas exactly (no orphaned lines, no clipped cards).
    `*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}`,
    `@media print{`,
    `html,body{background:#fff!important;}`,
    `.doc{max-width:none;margin:0;}`,
    `.page{box-shadow:none!important;border-radius:0!important;margin:0!important;background:#fff!important;break-before:page;break-inside:auto;min-height:0;}`,
    `.page:first-child,.page.cover{break-before:auto;}`,
    `.page.cover{min-height:1122px;}`,
    // small atomic visuals stay whole
    `.card,.kpi,.donut-row{break-inside:avoid;}`,
    `.legend li,.bar-row{break-inside:avoid;}`,
    // long tables FLOW across pages (rows kept intact, header repeats) instead of
    // being force-kept and cropped
    `table{break-inside:auto;}`,
    `thead{display:table-header-group;}`,
    `tr{break-inside:avoid;}`,
    // figures/diagrams: keep whole AND scale to fit one page so a tall flowchart
    // is never cropped at a page break
    `.fig,figure{break-inside:avoid;}`,
    `.fig .svgwrap{overflow:visible;max-height:none;}`,
    `.fig svg,.fig img{max-width:100%!important;max-height:235mm!important;width:auto!important;height:auto!important;}`,
    `.h2,.h3{break-after:avoid;}`,
    `.toc,.toc li{break-inside:avoid;}`,
    `p,li{orphans:3;widows:3;}`,
    `@page{size:A4;margin:0;}`,
    `.body{padding:32px 44px;}`,
    `}`,
  ].join('');
}

// ── group blocks into sections (each `heading` → a new numbered page) ─────────
interface Section { title: string; blocks: DocBlock[] }
function toSections(blocks: DocBlock[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const b of blocks) {
    if (b.type === 'heading') {
      cur = { title: b.text || '', blocks: [] };
      sections.push(cur);
    } else {
      if (!cur) { cur = { title: '', blocks: [] }; sections.push(cur); }
      cur.blocks.push(b);
    }
  }
  return sections;
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

// ── the builder: DocSpec → self-contained multi-page HTML document ───────────
export function buildCanvasHtml(spec: DocSpec): string {
  const lang: Lang = spec.lang === 'en' ? 'en' : 'ar';
  const rtl = lang === 'ar';
  const dirAttr = rtl ? 'rtl' : 'ltr';
  const accent = spec.accent || ACCENT_DEFAULT;
  const title = spec.title || (rtl ? 'وثيقة' : 'Document');
  const subtitle = spec.subtitle || (rtl ? 'وثيقة' : 'Document');
  const brand = spec.brand || 'AILIGENT';
  const date = spec.date || '';
  const footer = spec.footer || '';
  const allSections = toSections(spec.blocks || []);
  // Content before the first heading (an intro) → its own foreword page, placed
  // after the cover and before the TOC; the remaining (titled) sections drive the
  // TOC and are numbered 1..N.
  const lead = allSections.length && !allSections[0].title && allSections[0].blocks.length ? allSections[0] : null;
  const sections = lead ? allSections.slice(1) : allSections;

  const cover =
    `<section class="page cover" contenteditable="true">`
    + `<span class="pattern" contenteditable="false"></span>`
    + `<div class="brand">${esc(brand)}</div>`
    + `<div class="mid">`
    + `<p class="eyebrow">${esc(subtitle)}</p>`
    + `<h1 class="disp">${esc(title)}</h1>`
    + `<div class="rule" contenteditable="false"></div>`
    + (date ? `<p class="date">${esc(date)}</p>` : '')
    + `</div>`
    + `<div class="foot">${esc(footer)}</div></section>`;

  const foreword = lead
    ? `<section class="page"><div class="body" contenteditable="true">${lead.blocks.map(renderBlock).join('')}</div></section>`
    : '';

  const tocItems = sections
    .filter(s => s.title)
    .map((s, i) => `<li><span class="no" contenteditable="false">${pad2(i + 1)}</span> ${esc(s.title)}</li>`)
    .join('');
  const toc = tocItems
    ? `<section class="page"><div class="body" contenteditable="true">`
      + `<p class="toc-h">${esc(subtitle)}</p>`
      + `<h2 class="toc-title disp">${rtl ? 'جدول المحتويات' : 'Table of contents'}</h2>`
      + `<ul class="toc">${tocItems}</ul></div></section>`
    : '';

  let pages = '';
  sections.forEach((s, i) => {
    const head = s.title
      ? `<h2 class="h2"><span class="n" contenteditable="false">${pad2(i + 1)}</span> ${esc(s.title)}</h2>`
      : '';
    const inner = s.blocks.map(renderBlock).join('');
    pages += `<section class="page"><div class="body" contenteditable="true">${head}${inner}</div></section>`;
  });

  return `<!DOCTYPE html><html lang="${lang}" dir="${dirAttr}"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)}</title>`
    + `<style>${css(accent)}</style></head>`
    + `<body dir="${dirAttr}"><div class="doc">${cover}${foreword}${toc}${pages}</div></body></html>`;
}

// ===========================================================================
//  Markdown → DocSpec — so the copilot's existing Markdown documents render as
//  canvas pages. Mirrors the block grammar of components/Markdown.tsx.
// ===========================================================================

const splitRow = (line: string): string[] =>
  line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());

// Detect which table column (if any) is a "status" column → tag pills.
function detectTagCol(headers: string[], rows: string[][]): number | undefined {
  const STATUS_HEAD = /(الحالة|الحاله|status|state|risk|المخاطر|الخطورة|الأولوية|priority)/i;
  const hi = headers.findIndex(h => STATUS_HEAD.test(h));
  if (hi >= 0) return hi;
  return undefined;
}

export interface MdToSpecOptions {
  title?: string;
  subtitle?: string;
  lang?: Lang;
  date?: string;
  footer?: string;
  accent?: string;
  brand?: string;
}

export function markdownToDocSpec(md: string, opts: MdToSpecOptions = {}): DocSpec {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: DocBlock[] = [];
  let title = opts.title || '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1].trim().toLowerCase();
      const buf: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // closing fence
      const code = buf.join('\n');
      if (!code.trim()) continue;
      // Recognize a diagram by content too (models often mis-tag the fence) and
      // skip a ```docspec/```canvas block (it drives the spec, never shown as code).
      if (lang === 'docspec' || lang === 'canvas') continue;
      if (isMermaidBlock(lang, code)) blocks.push({ type: 'mermaid', code });
      else blocks.push({ type: 'code', code, lang });
      continue;
    }

    // horizontal rule → skip (sections already paginate)
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { i++; continue; }

    // table (header row + separator row)
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const headers = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      const tagCol = detectTagCol(headers, rows);
      blocks.push({ type: 'table', headers, rows, ...(tagCol != null ? { tags: { col: tagCol } } : {}) });
      continue;
    }

    // headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      const txt = h[2].trim();
      if (!title && lvl <= 2 && !blocks.length) {
        // first top heading → the document title (cover), not a section
        title = txt;
      } else if (lvl <= 2) {
        blocks.push({ type: 'heading', text: txt });
      } else {
        blocks.push({ type: 'subheading', text: txt });
      }
      i++; continue;
    }

    // blockquote → callout
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      blocks.push({ type: 'callout', text: buf.join(' ') });
      continue;
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    // unordered list
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*•]\s+/, '')); i++; }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    // blank line
    if (!line.trim()) { i++; continue; }

    // paragraph (gather consecutive non-structural lines)
    const buf: string[] = [];
    while (
      i < lines.length && lines[i].trim()
      && !/^(#{1,6}\s|```|\s*[-*•]\s|\s*\d+[.)]\s|\s*>\s)/.test(lines[i])
      && !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]))
    ) { buf.push(lines[i]); i++; }
    if (buf.length) blocks.push({ type: 'paragraph', text: buf.join(' ') });
    else i++;
  }

  return {
    title: title || opts.title || (opts.lang === 'en' ? 'Document' : 'وثيقة'),
    subtitle: opts.subtitle,
    lang: opts.lang || 'ar',
    date: opts.date,
    footer: opts.footer,
    accent: opts.accent,
    brand: opts.brand,
    blocks,
  };
}

// ===========================================================================
//  Optional structured spec block: the model MAY emit a ```docspec / ```canvas
//  fenced JSON block to drive KPI cards + charts directly. Returns the parsed
//  spec (merged with options) or null when none/invalid.
// ===========================================================================
export function extractDocSpec(md: string, opts: MdToSpecOptions = {}): DocSpec | null {
  const m = md.match(/```(?:docspec|canvas)\s*\n([\s\S]*?)\n```/i);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.blocks)) return null;
    return {
      title: String(raw.title || opts.title || (opts.lang === 'en' ? 'Document' : 'وثيقة')),
      subtitle: raw.subtitle ?? opts.subtitle,
      lang: (raw.lang === 'en' ? 'en' : 'ar'),
      date: raw.date ?? opts.date,
      footer: raw.footer ?? opts.footer,
      accent: raw.accent ?? opts.accent,
      brand: raw.brand ?? opts.brand,
      blocks: raw.blocks as DocBlock[],
    };
  } catch { return null; }
}

// True when the markdown actually carries document-grade structure worth
// rendering as a multi-page canvas (a heading, a table, or real length).
export function looksLikeDocument(md: string): boolean {
  const s = (md || '').trim();
  if (s.length < 200) return false;
  const headings = (s.match(/^#{1,6}\s+/gm) || []).length;
  const hasTable = /\n\s*\|?[^\n]*\|[^\n]*\n\s*\|?[\s:|-]+\|/.test(s);
  return headings >= 1 || hasTable || s.length > 600;
}

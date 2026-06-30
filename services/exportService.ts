// Real file export — Word (.docx), PDF (print + direct), Excel (.xlsx) — all RTL/Arabic aware.
// Single source of truth for parsing is services/markdownAst.ts. This module turns parsed
// blocks (or a whole GeneratedArtifact) into actual office files. No fake HTML-blob .doc/.xls.

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun, PageBreak,
  Header, Footer, PageNumber, ShadingType, VerticalAlign,
  Bookmark, InternalHyperlink, TabStopType, TabStopPosition, LeaderType,
} from 'docx';
import * as XLSX from 'xlsx';
import {
  parseMarkdown, parseInline, MdBlock, InlineRun, stripMarkdown, escapeHtml, inlineToHtml, splitBidiSegments,
} from './markdownAst';
import type {
  GeneratedArtifact, ArtifactSection, Language, CompanyGovernanceModel, MaturityReport, FrameworkAlignment,
} from '../types';
import { mermaidToPng } from './diagramService';

// ---------- brand palette (shared DOCX + PDF) — altanween/arabic-docx design system ----------
const NAVY = '1A3557';
const GOLD = 'C8912A';
const CYAN = '0E9EBB';
const WHITE = 'FFFFFF';
const LIGHT = 'F0F5FA';
const GREY = '6B7280';
const INK = '111827';
// Per-section theme rotation (altanween THEMES): navy → gold → cyan.
const THEME_MAIN = [NAVY, GOLD, CYAN];
const themeColor = (i: number) => THEME_MAIN[i % THEME_MAIN.length];

// ---------- Ailigent brand (refined teal) — PDF / print theming ----------
// The PDF is the brand surface: teal-led, no gold. DOCX/PPTX keep their own
// palette above (owner's Word styling); only the PDF/print CSS uses these.
const TEAL = '11A8BC';    // brand primary (structure, table headers, cover)
const TEALD = '0B8090';   // brand-deep (headings, dark text accents)
const TBLUE = '1E6FA8';   // brand blue (tertiary rotation, replaces cyan)
const BRAND50 = 'EEF8FA'; // brand-50 light fill (zebra rows, blockquote bg)
const BRAND100 = 'DEF2F6';
const TINK = '122A33';    // brand ink (body text)
// The PDF is always rendered in the brand font (Thmanyah). It loads as woff2
// (browser-shaped, captured by html2canvas) — the Word-font option (Almarai/
// Tajawal) does not apply to the PDF surface.
const PDF_FONT = 'Thmanyah Sans';
// @font-face for the PDF render holder: real Thmanyah woff2 (loads reliably and
// shapes Arabic correctly), Almarai kept as a fallback face.
const PDF_FONTFACE =
  `@font-face{font-family:'Thmanyah Sans';src:url('/fonts/thmanyah/thmanyahsans-Light.woff2') format('woff2');font-weight:300;font-display:swap;}`
  + `@font-face{font-family:'Thmanyah Sans';src:url('/fonts/thmanyah/thmanyahsans-Regular.woff2') format('woff2');font-weight:400;font-display:swap;}`
  + `@font-face{font-family:'Thmanyah Sans';src:url('/fonts/thmanyah/thmanyahsans-Medium.woff2') format('woff2');font-weight:500 600;font-display:swap;}`
  + `@font-face{font-family:'Thmanyah Sans';src:url('/fonts/thmanyah/thmanyahsans-Bold.woff2') format('woff2');font-weight:700;font-display:swap;}`
  + `@font-face{font-family:'Thmanyah Sans';src:url('/fonts/thmanyah/thmanyahsans-Black.woff2') format('woff2');font-weight:800 900;font-display:swap;}`
  + `@font-face{font-family:'Almarai';src:url('/fonts/Almarai-Regular.ttf') format('truetype');font-weight:400 600;font-display:swap;}`
  + `@font-face{font-family:'Almarai';src:url('/fonts/Almarai-Bold.ttf') format('truetype');font-weight:700 900;font-display:swap;}`;

declare global {
  interface Window {
    jspdf?: { jsPDF: new (...args: any[]) => any };
    html2canvas?: (el: HTMLElement, opts?: any) => Promise<HTMLCanvasElement>;
  }
}

export interface ExportOptions {
  fileName?: string;
  fontFamily?: string;   // Word font name (must exist in Word for shaping); defaults to Arial
  logoUrl?: string;      // base64 data URL for cover/header
  companyName?: string;
  language?: Language;
}

// Approved Arabic font for Word output: Almarai (المراعي) — owner's first choice and
// natively available in Google Docs / Google Drive (where the owner opens files), so
// it renders without embedding/substitution. Word desktop ships Arabic fallbacks too.
// Thmanyah brand font is WOFF2 (web-only) and can't embed in Word, so it's not used here.
const DOCX_FONT = (o?: ExportOptions) => o?.fontFamily || 'Almarai';
const EN_FONT = 'Calibri';
const MONO_FONT = 'Courier New';
const safeName = (s: string) => (s || 'report').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

// ---------- shared blob download ----------
function downloadBlob(blob: Blob, fileName: string) {
  // Guard the broken-blob path that surfaced as a full-page "File not found" on
  // open (PRD V1): never hand the browser a 0-byte/empty blob to "save" — the
  // resulting file can't be opened. Bail loudly instead of writing a dead file.
  if (!blob || blob.size === 0) {
    console.warn('[export] refusing to download an empty file:', fileName);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'document';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Keep BOTH the anchor and the object URL alive until the browser has committed
  // the download. Removing the <a> synchronously (the old behavior) cancels the
  // transfer in some browsers, and revoking the blob: URL too early leaves the
  // saved file pointing at freed memory ("File not found" on open). Defer the
  // single cleanup well past the click instead.
  setTimeout(() => {
    try { a.remove(); } catch { /* noop */ }
    URL.revokeObjectURL(url);
  }, 10_000);
}

// ============================================================
//  DOCX
// ============================================================

/** Force document-level RTL by post-processing the packed .docx zip.
 *  The `docx` lib emits per-paragraph `w:bidi`, but some viewers (Google Docs,
 *  Pages) only honor RTL when the SECTION (`sectPr`) and document defaults
 *  (`docDefaults`) are also RTL — otherwise the manual reads left-to-right.
 *  We inject `<w:bidi/>` into every section and a docDefaults RTL block.
 *  Pure XML patch; on any failure we return the original blob untouched. */
async function forceDocxRtl(blob: Blob): Promise<Blob> {
  try {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());

    const docFile = zip.file('word/document.xml');
    if (docFile) {
      let xml = await docFile.async('string');
      // Add <w:bidi/> to each sectPr that doesn't already have one (just before </w:sectPr>).
      xml = xml.replace(/<\/w:sectPr>/g, (m) => m); // no-op guard for clarity
      xml = xml.replace(/(<w:sectPr\b[^>]*>)([\s\S]*?)(<\/w:sectPr>)/g, (full, open, inner, close) =>
        /<w:bidi\b/.test(inner) ? full : `${open}${inner}<w:bidi/>${close}`);
      zip.file('word/document.xml', xml);
    }

    const stFile = zip.file('word/styles.xml');
    if (stFile) {
      let sx = await stFile.async('string');
      const rtlDefaults =
        '<w:docDefaults><w:rPrDefault><w:rPr><w:rtl/></w:rPr></w:rPrDefault>' +
        '<w:pPrDefault><w:pPr><w:bidi/></w:pPr></w:pPrDefault></w:docDefaults>';
      if (!/<w:docDefaults/.test(sx)) {
        sx = sx.replace(/(<w:styles\b[^>]*>)/, `$1${rtlDefaults}`);
      } else {
        if (!/<w:rtl\b/.test(sx)) {
          sx = /<w:rPrDefault>\s*<w:rPr>/.test(sx)
            ? sx.replace(/<w:rPrDefault>\s*<w:rPr>/, '<w:rPrDefault><w:rPr><w:rtl/>')
            : sx.replace(/<w:docDefaults>/, '<w:docDefaults><w:rPrDefault><w:rPr><w:rtl/></w:rPr></w:rPrDefault>');
        }
        if (!/<w:pPrDefault>[\s\S]*?<w:bidi\b/.test(sx)) {
          sx = /<w:pPrDefault>\s*<w:pPr>/.test(sx)
            ? sx.replace(/<w:pPrDefault>\s*<w:pPr>/, '<w:pPrDefault><w:pPr><w:bidi/>')
            : sx.replace(/<\/w:docDefaults>/, '<w:pPrDefault><w:pPr><w:bidi/></w:pPr></w:pPrDefault></w:docDefaults>');
        }
      }
      zip.file('word/styles.xml', sx);
    }

    // If a brand font is embedded (word/fonts/*.odttf), tell Word to honor it on open.
    const setFile = zip.file('word/settings.xml');
    if (setFile && zip.file(/word\/fonts\/.*\.odttf/).length) {
      let st = await setFile.async('string');
      if (!/<w:embedTrueTypeFonts\b/.test(st)) {
        st = st.replace(/(<w:settings\b[^>]*>)/, '$1<w:embedTrueTypeFonts/><w:embedSystemFonts/><w:saveSubsetFonts/>');
        zip.file('word/settings.xml', st);
      }
    }

    return await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  } catch {
    return blob; // never break an export because the RTL patch failed
  }
}

// ---- embedded brand font (Almarai, real OFL TTF) ----
// Word/Pages render the approved Arabic typeface even on machines that don't have
// it installed, because the TTF is obfuscated + embedded into the .docx (fontTable).
// Loaded once, runtime-agnostic: fetch() in the browser, fs in the node QA harness.
type EmbedFont = { name: string; data: Uint8Array };
let EMBED_FONTS: EmbedFont[] = [];
let _fontsPromise: Promise<void> | null = null;
async function ensureFonts(): Promise<void> {
  if (EMBED_FONTS.length) return;
  if (_fontsPromise) return _fontsPromise;
  _fontsPromise = (async () => {
    // Single regular face registered as "Almarai"; Word synthesizes bold for headings.
    const file = 'Almarai-Regular.ttf';
    try {
      let bytes: Uint8Array | null = null;
      // Discriminate node (file://) from browser (http) via the module URL — robust
      // even when a node QA harness shims `window`/`fetch` into the global scope.
      const isNode = typeof import.meta.url === 'string' && import.meta.url.startsWith('file:');
      if (!isNode && typeof fetch === 'function') {
        const res = await fetch(`/fonts/${file}`);
        if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        const { readFileSync } = await import('fs');
        const { fileURLToPath } = await import('url');
        const path = await import('path');
        const dir = path.dirname(fileURLToPath(import.meta.url));
        bytes = new Uint8Array(readFileSync(path.join(dir, '..', 'public', 'fonts', file)));
      }
      if (bytes && bytes.length) EMBED_FONTS = [{ name: 'Almarai', data: bytes }];
    } catch { /* embedding is best-effort; doc still renders with installed/fallback font */ }
  })();
  return _fontsPromise;
}

// ---------------------------------------------------------------------------------
//  FIX D — Thmanyah brand font for HTML export.
//  The shipped thmanyah-sans-*.ttf are actually WOFF2 (magic "wOF2"), NOT TrueType —
//  declaring format('truetype') made every browser silently reject them. Browsers DO
//  load WOFF2 fine; the fix is to declare format('woff2'). For an offline-portable
//  single-file HTML we base64-embed the faces so they render even when opened from
//  disk (where the /fonts/ path can't resolve). Best-effort: on failure we fall back
//  to a url('/fonts/...') src (works when the file is served) then to Almarai.
// ---------------------------------------------------------------------------------
const THMANYAH_FACES = [
  { file: 'thmanyah-sans-regular.ttf', weight: '400 600' },
  { file: 'thmanyah-sans-medium.ttf', weight: '500' },
  { file: 'thmanyah-sans-bold.ttf', weight: '700 900' },
];
let _thmanyahCss: string | null = null;
async function thmanyahFaceCss(): Promise<string> {
  if (_thmanyahCss !== null) return _thmanyahCss;
  const toDataUri = async (file: string): Promise<string | null> => {
    try {
      let bytes: Uint8Array | null = null;
      const isNode = typeof import.meta.url === 'string' && import.meta.url.startsWith('file:');
      if (!isNode && typeof fetch === 'function') {
        const res = await fetch(`/fonts/${file}`);
        if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        const { readFileSync } = await import('fs');
        const { fileURLToPath } = await import('url');
        const path = await import('path');
        const dir = path.dirname(fileURLToPath(import.meta.url));
        bytes = new Uint8Array(readFileSync(path.join(dir, '..', 'public', 'fonts', file)));
      }
      if (!bytes || !bytes.length) return null;
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
      return `data:font/woff2;base64,${b64}`;
    } catch { return null; }
  };
  const faces = await Promise.all(THMANYAH_FACES.map(async f => {
    const uri = await toDataUri(f.file);
    const src = uri ? `url('${uri}') format('woff2')` : `url('/fonts/${f.file}') format('woff2')`;
    return `@font-face{font-family:'Thmanyah Sans';src:${src};font-weight:${f.weight};font-display:swap;}`;
  }));
  _thmanyahCss = faces.join('\n');
  return _thmanyahCss;
}

/** Pack a Document to a Blob and force document-level RTL. Use everywhere
 *  instead of Packer.toBlob so every .docx is RTL at section + defaults level.
 *  Takes a builder thunk so embedded fonts are loaded BEFORE the Document is built. */
async function packDocx(build: () => Document): Promise<Blob> {
  await ensureFonts();
  return forceDocxRtl(await Packer.toBlob(build()));
}

// ---- clickable TOC: bookmark anchors on headings + internal hyperlinks ----
const anchorId = (i: number) => `sec_${i}`;

/** Heading-1 carrying a bookmark anchor so the TOC can link to it. */
function h1Anchored(text: string, anchor: string, o?: ExportOptions): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1, bidirectional: true, alignment: AlignmentType.RIGHT,
    spacing: { before: 280, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GOLD, space: 6 } },
    children: [new Bookmark({ id: anchor, children: [
      new TextRun({ text, bold: true, color: NAVY, size: 32, font: DOCX_FONT(o), rightToLeft: true }),
    ] })],
  });
}

/** One clickable TOC line: "label .... n" linking to its heading bookmark. */
function tocLink(label: string, anchor: string, num: number, o?: ExportOptions): Paragraph {
  const font = DOCX_FONT(o);
  return new Paragraph({
    bidirectional: true, alignment: AlignmentType.RIGHT,
    tabStops: [{ type: TabStopType.LEFT, position: TabStopPosition.MAX, leader: LeaderType.DOT }],
    spacing: { after: 60 },
    children: [new InternalHyperlink({ anchor, children: [
      new TextRun({ text: `${num}. ${label}`, font, rightToLeft: true, color: '1D4ED8' }),
      new TextRun({ text: '\t', font }),
    ] })],
  });
}

function inlineToRuns(runs: InlineRun[], o?: ExportOptions): TextRun[] {
  const font = DOCX_FONT(o);
  return runs.flatMap(r => {
    if (r.code) return [new TextRun({ text: r.text, font: MONO_FONT, shading: { fill: 'F1F5F9' }, rightToLeft: false })];
    // Split off numeric/operator tokens (≥ 90%, 10,000…) as LTR runs so Word doesn't
    // mirror the comparison glyphs the way it does inside an RTL run.
    return splitBidiSegments(r.text).map(seg => new TextRun({
      text: seg.text, bold: r.bold, italics: r.italic, font, rightToLeft: !seg.ltr,
    }));
  });
}

function headingLevel(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (level) {
    case 1: return HeadingLevel.HEADING_1;
    case 2: return HeadingLevel.HEADING_2;
    case 3: return HeadingLevel.HEADING_3;
    case 4: return HeadingLevel.HEADING_4;
    case 5: return HeadingLevel.HEADING_5;
    default: return HeadingLevel.HEADING_6;
  }
}

// A4 content width in twips (11906 − 2×1000 margins). Skill rule: width on the
// Table AND every cell, in DXA — PERCENTAGE breaks RTL table layout in Word.
const TBL_W = 9900;

/** Rich RTL table per arabic-docx skill: DXA widths everywhere, CLEAR shading,
 *  navy header band with white text, zebra rows, real cell margins. */
function richDocxTable(headers: string[], rows: string[][], o?: ExportOptions): Table {
  const font = DOCX_FONT(o);
  const cols = Math.max(headers.length, 1);
  const cellW = Math.floor(TBL_W / cols);
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const mkCell = (text: string, header: boolean, zebra: boolean) => new TableCell({
    width: { size: cellW, type: WidthType.DXA },
    borders,
    shading: { fill: header ? NAVY : (zebra ? LIGHT : WHITE), type: ShadingType.CLEAR },
    margins: { top: 120, bottom: 120, left: 180, right: 180 },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.RIGHT,
      children: splitBidiSegments(stripMarkdown(text || '—')).map(seg => new TextRun({
        text: seg.text,
        bold: header,
        color: header ? WHITE : INK,
        font, rightToLeft: !seg.ltr, size: 22,
      })),
    })],
  });
  const trs: TableRow[] = [new TableRow({
    tableHeader: true, cantSplit: true,
    children: headers.map(h => mkCell(h, true, false)),
  })];
  rows.forEach((r, ri) => trs.push(new TableRow({
    cantSplit: true,
    children: Array.from({ length: cols }, (_, ci) => mkCell(r[ci] ?? '', false, ri % 2 === 1)),
  })));
  return new Table({
    width: { size: TBL_W, type: WidthType.DXA },
    columnWidths: Array.from({ length: cols }, () => cellW),
    visuallyRightToLeft: true,
    rows: trs,
  });
}

/** Mermaid source → centered embedded image paragraphs (diagram INSIDE the document body). */
async function mermaidBlockToDocx(code: string): Promise<Paragraph[]> {
  try {
    const { png, width, height } = await mermaidToPng(code);
    const img = dataUrlToUint8(png);
    if (!img) return [];
    const MAXW = 620, MAXH = 760;
    const scale = Math.min(MAXW / (width || MAXW), MAXH / (height || MAXH), 1);
    return [new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 160, after: 200 },
      children: [new ImageRun({
        data: img.data, type: img.type,
        transformation: { width: Math.max(1, Math.round((width || MAXW) * scale)), height: Math.max(1, Math.round((height || MAXH) * scale)) },
      } as any)],
    })];
  } catch { return []; } // un-renderable diagram → skip rather than dump raw code
}

async function blockToDocx(block: MdBlock, o?: ExportOptions): Promise<(Paragraph | Table)[]> {
  const font = DOCX_FONT(o);
  switch (block.type) {
    case 'spacer':
      return [new Paragraph({ text: '', bidirectional: true })];
    case 'heading': {
      // Brand heading colors: H1 navy w/ gold underline, H2 navy, H3+ cyan-dark.
      const hColor = block.level <= 2 ? NAVY : '0A6D82';
      const hSize = block.level === 1 ? 32 : block.level === 2 ? 28 : 26;
      return [new Paragraph({
        heading: headingLevel(block.level),
        bidirectional: true,
        alignment: AlignmentType.RIGHT,
        spacing: { before: 280, after: 120 },
        ...(block.level === 1 ? { border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GOLD, space: 6 } } } : {}),
        children: block.runs.flatMap(r => r.code
          ? [new TextRun({ text: r.text, bold: true, font: MONO_FONT, color: hColor, size: hSize, rightToLeft: false })]
          : splitBidiSegments(r.text).map(seg => new TextRun({
              text: seg.text, bold: true, italics: r.italic, font, color: hColor, size: hSize, rightToLeft: !seg.ltr,
            }))),
      })];
    }
    case 'bullet':
      // Ordered → manual "n." marker with hanging indent (keeps RTL numbering correct).
      if (block.ordered) {
        return [new Paragraph({
          bidirectional: true,
          alignment: AlignmentType.RIGHT,
          indent: { start: 600, hanging: 280 },
          children: [
            new TextRun({ text: `${block.marker || '•'} `, bold: true, font, rightToLeft: true }),
            ...inlineToRuns(block.runs, o),
          ],
        })];
      }
      return [new Paragraph({
        bullet: { level: 0 },
        bidirectional: true,
        alignment: AlignmentType.RIGHT,
        children: [
          ...(block.checked !== undefined
            ? [new TextRun({ text: block.checked ? '☑ ' : '☐ ', font, rightToLeft: true })]
            : []),
          ...inlineToRuns(block.runs, o),
        ],
      })];
    case 'quote':
      // arabic-docx pull quote: gold right border, light brand background, navy bold.
      return [new Paragraph({
        bidirectional: true,
        alignment: AlignmentType.RIGHT,
        spacing: { before: 200, after: 200 },
        indent: { right: 360 },
        border: { right: { style: BorderStyle.SINGLE, size: 24, color: GOLD, space: 10 } },
        shading: { fill: LIGHT, type: ShadingType.CLEAR },
        children: block.runs.flatMap(r =>
          splitBidiSegments(r.text).map(seg =>
            new TextRun({ text: seg.text, bold: true, italics: true, color: NAVY, font, rightToLeft: !seg.ltr }))),
      })];
    case 'code':
      // Mermaid → embedded rendered diagram (never raw code in the document).
      if ((block.lang || '').toLowerCase() === 'mermaid') return mermaidBlockToDocx(block.text);
      return block.text.split('\n').map(line => new Paragraph({
        alignment: AlignmentType.LEFT,
        shading: { fill: 'F1F5F9' },
        children: [new TextRun({ text: line || ' ', font: MONO_FONT, size: 18 })],
      }));
    case 'rule':
      return [new Paragraph({
        bidirectional: true,
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CBD5E1', space: 4 } },
        children: [new TextRun({ text: '', font })],
      })];
    case 'paragraph':
      return [new Paragraph({
        bidirectional: true,
        alignment: AlignmentType.RIGHT,
        children: inlineToRuns(block.runs, o),
      })];
    case 'table':
      return [richDocxTable(block.headers, block.rows, o)];
    default:
      return [];
  }
}

async function mdToDocx(md: string, o?: ExportOptions): Promise<(Paragraph | Table)[]> {
  const out: (Paragraph | Table)[] = [];
  for (const b of parseMarkdown(md)) out.push(...await blockToDocx(b, o));
  return out;
}

function dataUrlToUint8(dataUrl: string): { data: Uint8Array; type: 'png' | 'jpg' } | null {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  const type = m[1].toLowerCase().startsWith('jp') ? 'jpg' : 'png';
  const bin = atob(m[2]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return { data: arr, type };
}

/** Embedded diagrams (PNG data URLs) → docx paragraphs, scaled to fit the page. */
function diagramsToDocx(diagrams: GeneratedArtifact['diagrams'], o?: ExportOptions): (Paragraph | Table)[] {
  if (!diagrams || !diagrams.length) return [];
  const font = DOCX_FONT(o);
  const out: (Paragraph | Table)[] = [];
  out.push(new Paragraph({ children: [new PageBreak()] }));
  out.push(new Paragraph({
    heading: HeadingLevel.HEADING_1, bidirectional: true, alignment: AlignmentType.RIGHT,
    children: [new TextRun({ text: 'المخططات والرسومات', bold: true, font, rightToLeft: true })],
  }));
  // A4 = 11906×16838 twips. Content box = page − margins (1000 each side here).
  // twips→px @96dpi: px = twips / 15. Leave headroom for the diagram caption + spacing.
  const MARGIN = 1000;
  const MAXW = Math.floor((11906 - MARGIN * 2) / 15);            // ≈ 660px content width
  const MAXH = Math.floor((16838 - MARGIN * 2 - 1400) / 15);     // ≈ 1029px (minus caption room)
  diagrams.forEach((d, i) => {
    const img = dataUrlToUint8(d.png);
    if (!img) return;
    const w = d.width || 1000, h = d.height || 700;
    // fit BOTH width and height inside the content box → never overflow the page
    const scale = Math.min(MAXW / w, MAXH / h, 1);
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));
    // each diagram on its own page → no split across pages
    if (i > 0) out.push(new Paragraph({ children: [new PageBreak()] }));
    out.push(new Paragraph({
      heading: HeadingLevel.HEADING_3, bidirectional: true, alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: `${i + 1}. ${d.title}`, bold: true, font, rightToLeft: true })],
    }));
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 120, after: 240 },
      children: [new ImageRun({ data: img.data, type: img.type, transformation: { width: dw, height: dh } } as any)],
    }));
  });
  return out;
}

/** One html block per embedded diagram (caller decides grouping/pagination). */
function diagramItemHtml(d: NonNullable<GeneratedArtifact['diagrams']>[number], i: number): string {
  // PRD V15: embedded diagrams render FULL page-width (ratio preserved via height:auto),
  // not pinned to their natural — usually small, left-shifted — size.
  return `<div class="no-break" style="margin:18px 0;text-align:center"><h3 style="text-align:right">${i + 1}. ${escapeHtml(d.title)}</h3><img src="${d.png}" style="width:100%;max-width:100%;max-height:880px;height:auto;border:1px solid #e2e8f0;border-radius:8px"/></div>`;
}

/** Embedded diagrams → print/PDF html. */
function diagramsHtml(diagrams: GeneratedArtifact['diagrams']): string {
  if (!diagrams || !diagrams.length) return '';
  return `<div class="section"><h1>المخططات والرسومات</h1>${diagrams.map(diagramItemHtml).join('')}</div>`;
}

// arabic-docx cover: navy title block + gold subtitle strip + company/date.
function coverParagraphs(title: string, subtitle: string | undefined, o?: ExportOptions): Paragraph[] {
  const font = DOCX_FONT(o);
  const out: Paragraph[] = [];
  const logo = o?.logoUrl ? dataUrlToUint8(o.logoUrl) : null;
  if (logo) {
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 800, after: 300 },
      children: [new ImageRun({ data: logo.data, type: logo.type, transformation: { width: 140, height: 140 } } as any)],
    }));
  } else {
    out.push(new Paragraph({ spacing: { before: 1800, after: 0 }, children: [] }));
  }
  // navy block — main title (white, 26pt)
  out.push(new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.CENTER,
    shading: { fill: NAVY, type: ShadingType.CLEAR },
    spacing: { before: 240, after: 0 },
    children: [new TextRun({ text: title, bold: true, size: 52, color: WHITE, font, rightToLeft: true })],
  }));
  // gold strip — subtitle (white, 15pt)
  out.push(new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.CENTER,
    shading: { fill: GOLD, type: ShadingType.CLEAR },
    spacing: { before: 0, after: 360 },
    children: [new TextRun({ text: subtitle || ' ', bold: true, size: 30, color: WHITE, font, rightToLeft: true })],
  }));
  if (o?.companyName) {
    out.push(new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.CENTER,
      spacing: { before: 360 },
      children: [new TextRun({ text: o.companyName, bold: true, size: 28, color: NAVY, font, rightToLeft: true })],
    }));
  }
  out.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 160 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: GOLD, space: 8 } },
    children: [new TextRun({ text: new Date().toISOString().slice(0, 10), size: 20, color: GREY, font: EN_FONT })],
  }));
  out.push(new Paragraph({ children: [new PageBreak()] }));
  return out;
}

/** arabic-docx stat band: navy cells, gold numbers, white labels — one row. */
function docxStatBand(stats: { num: string; label: string }[], o?: ExportOptions): Table {
  const font = DOCX_FONT(o);
  const cellW = Math.floor(TBL_W / Math.max(stats.length, 1));
  const none = { style: BorderStyle.NONE } as const;
  return new Table({
    width: { size: TBL_W, type: WidthType.DXA },
    columnWidths: stats.map(() => cellW),
    visuallyRightToLeft: true,
    rows: [new TableRow({
      children: stats.map(s => new TableCell({
        width: { size: cellW, type: WidthType.DXA },
        shading: { fill: NAVY, type: ShadingType.CLEAR },
        margins: { top: 160, bottom: 160, left: 200, right: 200 },
        verticalAlign: VerticalAlign.CENTER,
        borders: { top: none, bottom: none, left: none, right: none },
        children: [
          new Paragraph({
            bidirectional: true, alignment: AlignmentType.CENTER, spacing: { before: 0, after: 60 },
            children: [new TextRun({ text: s.num, font: EN_FONT, color: GOLD, size: 48, bold: true })],
          }),
          new Paragraph({
            bidirectional: true, alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
            children: [new TextRun({ text: s.label, font, color: WHITE, size: 18, rightToLeft: true })],
          }),
        ],
      })),
    })],
  });
}

function buildDocxDocument(children: (Paragraph | Table)[], o?: ExportOptions, headerTitle?: string): Document {
  const font = DOCX_FONT(o);
  // Every exported document carries a running header + page numbers — not just
  // the structured manuals. Header text: "company — title" (or whichever exists).
  const headerText = [o?.companyName, headerTitle].filter(Boolean).join(' — ');
  const header = headerText
    ? new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, bidirectional: true,
        children: [new TextRun({ text: headerText, size: 16, color: '64748B', font, rightToLeft: true })] })] })
    : undefined;
  const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
    new TextRun({ text: 'صفحة ', size: 16, color: '64748B', font, rightToLeft: true }),
    new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '64748B', font }),
    new TextRun({ text: ' / ', size: 16, color: '64748B', font }),
    new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '64748B', font }),
  ] })] });
  return new Document({
    ...(EMBED_FONTS.length ? { fonts: EMBED_FONTS as any } : {}),
    styles: {
      default: {
        document: { run: { font } },
      },
    },
    sections: [{
      properties: { page: { margin: { top: 1100, bottom: 1100, left: 1000, right: 1000 } } },
      ...(header ? { headers: { default: header } } : {}),
      footers: { default: footer },
      children,
    }],
  });
}

/** Export a single assistant message (Markdown) as a real .docx. */
export async function exportMessageDocx(markdown: string, title: string, o?: ExportOptions): Promise<void> {
  const children: (Paragraph | Table)[] = [
    ...coverParagraphs(title, undefined, o),
    ...await mdToDocx(markdown, o),
  ];
  const blob = await packDocx(() => buildDocxDocument(children, o, title));
  downloadBlob(blob, `${safeName(o?.fileName || title)}.docx`);
}

/** Export a full generated long artifact (cover + TOC-ish + sections) as a real .docx. */
export async function exportDocx(artifact: GeneratedArtifact, o?: ExportOptions): Promise<void> {
  const blob = await buildDocxBlob(artifact, o);
  downloadBlob(blob, `${safeName(o?.fileName || artifact.title)}.docx`);
}

/** Build a single artifact as a .docx Blob (no download) — used by ZIP export. */
export async function buildDocxBlob(artifact: GeneratedArtifact, o?: ExportOptions): Promise<Blob> {
  const font = DOCX_FONT(o);
  const children: (Paragraph | Table)[] = [...coverParagraphs(artifact.title, artifact.goal, o)];

  // Clickable TOC: each entry hyperlinks to its section's bookmark anchor.
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1, bidirectional: true, alignment: AlignmentType.RIGHT,
    children: [new TextRun({ text: 'المحتويات', bold: true, font, rightToLeft: true })],
  }));
  let tn = 0;
  if (artifact.executiveSummary) children.push(tocLink('الملخص التنفيذي', anchorId(0), ++tn, o));
  artifact.sections.forEach((s, i) => {
    children.push(tocLink(stripMarkdown(s.title), anchorId(i + 1), ++tn, o));
  });
  children.push(new Paragraph({ children: [new PageBreak()] }));

  if (artifact.executiveSummary) {
    children.push(h1Anchored('الملخص التنفيذي', anchorId(0), o));
    children.push(...await mdToDocx(artifact.executiveSummary, o));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  for (let i = 0; i < artifact.sections.length; i++) {
    const s = artifact.sections[i];
    children.push(h1Anchored(`${i + 1}. ${stripMarkdown(s.title)}`, anchorId(i + 1), o));
    children.push(...await mdToDocx(s.content, o));
    if (i < artifact.sections.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // Embedded diagrams (Mermaid → PNG) on their own pages at the end.
  children.push(...diagramsToDocx(artifact.diagrams, o));

  return await packDocx(() => buildDocxDocument(children, o, artifact.title));
}

// ============================================================
//  Batch export — many generated docs at once, MERGED into one file or
//  each as a SEPARATE file, in either Word (.docx) or PDF. Diagrams that are
//  already embedded on each artifact are carried into the output.
// ============================================================

export type BatchFormat = 'docx' | 'pdf' | 'html';
export type BatchMode = 'merged' | 'separate';

/** Flatten N artifacts into ONE artifact: each doc becomes a chapter (its title +
 *  summary as the lead section, then its own sections), diagrams concatenated. */
function mergeArtifacts(arts: GeneratedArtifact[], title: string): GeneratedArtifact {
  const sections: GeneratedArtifact['sections'] = [];
  const diagrams: NonNullable<GeneratedArtifact['diagrams']> = [];
  let n = 0;
  arts.forEach((a) => {
    // Chapter lead = the doc title carrying its goal/summary so the merged TOC reads as a manual.
    sections.push({ id: `m${n++}`, title: a.title, content: a.executiveSummary || a.goal || '', status: 'done' });
    a.sections.forEach(s => sections.push({ id: `m${n++}`, title: `${a.title} — ${stripMarkdown(s.title)}`, content: s.content, status: 'done' }));
    (a.diagrams || []).forEach(d => diagrams.push({ ...d, title: `${a.title} — ${d.title || ''}`.trim() }));
  });
  return { title, goal: '', language: arts[0]?.language || 'ar', sections, diagrams, createdAt: new Date(), complete: true } as GeneratedArtifact;
}

/** Export a set of artifacts. merged → single file; separate → one file each. */
export async function exportArtifactsBatch(
  arts: GeneratedArtifact[],
  o: ExportOptions | undefined,
  cfg: { format: BatchFormat; mode: BatchMode; bundleTitle?: string },
): Promise<void> {
  const docs = (arts || []).filter(Boolean);
  if (!docs.length) return;
  const title = cfg.bundleTitle || (o?.fileName) || 'governance_documents';

  if (cfg.mode === 'merged') {
    const merged = mergeArtifacts(docs, title);
    if (cfg.format === 'docx') await exportDocx(merged, { ...o, fileName: title });
    else if (cfg.format === 'html') await exportHtml(merged, { ...o, fileName: title });
    else await exportPdfDirect(merged, { ...o, fileName: title });
    return;
  }

  // separate: one download per doc. Stagger slightly so browsers don't drop downloads.
  for (let i = 0; i < docs.length; i++) {
    const a = docs[i];
    const fileName = safeName(a.title || `doc_${i + 1}`);
    if (cfg.format === 'docx') await exportDocx(a, { ...o, fileName });
    else if (cfg.format === 'html') await exportHtml(a, { ...o, fileName });
    else await exportPdfDirect(a, { ...o, fileName });
    if (i < docs.length - 1) await new Promise(r => setTimeout(r, 400));
  }
}

// ============================================================
//  ZIP export (R5 #2) — ONE .zip with a version-named root folder and
//  per-type sub-folders, every generated document inside its type folder.
//  e.g.  مشروع_تال_للمقاولات_v4/
//          السياسات/ <policy docs>.docx
//          الإجراءات/ <procedure docs>.docx
//          ...
// ============================================================

/** Type-folder names (Arabic/English) by document kind. Mirrors the Library grouping. */
const ZIP_KIND_FOLDER: Record<string, { ar: string; en: string }> = {
  governance: { ar: 'أدلة الحوكمة', en: 'Governance manuals' },
  policy:     { ar: 'السياسات', en: 'Policies' },
  procedure:  { ar: 'الإجراءات', en: 'Procedures' },
  workflow:   { ar: 'سلاسل العمليات', en: 'Workflows' },
  orgchart:   { ar: 'الهياكل التنظيمية', en: 'Org structures' },
  jobdesc:    { ar: 'الأوصاف الوظيفية', en: 'Job descriptions' },
  gapfix:     { ar: 'معالجات الفجوات', en: 'Gap fixes' },
  charter:    { ar: 'المواثيق', en: 'Charters' },
};

export interface ZipDocItem { artifact: GeneratedArtifact; kind: string; }

/** Build ONE zip: root = `{project}_v{N}`, sub-folders by document type.
 *  Returns the blob + fileName instead of triggering download — caller owns the
 *  user-gesture so Edge's gesture-expiry check is bypassed. */
export async function exportArtifactsZip(
  items: ZipDocItem[],
  o: ExportOptions | undefined,
  cfg: { format: BatchFormat; projectName?: string; version?: number },
): Promise<{ total: number; written: number; skipped: number; blob: Blob; fileName: string }> {
  const docs = (items || []).filter(it => it && it.artifact);
  if (!docs.length) return { total: 0, written: 0, skipped: 0, blob: new Blob(), fileName: '' };
  const ar = (o?.language ?? 'ar') !== 'en';
  const JSZipMod = (await import('jszip')).default;
  const zip = new JSZipMod();

  const ver = cfg.version && cfg.version > 0 ? cfg.version : 1;
  const proj = safeName(cfg.projectName || (ar ? 'مشروع_الحوكمة' : 'governance_project'));
  const rootName = `${proj}_v${ver}`;
  const root = zip.folder(rootName)!;

  // de-dupe filenames within a folder
  const usedNames = new Map<string, number>();
  let written = 0, skipped = 0;

  for (let i = 0; i < docs.length; i++) {
    const { artifact, kind } = docs[i];
    const folderMeta = ZIP_KIND_FOLDER[kind] || { ar: kind || 'أخرى', en: kind || 'Other' };
    const folderName = safeName(ar ? folderMeta.ar : folderMeta.en);
    const folder = root.folder(folderName)!;

    let base = safeName(artifact.title || `${kind || 'doc'}_${i + 1}`);
    const key = `${folderName}/${base}`;
    const seen = usedNames.get(key) || 0;
    usedNames.set(key, seen + 1);
    if (seen) base = `${base}_${seen + 1}`;

    try {
      if (cfg.format === 'docx') {
        const blob = await buildDocxBlob(artifact, { ...o, fileName: base });
        folder.file(`${base}.docx`, blob);
        written++;
      } else {
        const blob = await buildPdfBlob(artifact, { ...o, fileName: base });
        if (blob) { folder.file(`${base}.pdf`, blob); written++; }
        else skipped++;   // jsPDF unavailable for this doc
      }
    } catch (e) {
      console.warn('[zip] doc skipped:', artifact.title, e);
      skipped++;
    }
  }

  // Manifest so the package is self-describing.
  const manifest = [
    ar ? `حزمة وثائق الحوكمة — ${rootName}` : `Governance document package — ${rootName}`,
    ar ? `الإصدار: v${ver}` : `Version: v${ver}`,
    ar ? `عدد الوثائق: ${written}${skipped ? ` (تخطّي ${skipped})` : ''}` : `Documents: ${written}${skipped ? ` (${skipped} skipped)` : ''}`,
    '',
    ...docs.map((d, i) => `${i + 1}. [${(ZIP_KIND_FOLDER[d.kind] || { ar: d.kind, en: d.kind })[ar ? 'ar' : 'en']}] ${d.artifact.title}`),
  ].join('\n');
  root.file(ar ? 'الفهرس.txt' : 'INDEX.txt', manifest);

  const out = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const fileName = `${rootName}.zip`;
  return { total: docs.length, written, skipped, blob: out, fileName };
}

// ============================================================
//  Rich governance MANUAL export (cover, doc-control, TOC, header/footer +
//  page numbers, signature block, RACI table, embedded org chart, gaps appendix).
// ============================================================

export interface ManualExtras {
  maturity?: MaturityReport;
  alignment?: FrameworkAlignment[];
  approvedBy?: string;       // signatory name
  effectiveDate?: string;    // ISO or display
}

const docxTable = (headers: string[], rows: string[][], o?: ExportOptions): Table =>
  richDocxTable(headers, rows, o);

function h1(text: string, o?: ExportOptions): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, bidirectional: true, alignment: AlignmentType.RIGHT,
    spacing: { before: 280, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GOLD, space: 6 } },
    children: [new TextRun({ text, bold: true, color: NAVY, size: 32, font: DOCX_FONT(o), rightToLeft: true })] });
}

/** Build a complete, professional governance manual as a real .docx. */
export async function exportGovernanceManual(
  model: CompanyGovernanceModel,
  artifact: GeneratedArtifact,
  o?: ExportOptions,
  extras?: ManualExtras,
): Promise<void> {
  const font = DOCX_FONT(o);
  const company = o?.companyName || model.companyName || '';
  const children: (Paragraph | Table)[] = [...coverParagraphs(artifact.title, artifact.goal, o)];

  // --- stat band (altanween): model coverage at a glance ---
  children.push(docxStatBand([
    { num: String(model.orgUnits.length), label: 'وحدة تنظيمية' },
    { num: String(model.roles.length), label: 'دور وظيفي' },
    { num: String(model.policies.length), label: 'سياسة' },
    { num: String((model.procedures || []).length), label: 'إجراء تشغيلي' },
  ], o));
  children.push(new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }));

  // --- document-control table ---
  children.push(h1('ضبط الوثيقة', o));
  children.push(docxTable(
    ['البند', 'التفاصيل'],
    [
      ['عنوان الوثيقة', artifact.title],
      ['الجهة', company],
      ['الإصدار', `v${model.version || 1}`],
      ['تاريخ الإصدار', extras?.effectiveDate || new Date().toISOString().slice(0, 10)],
      ['الحالة', artifact.complete ? 'معتمدة' : 'مسودة'],
      ['نطاق التغطية', `${model.orgUnits.length} وحدة، ${model.policies.length} سياسة، ${(model.procedures || []).length} إجراء`],
      ...(extras?.maturity ? [['درجة نضج الحوكمة', `${extras.maturity.overall}% — ${extras.maturity.label}`]] : []),
    ],
    o,
  ));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // --- TOC (clickable: every entry hyperlinks to its heading bookmark) ---
  children.push(h1('المحتويات', o));
  const toc: { label: string; anchor: string }[] = [];
  if (artifact.executiveSummary) toc.push({ label: 'الملخص التنفيذي', anchor: 'm_exec' });
  artifact.sections.forEach((s, i) => toc.push({ label: stripMarkdown(s.title), anchor: `m_sec${i}` }));
  toc.push({ label: 'مصفوفة الصلاحيات (RACI)', anchor: 'm_raci' });
  if (extras?.maturity) toc.push({ label: 'درجة نضج الحوكمة', anchor: 'm_maturity' });
  if (extras?.alignment?.length) toc.push({ label: 'المواءمة مع الأطر المرجعية', anchor: 'm_align' });
  toc.push({ label: 'ملحق: الفجوات الحوكمية', anchor: 'm_gaps' });
  toc.push({ label: 'اعتماد الوثيقة', anchor: 'm_approval' });
  toc.forEach((t, i) => children.push(tocLink(t.label, t.anchor, i + 1, o)));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // --- executive summary ---
  if (artifact.executiveSummary) {
    children.push(h1Anchored('الملخص التنفيذي', 'm_exec', o));
    children.push(...await mdToDocx(artifact.executiveSummary, o));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // --- body sections ---
  for (let i = 0; i < artifact.sections.length; i++) {
    const s = artifact.sections[i];
    children.push(h1Anchored(`${i + 1}. ${stripMarkdown(s.title)}`, `m_sec${i}`, o));
    children.push(...await mdToDocx(s.content, o));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // --- RACI / authority matrix ---
  children.push(h1Anchored('مصفوفة الصلاحيات (RACI)', 'm_raci', o));
  const levelAr: Record<string, string> = { execute: 'مسؤول (R)', approve: 'مساءل (A)', recommend: 'مُستشار (C)', inform: 'مُطّلع (I)' };
  const roleTitle = (id: string) => model.roles.find(r => r.id === id)?.title || '—';
  if ((model.authorities || []).length) {
    children.push(docxTable(
      ['القرار / الصلاحية', 'الدور الحامل', 'مستوى RACI'],
      (model.authorities || []).map(a => [a.decision, roleTitle(a.roleId), levelAr[a.level] || a.level]),
      o,
    ));
  } else {
    children.push(new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: 'لم تُعرّف صلاحيات بعد.', font, rightToLeft: true })] }));
  }
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // --- maturity ---
  if (extras?.maturity) {
    children.push(h1Anchored('درجة نضج الحوكمة', 'm_maturity', o));
    children.push(docxTable(
      ['المجال', 'الدرجة', 'المستوى'],
      extras.maturity.domains.map(d => [d.domain, `${d.score}%`, d.label]),
      o,
    ));
    children.push(new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, spacing: { before: 120 },
      children: [new TextRun({ text: `الدرجة الإجمالية: ${extras.maturity.overall}% — ${extras.maturity.label}`, bold: true, font, rightToLeft: true })] }));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // --- framework alignment ---
  if (extras?.alignment?.length) {
    children.push(h1Anchored('المواءمة مع الأطر المرجعية', 'm_align', o));
    const stateAr: Record<string, string> = { covered: 'مُغطّى', partial: 'جزئي', missing: 'مفقود' };
    extras.alignment.forEach(fa => {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, bidirectional: true, alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: `${fa.frameworkName} — ${fa.score}%`, bold: true, font, rightToLeft: true })] }));
      children.push(docxTable(['الضابط', 'الحالة', 'الدليل'],
        fa.controls.map(c => [c.title, stateAr[c.state] || c.state, c.evidence]), o));
    });
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // --- embedded diagrams (org chart etc.) ---
  children.push(...diagramsToDocx(artifact.diagrams, o));
  if ((artifact.diagrams || []).length) children.push(new Paragraph({ children: [new PageBreak()] }));

  // --- gaps appendix ---
  children.push(h1Anchored('ملحق: الفجوات الحوكمية', 'm_gaps', o));
  const openGaps = (model.gaps || []).filter(g => !g.resolved);
  if (openGaps.length) {
    children.push(docxTable(['المجال', 'الوصف', 'الخطورة', 'التوصية'],
      openGaps.map(g => [g.area, g.description, g.severity, g.recommendation || '—']), o));
  } else {
    children.push(new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: 'لا توجد فجوات مفتوحة — جميعها مُعالَجة. ✅', font, rightToLeft: true })] }));
  }
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // --- signature / approval block ---
  children.push(h1Anchored('اعتماد الوثيقة', 'm_approval', o));
  children.push(docxTable(
    ['الدور', 'الاسم', 'التوقيع', 'التاريخ'],
    [
      ['أعدّها', '', '', ''],
      ['راجعها', '', '', ''],
      ['اعتمدها', extras?.approvedBy || '', '', extras?.effectiveDate || ''],
    ],
    o,
  ));

  // --- header/footer with page numbers ---
  const header = new Header({ children: [new Paragraph({
    alignment: AlignmentType.RIGHT, bidirectional: true,
    children: [new TextRun({ text: `${company} — ${artifact.title}`, size: 16, color: '64748B', font, rightToLeft: true })],
  })] });
  const footer = new Footer({ children: [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({ text: 'صفحة ', size: 16, color: '64748B', font, rightToLeft: true }),
      new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '64748B', font }),
      new TextRun({ text: ' / ', size: 16, color: '64748B', font }),
      new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '64748B', font }),
    ],
  })] });

  // Built inside the thunk so packDocx's ensureFonts() runs first and EMBED_FONTS is populated.
  const blob = await packDocx(() => new Document({
    ...(EMBED_FONTS.length ? { fonts: EMBED_FONTS as any } : {}),
    styles: { default: { document: { run: { font } } } },
    sections: [{
      properties: { page: { margin: { top: 1200, bottom: 1200, left: 1000, right: 1000 } } },
      headers: { default: header },
      footers: { default: footer },
      children,
    }],
  }));
  downloadBlob(blob, `${safeName(o?.fileName || artifact.title)}.docx`);
}

// ============================================================
//  Sample-matching MANUAL exporters (built straight from the model):
//   1) دليل دورة العمل المتكاملة  2) دليل الأوصاف الوظيفية  3) دليل السياسات
//  Each mirrors the structure of the real consultancy deliverables.
// ============================================================

function h2(text: string, o?: ExportOptions): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, bidirectional: true, alignment: AlignmentType.RIGHT,
    spacing: { before: 240, after: 100 },
    children: [new TextRun({ text, bold: true, color: NAVY, size: 28, font: DOCX_FONT(o), rightToLeft: true })] });
}
function h3(text: string, o?: ExportOptions): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_3, bidirectional: true, alignment: AlignmentType.RIGHT,
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, bold: true, color: '0A6D82', size: 26, font: DOCX_FONT(o), rightToLeft: true })] });
}
function para(text: string, o?: ExportOptions): Paragraph {
  return new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT,
    children: [new TextRun({ text, font: DOCX_FONT(o), rightToLeft: true })] });
}
function bullet(text: string, o?: ExportOptions): Paragraph {
  return new Paragraph({ bullet: { level: 0 }, bidirectional: true, alignment: AlignmentType.RIGHT,
    children: [new TextRun({ text, font: DOCX_FONT(o), rightToLeft: true })] });
}
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

/** Wrap children into a manual Document with RTL header/footer + page numbers. */
function buildManualDoc(children: (Paragraph | Table)[], company: string, title: string, o?: ExportOptions): Document {
  const font = DOCX_FONT(o);
  const header = new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, bidirectional: true,
    children: [new TextRun({ text: `${company} — ${title}`, size: 16, color: '64748B', font, rightToLeft: true })] })] });
  const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
    new TextRun({ text: 'صفحة ', size: 16, color: '64748B', font, rightToLeft: true }),
    new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '64748B', font }),
    new TextRun({ text: ' / ', size: 16, color: '64748B', font }),
    new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '64748B', font }),
  ] })] });
  return new Document({
    ...(EMBED_FONTS.length ? { fonts: EMBED_FONTS as any } : {}),
    styles: { default: { document: { run: { font } } } },
    sections: [{
      properties: { page: { margin: { top: 1200, bottom: 1200, left: 1000, right: 1000 } } },
      headers: { default: header }, footers: { default: footer }, children,
    }],
  });
}

function docCtrl(model: CompanyGovernanceModel, company: string, title: string, scopeLine: string, o?: ExportOptions): (Paragraph | Table)[] {
  return [
    h1('ضبط الوثيقة', o),
    docxTable(['البند', 'التفاصيل'], [
      ['عنوان الوثيقة', title],
      ['الجهة', company],
      ['الإصدار', `v${model.version || 1}`],
      ['تاريخ الإصدار', new Date().toISOString().slice(0, 10)],
      ['نطاق التغطية', scopeLine],
    ], o),
    pageBreak(),
  ];
}

/** 1) دليل دورة العمل المتكاملة — مصفوفة الترابط + لكل وحدة: الهدف/الإجراءات/مراحل سير العمل. */
export async function exportWorkflowManual(model: CompanyGovernanceModel, o?: ExportOptions): Promise<void> {
  const font = DOCX_FONT(o);
  const company = o?.companyName || model.companyName || '';
  const title = o?.fileName || 'دليل دورة العمل المتكاملة';
  const unitName = (id?: string) => model.orgUnits.find(u => u.id === id)?.name || '—';
  const children: (Paragraph | Table)[] = [
    ...coverParagraphs(title, 'الترابط بين الوحدات وسير العمل التشغيلي', o),
    ...docCtrl(model, company, title, `${model.orgUnits.length} وحدة، ${(model.procedures || []).length} إجراء`, o),
  ];

  // --- interconnection (feed) matrix ---
  children.push(h1('مصفوفة الترابط بين الوحدات', o));
  if (model.orgUnits.length) {
    children.push(docxTable(
      ['الوحدة', 'تُغذّي (مخرجات إلى)', 'تعتمد على (مدخلات من)'],
      model.orgUnits.map(u => [
        u.name,
        (u.feeds || []).map(unitName).join('، ') || '—',
        (u.dependsOn || []).map(unitName).join('، ') || '—',
      ]),
      o,
    ));
  } else {
    children.push(para('لا توجد وحدات معرّفة بعد.', o));
  }
  children.push(pageBreak());

  // --- per-unit workflow ---
  for (let i = 0; i < model.orgUnits.length; i++) {
    const u = model.orgUnits[i];
    children.push(h1(`${i + 1}. ${u.name}`, o));
    if (u.objective) { children.push(h3('الهدف', o)); children.push(para(u.objective, o)); }
    if (u.mandate) { children.push(h3('المهمة', o)); children.push(para(u.mandate, o)); }

    const procs = (model.procedures || []).filter(p => p.unitId === u.id);
    if (procs.length) {
      children.push(h3('الإجراءات التشغيلية', o));
      for (const pr of procs) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_4, bidirectional: true, alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: pr.title, bold: true, font, rightToLeft: true })] }));
        if (pr.purpose) children.push(para(pr.purpose, o));
        if (pr.steps?.length) {
          children.push(docxTable(['#', 'الخطوة'], pr.steps.map((s, n) => [String(n + 1), s]), o));
        } else if (pr.body) {
          children.push(...await mdToDocx(pr.body, o));
        }
      }
    }

    if (u.workflow?.length) {
      children.push(h3('مراحل سير العمل', o));
      children.push(docxTable(['المرحلة', 'الوصف', 'المسؤول'],
        u.workflow.map(w => [w.stage, w.description, w.responsible]), o));
    }
    children.push(pageBreak());
  }

  const blob = await packDocx(() => buildManualDoc(children, company, title, o));
  downloadBlob(blob, `${safeName(title)}.docx`);
}

/** 2) دليل الأوصاف الوظيفية — لكل دور: بطاقة وصف كاملة + جدول مؤشرات موزونة. */
export async function exportJobDescriptions(model: CompanyGovernanceModel, o?: ExportOptions): Promise<void> {
  const font = DOCX_FONT(o);
  const company = o?.companyName || model.companyName || '';
  const title = o?.fileName || 'دليل الأوصاف الوظيفية';
  const unitName = (id?: string) => model.orgUnits.find(u => u.id === id)?.name || '—';
  const children: (Paragraph | Table)[] = [
    ...coverParagraphs(title, 'بطاقات الوصف الوظيفي ومؤشرات الأداء', o),
    ...docCtrl(model, company, title, `${model.roles.length} دور وظيفي`, o),
  ];

  if (!model.roles.length) children.push(para('لا توجد أدوار معرّفة بعد.', o));

  model.roles.forEach((r, i) => {
    children.push(h1(`${i + 1}. ${r.title}`, o));

    // identity table
    children.push(docxTable(['البند', 'التفاصيل'], [
      ['المسمى الوظيفي', r.title],
      ['الإدارة/الوحدة', unitName(r.unitId)],
      ['المستوى الإداري', r.managerialLevel || '—'],
      ['يرفع تقاريره إلى', r.relations?.reportsTo || '—'],
    ], o));

    if (r.summary) { children.push(h3('ملخص الوظيفة', o)); children.push(para(r.summary, o)); }
    else if (r.purpose) { children.push(h3('الغرض من الوظيفة', o)); children.push(para(r.purpose, o)); }

    // responsibilities — grouped if available, else flat
    if (r.responsibilityGroups?.length) {
      children.push(h3('المسؤوليات والمهام', o));
      r.responsibilityGroups.forEach(g => {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_4, bidirectional: true, alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: g.theme, bold: true, font, rightToLeft: true })] }));
        g.items.forEach(it => children.push(bullet(it, o)));
      });
    } else if (r.responsibilities?.length) {
      children.push(h3('المسؤوليات والمهام', o));
      r.responsibilities.forEach(it => children.push(bullet(it, o)));
    }

    // qualifications
    if (r.qualifications && (r.qualifications.education || r.qualifications.experience || r.qualifications.certifications)) {
      children.push(h3('المؤهلات والخبرات', o));
      children.push(docxTable(['البند', 'التفاصيل'], [
        ['المؤهل العلمي', r.qualifications.education || '—'],
        ['الخبرة', r.qualifications.experience || '—'],
        ['الشهادات', r.qualifications.certifications || '—'],
      ], o));
    }

    // skills
    if (r.skills && ((r.skills.technical?.length) || (r.skills.soft?.length))) {
      children.push(h3('المهارات', o));
      children.push(docxTable(['النوع', 'المهارات'], [
        ['مهارات فنية', (r.skills.technical || []).join('، ') || '—'],
        ['مهارات سلوكية', (r.skills.soft || []).join('، ') || '—'],
      ], o));
    }

    // relations
    if (r.relations && ((r.relations.supervises?.length) || (r.relations.interactsWith?.length))) {
      children.push(h3('علاقات العمل', o));
      children.push(docxTable(['البند', 'التفاصيل'], [
        ['يشرف على', (r.relations.supervises || []).join('، ') || '—'],
        ['يتفاعل مع', (r.relations.interactsWith || []).join('، ') || '—'],
      ], o));
    }

    // weighted KPIs owned by this role
    const roleKpis = (model.kpis || []).filter(k => k.roleId === r.id);
    if (roleKpis.length) {
      children.push(h3('مؤشرات الأداء الرئيسية (موزونة)', o));
      children.push(docxTable(
        ['المؤشر', 'المعادلة', 'المستهدف', 'الوزن %', 'الدورية', 'طريقة القياس'],
        roleKpis.map(k => [k.name, k.formula || '—', k.target || '—',
          typeof k.weight === 'number' ? String(k.weight) : '—', k.frequency || '—', k.measurementMethod || '—']),
        o,
      ));
      const sum = roleKpis.reduce((s, k) => s + (k.weight || 0), 0);
      if (sum) children.push(para(`إجمالي الأوزان: ${sum}%`, o));
    }

    children.push(pageBreak());
  });

  const blob = await packDocx(() => buildManualDoc(children, company, title, o));
  downloadBlob(blob, `${safeName(title)}.docx`);
}

/** 3) دليل السياسات — محاور→سياسات + مصفوفة التفويض المالي + اللجان والاجتماعات. */
export async function exportPoliciesManual(model: CompanyGovernanceModel, o?: ExportOptions): Promise<void> {
  const font = DOCX_FONT(o);
  const company = o?.companyName || model.companyName || '';
  const title = o?.fileName || 'دليل السياسات والصلاحيات';
  const roleTitle = (id?: string) => model.roles.find(r => r.id === id)?.title || '—';
  const children: (Paragraph | Table)[] = [
    ...coverParagraphs(title, 'السياسات ومبادئها وآليات تطبيقها', o),
    ...docCtrl(model, company, title, `${model.policies.length} سياسة، ${(model.authorities || []).length} صلاحية`, o),
  ];

  // --- policies grouped by domain (محور) ---
  const domains = Array.from(new Set(model.policies.map(p => p.domain || 'عام')));
  if (!model.policies.length) children.push(para('لا توجد سياسات معرّفة بعد.', o));
  for (let di = 0; di < domains.length; di++) {
    const dom = domains[di];
    children.push(h1(`المحور ${di + 1}: ${dom}`, o));
    for (const pol of model.policies.filter(p => (p.domain || 'عام') === dom)) {
      children.push(h2(pol.title, o));
      if (pol.body) children.push(...await mdToDocx(pol.body, o));
      else children.push(para('— لم يُوثّق نص السياسة بعد —', o));
    }
    children.push(pageBreak());
  }

  // --- financial Delegation-of-Authority matrix ---
  children.push(h1('مصفوفة التفويض المالي والصلاحيات', o));
  const levelAr: Record<string, string> = { execute: 'ينفّذ', approve: 'يعتمد', recommend: 'يوصي', inform: 'يُبلَّغ' };
  if ((model.authorities || []).length) {
    children.push(docxTable(
      ['القرار / الصلاحية', 'الدور الحامل', 'المستوى', 'حدّ التفويض', 'السقف الأعلى'],
      (model.authorities || []).map(a => [a.decision, roleTitle(a.roleId),
        levelAr[a.level] || a.level, a.threshold || '—', a.limit || '—']),
      o,
    ));
  } else {
    children.push(para('لم تُعرّف صلاحيات بعد.', o));
  }
  children.push(pageBreak());

  // --- committees ---
  children.push(h1('اللجان', o));
  if ((model.committees || []).length) {
    children.push(docxTable(['اللجنة', 'الأعضاء', 'المهمة', 'الدورية'],
      (model.committees || []).map(c => [c.name, (c.members || []).join('، ') || '—', c.mandate || '—', c.cadence || '—']), o));
  } else {
    children.push(para('لا توجد لجان معرّفة بعد.', o));
  }

  // --- meetings ---
  children.push(h2('الاجتماعات الدورية', o));
  if ((model.meetings || []).length) {
    children.push(docxTable(['النوع', 'الغرض', 'التكرار', 'الحضور'],
      (model.meetings || []).map(mt => [mt.type, mt.purpose || '—', mt.frequency || '—', (mt.attendees || []).join('، ') || '—']), o));
  } else {
    children.push(para('لا توجد اجتماعات معرّفة بعد.', o));
  }

  const blob = await packDocx(() => buildManualDoc(children, company, title, o));
  downloadBlob(blob, `${safeName(title)}.docx`);
}

// ============================================================
//  PDF (default: iframe + window.print — perfect Arabic shaping)
// ============================================================

const PRINT_CSS = (font: string) => `
  @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;900&family=Cairo:wght@400;600;700;900&display=swap');
  /* Brand font: Thmanyah Sans (real woff2 — loads + shapes Arabic correctly under
     html2canvas). Almarai kept as a fallback face. */
  ${PDF_FONTFACE}
  /* The app's global stylesheet tracks headings at -0.288px; any non-normal
     letter-spacing makes html2canvas paint text glyph-by-glyph, which destroys
     Arabic joining (headings come out scrambled). Force it off for export. */
  * { box-sizing: border-box; letter-spacing: normal !important; word-spacing: normal !important; }
  /* Overflow guard (arabic-pdf skill §12): the export holder is a fixed 794px box;
     anything wider gets CLIPPED by html2canvas (long words, URLs, wide tables, code).
     Force every text container to wrap instead of bleed off the page edge. */
  body, .pdf-root { font-family: '${font}','Almarai','Cairo','Tajawal',sans-serif; direction: rtl; text-align: right; color:#${TINK}; background:#fff; line-height:1.95; font-size:14px; max-width:100%; overflow-wrap:break-word; word-break:break-word; }
  body { padding:36px 42px; }
  h1,h2,h3,h4,h5,h6,p,li,blockquote,th,td { text-align:right; overflow-wrap:break-word; word-break:break-word; }
  h1 { font-size:23px; color:#${TEALD}; margin:26px 0 12px; line-height:1.45; font-weight:900; border-bottom:3px solid #${TEAL}; padding-bottom:7px; }
  h2 { font-size:19px; color:#${TEALD}; margin:20px 0 10px; font-weight:800; }
  h3 { font-size:16px; color:#${TEAL}; margin:16px 0 8px; font-weight:700; }
  h4 { font-size:14.5px; color:#${TBLUE}; margin:13px 0 6px; font-weight:700; }
  h5 { font-size:13.5px; color:#${TBLUE}; margin:11px 0 4px; font-weight:700; }
  h6 { font-size:13px; color:#${GREY}; margin:10px 0 4px; font-weight:600; }
  p { margin:8px 0; }
  ul,ol { margin:8px 28px 8px 0; padding:0 20px 0 0; }
  li { margin:5px 0; }
  li::marker { color:#${TEAL}; font-weight:700; }
  blockquote { margin:14px 0; padding:12px 18px; border-right:5px solid #${TEAL}; background:#${BRAND50}; color:#${TEALD}; font-weight:600; font-style:italic; border-radius:0 8px 8px 0; }
  /* white-space:pre-wrap + break-word: long code lines wrap on paper instead of
     overflowing (overflow-x:auto gives no scrollbar in a rasterized PDF → clipped). */
  pre { background:#${BRAND50}; padding:14px 16px; border-radius:8px; direction:ltr; text-align:left; margin:10px 0; max-width:100%; white-space:pre-wrap; overflow-wrap:break-word; word-break:break-word; border:1px solid #${BRAND100}; }
  pre code { font-family:'Courier New',monospace; font-size:13px; color:#${TINK}; white-space:pre-wrap; word-break:break-word; }
  code { background:#${BRAND50}; padding:2px 6px; border-radius:4px; font-family:monospace; font-size:0.88em; color:#${TEALD}; overflow-wrap:break-word; word-break:break-word; }
  hr { border:none; border-top:2px solid #${TEAL}; opacity:.45; margin:18px 0; }
  /* table-layout:fixed pins columns to the page width so a wide table wraps its
     cells rather than stretching past the holder and getting clipped. */
  table { width:100%; max-width:100%; border-collapse:collapse; margin:14px 0; font-size:13px; table-layout:fixed; }
  th,td { border:1px solid #cfe4e9; padding:9px 12px; vertical-align:top; overflow-wrap:break-word; word-break:break-word; }
  th { background:#${TEALD}; font-weight:800; color:#fff; }
  tr:nth-child(even) td { background:#${BRAND50}; }
  .mermaid { margin:18px auto; text-align:center; max-width:100%; background:#f7fafb; border:1px solid #${BRAND100}; border-radius:10px; padding:16px; }
  /* PRD V15: diagrams fill the page width (ratio preserved), not their small natural size. */
  .mermaid svg, .mermaid-img { width:100%; max-width:100%; height:auto; }
  .mermaid-fig { margin:18px auto; text-align:center; background:#f7fafb; border:1px solid #${BRAND100}; border-radius:10px; padding:14px; }
  .cover { text-align:center; padding:70px 0 50px; page-break-after:always; }
  .cover img { width:150px; height:150px; object-fit:contain; margin-bottom:26px; }
  .cover .title { background:linear-gradient(135deg,#${TEAL},#${TBLUE}); color:#fff; font-size:32px; font-weight:900; padding:34px 26px; margin:0; line-height:1.5; border-radius:14px; }
  .cover .subtitle { color:#${TEALD}; font-size:18px; font-weight:700; padding:14px 22px; margin:8px 36px 0; }
  .cover .company { font-size:17px; color:#${TEALD}; margin-top:30px; font-weight:800; }
  .cover .date { display:inline-block; font-size:13px; color:#${GREY}; margin-top:12px; border-bottom:2px solid #${TEAL}; padding-bottom:4px; }
  .toc { page-break-after:always; padding:0 0 20px; }
  .toc h1 { border-bottom:3px solid #${TEAL}; padding-bottom:8px; }
  .toc ol { list-style:none; margin:10px 0; padding:0; }
  .toc li { padding:7px 0; border-bottom:1px dotted #bfdbe2; font-weight:600; color:#${TEALD}; }
  .toc li a { color:inherit; text-decoration:none; display:flex; align-items:center; }
  .toc-num { display:inline-block; min-width:26px; height:26px; line-height:26px; text-align:center; background:#${TEAL}; color:#fff; border-radius:13px; font-size:12px; font-weight:800; margin-left:10px; }
  .toc li:nth-child(3n+2) .toc-num { background:#${TEALD}; color:#fff; }
  .toc li:nth-child(3n) .toc-num { background:#${TBLUE}; color:#fff; }
  .sec-h.t1 { color:#${TEAL}; border-bottom-color:#${TEALD}; }
  .sec-h.t2 { color:#${TBLUE}; border-bottom-color:#${TEALD}; }
  .stat-band { display:flex; gap:0; background:linear-gradient(135deg,#${TEALD},#${TBLUE}); border-radius:10px; overflow:hidden; margin:16px 0; }
  .stat-band .stat { flex:1; text-align:center; padding:16px 8px; }
  .stat-band .num { color:#fff; font-size:30px; font-weight:900; }
  .stat-band .lbl { color:#${BRAND100}; font-size:12.5px; margin-top:2px; }
  .section { page-break-before:always; padding-top:4px; }
  @media print {
    @page { size:A4; margin:18mm 15mm; }
    body { padding:0; font-size:13px; }
    .section { page-break-before:always; }
    .no-break { break-inside:avoid; }
    h1,h2,h3 { break-after:avoid; }
  }
`;

function cellHtml(text: string): string {
  // Preserve inline bold/italic/code inside table cells (was plain stripMarkdown before).
  return inlineToHtml(parseInline(text));
}

function blocksToHtml(md: string, mermaidImg?: (code: string) => string | null): string {
  const blocks = parseMarkdown(md);
  let html = '';
  let list: '' | 'ul' | 'ol' = '';
  const closeList = () => { if (list) { html += `</${list}>`; list = ''; } };
  for (const b of blocks) {
    if (b.type === 'bullet') {
      const want = b.ordered ? 'ol' : 'ul';
      if (list !== want) { closeList(); html += `<${want}>`; list = want; }
      const box = b.checked !== undefined ? (b.checked ? '☑ ' : '☐ ') : '';
      html += `<li>${box}${inlineToHtml(b.runs)}</li>`;
      continue;
    }
    closeList();
    if (b.type === 'heading') html += `<h${b.level}>${inlineToHtml(b.runs)}</h${b.level}>`;
    else if (b.type === 'paragraph') html += `<p>${inlineToHtml(b.runs)}</p>`;
    else if (b.type === 'quote') html += `<blockquote>${inlineToHtml(b.runs)}</blockquote>`;
    else if (b.type === 'code') {
      if ((b.lang || '').toLowerCase() === 'mermaid') {
        const img = mermaidImg?.(b.text);
        if (img) html += img;
        else if (mermaidImg) html += '';                 // direct path, render failed → skip raw code
        else html += `<div class="mermaid no-break">${escapeHtml(b.text)}</div>`;  // print path: live mermaid.js
      }
      else html += `<pre><code>${escapeHtml(b.text)}</code></pre>`;
    }
    else if (b.type === 'rule') html += '<hr/>';
    else if (b.type === 'spacer') html += '';
    else if (b.type === 'table') {
      html += '<table class="no-break"><thead><tr>' +
        b.headers.map(h => `<th>${cellHtml(h)}</th>`).join('') + '</tr></thead><tbody>' +
        b.rows.map(r => '<tr>' + r.map(c => `<td>${cellHtml(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>';
    }
  }
  closeList();
  return html;
}

/** Direct-PDF variant: pre-renders mermaid blocks to PNG <img> (no live mermaid.js offscreen). */
async function blocksToHtmlAsync(md: string): Promise<string> {
  const imgs = new Map<string, string>();
  for (const b of parseMarkdown(md)) {
    if (b.type === 'code' && (b.lang || '').toLowerCase() === 'mermaid' && !imgs.has(b.text)) {
      try {
        const { png } = await mermaidToPng(b.text);
        imgs.set(b.text, `<div class="mermaid-fig no-break"><img class="mermaid-img" src="${png}"/></div>`);
      } catch { imgs.set(b.text, ''); }
    }
  }
  return blocksToHtml(md, code => imgs.get(code) ?? '');
}

function coverHtml(title: string, subtitle: string | undefined, o?: ExportOptions): string {
  const date = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
  return `<div class="cover">
    ${o?.logoUrl ? `<img src="${o.logoUrl}" alt="logo"/>` : ''}
    <div class="title">${escapeHtml(title)}</div>
    <div class="subtitle">${subtitle ? escapeHtml(subtitle) : '&nbsp;'}</div>
    ${o?.companyName ? `<div class="company">${escapeHtml(o.companyName)}</div>` : ''}
    <div><span class="date">${date}</span></div>
  </div>`;
}

function printHtml(innerHtml: string, title: string, o?: ExportOptions) {
  const iframe = document.createElement('iframe');
  Object.assign(iframe.style, { position: 'absolute', width: '0', height: '0', top: '-1000px', left: '-1000px' });
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow?.document || iframe.contentDocument;
  if (!doc) return;
  doc.open();
  doc.write(`<html dir="rtl"><head><title>${escapeHtml(title)}</title><style>${PRINT_CSS(PDF_FONT)}</style>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script>
  </head><body>${innerHtml}<script>
    mermaid.initialize({startOnLoad:true,theme:'neutral',rtl:false,flowchart:{htmlLabels:true,useMaxWidth:true}});
    window.addEventListener('load',()=>{
      mermaid.run().catch(()=>{}).finally(()=>{
        setTimeout(()=>{window.print();setTimeout(()=>{try{window.parent.document.body.removeChild(window.frameElement);}catch(e){}},500);},900);
      });
    });
  <\/script></body></html>`);
  doc.close();
  // Parent-side safety net: the in-iframe self-removal only fires on a successful
  // load→mermaid.run→print sequence. If mermaid hangs, the CDN script is blocked
  // (offline), or print() throws, the iframe would leak forever and accumulate across
  // exports. Force-remove after a generous window regardless.
  setTimeout(() => { try { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); } catch {} }, 60_000);
}

/** Default PDF path: print window with native browser Arabic shaping. */
export function exportPdfViaPrint(artifact: GeneratedArtifact, o?: ExportOptions) {
  const toc = `<div class="toc"><h1>المحتويات</h1><ol>${
    artifact.sections.map((s, i) => `<li><a href="#sec-${i}"><span class="toc-num">${i + 1}</span>${escapeHtml(stripMarkdown(s.title))}</a></li>`).join('')
  }</ol></div>`;
  const summary = artifact.executiveSummary
    ? `<div class="section"><h1 class="sec-h">الملخص التنفيذي</h1>${blocksToHtml(artifact.executiveSummary)}</div>` : '';
  const body = artifact.sections.map((s, i) =>
    `<div class="section"><h1 id="sec-${i}" class="sec-h t${i % 3}">${i + 1}. ${escapeHtml(stripMarkdown(s.title))}</h1>${blocksToHtml(s.content)}</div>`
  ).join('');
  printHtml(coverHtml(artifact.title, artifact.goal, o) + toc + summary + body + diagramsHtml(artifact.diagrams), artifact.title, o);
}

/**
 * Build the COMPLETE standalone PDF HTML document (head+style+body) used by the
 * print path — but as a pure string with no DOM, no auto-print, no mermaid CDN.
 * Intended for headless rendering / offline visual QA of export shape. `fontBase`
 * rewrites the `/fonts/` web paths to a filesystem/URL base so Thmanyah resolves
 * when the file is opened directly (e.g. `file:///…/public/fonts/`).
 */
export function buildStandalonePdfHtml(artifact: GeneratedArtifact, o?: ExportOptions, fontBase?: string): string {
  const font = PDF_FONT;
  const toc = `<div class="toc"><h1>المحتويات</h1><ol>${
    artifact.sections.map((s, i) => `<li><a href="#sec-${i}"><span class="toc-num">${i + 1}</span>${escapeHtml(stripMarkdown(s.title))}</a></li>`).join('')
  }</ol></div>`;
  const summary = artifact.executiveSummary
    ? `<div class="section"><h1 class="sec-h">الملخص التنفيذي</h1>${blocksToHtml(artifact.executiveSummary)}</div>` : '';
  const body = artifact.sections.map((s, i) =>
    `<div class="section"><h1 id="sec-${i}" class="sec-h t${i % 3}">${i + 1}. ${escapeHtml(stripMarkdown(s.title))}</h1>${blocksToHtml(s.content)}</div>`
  ).join('');
  const inner = coverHtml(artifact.title, artifact.goal, o) + toc + summary + body + diagramsHtml(artifact.diagrams);
  let css = PRINT_CSS(font);
  if (fontBase) css = css.split("url('/fonts/").join(`url('${fontBase}`);
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${escapeHtml(artifact.title)}</title><style>${css}</style></head><body class="pdf-root">${inner}</body></html>`;
}

// ============================================================
//  HTML (navigable single-file) — canonical interactive output.
//  Same markdown AST as DOCX/PDF/PPTX; sidebar TOC + live search +
//  anchors + company identity. Self-contained (inline mermaid PNGs,
//  embedded CSS+JS), opens offline in any browser.
// ============================================================

const HTML_CSS = (font: string) => `
:root{--brand:#0f766e;--brand-d:#065f46;--ink:#0f172a;--mut:#475569;--line:#e2e8f0;--bg:#f8fafc;--card:#fff;--mist:#f0fdf9;}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font-family:'${font}','Almarai','Segoe UI',Tahoma,sans-serif;line-height:1.85}
a{color:var(--brand);text-decoration:none}
.hw-wrap{display:flex;min-height:100vh;max-width:1400px;margin:0 auto}
.hw-side{width:300px;flex:0 0 300px;background:var(--card);border-inline-start:1px solid var(--line);position:sticky;top:0;height:100vh;overflow:auto;padding:0}
.hw-brand{padding:20px 18px;border-bottom:1px solid var(--line);text-align:center;background:linear-gradient(180deg,var(--mist),var(--card))}
.hw-brand img{max-width:96px;max-height:96px;object-fit:contain;margin-bottom:8px}
.hw-brand .co{font-weight:800;color:var(--brand-d);font-size:15px}
.hw-search{padding:12px 14px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card);z-index:2}
.hw-search input{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;font-size:13px;outline:none}
.hw-search input:focus{border-color:var(--brand)}
.hw-toc{list-style:none;margin:0;padding:8px 0 40px}
.hw-toc li a{display:flex;gap:8px;align-items:baseline;padding:7px 16px;color:var(--mut);font-size:13px;font-weight:600;border-inline-start:3px solid transparent}
.hw-toc li a:hover{background:var(--mist);color:var(--brand-d)}
.hw-toc li a.active{background:var(--mist);color:var(--brand-d);border-inline-start-color:var(--brand)}
.hw-toc .num{color:var(--brand);font-weight:800;font-size:11px;min-width:18px}
.hw-main{flex:1;min-width:0;padding:0 0 80px}
.hw-cover{padding:64px 56px 40px;text-align:center;background:linear-gradient(180deg,var(--mist),var(--bg))}
.hw-cover img{max-width:120px;max-height:120px;object-fit:contain;margin-bottom:14px}
.hw-cover .title{font-size:30px;font-weight:900;color:var(--brand-d);margin:6px 0}
.hw-cover .sub{font-size:15px;color:var(--mut);margin:6px auto;max-width:680px}
.hw-cover .co{font-size:15px;font-weight:800;color:var(--ink);margin-top:10px}
.hw-cover .date{display:inline-block;margin-top:10px;font-size:12px;color:var(--mut);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:4px 14px}
.hw-sec{padding:30px 56px;border-bottom:1px solid var(--line);scroll-margin-top:10px}
.hw-sec.dim{display:none}
.hw-sec>h1{font-size:22px;font-weight:900;color:var(--brand-d);margin:0 0 14px;padding-bottom:8px;border-bottom:2px solid var(--brand)}
.hw-sec h2{font-size:18px;color:var(--ink);margin:20px 0 8px}
.hw-sec h3{font-size:15px;color:var(--mut);margin:16px 0 6px}
.hw-sec p{margin:8px 0}
.hw-sec ul,.hw-sec ol{margin:8px 0;padding-inline-start:26px}
.hw-sec li{margin:4px 0}
.hw-sec blockquote{margin:12px 0;padding:8px 16px;border-inline-start:4px solid var(--brand);background:var(--mist);color:var(--mut);border-radius:0 8px 8px 0}
.hw-sec table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px}
.hw-sec th{background:var(--brand);color:#fff;padding:9px 11px;text-align:start;font-weight:700}
.hw-sec td{border:1px solid var(--line);padding:8px 11px}
.hw-sec tr:nth-child(even) td{background:var(--mist)}
.hw-sec pre{background:#0f172a;color:#e2e8f0;padding:12px 14px;border-radius:10px;overflow:auto;direction:ltr;text-align:left}
.hw-sec img{max-width:100%;height:auto;border-radius:10px;margin:12px 0}
.hw-sec .mermaid-img{width:100%;max-width:100%;height:auto;border-radius:10px;margin:12px 0}/* PRD V15: full page-width diagrams */
mark{background:#fde68a;color:#7c2d12;border-radius:3px}
.hw-empty{display:none;padding:40px 56px;color:var(--mut);font-weight:700}
.hw-empty.on{display:block}
@media(max-width:900px){.hw-side{display:none}.hw-cover,.hw-sec{padding-inline:22px}}
@media print{.hw-side,.hw-search{display:none}.hw-sec{break-inside:avoid}}
`;

/** Build the COMPLETE navigable single-file HTML document for an artifact.
 *  Same AST path as DOCX/PDF; mermaid diagrams are pre-rendered to inline PNGs
 *  so the file is fully self-contained and offline-portable. */
export async function buildHtmlDoc(artifact: GeneratedArtifact, o?: ExportOptions): Promise<string> {
  // FIX D — owner-agreed brand font for HTML output is Thmanyah; embedded as WOFF2.
  const font = o?.fontFamily || 'Thmanyah Sans';
  const fontFaceCss = await thmanyahFaceCss();
  const ar = (o?.language || 'ar') !== 'en';
  const date = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
  const secs = artifact.sections || [];

  // pre-render section bodies (inline mermaid PNGs) + exec summary
  const summaryHtml = artifact.executiveSummary ? await blocksToHtmlAsync(artifact.executiveSummary) : '';
  const bodyHtmls = await Promise.all(secs.map(s => blocksToHtmlAsync(s.content)));
  const diagHtml = diagramsHtml(artifact.diagrams);

  type TocItem = { id: string; num: string; title: string };
  const toc: TocItem[] = [];
  if (summaryHtml) toc.push({ id: 'sec-summary', num: '◆', title: ar ? 'الملخص التنفيذي' : 'Executive summary' });
  secs.forEach((s, i) => toc.push({ id: `sec-${i}`, num: String(i + 1), title: stripMarkdown(s.title) }));
  if (diagHtml) toc.push({ id: 'sec-diagrams', num: '▤', title: ar ? 'المخططات' : 'Diagrams' });

  const tocHtml = toc.map(it =>
    `<li><a href="#${it.id}" data-target="${it.id}"><span class="num">${escapeHtml(it.num)}</span><span class="lbl">${escapeHtml(it.title)}</span></a></li>`
  ).join('');

  const sectionsHtml = [
    summaryHtml ? `<section class="hw-sec" id="sec-summary"><h1>${ar ? 'الملخص التنفيذي' : 'Executive summary'}</h1>${summaryHtml}</section>` : '',
    ...secs.map((s, i) => `<section class="hw-sec" id="sec-${i}"><h1>${i + 1}. ${escapeHtml(stripMarkdown(s.title))}</h1>${bodyHtmls[i]}</section>`),
    diagHtml ? `<section class="hw-sec" id="sec-diagrams">${diagHtml.replace(/^<div class="section">/, '').replace(/<\/div>$/, '')}</section>` : '',
  ].join('');

  const brandSide = `${o?.logoUrl ? `<img src="${o.logoUrl}" alt="logo"/>` : ''}${o?.companyName ? `<div class="co">${escapeHtml(o.companyName)}</div>` : ''}`;
  const cover = `<div class="hw-cover">
    ${o?.logoUrl ? `<img src="${o.logoUrl}" alt="logo"/>` : ''}
    <div class="title">${escapeHtml(artifact.title)}</div>
    <div class="sub">${artifact.goal ? escapeHtml(artifact.goal) : ''}</div>
    ${o?.companyName ? `<div class="co">${escapeHtml(o.companyName)}</div>` : ''}
    <div><span class="date">${date}</span></div>
  </div>`;

  // inline JS: live search (highlight + filter) + scroll-spy on TOC
  const js = `
(function(){
  var secs=[].slice.call(document.querySelectorAll('.hw-sec'));
  var links=[].slice.call(document.querySelectorAll('.hw-toc a'));
  var box=document.getElementById('hw-q');
  var empty=document.getElementById('hw-empty');
  function clearMarks(el){el.querySelectorAll('mark').forEach(function(m){m.replaceWith(document.createTextNode(m.textContent));});el.normalize();}
  function mark(el,q){var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null);var ns=[],n;while(n=w.nextNode())ns.push(n);ns.forEach(function(t){var i=t.nodeValue.toLowerCase().indexOf(q);if(i<0)return;var sp=document.createElement('span');sp.innerHTML=t.nodeValue.replace(new RegExp('('+q.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&')+')','ig'),'<mark>$1</mark>');t.replaceWith(sp);});}
  function run(){var q=(box.value||'').trim().toLowerCase();var any=false;secs.forEach(function(s){clearMarks(s);if(!q){s.classList.remove('dim');any=true;return;}var hit=s.textContent.toLowerCase().indexOf(q)>=0;s.classList.toggle('dim',!hit);if(hit){mark(s,q);any=true;}});empty.classList.toggle('on',!any);}
  if(box)box.addEventListener('input',run);
  var obs=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){var id=e.target.id;links.forEach(function(l){l.classList.toggle('active',l.getAttribute('data-target')===id);});}});},{rootMargin:'-10% 0px -80% 0px'});
  secs.forEach(function(s){obs.observe(s);});
})();`;

  return `<!doctype html><html dir="${ar ? 'rtl' : 'ltr'}" lang="${ar ? 'ar' : 'en'}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(artifact.title)}</title><style>${fontFaceCss}\n${HTML_CSS(font)}</style></head>
<body><div class="hw-wrap">
<aside class="hw-side">
  <div class="hw-brand">${brandSide || `<div class="co">${ar ? 'حوكمة' : 'Governance'}</div>`}</div>
  <div class="hw-search"><input id="hw-q" type="search" placeholder="${ar ? '🔍 ابحث في الوثيقة…' : '🔍 Search…'}"/></div>
  <ul class="hw-toc">${tocHtml}</ul>
</aside>
<main class="hw-main">${cover}<div id="hw-empty" class="hw-empty">${ar ? 'لا نتائج مطابقة.' : 'No matches.'}</div>${sectionsHtml}</main>
</div><script>${js}</script></body></html>`;
}

/** One-click: download the navigable HTML file. */
export async function exportHtml(artifact: GeneratedArtifact, o?: ExportOptions): Promise<void> {
  const html = await buildHtmlDoc(artifact, o);
  downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${safeName(o?.fileName || artifact.title)}.html`);
}

/** Single message/markdown → navigable HTML. */
export async function exportMessageHtml(markdown: string, title: string, o?: ExportOptions): Promise<void> {
  const art: GeneratedArtifact = {
    title, goal: '', language: o?.language || 'ar',
    sections: [{ id: 's0', title, content: markdown, status: 'done' }] as ArtifactSection[],
    createdAt: new Date(), complete: true,
  };
  await exportHtml(art, o);
}

/** Single message → PDF via print. */
export function exportMessagePdf(markdown: string, title: string, o?: ExportOptions) {
  printHtml(coverHtml(title, undefined, o) + `<div class="section">${blocksToHtml(markdown)}</div>`, title, o);
}

// ============================================================
//  PDF (direct one-click file) — reuse loaded jsPDF + html2canvas globals.
//  Renders an offscreen DOM node so the browser shapes Arabic, then rasterizes
//  to a multi-page PDF. Falls back to the print path if globals are missing.
// ============================================================

// Each chunk (cover / summary / section / diagrams) renders as its OWN canvas and
// starts on a fresh PDF page. This avoids the old single-giant-canvas approach which
// (a) hit canvas size limits on 25-30 page documents and (b) sliced text lines in
// half at page boundaries between sections. Within a chunk, pages are cut from the
// canvas via crisp tile copies (no negative-offset overdraw).
async function htmlToPdfFile(content: string | string[], title: string, o?: ExportOptions): Promise<void> {
  const blob = await htmlToPdfBlob(content, title, o);
  if (blob) downloadBlob(blob, `${safeName(o?.fileName || title)}.pdf`);
  // null → jsPDF unavailable; htmlToPdfBlob already fell back to printHtml.
}

/** Build a paginated A4 PDF Blob from HTML chunks. Returns null if jsPDF is unavailable
 *  (falls back to print for the single-file path; ZIP export skips the doc). */
async function htmlToPdfBlob(content: string | string[], title: string, o?: ExportOptions): Promise<Blob | null> {
  const chunks = (Array.isArray(content) ? content : [content]).filter(c => c && c.trim());
  if (!chunks.length) return null;
  const jsPDFCtor = window.jspdf?.jsPDF;
  const html2canvas = window.html2canvas;
  if (!jsPDFCtor || !html2canvas) {
    // Graceful fallback — still gives the user a perfectly-shaped PDF via print.
    printHtml(chunks.join(''), title, o);
    return null;
  }
  const holder = document.createElement('div');
  Object.assign(holder.style, {
    position: 'fixed', top: '0', left: '-10000px', width: '794px', // ~A4 @96dpi
    background: '#fff', zIndex: '-1',
  });
  holder.setAttribute('dir', 'rtl');
  document.body.appendChild(holder);
  // Browser canvas have a hard per-side pixel cap (~32k in Chrome/Safari). A long
  // section rasterized at scale 2 can exceed it → html2canvas silently returns a
  // blank/partial canvas. Cap the effective scale per chunk by its measured height.
  const MAX_CANVAS_PX = 32000;
  try {
    // Explicitly load the weights we render so Arabic shapes with the real font, not a
    // fallback (broken joining). fonts.ready alone doesn't force-load unused families.
    // The PDF surface is always the brand font (Thmanyah), independent of the
    // Word-font option passed in o.fontFamily.
    const fam = PDF_FONT;
    // Register the brand @font-face (Thmanyah woff2 + Almarai fallback) in the MAIN
    // document up-front so fonts.load can fetch them before the first html2canvas
    // pass (font-display:swap otherwise rasterizes a glyph-dropping fallback first).
    if (!document.getElementById('brand-pdf-fontface')) {
      const ff = document.createElement('style');
      ff.id = 'brand-pdf-fontface';
      ff.textContent = PDF_FONTFACE;
      document.head.appendChild(ff);
    }
    const fontsApi = (document as any).fonts;
    if (fontsApi?.load) {
      // Preload the EXACT weights PRINT_CSS renders (400 body, 700/900 headings) so
      // Arabic shapes with Thmanyah, never a fallback that drops letters.
      try { await Promise.all(['400 14px', '700 14px', '900 14px'].map(spec => fontsApi.load(`${spec} "${fam}"`))); } catch {}
      try { await fontsApi.load('700 14px "Almarai"'); } catch {}
    }
    if (fontsApi?.ready) { try { await fontsApi.ready; } catch {} }
    const pdf = new jsPDFCtor({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    let firstPage = true;
    for (const chunk of chunks) {
      // .pdf-root carries the RTL/font/typography rules (body-scoped CSS never applies inside this holder div).
      holder.innerHTML = `<style>${PRINT_CSS(PDF_FONT)}</style><div class="pdf-root" dir="rtl" style="padding:30px">${chunk}</div>`;
      await new Promise(r => setTimeout(r, firstPage ? 400 : 60));   // fonts settle once; then minimal
      const estH = holder.scrollHeight || 0;
      const scale = estH * 2 > MAX_CANVAS_PX ? Math.max(1, MAX_CANVAS_PX / Math.max(1, estH)) : 2;
      let canvas = await html2canvas(holder, { scale, useCORS: true, backgroundColor: '#ffffff' });
      if (!canvas.width || !canvas.height) {
        // Blank result (hit the limit anyway) → retry at scale 1 as a last resort.
        canvas = await html2canvas(holder, { scale: 1, useCORS: true, backgroundColor: '#ffffff' });
      }
      const pxPerPage = Math.max(1, Math.floor((canvas.width * pageH) / pageW));
      for (let y = 0; y < canvas.height; y += pxPerPage) {
        const sliceH = Math.min(pxPerPage, canvas.height - y);
        if (sliceH < 4) break;                                       // skip sub-pixel tail
        const tile = document.createElement('canvas');
        tile.width = canvas.width; tile.height = sliceH;
        const ctx = tile.getContext('2d')!;
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, tile.width, tile.height);
        ctx.drawImage(canvas, 0, y, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
        if (!firstPage) pdf.addPage();
        firstPage = false;
        pdf.addImage(tile.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pageW, (sliceH * pageW) / canvas.width);
      }
    }
    // Page numbers on every page (digits — no Arabic shaping needed).
    const total = pdf.getNumberOfPages();
    for (let pno = 1; pno <= total; pno++) {
      pdf.setPage(pno);
      pdf.setFontSize(9);
      pdf.setTextColor(120, 130, 145);
      pdf.text(`${pno} / ${total}`, pageW / 2, pageH - 5, { align: 'center' });
    }
    return pdf.output('blob') as Blob;
  } finally {
    document.body.removeChild(holder);
  }
}

/** Direct PDF file (no print dialog) for a full artifact — paginated per section. */
async function artifactPdfChunks(artifact: GeneratedArtifact, o?: ExportOptions): Promise<string[]> {
  const chunks: string[] = [coverHtml(artifact.title, artifact.goal, o)];
  if (artifact.executiveSummary) chunks.push(`<h1 class="sec-h">الملخص التنفيذي</h1>${await blocksToHtmlAsync(artifact.executiveSummary)}`);
  for (let i = 0; i < artifact.sections.length; i++) {
    const s = artifact.sections[i];
    chunks.push(`<h1 class="sec-h t${i % 3}">${i + 1}. ${escapeHtml(stripMarkdown(s.title))}</h1>${await blocksToHtmlAsync(s.content)}`);
  }
  // One chunk per diagram = each starts on a fresh page; the blind tile slicer
  // would otherwise cut a diagram in half at a page boundary.
  if (artifact.diagrams?.length) {
    artifact.diagrams.forEach((d, i) => {
      chunks.push(`${i === 0 ? '<h1>المخططات والرسومات</h1>' : ''}${diagramItemHtml(d, i)}`);
    });
  }
  return chunks;
}

export async function exportPdfDirect(artifact: GeneratedArtifact, o?: ExportOptions): Promise<void> {
  await htmlToPdfFile(await artifactPdfChunks(artifact, o), artifact.title, o);
}

/** Build a single artifact as a PDF Blob (no download). Null if jsPDF unavailable. */
export async function buildPdfBlob(artifact: GeneratedArtifact, o?: ExportOptions): Promise<Blob | null> {
  return await htmlToPdfBlob(await artifactPdfChunks(artifact, o), artifact.title, o);
}

/** Direct PDF file for a single message. */
export async function exportMessagePdfDirect(markdown: string, title: string, o?: ExportOptions): Promise<void> {
  await htmlToPdfFile([coverHtml(title, undefined, o), await blocksToHtmlAsync(markdown)], title, o);
}

// ============================================================
//  XLSX (SheetJS) — RTL workbook
// ============================================================

export interface SheetSpec {
  name: string;
  headers: string[];
  rows: (string | number)[][];
}

function buildWorkbook(sheets: SheetSpec[]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  (wb as any).Workbook = { Views: [{ RTL: true }] };
  sheets.forEach((sh, idx) => {
    const aoa = [sh.headers, ...sh.rows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const colCount = Math.max(sh.headers.length, ...sh.rows.map(r => r.length));
    (ws as any)['!cols'] = Array.from({ length: colCount }, () => ({ wch: 24 }));
    XLSX.utils.book_append_sheet(wb, ws, (sh.name || `Sheet${idx + 1}`).slice(0, 31));
  });
  return wb;
}

/** Export one or more tables to a real .xlsx (RTL). */
export function exportXlsx(sheets: SheetSpec[], title: string): void {
  if (!sheets.length) return;
  const wb = buildWorkbook(sheets);
  XLSX.writeFile(wb, `${safeName(title)}.xlsx`);
}

/** Export every Markdown table found in a message as sheets in one workbook. */
export function exportMessageXlsx(markdown: string, title: string): void {
  const tables = parseMarkdown(markdown).filter(b => b.type === 'table') as Extract<MdBlock, { type: 'table' }>[];
  if (!tables.length) {
    // No table — dump the plain text into a single column so the action never
    // silently no-ops. Drop fenced blocks (e.g. ```mermaid diagram source from the
    // canvas bridge) and standalone image lines so their raw lines aren't poured
    // into cells; a diagram can't be embedded in a flat sheet anyway.
    const text = markdown.replace(/```[\s\S]*?```/g, '');
    const rows = text.split('\n')
      .filter(l => l.trim() && !/^!\[[^\]]*\]\([^)]*\)\s*$/.test(l.trim()))
      .map(l => [stripMarkdown(l)]);
    exportXlsx([{ name: 'المحتوى', headers: [stripMarkdown(title)], rows }], title);
    return;
  }
  const sheets: SheetSpec[] = tables.map((t, i) => ({
    name: `جدول ${i + 1}`,
    headers: t.headers.map(h => stripMarkdown(h)),
    rows: t.rows.map(r => r.map(c => stripMarkdown(c))),
  }));
  exportXlsx(sheets, title);
}

// ============================================================
//  Employee assessment reports (R5 #3)
//  Exports the OUTCOMES of employee interviews/assessments —
//  technical (competencyScores) + behavioral (Holland/Birkman) —
//  NOT the questionnaire. Two flavors:
//    • company-wide aggregate over ALL assessments (work environment)
//    • per-employee detailed report (every assessment on a timeline)
// ============================================================

export interface AssessmentRecord {
  id?: string;
  userName?: string;
  userEmail?: string;
  jobTitle?: string;
  assessmentType?: string;   // 'verbal' | 'text' | 'survey'
  timestamp?: string | number | Date;
  evaluatorReview?: { status?: string; notes?: string };
  reportData?: {
    totalScore?: number;
    riasec?: { R?: number; I?: number; A?: number; S?: number; E?: number; C?: number };
    competencyScores?: { competency?: string; score?: number }[];
    strengths?: string;
    weaknesses?: string;
    recommendations?: string;
    birkmanHollandSummary?: string;
  };
}

const A_TYPE_LABEL = (tp?: string, ar = true) =>
  tp === 'verbal' ? (ar ? 'شفهي' : 'Verbal')
  : tp === 'survey' ? (ar ? 'استبيان' : 'Survey')
  : (ar ? 'تحريري' : 'Written');

const fmtDate = (ts?: string | number | Date) => {
  if (!ts) return '—';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
};

/** Markdown body for ONE assessment's outcome (technical + behavioral). */
function assessmentBodyMd(a: AssessmentRecord, ar: boolean): string {
  const r = a.reportData || {};
  const L: string[] = [];
  L.push(`**${ar ? 'النوع' : 'Type'}:** ${A_TYPE_LABEL(a.assessmentType, ar)}  |  **${ar ? 'التاريخ' : 'Date'}:** ${fmtDate(a.timestamp)}  |  **${ar ? 'الدرجة الكلية' : 'Total score'}:** ${r.totalScore != null ? Math.round(r.totalScore) + '%' : '—'}`);
  if (a.evaluatorReview?.status) L.push(`**${ar ? 'حالة الاعتماد' : 'Review'}:** ${a.evaluatorReview.status}`);
  L.push('');
  const comps = r.competencyScores || [];
  if (comps.length) {
    L.push(`### ${ar ? 'الجدارات الفنية' : 'Technical competencies'}`);
    L.push(`| ${ar ? 'الجدارة' : 'Competency'} | ${ar ? 'الدرجة' : 'Score'} |`);
    L.push('| --- | --- |');
    comps.forEach(c => L.push(`| ${c.competency || '—'} | ${c.score != null ? Math.round(c.score) + '%' : '—'} |`));
    L.push('');
  }
  const ri = r.riasec;
  if (ri) {
    L.push(`### ${ar ? 'الميول السلوكية (هولاند RIASEC)' : 'Behavioral interests (Holland RIASEC)'}`);
    L.push(`| R | I | A | S | E | C |`);
    L.push('| --- | --- | --- | --- | --- | --- |');
    L.push(`| ${ri.R ?? 0} | ${ri.I ?? 0} | ${ri.A ?? 0} | ${ri.S ?? 0} | ${ri.E ?? 0} | ${ri.C ?? 0} |`);
    L.push('');
  }
  if (r.strengths) { L.push(`### ${ar ? 'مواطن القوة' : 'Strengths'}`); L.push(r.strengths); L.push(''); }
  if (r.weaknesses) { L.push(`### ${ar ? 'فرص التطوير' : 'Areas for improvement'}`); L.push(r.weaknesses); L.push(''); }
  if (r.recommendations) { L.push(`### ${ar ? 'التوصيات' : 'Recommendations'}`); L.push(r.recommendations); L.push(''); }
  if (r.birkmanHollandSummary) { L.push(`### ${ar ? 'تحليل سلوكي (هولاند/بريكمان)' : 'Behavioral analysis (Holland/Birkman)'}`); L.push(r.birkmanHollandSummary); L.push(''); }
  return L.join('\n');
}

/** Build a GeneratedArtifact for ONE employee (all their assessments). */
function employeeArtifact(name: string, email: string, items: AssessmentRecord[], ar: boolean): GeneratedArtifact {
  const sorted = [...items].sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  const scores = sorted.map(a => a.reportData?.totalScore).filter((s): s is number => s != null);
  const avg = scores.length ? Math.round(scores.reduce((x, y) => x + y, 0) / scores.length) : null;
  const sections: ArtifactSection[] = [];
  sections.push({
    id: 'overview', status: 'done',
    title: ar ? 'نظرة عامة' : 'Overview',
    content: [
      `**${ar ? 'الموظف' : 'Employee'}:** ${name}`,
      email ? `**${ar ? 'البريد' : 'Email'}:** ${email}` : '',
      sorted[0]?.jobTitle ? `**${ar ? 'الوظيفة' : 'Job title'}:** ${sorted[0].jobTitle}` : '',
      `**${ar ? 'عدد التقييمات' : 'Assessments'}:** ${sorted.length}`,
      avg != null ? `**${ar ? 'متوسط الدرجة' : 'Average score'}:** ${avg}%` : '',
    ].filter(Boolean).join('\n'),
  });
  sorted.forEach((a, i) => sections.push({
    id: `a${i}`, status: 'done',
    title: `${A_TYPE_LABEL(a.assessmentType, ar)} — ${fmtDate(a.timestamp)}`,
    content: assessmentBodyMd(a, ar),
  }));
  return {
    title: (ar ? 'تقرير تقييم — ' : 'Assessment report — ') + name,
    goal: ar ? 'تقرير شامل عن تقييمات الموظف الفنية والسلوكية' : 'Comprehensive technical & behavioral assessment report',
    language: ar ? 'ar' : 'en',
    sections, createdAt: new Date(), complete: true,
  };
}

/** Build a company-wide aggregate artifact over ALL assessments. */
function companyAssessmentsArtifact(records: AssessmentRecord[], companyName: string, ar: boolean): GeneratedArtifact {
  const withScore = records.filter(a => a.reportData?.totalScore != null);
  const scores = withScore.map(a => a.reportData!.totalScore!);
  const avg = scores.length ? Math.round(scores.reduce((x, y) => x + y, 0) / scores.length) : 0;
  const byEmail = new Map<string, AssessmentRecord[]>();
  records.forEach(a => { const k = a.userEmail || a.userName || 'unknown'; (byEmail.get(k) || byEmail.set(k, []).get(k)!).push(a); });
  const band = (s?: number) => s == null ? '—' : s >= 85 ? (ar ? 'فائقة' : 'High') : s >= 70 ? (ar ? 'جيدة' : 'Optimal') : s >= 55 ? (ar ? 'مقبولة' : 'Mild') : (ar ? 'تطوير' : 'Low');
  const ri = { R: 0, I: 0, A: 0, S: 0, E: 0, C: 0 };
  records.forEach(a => { const x = a.reportData?.riasec; if (x) (['R','I','A','S','E','C'] as const).forEach(k => ri[k] += x[k] || 0); });

  const sections: ArtifactSection[] = [];
  sections.push({
    id: 'summary', status: 'done', title: ar ? 'الملخّص التنفيذي' : 'Executive summary',
    content: [
      `**${ar ? 'الجهة' : 'Entity'}:** ${companyName}`,
      `**${ar ? 'عدد الموظفين المقيَّمين' : 'Employees assessed'}:** ${byEmail.size}`,
      `**${ar ? 'إجمالي التقييمات' : 'Total assessments'}:** ${records.length}`,
      `**${ar ? 'متوسط الدرجة العام' : 'Overall average score'}:** ${avg}%`,
      `**${ar ? 'المعتمدة من المقيّم' : 'Evaluator-approved'}:** ${records.filter(a => a.evaluatorReview?.status === 'approved').length}`,
    ].join('\n'),
  });
  // RIASEC aggregate (work-environment behavioral profile)
  sections.push({
    id: 'riasec', status: 'done', title: ar ? 'الملف السلوكي للجهة (RIASEC)' : 'Organization behavioral profile (RIASEC)',
    content: [
      `| R | I | A | S | E | C |`, '| --- | --- | --- | --- | --- | --- |',
      `| ${ri.R} | ${ri.I} | ${ri.A} | ${ri.S} | ${ri.E} | ${ri.C} |`,
    ].join('\n'),
  });
  // Roster table
  const rows: string[] = [];
  rows.push(`| ${ar ? 'الموظف' : 'Employee'} | ${ar ? 'الوظيفة' : 'Job'} | ${ar ? 'تقييمات' : 'Count'} | ${ar ? 'أحدث درجة' : 'Latest'} | ${ar ? 'الفئة' : 'Band'} |`);
  rows.push('| --- | --- | --- | --- | --- |');
  Array.from(byEmail.entries()).forEach(([, items]) => {
    const sorted = [...items].sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    const latest = sorted[0]?.reportData?.totalScore;
    // Band the SAME rounded value that's displayed — banding the raw score while
    // showing Math.round(latest) made e.g. 84.6 render as "85% | Optimal" (the <85
    // band) even though the legend puts 85 in the next band up.
    const shown = latest != null ? Math.round(latest) : undefined;
    rows.push(`| ${sorted[0]?.userName || '—'} | ${sorted[0]?.jobTitle || '—'} | ${items.length} | ${shown != null ? shown + '%' : '—'} | ${band(shown)} |`);
  });
  sections.push({ id: 'roster', status: 'done', title: ar ? 'سجل الموظفين والدرجات' : 'Employee roster & scores', content: rows.join('\n') });
  // Per-employee detail
  Array.from(byEmail.entries()).forEach(([, items], idx) => {
    const sorted = [...items].sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    const name = sorted[0]?.userName || sorted[0]?.userEmail || `#${idx + 1}`;
    sections.push({
      id: `emp${idx}`, status: 'done', title: `${ar ? 'تفصيل' : 'Detail'}: ${name}`,
      content: sorted.map(a => assessmentBodyMd(a, ar)).join('\n\n---\n\n'),
    });
  });
  return {
    title: (ar ? 'التقرير الشامل لتقييمات الموظفين — ' : 'Company-wide employee assessments — ') + companyName,
    goal: ar ? 'تجميع كل تقييمات الموظفين الفنية والسلوكية على مستوى الجهة' : 'Aggregate of all employee technical & behavioral assessments',
    language: ar ? 'ar' : 'en',
    sections, createdAt: new Date(), complete: true,
  };
}

export type AssessmentExportFormat = 'docx' | 'pdf' | 'xlsx';

/** Per-employee detailed report (docx/pdf/xlsx). */
export async function exportEmployeeReport(
  person: { name: string; email: string; items: AssessmentRecord[] },
  o: ExportOptions | undefined,
  format: AssessmentExportFormat = 'docx',
): Promise<void> {
  const ar = (o?.language ?? 'ar') !== 'en';
  if (format === 'xlsx') {
    const headers = [ar ? 'النوع' : 'Type', ar ? 'التاريخ' : 'Date', ar ? 'الدرجة' : 'Score', ar ? 'الجدارات' : 'Competencies', ar ? 'القوة' : 'Strengths', ar ? 'التطوير' : 'Improve'];
    const rows = person.items.map(a => {
      const r = a.reportData || {};
      const comps = (r.competencyScores || []).map(c => `${c.competency}:${c.score != null ? Math.round(c.score) : ''}`).join(' · ');
      return [A_TYPE_LABEL(a.assessmentType, ar), fmtDate(a.timestamp), r.totalScore != null ? Math.round(r.totalScore) : '', comps, (r.strengths || '').slice(0, 500), (r.weaknesses || '').slice(0, 500)];
    });
    exportXlsx([{ name: (ar ? 'تقييمات' : 'Assessments'), headers, rows }], `assessment_${safeName(person.name)}`);
    return;
  }
  const art = employeeArtifact(person.name, person.email, person.items, ar);
  if (format === 'pdf') await exportPdfDirect(art, o);
  else await exportDocx(art, o);
}

/** Company-wide aggregate report over ALL assessments (docx/pdf/xlsx). */
export async function exportAssessmentsReport(
  records: AssessmentRecord[],
  o: ExportOptions | undefined,
  cfg: { format: AssessmentExportFormat; companyName?: string },
): Promise<{ employees: number; assessments: number }> {
  const ar = (o?.language ?? 'ar') !== 'en';
  const company = cfg.companyName || (ar ? 'الجهة' : 'Organization');
  const byEmail = new Map<string, AssessmentRecord[]>();
  records.forEach(a => { const k = a.userEmail || a.userName || 'unknown'; (byEmail.get(k) || byEmail.set(k, []).get(k)!).push(a); });
  if (cfg.format === 'xlsx') {
    const headers = [ar ? 'الموظف' : 'Employee', ar ? 'البريد' : 'Email', ar ? 'الوظيفة' : 'Job', ar ? 'النوع' : 'Type', ar ? 'التاريخ' : 'Date', ar ? 'الدرجة' : 'Score', ar ? 'الاعتماد' : 'Review', ar ? 'الجدارات' : 'Competencies'];
    const rows = records.map(a => {
      const r = a.reportData || {};
      const comps = (r.competencyScores || []).map(c => `${c.competency}:${c.score != null ? Math.round(c.score) : ''}`).join(' · ');
      return [a.userName || '—', a.userEmail || '', a.jobTitle || '', A_TYPE_LABEL(a.assessmentType, ar), fmtDate(a.timestamp), r.totalScore != null ? Math.round(r.totalScore) : '', a.evaluatorReview?.status || '', comps];
    });
    exportXlsx([{ name: (ar ? 'كل التقييمات' : 'All assessments'), headers, rows }], `assessments_${safeName(company)}`);
    return { employees: byEmail.size, assessments: records.length };
  }
  const art = companyAssessmentsArtifact(records, company, ar);
  if (cfg.format === 'pdf') await exportPdfDirect(art, o);
  else await exportDocx(art, o);
  return { employees: byEmail.size, assessments: records.length };
}

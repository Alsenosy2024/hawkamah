// PowerPoint (.pptx) exporter — Hawkamah brand deck on pptxgenjs.
//
// Built on the SHARED Markdown AST (services/markdownAst) so slides match the
// DOCX/PDF exports exactly: real headings, real bullet separation, REAL tables
// (not ` · `-joined text), stripped emphasis markers, and bidi-safe numeric/
// comparison tokens (≥ 90% / ≤ 5%) that don't mirror inside RTL flow.
//
// Structure: cover → for each heading a section. A heading with body content
// becomes one (or more, chunked) content slide(s); a heading with no direct
// body becomes a branded divider slide (so chapter headings read as intentional
// dividers, never as broken empty slides). Tables render on their own slide.
//
// NOTE: pptxgenjs cannot embed TTFs, so `fontFace` is a hint — the owner's
// machines have "Thmanyah Sans" installed, so it resolves there; elsewhere it
// falls back to the theme Arabic font. Brand colours/layout embed regardless.

import PptxGenJSImport from 'pptxgenjs';
import { parseMarkdown, stripMarkdown, splitBidiSegments, type MdBlock } from './markdownAst';
import { mermaidToPng } from './diagramService';
import type { ArtifactDiagram } from '../types';

// Interop: Vite (es build) gives the class as default; Node/tsx (cjs) may wrap it
// in `.default`. Normalise so `new PptxGenJS()` works in both.
const PptxGenJS: typeof PptxGenJSImport = (PptxGenJSImport as any)?.default || PptxGenJSImport;

// ── Brand tokens ──────────────────────────────────────────────────────────
const BRAND = {
  emerald: '10B981',
  emeraldDark: '047857',
  deepGreen: '0F2E25',
  mist: 'E8F5EE',
  ink: '0F172A',
  slate: '475569',
  line: 'D1E7DC',
  white: 'FFFFFF',
};
const FONT = 'Thmanyah Sans';

// ── Bidi-safe text ──────────────────────────────────────────────────────────
// Wrap numeric/comparison tokens in LTR isolates (U+2066 … U+2069) so PowerPoint
// renders ≥/≤/< > and digits left-to-right with their true meaning, while the
// surrounding paragraph stays RTL. Same fix as the HTML/DOCX exporters.
const LRI = '⁦', PDI = '⁩';
function bidi(raw: string): string {
  return splitBidiSegments(raw || '').map(s => (s.ltr ? LRI + s.text + PDI : s.text)).join('');
}
const cell = (raw: string): string => bidi(stripMarkdown(raw || '—').trim() || '—');

// ── Slide model ──────────────────────────────────────────────────────────────
// `sub` marks an in-slide sub-heading line (a markdown h3–h6) — rendered bold so
// deeper structure reads as a heading WITHOUT exploding into its own slide.
interface BulletLine { text: string; level: number; bullet: boolean; quote?: boolean; sub?: boolean }
type Body =
  | { kind: 'lines'; lines: BulletLine[] }
  | { kind: 'table'; headers: string[]; rows: string[][] };
interface Section { title: string; body: Body[] }

/** Group the AST into heading-rooted sections, each carrying ordered bodies.
 *  Only top-level headings (h1/h2) start a NEW section/slide group; deeper
 *  headings (h3–h6) become bold sub-heading LINES inside the current section.
 *  This mirrors the canvas builder (canvasDocument.markdownToDocSpec treats
 *  `level <= 2` as sections, `> 2` as sub-headings) and is the fix for the
 *  "two words per slide" defect — previously EVERY heading level split a new
 *  near-empty slide, so a structured report fanned out into hundreds of slides
 *  carrying a couple of words each. */
export function toSections(md: string, deckTitle: string): Section[] {
  const blocks = parseMarkdown(md) as MdBlock[];
  const sections: Section[] = [];
  let cur: Section | null = null;
  const ensure = (): Section => { if (!cur) { cur = { title: deckTitle, body: [] }; sections.push(cur); } return cur; };
  const lines = (): BulletLine[] => {
    const s = ensure();
    let tail = s.body[s.body.length - 1];
    if (!tail || tail.kind !== 'lines') { tail = { kind: 'lines', lines: [] }; s.body.push(tail); }
    return (tail as { kind: 'lines'; lines: BulletLine[] }).lines;
  };

  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        if ((b.level ?? 1) <= 2) {
          cur = { title: stripMarkdown(b.text), body: [] };
          sections.push(cur);
        } else {
          // h3–h6 → a bold sub-heading line within the current section, not a slide.
          lines().push({ text: stripMarkdown(b.text), level: 0, bullet: false, sub: true });
        }
        break;
      case 'paragraph':
        lines().push({ text: stripMarkdown(b.text), level: 0, bullet: false });
        break;
      case 'bullet':
        lines().push({ text: stripMarkdown(b.text), level: 0, bullet: true });
        break;
      case 'quote':
        lines().push({ text: stripMarkdown(b.text), level: 0, bullet: false, quote: true });
        break;
      case 'table':
        ensure().body.push({ kind: 'table', headers: b.headers, rows: b.rows });
        break;
      case 'code':
        b.text.split('\n').filter(t => t.trim()).forEach(t => lines().push({ text: t, level: 1, bullet: false }));
        break;
      default: break; // rule / spacer — ignored
    }
  }
  return sections.filter(s => s.title || s.body.length);
}

const safeName = (s: string) =>
  (s || 'presentation').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '_').slice(0, 60) || 'presentation';

const MAX_LINES = 9;     // bullet lines per content slide
const MAX_ROWS = 11;     // body rows per table slide (excl. header)
function chunk<T>(arr: T[], n: number): T[][] {
  if (!arr.length) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Build the branded deck. Returns the configured PptxGenJS instance.
 *  `diagrams` (rasterized Mermaid PNGs) each get their own branded slide at the
 *  end — parity with the DOCX/PDF exporters which embed the same diagrams. */
export interface PptxBrand { companyName?: string; logoUrl?: string; }

export function buildPptx(markdown: string, title: string, dateStr: string, diagrams: ArtifactDiagram[] = [], brand: PptxBrand = {}): InstanceType<typeof PptxGenJSImport> {
  const sections = toSections(markdown, title);
  // N12: company identity on every deck — cover logo+name and a footer name,
  // mirroring the DOCX/PDF exporters. Falls back to the platform brand when a
  // tenant has no logo/name configured.
  const company = (brand.companyName || '').trim();
  const footerName = company || 'حوكمة';
  const logo = (brand.logoUrl && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(brand.logoUrl)) ? brand.logoUrl : '';
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'HK16x9', width: 13.333, height: 7.5 });
  pptx.layout = 'HK16x9';
  pptx.rtlMode = true;
  pptx.author = company || 'Hawkamah';
  pptx.company = company || 'Hawkamah';
  pptx.title = title;

  // Content master: emerald right band + footer rule + slide number.
  pptx.defineSlideMaster({
    title: 'HK_CONTENT',
    background: { color: BRAND.white },
    objects: [
      { rect: { x: 12.93, y: 0, w: 0.4, h: 7.5, fill: { color: BRAND.emerald } } },
      { rect: { x: 0, y: 7.18, w: 13.333, h: 0.32, fill: { color: BRAND.deepGreen } } },
      { text: { text: footerName, options: { x: 0.3, y: 7.16, w: 6, h: 0.34, align: 'left', color: BRAND.mist, fontFace: FONT, fontSize: 10 } } },
    ],
    slideNumber: { x: 12.4, y: 7.16, w: 0.7, h: 0.34, color: BRAND.mist, fontFace: FONT, fontSize: 10 },
  });

  // ── Cover ────────────────────────────────────────────────────────────────
  const cover = pptx.addSlide();
  cover.background = { color: BRAND.deepGreen };
  if (logo) {
    try { cover.addImage({ data: logo, x: 0.8, y: 0.6, w: 1.3, h: 1.3, sizing: { type: 'contain', w: 1.3, h: 1.3 } }); } catch { /* bad logo → skip */ }
  }
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 3.05, w: 13.333, h: 0.06, fill: { color: BRAND.emerald } });
  if (company) cover.addText(bidi(company), { x: 0.8, y: 1.25, w: 11.7, h: 0.6, align: 'right', fontFace: FONT, fontSize: 22, bold: true, color: BRAND.mist });
  cover.addText(title, { x: 0.8, y: 2.0, w: 11.7, h: 1.0, align: 'right', fontFace: FONT, fontSize: 40, bold: true, color: BRAND.white });
  cover.addText('وثيقة حوكمة مؤسسية', { x: 0.8, y: 3.25, w: 11.7, h: 0.6, align: 'right', fontFace: FONT, fontSize: 18, color: BRAND.emerald });
  cover.addText(bidi(dateStr), { x: 0.8, y: 6.5, w: 11.7, h: 0.5, align: 'right', fontFace: FONT, fontSize: 13, color: BRAND.mist });

  const titleBand = (slide: ReturnType<typeof pptx.addSlide>, heading: string) => {
    slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 0.45, w: 12.4, h: 0.9, fill: { color: BRAND.mist } });
    slide.addShape(pptx.ShapeType.rect, { x: 12.55, y: 0.45, w: 0.08, h: 0.9, fill: { color: BRAND.emerald } });
    slide.addText(bidi(heading), { x: 0.7, y: 0.45, w: 11.7, h: 0.9, align: 'right', valign: 'middle', fontFace: FONT, fontSize: 24, bold: true, color: BRAND.deepGreen });
  };

  // ── Sections ───────────────────────────────────────────────────────────────
  for (const s of sections) {
    // Empty heading → branded chapter divider (never a blank content slide).
    if (!s.body.length) {
      const d = pptx.addSlide();
      d.background = { color: BRAND.deepGreen };
      d.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.7, w: 4.2, h: 0.06, fill: { color: BRAND.emerald } });
      d.addText(bidi(s.title), { x: 0.8, y: 2.7, w: 11.7, h: 1.0, align: 'right', fontFace: FONT, fontSize: 32, bold: true, color: BRAND.white });
      continue;
    }

    let firstSlideOfSection = true;
    const heading = () => (firstSlideOfSection ? s.title : `${s.title} (تابع)`);

    for (const body of s.body) {
      if (body.kind === 'lines') {
        const real = body.lines.filter(l => l.text.trim());
        for (const part of chunk(real, MAX_LINES)) {
          const slide = pptx.addSlide({ masterName: 'HK_CONTENT' });
          titleBand(slide, heading());
          firstSlideOfSection = false;
          slide.addText(
            part.map(l => ({
              // Quote lines get a leading emerald bar instead of italic — Thmanyah
              // Sans has no italic Arabic glyphs, so `italic:true` drops them.
              text: bidi(l.quote ? `▍ ${l.text}` : l.text),
              options: {
                breakLine: true,                       // ← each line its own paragraph
                bullet: l.bullet ? { code: '2022', indent: 16 } : false,
                indentLevel: l.level,
                align: 'right' as const,
                fontFace: FONT,
                // Sub-headings read a touch larger + bold; quotes bold; bullets 16; body 15.
                fontSize: l.sub ? 18 : (l.level > 0 ? 14 : (l.bullet ? 16 : 15)),
                bold: l.sub || !!l.quote,
                color: l.sub ? BRAND.emeraldDark : (l.quote ? BRAND.emeraldDark : (l.level > 0 ? BRAND.slate : BRAND.ink)),
                paraSpaceBefore: l.sub ? 6 : 0,
                paraSpaceAfter: 8,
              },
            })),
            { x: 0.7, y: 1.65, w: 11.9, h: 5.25, align: 'right', valign: 'top' },
          );
        }
      } else {
        // Real branded table — reverse columns for RTL visual order.
        const ncols = Math.max(1, body.headers.length);
        const colW = Array(ncols).fill(11.9 / ncols);
        const headRow = [...body.headers].reverse().map(h => ({
          text: cell(h),
          options: { fill: { color: BRAND.emeraldDark }, color: BRAND.white, bold: true, align: 'right' as const, valign: 'middle' as const, fontFace: FONT, fontSize: 13 },
        }));
        for (const rowsPart of chunk(body.rows, MAX_ROWS)) {
          const slide = pptx.addSlide({ masterName: 'HK_CONTENT' });
          titleBand(slide, heading());
          firstSlideOfSection = false;
          const dataRows = rowsPart.map((r, ri) => {
            const padded = [...r];
            while (padded.length < ncols) padded.push('');
            return padded.slice(0, ncols).reverse().map(c => ({
              text: cell(c),
              options: { fill: { color: ri % 2 ? 'F4FBF7' : BRAND.white }, color: BRAND.ink, align: 'right' as const, valign: 'middle' as const, fontFace: FONT, fontSize: 12 },
            }));
          });
          slide.addTable([headRow, ...dataRows], {
            x: 0.7, y: 1.65, w: 11.9, colW,
            border: { type: 'solid', pt: 1, color: BRAND.line },
            rowH: 0.5, valign: 'middle', autoPage: false,
          });
        }
      }
    }
  }

  // ── Diagrams ─────────────────────────────────────────────────────────────
  // One branded slide per rasterized Mermaid PNG, scaled to fit the content area
  // while preserving aspect ratio (contain). Caption = diagram title.
  const CW = 11.9, CH = 4.9, CX = 0.7, CY = 1.7;   // content box under the title band
  for (const d of diagrams) {
    if (!d || !/^data:image\/(png|jpe?g);base64,/i.test(d.png || '')) continue;
    const slide = pptx.addSlide({ masterName: 'HK_CONTENT' });
    titleBand(slide, d.title || 'مخطط');
    const ar = d.width && d.height ? d.width / d.height : 16 / 9;
    let w = CW, h = w / ar;
    if (h > CH) { h = CH; w = h * ar; }
    slide.addImage({ data: d.png, x: CX + (CW - w) / 2, y: CY + (CH - h) / 2, w, h });
  }

  return pptx;
}

// Inline ```mermaid fences → rasterized PNGs (browser-only: mermaid.render needs
// the DOM). Returns the rendered diagrams and the markdown with those fences
// removed, so buildPptx renders them as image slides instead of raw code lines.
async function extractMermaid(markdown: string): Promise<{ md: string; diagrams: ArtifactDiagram[] }> {
  const diagrams: ArtifactDiagram[] = [];
  const fence = /```mermaid\s*\n([\s\S]*?)```/gi;
  let n = 0;
  const matches = [...(markdown || '').matchAll(fence)];
  for (const m of matches) {
    n += 1;
    try {
      const { png, width, height } = await mermaidToPng(m[1]);
      diagrams.push({ title: `مخطط ${n}`, png, width, height });
    } catch { /* un-renderable → drop the fence, no raw code dumped */ }
  }
  const md = (markdown || '').replace(fence, '').replace(/\n{3,}/g, '\n\n');
  return { md, diagrams };
}

/** Build a branded .pptx from Markdown and trigger a browser download. */
export async function exportMessagePptx(markdown: string, title: string, brand: PptxBrand = {}, diagrams: ArtifactDiagram[] = []): Promise<void> {
  const dateStr = new Date().toLocaleDateString('ar', { year: 'numeric', month: 'long', day: 'numeric' });
  const { md, diagrams: inline } = await extractMermaid(markdown);
  const pptx = buildPptx(md, title, dateStr, [...diagrams, ...inline], brand);
  await pptx.writeFile({ fileName: `${safeName(title)}.pptx` });
}

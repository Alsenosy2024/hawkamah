// Diagram generation for the Governance Center.
// Two representations, kept convertible:
//   1. Mermaid syntax  -> high-quality SVG (view + export), AI-generated from the model.
//   2. React Flow graph -> interactive, editable canvas (drag/connect/move).
// generateMermaid() is GROUNDED in the CompanyGovernanceModel (never invents structure).

import { Type } from '@google/genai';
import mermaid from 'mermaid';
import { MERMAID_THEME_VARIABLES, MERMAID_THEME_CSS, MERMAID_FONT } from './mermaidTheme';
import { generateJson } from './agentOrchestrator';
import { swimlaneToPng, type SwimlaneSpec } from './swimlaneService';
import type { CompanyGovernanceModel, GovDiagramKind, GovFlowNode, GovFlowEdge, ArtifactDiagram } from '../types';

let _mmInit = false;
// htmlLabels emits <foreignObject> HTML inside the SVG, which Chrome refuses to
// rasterize through <img> — so PNG export must render with pure-SVG text labels.
// An %%{init}%% directive can't do it (securityLevel 'strict' ignores directives),
// so we flip the global config around the PNG render and restore it after.
function initMermaid(pngExport = false) {
  try {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',                       // brand theme (was 'default' purple)
      securityLevel: pngExport ? 'strict' : 'loose',
      suppressErrorRendering: true,        // throw → caller shows fallback (no error SVG in DOM)
      fontFamily: MERMAID_FONT,
      htmlLabels: !pngExport,
      flowchart: { curve: 'basis', htmlLabels: !pngExport, useMaxWidth: true },
      sequence: { useMaxWidth: true, wrap: true },
      gantt: { useMaxWidth: true },
      themeVariables: MERMAID_THEME_VARIABLES,
      themeCSS: MERMAID_THEME_CSS,
    } as any);
  } catch { /* already initialized elsewhere */ }
}
function ensureMermaid() {
  if (_mmInit) return;
  initMermaid(false);
  _mmInit = true;
}

// Mermaid measures text synchronously at render time — if the brand font isn't
// loaded yet, boxes are sized with fallback metrics and Arabic overflows. Load it
// once before any render.
let _fontReady: Promise<void> | null = null;
export function ensureMermaidFont(): Promise<void> {
  if (_fontReady) return _fontReady;
  _fontReady = (async () => {
    try {
      const f: FontFaceSet | undefined = (document as any).fonts;
      if (!f) return;
      await Promise.all([
        f.load('400 16px "Thmanyah Sans"'),
        f.load('700 16px "Thmanyah Sans"'),
      ]).catch(() => undefined);
      await (f.ready as Promise<unknown>).catch(() => undefined);
    } catch { /* non-fatal */ }
  })();
  return _fontReady;
}

let _svgRid = 0;
/**
 * Render Mermaid syntax → themed SVG string (htmlLabels ON so Arabic shapes
 * correctly via the BiDi algorithm). Used by the document canvas, which embeds
 * the live SVG (it displays AND prints correctly — unlike a rasterized PNG,
 * which would need htmlLabels OFF and break Arabic shaping).
 */
export async function mermaidToSvg(src: string): Promise<string> {
  const code = prepareMermaidForRender(src);
  if (!code) throw new Error('empty mermaid');
  ensureMermaid();
  await ensureMermaidFont();
  const id = `mmd_svg_${_svgRid++}`;
  return withMermaidLock(async () => {
    initMermaid(false);                    // htmlLabels ON (brand theme)
    const { svg } = await mermaid.render(id, code);
    return svg;
  });
}

let _pngRid = 0;

// mermaid config is GLOBAL. mermaidToPng flips htmlLabels off around its render and
// restores it after. Two concurrent renders (e.g. live canvas preview + PDF export)
// would race on that global → one render gets the wrong label mode (scrambled/clipped
// Arabic). Serialize the config-sensitive render section through this lock.
let _pngLock: Promise<unknown> = Promise.resolve();
function withMermaidLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = _pngLock.then(fn, fn);
  // keep the chain alive but swallow rejection so one failure doesn't poison the queue
  _pngLock = run.then(() => undefined, () => undefined);
  return run;
}

/** Render Mermaid syntax → PNG data URL (white bg, 2x). For embedding into PDF/Word. */
export async function mermaidToPng(
  src: string,
  opts: { scale?: number; signal?: AbortSignal } = {},
): Promise<{ png: string; width: number; height: number }> {
  const scale = opts.scale ?? 2;
  // guard long Arabic labels (wrap/truncate) only for the rasterized PNG → prevents
  // node-box overflow in PDF/Word; type-aware so gantt/sequence/etc. aren't corrupted.
  const code = prepareMermaidForRender(src);
  if (!code) throw new Error('empty mermaid');
  ensureMermaid();
  await ensureMermaidFont();
  const id = `mmd_png_${_pngRid++}`;
  // serialize the global-config flip so concurrent renders don't corrupt each other
  const svg: string = await withMermaidLock(async () => {
    initMermaid(true);
    try { return (await mermaid.render(id, code)).svg; }
    finally { initMermaid(false); }
  });
  // Mermaid emits width="100%" with a viewBox, so the <img> has no usable intrinsic
  // size and drawImage would rasterize at the 300×150 default. Worse, mermaid's bbox
  // measurement undershoots RTL Arabic labels, so text spills past the viewBox edge.
  // Take the real geometry from the viewBox, pad it, and force explicit dimensions.
  const PAD = 24;
  const vbm = svg.match(/viewBox="([\d.\-]+)[ ,]+([\d.\-]+)[ ,]+([\d.]+)[ ,]+([\d.]+)"/);
  const minX = vbm ? parseFloat(vbm[1]) : 0, minY = vbm ? parseFloat(vbm[2]) : 0;
  const vbW = vbm ? Math.ceil(parseFloat(vbm[3])) : 0, vbH = vbm ? Math.ceil(parseFloat(vbm[4])) : 0;
  let svgOut = svg;
  if (vbm) {
    const w = vbW + PAD * 2, h = vbH + PAD * 2;
    svgOut = svg.replace(
      /<svg([^>]*?)viewBox="[^"]*"/,
      (_m, pre) => `<svg${pre.replace(/\s(?:width|height)="[^"]*"/g, '')} width="${w}" height="${h}" viewBox="${minX - PAD} ${minY - PAD} ${w} ${h}"`,
    );
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    const blob = new Blob([svgOut], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      // No viewBox AND no intrinsic <img> size → drawImage would paint nothing and we'd
      // embed a blank "successful" PNG. Reject so callers skip it instead.
      if (!vbW && !vbH && !img.width && !img.height) {
        URL.revokeObjectURL(url);
        return reject(new Error('mermaid svg has no resolvable dimensions'));
      }
      const w = (vbW ? vbW + PAD * 2 : 0) || img.width || 1200;
      const h = (vbH ? vbH + PAD * 2 : 0) || img.height || 800;
      const canvas = document.createElement('canvas');
      canvas.width = w * scale; canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); return reject(new Error('no 2d ctx')); }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve({ png: canvas.toDataURL('image/png'), width: w, height: h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('svg img load failed')); };
    img.src = url;
  });
}

/** Build embeddable ArtifactDiagram[] from saved diagrams (best-effort, skips failures). */
export async function diagramsToImages(
  diagrams: { title: string; mermaid: string; swimlane?: SwimlaneSpec }[],
  signal?: AbortSignal,
): Promise<ArtifactDiagram[]> {
  const out: ArtifactDiagram[] = [];
  for (const d of diagrams) {
    if (signal?.aborted) break;
    try {
      const { png, width, height } = d.swimlane
        ? await swimlaneToPng(d.swimlane)               // custom swimlane renderer (no Mermaid)
        : await mermaidToPng(d.mermaid, { signal });
      out.push({ title: d.title, png, width, height });
    } catch (e) { console.warn('[export] diagram skipped (render failed):', d.title, e); }
  }
  return out;
}

const KIND_GUIDE: Record<GovDiagramKind, { ar: string; en: string; hint: string }> = {
  flowchart: {
    ar: 'مخطط تدفق الإجراءات', en: 'Procedure flowchart',
    hint: 'flowchart TD with decision diamonds {…}, process boxes […], start/end as ([…]). Model the actual approval/execution flow of the company\'s key processes and authorities.',
  },
  swimlane: {
    ar: 'مخطط المسؤوليات (مسارات)', en: 'Responsibility swimlane',
    hint: 'flowchart LR using subgraph per org unit/role as a lane; place each step inside the lane of its owner; arrows cross lanes to show handoffs (RACI-style).',
  },
  state: {
    ar: 'مخطط الحالات', en: 'State diagram',
    hint: 'stateDiagram-v2 with [*] start, transitions labelled by the triggering event/decision; model lifecycle of a policy/request/document.',
  },
  orgchart: {
    ar: 'الهيكل التنظيمي', en: 'Org chart',
    hint: 'flowchart TD as a tree from the org units (parentId builds edges) with roles attached under their unit.',
  },
  raci: {
    ar: 'مصفوفة الصلاحيات (RACI)', en: 'RACI authority matrix',
    hint: 'flowchart LR: one subgraph per role (lane); inside each lane place the decisions/authorities that role holds, labelling the edge with the RACI level — مسؤول (R)/مساءل (A)/مُستشار (C)/مُطّلع (I) mapped from authority.level (execute=R, approve=A, recommend=C, inform=I). Connect each decision node to the role(s) that act on it.',
  },
};

function modelDigest(model: CompanyGovernanceModel): string {
  const units = model.orgUnits.map(u => `- ${u.id}: ${u.name}${u.parentId ? ` (parent: ${u.parentId})` : ''} — ${u.mandate}`).join('\n');
  const roles = model.roles.map(r => `- ${r.id}: ${r.title} @${r.unitId} — ${r.purpose}; مسؤوليات: ${(r.responsibilities || []).join('، ')}`).join('\n');
  const policies = model.policies.map(p => `- ${p.title} [${p.domain}] (${p.status})`).join('\n');
  const auth = (model.authorities || []).map(a => `- ${a.decision} → ${a.roleId} (${a.level})`).join('\n');
  const kpis = (model.kpis || []).map(k => `- ${k.name}: ${k.formula} → ${k.target}`).join('\n');
  return [
    `# الشركة: ${model.companyName}`,
    `## الوحدات التنظيمية\n${units || '—'}`,
    `## الأدوار\n${roles || '—'}`,
    `## السياسات\n${policies || '—'}`,
    `## الصلاحيات\n${auth || '—'}`,
    `## المؤشرات\n${kpis || '—'}`,
  ].join('\n\n');
}

/** AI generates Mermaid syntax for the requested diagram kind, grounded in the model. */
export async function generateMermaid(
  model: CompanyGovernanceModel,
  kind: GovDiagramKind,
  opts: { language?: 'ar' | 'en'; focus?: string; signal?: AbortSignal } = {},
): Promise<{ title: string; mermaid: string }> {
  const g = KIND_GUIDE[kind];
  const ar = opts.language !== 'en';
  const sys = [
    'You are a senior governance analyst that draws precise, high-quality diagrams.',
    'Output VALID Mermaid syntax only — it must render without errors.',
    'Ground every node/edge in the provided model. Do NOT invent units, roles, or steps that are not implied by the model.',
    ar ? 'Node labels in Arabic. Wrap any label containing spaces/punctuation in double quotes: A["نص العقدة"]. NEVER put double-quote characters inside a label — use single-quotes instead. NEVER use <br/> in labels.'
       : 'Node labels in English. NEVER put double-quote characters inside a label — use single-quotes instead. NEVER use <br/> in labels.',
    'Keep IDs ASCII alphanumeric (n1, n2, ...). Do not use reserved Mermaid words as bare IDs.',
    'No markdown fences, no prose, no explanation — Mermaid code only in the `mermaid` field.',
  ].join(' ');

  const prompt = [
    `Diagram type: ${kind} — ${g.en}.`,
    `Construction hint: ${g.hint}`,
    opts.focus ? `Focus on: ${opts.focus}` : '',
    '',
    'Governance model (single source of truth):',
    modelDigest(model),
    '',
    `Return JSON: { "title": short ${ar ? 'Arabic' : 'English'} title, "mermaid": the diagram code }.`,
  ].filter(Boolean).join('\n');

  const schema = {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      mermaid: { type: Type.STRING },
    },
    required: ['title', 'mermaid'],
  };

  // ROOT FIX (R5 #1): never return un-renderable Mermaid. Validate every AI output
  // with mermaid.parse; on failure, feed the parser error back and retry; if all
  // retries fail, fall back to a DETERMINISTIC diagram built straight from the model
  // (guaranteed valid) so a diagram ALWAYS renders instead of silently disappearing.
  const MAX_TRIES = 3;
  let title = g[ar ? 'ar' : 'en'];
  let lastErr = '';
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const repairNote = attempt === 0 ? '' :
      `\n\nYour previous Mermaid output FAILED to parse with this error:\n${lastErr}\nReturn corrected, VALID Mermaid that renders without errors. Keep IDs ASCII; quote every label with spaces/punctuation.`;
    try {
      const res = await generateJson<{ title: string; mermaid: string }>(prompt + repairNote, schema, {
        systemInstruction: sys, signal: opts.signal, temperature: attempt === 0 ? 0.25 : 0.1,
      });
      title = (res.title || title).trim();
      const code = sanitizeMermaid(res.mermaid);
      // validate the SAME transform used at render/export time (type-aware guard)
      const err = await validateMermaid(prepareMermaidForRender(res.mermaid));
      if (!err) return { title, mermaid: code };
      lastErr = err;
      console.warn(`[diagram] generated mermaid invalid (try ${attempt + 1}/${MAX_TRIES}): ${err}`);
    } catch (e: any) {
      if (opts.signal?.aborted) throw e;
      lastErr = String(e?.message || e).slice(0, 300);
      console.warn(`[diagram] generation attempt ${attempt + 1} threw: ${lastErr}`);
    }
  }

  // Deterministic fallback — flowchart straight from the model structure.
  const fb = deterministicFallback(model);
  console.warn('[diagram] AI output invalid after retries — using deterministic model-derived fallback.');
  return { title, mermaid: fb };
}

/** Validate a Mermaid string the way it will ACTUALLY render (type-aware prepare →
 *  mermaid.parse). Returns null when valid, else the parser error. Used by the
 *  natural-language editor's repair loop so it only accepts diagrams that draw. */
export async function validateMermaidForRender(code: string): Promise<string | null> {
  return validateMermaid(prepareMermaidForRender(code));
}

/** Validate Mermaid via the real parser. Returns null if valid, else the error string. */
async function validateMermaid(code: string): Promise<string | null> {
  if (!code || !code.trim()) return 'empty diagram';
  ensureMermaid();
  return withMermaidLock(async () => {
    try {
      // mermaid.parse rejects on invalid syntax (v11). suppressErrors:false → throws.
      await (mermaid as any).parse(code, { suppressErrors: false });
      return null;
    } catch (e: any) {
      return String(e?.message || e).slice(0, 400);
    }
  });
}

/** Guaranteed-valid flowchart derived purely from the model (no AI). Last-resort fallback. */
function deterministicFallback(model: CompanyGovernanceModel): string {
  try {
    const { nodes, edges } = modelToFlow(model);
    if (nodes.length) {
      const mm = flowToMermaid(nodes, edges);
      // flowToMermaid output is already safe-id + quoted; trust it.
      if (mm && mm.trim()) return mm;
    }
  } catch { /* fall through to stub */ }
  const name = (model.companyName || 'الجهة').replace(/"/g, "'");
  return `flowchart TD\n  n0["${name}"]`;
}

/** Strip accidental code fences / leading prose the model may add. */
/**
 * Wrap/truncate a single node-label so long Arabic strings don't overflow the
 * node box (Mermaid does NOT auto-wrap). Inserts <br/> at word boundaries every
 * ~WRAP chars and hard-truncates past MAXLEN with an ellipsis.
 */
function guardLabel(raw: string): string {
  const WRAP = 20, MAXLEN = 90;
  let txt = (raw || '').replace(/\s+/g, ' ').trim();
  if (!txt) return txt;
  if (txt.length > MAXLEN) txt = txt.slice(0, MAXLEN - 1).trim() + '…';
  // already has explicit breaks → respect author intent, don't re-wrap
  if (/<br\s*\/?>/i.test(txt)) return txt;
  const words = txt.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; }
    else if ((cur + ' ' + w).length <= WRAP) { cur += ' ' + w; }
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.join('<br/>');
}

// GovF17: per-shape label guards. The old single regex excluded parens from the
// label body, so an Arabic label with embedded parentheses — e.g. "اللجنة (التنفيذية)"
// — was cut at the first inner paren and the diagram broke. Square `[...]` and curly
// `{...}` shapes have unambiguous terminators, so their bodies may safely contain
// parens; only the round shapes `((...))`/`(...)` must stay paren-free (a Mermaid
// limitation). Output is always force-quoted so <br/> and Arabic punctuation are safe.
const wrapBody = (body: string): string | null => {
  const t = (body || '').trim();
  if (!t) return null;
  return guardLabel(t).replace(/"/g, "'");
};
// Bracket/brace shapes have unambiguous [ / { delimiters, so a global pass is safe:
// quoted-square → plain-square → curly. Round (..) shapes are handled by
// guardRoundNodes (anchored on the node id) so parens sitting INSIDE a label or an
// |edge label| are never mis-wrapped to ("..").
const GUARD_PASSES: { re: RegExp; o: string; c: string }[] = [
  { re: /\["([^"]*?)"\]/g,            o: '["', c: '"]' },   // already-quoted square (re-wrap → guardLabel)
  { re: /\[(?![(\/\\])([^"\[\]]*?)\]/g, o: '["', c: '"]' }, // plain square — inner parens allowed; skip decorated [(cyl)] [/para/] [\trap\] so their shape survives
  { re: /\{([^{}"]*?)\}/g,            o: '{"', c: '"}' },   // curly — inner parens allowed
];

// Round node shapes id((label)) / id(label) — ONLY when the ( directly follows an id
// char. This lets a flowchart label keep literal parens ("اللجنة (التنفيذية)") and an
// |edge (label)| keep its parens, instead of them being re-quoted to ("..").
function guardRoundNodes(line: string): string {
  return line
    .replace(/([A-Za-z0-9_])\(\(([^()"]*?)\)\)/g, (m, id, body) => {
      const w = wrapBody(body); return w === null ? m : `${id}(("${w}"))`;
    })
    .replace(/([A-Za-z0-9_])\(([^()"]*?)\)/g, (m, id, body) => {
      const w = wrapBody(body); return w === null ? m : `${id}("${w}")`;
    });
}

// The Mermaid diagram type from the first meaningful line (after optional
// %%{init}%% directives / YAML front-matter / comments). Lowercased keyword;
// 'graph' normalizes to 'flowchart' and '-v2'/'-beta' suffixes are dropped.
// '' when the head is not a recognized Mermaid header.
export function detectMermaidType(src: string): string {
  let s = (src || '').replace(/^﻿/, '');
  s = s.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\s*\r?\n/, ''); // YAML front-matter block
  for (const raw of s.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(/^%%\{[^}]*\}%%\s*/, '').trim();     // inline %%{init}%% directive
    if (!line || line.startsWith('%%')) continue;            // blank / comment
    const m = line.match(/^(flowchart|graph|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|mindmap|timeline|quadrantChart|gitGraph|requirementDiagram|C4\w*|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|architecture(?:-beta)?|kanban|radar|treemap|zenuml)\b/i);
    if (!m) return '';
    const k = m[1].toLowerCase();
    return k === 'graph' ? 'flowchart' : k.replace(/-v2$|-beta$/, '');
  }
  return '';
}

// Only true flowcharts use [..]/(..)/{..} as node-LABEL shapes that our quote-guard
// rewrites. In gantt/class/er/sequence/state/pie/etc. those brackets are real
// syntax (task rows, members, attributes, [*] markers, composite { }), so guarding
// them everywhere is what made non-flowchart diagrams fall back to raw code.
function isFlowchartLike(src: string): boolean {
  return detectMermaidType(src) === 'flowchart';
}

// Mermaid *structure/directive* lines — their parens/brackets are syntax (subgraph
// titles, style rules, class refs), never labels. The guard must leave them alone
// (e.g. `subgraph الوضع الراهن (الخصم)` must NOT become `("الخصم")`).
const STRUCT_LINE = /^\s*(?:subgraph\b|end\b|direction\b|style\b|classDef\b|class\b|linkStyle\b|click\b|accTitle\b|accDescr\b|%%)/i;

/** Wrap long Arabic labels inside every node shape so they never overflow.
 *  Line-aware: structural/directive lines pass through untouched so subgraph
 *  titles and style rules with parens are never mangled. */
export function guardMermaidLabels(src: string): string {
  return src.split('\n').map((line) => {
    if (STRUCT_LINE.test(line)) return line;
    let out = line;
    for (const { re, o, c } of GUARD_PASSES) {
      out = out.replace(re, (m, body: string) => {
        const wrapped = wrapBody(body);
        if (wrapped === null) return m;
        return `${o}${wrapped}${c}`;
      });
    }
    return guardRoundNodes(out);
  }).join('\n');
}

// The model frequently invents a `radar-chart` dialect (header `radar-chart`,
// an `axes` block of `"label" : value` rows) that Mermaid has NO diagram type
// for — it throws "No diagram type detected" and the chart falls back to raw
// code. Mermaid 11's real radar diagram is `radar-beta`. Translate the invented
// syntax into valid radar-beta so it renders. Returns the input unchanged if it
// can't extract any axis rows (so a genuinely-different chart is never mangled).
export function convertRadarChart(src: string): string {
  let title = '';
  const axes: { label: string; value: number }[] = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || /^(radar-chart|axes)\b/i.test(line) || line.startsWith('%%')) continue;
    const tm = line.match(/^title\b\s*(.+)$/i);
    if (tm) { title = tm[1].replace(/^["']|["']$/g, '').trim(); continue; }
    const am = line.match(/^["']?(.+?)["']?\s*:\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (am) axes.push({ label: am[1].trim(), value: parseFloat(am[2]) });
  }
  if (!axes.length) return src;                       // nothing to convert → leave as-is
  const q = (t: string) => t.replace(/"/g, "'");
  const axisLine = 'axis ' + axes.map((a, i) => `a${i}["${q(a.label)}"]`).join(', ');
  const curveLine = `curve c0["${q(title || 'القيمة')}"]{${axes.map(a => a.value).join(', ')}}`;
  const max = Math.max(5, Math.ceil(Math.max(...axes.map(a => a.value))));
  return [
    'radar-beta',
    title ? `  title "${q(title)}"` : '',
    `  ${axisLine}`,
    `  ${curveLine}`,
    `  max ${max}`,
  ].filter(Boolean).join('\n');
}

export function sanitizeMermaid(src: string): string {
  let s = (src || '').trim();
  s = s.replace(/^```(?:mermaid)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Invalid `radar-chart` dialect → real `radar-beta` (must run before type
  // detection so the rest of the pipeline sees a recognised diagram type).
  if (/^\s*radar-chart\b/i.test(s)) s = convertRadarChart(s);
  // Strip [مصدر N] / [source N] citation markers the model leaks INTO diagram node
  // labels — the nested [...] closes the id[label] bracket early and the whole chart
  // fails to parse (the #1 cause of flowcharts falling back to raw code). The keyword
  // must be followed by a digit, so real words like "مصدرة" are never touched.
  s = s.replace(/\s*\[\s*(?:مصدر|sources?|src|ref)\s*\d[^\]]*\]/gi, '');
  // Strip Arabic diacritics/tashkeel — they can crash Mermaid's label lexer and
  // are not needed for display in node boxes.
  s = s.replace(/[ً-ٰٟۖ-ۭ]/g, '');
  // Strip AI-injected <br/> tags — guardLabel will add proper wrapping after label extraction
  s = s.replace(/<br\s*\/?>/gi, ' ');
  // Collapse literal "\n" line-break artifacts the model leaves inside labels —
  // Mermaid renders them as the characters "\n", not a break. guardLabel re-wraps.
  s = s.replace(/\\n/g, ' ');
  // ---- type-gated rewrites: valid ONLY for flowchart/state syntax. Applying them
  // to gantt/sequence/pie/class/er/etc. corrupts real syntax (the root cause of
  // those diagram types degrading to raw code).
  const _type = detectMermaidType(s);
  if (_type === 'flowchart') {
    // Fix inner double-quotes inside square-bracket node labels: ["foo "bar" baz"] → ["foo 'bar' baz"]
    // The GUARD_PASSES regex [^"]*? stops at inner quotes, leaving them unprocessed.
    s = s.replace(/\["[^\]]*"\]/g, m => '["' + m.slice(2, -2).replace(/"/g, "'") + '"]');
    // RACI/flowchart: inner quotes around single letters ("A") inside node labels → (A)
    s = s.replace(/\("([RACI])"\)/g, '($1)');
  } else if (_type === 'statediagram') {
    // stateDiagram-v2: parentheses inside quoted labels crash the parser
    s = s.replace(/state\s+"([^"]+)"\s+as/g, (_m, lbl) =>
      `state "${lbl.replace(/\s*\([^)]*\)/g, '').trim()}" as`
    );
  }
  return s;
}

/** Type-aware pre-render transform — the SINGLE transform MermaidView, mermaidToSvg
 *  and the AI validator all use. Cleans EVERY diagram type, but only applies the
 *  flowchart quote-guard to actual flowcharts, so gantt/sequence/pie/class/er/
 *  state/journey/mindmap/timeline/etc. render instead of falling back to raw source. */
export function prepareMermaidForRender(code: string): string {
  const s = sanitizeMermaid(code);
  if (isFlowchartLike(s)) {
    return guardMermaidLabels(s).replace(/\("([RACI])"\)/g, '($1)');
  }
  return s;
}

// ---- Mermaid <-> React Flow (lightweight, for flowchart-style graphs) ----------

const ARROW_RE = /^\s*([A-Za-z0-9_]+)\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*(?:--?>|---|-\.->|==>)\s*(?:\|([^|]*)\|)?\s*([A-Za-z0-9_]+)\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?/;
const LABEL_RE = /([A-Za-z0-9_]+)\s*(?:\["([^"]*)"\]|\[([^\]]*)\]|\(\(([^)]*)\)\)|\(([^)]*)\)|\{([^}]*)\})/g;

/** Best-effort parse of flowchart Mermaid into a React Flow graph (auto-positioned). */
export function mermaidToFlow(mermaid: string): { nodes: GovFlowNode[]; edges: GovFlowEdge[] } {
  const src = sanitizeMermaid(mermaid);
  const labels = new Map<string, string>();
  let m: RegExpExecArray | null;
  const lr = new RegExp(LABEL_RE);
  while ((m = lr.exec(src))) {
    const id = m[1];
    const lbl = m[2] || m[3] || m[4] || m[5] || m[6];
    if (lbl) labels.set(id, lbl);
  }

  const ids: string[] = [];
  const edges: GovFlowEdge[] = [];
  let ei = 0;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || /^(flowchart|graph|stateDiagram|subgraph|end|direction|classDef|class |style )/i.test(line)) continue;
    const am = ARROW_RE.exec(line);
    if (am) {
      const [, from, elabel, to] = am;
      for (const id of [from, to]) if (!ids.includes(id)) ids.push(id);
      edges.push({ id: `e${ei++}`, source: from, target: to, label: (elabel || '').trim() || undefined, animated: true });
    }
  }
  // any labelled-but-unconnected nodes
  for (const id of labels.keys()) if (!ids.includes(id)) ids.push(id);

  const COLW = 240, ROWH = 120, PERCOL = 4;
  const nodes: GovFlowNode[] = ids.map((id, i) => ({
    id,
    position: { x: (Math.floor(i / PERCOL)) * COLW + 40, y: (i % PERCOL) * ROWH + 40 },
    data: { label: labels.get(id) || id },
  }));
  return { nodes, edges };
}

// ---- Model -> React Flow (nodes BOUND to real entities for the editable canvas) ----

const NODE_STYLE: Record<NonNullable<GovFlowNode['data']['refKind']>, Record<string, any>> = {
  unit:      { background: '#4f46e5', color: '#fff', border: '1px solid #4338ca', borderRadius: 12, fontWeight: 700, padding: 8, width: 200 },
  role:      { background: '#0ea5e9', color: '#fff', border: '1px solid #0284c7', borderRadius: 10, padding: 6, width: 190 },
  policy:    { background: '#f59e0b', color: '#1e293b', border: '1px solid #d97706', borderRadius: 10, padding: 6, width: 190 },
  procedure: { background: '#10b981', color: '#04321f', border: '1px solid #059669', borderRadius: 10, padding: 6, width: 200 },
  authority: { background: '#e11d48', color: '#fff', border: '1px solid #be123c', borderRadius: 10, padding: 6, width: 200 },
  kpi:       { background: '#7c3aed', color: '#fff', border: '1px solid #6d28d9', borderRadius: 10, padding: 6, width: 190 },
};

/** Parse a canvas node id `kind:realId` → {refKind, refId}. */
export function parseNodeId(nodeId: string): { refKind?: GovFlowNode['data']['refKind']; refId?: string } {
  const i = nodeId.indexOf(':');
  if (i < 0) return {};
  const kind = nodeId.slice(0, i) as any;
  if (!['unit', 'role', 'policy', 'procedure', 'authority', 'kpi'].includes(kind)) return {};
  return { refKind: kind, refId: nodeId.slice(i + 1) };
}

/**
 * Build an editable canvas graph from the REAL model.
 * Layout (RTL-friendly columns): units → roles → procedures/policies.
 * Every node carries data.refKind + data.refId so edits write back to the model.
 */
export function modelToFlow(model: CompanyGovernanceModel): { nodes: GovFlowNode[]; edges: GovFlowEdge[] } {
  const nodes: GovFlowNode[] = [];
  const edges: GovFlowEdge[] = [];
  let ei = 0;
  const COLW = 280, ROWH = 110;

  const unitRow = new Map<string, number>();
  model.orgUnits.forEach((u, i) => {
    unitRow.set(u.id, i);
    nodes.push({
      id: `unit:${u.id}`, position: { x: 40, y: 40 + i * ROWH * 2 },
      data: { label: u.name, refKind: 'unit', refId: u.id }, style: NODE_STYLE.unit,
    });
  });
  // unit hierarchy edges
  model.orgUnits.forEach(u => {
    if (u.parentId) edges.push({ id: `e${ei++}`, source: `unit:${u.parentId}`, target: `unit:${u.id}`, animated: false });
  });

  // roles in column 2, grouped under their unit
  const roleCount = new Map<string, number>();
  model.roles.forEach(r => {
    const base = r.unitId && unitRow.has(r.unitId) ? unitRow.get(r.unitId)! : model.orgUnits.length;
    const k = r.unitId || '_';
    const n = roleCount.get(k) || 0; roleCount.set(k, n + 1);
    nodes.push({
      id: `role:${r.id}`, position: { x: 40 + COLW, y: 40 + base * ROWH * 2 + n * ROWH },
      data: { label: r.title, refKind: 'role', refId: r.id }, style: NODE_STYLE.role,
    });
    if (r.unitId && unitRow.has(r.unitId)) edges.push({ id: `e${ei++}`, source: `unit:${r.unitId}`, target: `role:${r.id}`, animated: false });
  });

  // procedures in column 3, linked to owning unit (+ policy if any)
  const procCount = new Map<string, number>();
  (model.procedures || []).forEach(pr => {
    const base = pr.unitId && unitRow.has(pr.unitId) ? unitRow.get(pr.unitId)! : model.orgUnits.length;
    const k = pr.unitId || '_';
    const n = procCount.get(k) || 0; procCount.set(k, n + 1);
    nodes.push({
      id: `procedure:${pr.id}`, position: { x: 40 + COLW * 2, y: 40 + base * ROWH * 2 + n * ROWH },
      data: { label: pr.title, refKind: 'procedure', refId: pr.id }, style: NODE_STYLE.procedure,
    });
    if (pr.unitId && unitRow.has(pr.unitId)) edges.push({ id: `e${ei++}`, source: `unit:${pr.unitId}`, target: `procedure:${pr.id}`, label: 'إجراء', animated: true });
  });

  // policies in column 4
  model.policies.forEach((pol, i) => {
    nodes.push({
      id: `policy:${pol.id}`, position: { x: 40 + COLW * 3, y: 40 + i * ROWH },
      data: { label: pol.title, refKind: 'policy', refId: pol.id }, style: NODE_STYLE.policy,
    });
  });
  // policy ↔ procedure links
  (model.procedures || []).forEach(pr => {
    if (pr.policyId && model.policies.some(p => p.id === pr.policyId))
      edges.push({ id: `e${ei++}`, source: `policy:${pr.policyId}`, target: `procedure:${pr.id}`, label: 'يحكمه', animated: false });
  });

  // authorities in column 5, linked to the holding role
  (model.authorities || []).forEach((a, i) => {
    nodes.push({
      id: `authority:${a.id}`, position: { x: 40 + COLW * 4, y: 40 + i * ROWH },
      data: { label: `${a.decision} (${a.level})`, refKind: 'authority', refId: a.id }, style: NODE_STYLE.authority,
    });
    if (a.roleId && model.roles.some(r => r.id === a.roleId))
      edges.push({ id: `e${ei++}`, source: `role:${a.roleId}`, target: `authority:${a.id}`, label: a.level, animated: false });
  });

  // kpis in column 6, linked to owning unit
  (model.kpis || []).forEach((k, i) => {
    nodes.push({
      id: `kpi:${k.id}`, position: { x: 40 + COLW * 5, y: 40 + i * ROWH },
      data: { label: k.name, refKind: 'kpi', refId: k.id }, style: NODE_STYLE.kpi,
    });
    if (k.unitId && model.orgUnits.some(u => u.id === k.unitId))
      edges.push({ id: `e${ei++}`, source: `unit:${k.unitId}`, target: `kpi:${k.id}`, label: 'يقيس', animated: false });
  });

  return { nodes, edges };
}

/**
 * Simple layered auto-layout (BFS by column kind) — repositions nodes into tidy
 * columns by their bound entity kind, stacking siblings vertically. Pure.
 */
export function autoLayout(nodes: GovFlowNode[], edges: GovFlowEdge[]): GovFlowNode[] {
  const COLW = 280, ROWH = 110;
  const colOf: Record<string, number> = { unit: 0, role: 1, procedure: 2, policy: 3, authority: 4, kpi: 5 };
  const colCount = new Map<number, number>();
  return nodes.map(n => {
    const kind = (n.data?.refKind || parseNodeId(n.id).refKind || 'unit') as string;
    const col = colOf[kind] ?? 0;
    const row = colCount.get(col) || 0;
    colCount.set(col, row + 1);
    return { ...n, position: { x: 40 + col * COLW, y: 40 + row * ROWH } };
  });
}

/** Serialize an edited React Flow graph back to flowchart Mermaid.
 *  Canvas ids are `kind:realId` — Mermaid forbids ':' (and other punctuation) in
 *  node ids, so every id is mapped to a safe ASCII token (n0, n1, …). Without this
 *  the re-render of an edited canvas failed outright ("درايينج مش شغال"). */
export function flowToMermaid(nodes: GovFlowNode[], edges: GovFlowEdge[]): string {
  const esc = (s: string) => `"${(s || '').replace(/"/g, "'")}"`;
  const safe = new Map<string, string>();
  const idOf = (raw: string) => {
    if (!safe.has(raw)) safe.set(raw, `n${safe.size}`);
    return safe.get(raw)!;
  };
  const lines = ['flowchart TD'];
  for (const n of nodes) lines.push(`  ${idOf(n.id)}[${esc(n.data?.label || n.id)}]`);
  for (const e of edges) {
    // edges may reference ids that have no node entry — still give them a token
    const lbl = e.label ? `|${esc(e.label)}|` : '';
    lines.push(`  ${idOf(e.source)} -->${lbl} ${idOf(e.target)}`);
  }
  return lines.join('\n');
}

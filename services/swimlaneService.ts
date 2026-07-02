// Swimlane flow diagrams for the Governance Center.
// Mermaid v11 has NO real horizontal swimlanes (only ugly nested subgraphs), so this
// is a PURPOSE-BUILT renderer: org roles/units become horizontal colored lanes, each
// step sits in its owner's lane, shapes encode the step type (process/decision/approve/
// reject/end) and arrows are color-coded (green=approve, red-dashed=reject/return).
// RTL: the flow starts on the RIGHT and runs leftward, matching the owner's reference.
//
// Pipeline mirrors diagramService.generateMermaid: AI produces a SwimlaneSpec grounded
// in the model, we VALIDATE it, and on any failure fall back to a DETERMINISTIC spec
// built straight from the model — a swimlane ALWAYS renders, never fails silently.

import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import { generateJson } from './agentOrchestrator';
import { MODELS } from '../constants/models';
import type { CompanyGovernanceModel } from '../types';

export type SwimNodeType = 'start' | 'process' | 'decision' | 'approve' | 'reject' | 'end';
export type SwimEdgeKind = 'flow' | 'approve' | 'reject';

export interface SwimLane { id: string; title: string; subtitle?: string; }
export interface SwimNode { id: string; lane: string; label: string; type: SwimNodeType; }
export interface SwimEdge { from: string; to: string; label?: string; kind?: SwimEdgeKind; }
export interface SwimlaneSpec {
  title: string;
  lanes: SwimLane[];
  nodes: SwimNode[];
  edges: SwimEdge[];
}

// ---- palette (matches the reference image legend) ---------------------------------
const LANE_COLORS = [
  { bg: '#eff6ff', band: '#dbeafe', text: '#1e3a8a' }, // blue
  { bg: '#eef2ff', band: '#e0e7ff', text: '#3730a3' }, // indigo
  { bg: '#ecfdf5', band: '#d1fae5', text: '#065f46' }, // green
  { bg: '#faf5ff', band: '#f3e8ff', text: '#6b21a8' }, // purple
  { bg: '#fff7ed', band: '#ffedd5', text: '#9a3412' }, // orange
  { bg: '#fdf2f8', band: '#fce7f3', text: '#9d174d' }, // pink
  { bg: '#f0fdfa', band: '#ccfbf1', text: '#115e59' }, // teal
];
const NODE_FILL: Record<SwimNodeType, { fill: string; stroke: string; text: string }> = {
  start:   { fill: '#0d9488', stroke: '#0f766e', text: '#ffffff' },
  process: { fill: '#3b82f6', stroke: '#2563eb', text: '#ffffff' },
  decision:{ fill: '#fde047', stroke: '#eab308', text: '#713f12' },
  approve: { fill: '#22c55e', stroke: '#16a34a', text: '#ffffff' },
  reject:  { fill: '#ef4444', stroke: '#dc2626', text: '#ffffff' },
  end:     { fill: '#16a34a', stroke: '#15803d', text: '#ffffff' },
};

// ---------------------------------------------------------------------------------
//  AI generation (grounded) + deterministic fallback
// ---------------------------------------------------------------------------------

function modelDigest(model: CompanyGovernanceModel): string {
  const units = model.orgUnits.map(u => `- ${u.id}: ${u.name}`).join('\n');
  const roles = model.roles.map(r => `- ${r.id}: ${r.title} @${r.unitId}`).join('\n');
  const procs = (model.procedures || []).map(p =>
    `- ${p.id}: ${p.title}${p.unitId ? ` @${p.unitId}` : ''} — steps: ${(p.steps || []).join(' ← ')}`).join('\n');
  const auth = (model.authorities || []).map(a =>
    `- ${a.decision} → role ${a.roleId} (${a.level}${a.threshold ? `, ${a.threshold}` : ''})`).join('\n');
  return [
    `# ${model.companyName}`,
    `## الوحدات\n${units || '—'}`,
    `## الأدوار\n${roles || '—'}`,
    `## الإجراءات\n${procs || '—'}`,
    `## الصلاحيات (سلسلة الاعتماد)\n${auth || '—'}`,
  ].join('\n\n');
}

const SPEC_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    lanes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          title: { type: Type.STRING },
          subtitle: { type: Type.STRING },
        },
        required: ['id', 'title'],
      },
    },
    nodes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          lane: { type: Type.STRING },
          label: { type: Type.STRING },
          type: { type: Type.STRING, enum: ['start', 'process', 'decision', 'approve', 'reject', 'end'] },
        },
        required: ['id', 'lane', 'label', 'type'],
      },
    },
    edges: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          from: { type: Type.STRING },
          to: { type: Type.STRING },
          label: { type: Type.STRING },
          kind: { type: Type.STRING, enum: ['flow', 'approve', 'reject'] },
        },
        required: ['from', 'to'],
      },
    },
  },
  required: ['title', 'lanes', 'nodes', 'edges'],
};

/** Returns null if the spec is renderable, else a short reason. */
export function validateSpec(s: any): string | null {
  if (!s || typeof s !== 'object') return 'spec missing';
  if (!Array.isArray(s.lanes) || s.lanes.length === 0) return 'no lanes';
  if (!Array.isArray(s.nodes) || s.nodes.length === 0) return 'no nodes';
  if (!Array.isArray(s.edges)) return 'edges not array';
  const laneIds = new Set(s.lanes.map((l: SwimLane) => l.id));
  const nodeIds = new Set(s.nodes.map((n: SwimNode) => n.id));
  for (const n of s.nodes) {
    if (!laneIds.has(n.lane)) return `node "${n.id}" references unknown lane "${n.lane}"`;
  }
  for (const e of s.edges) {
    if (!nodeIds.has(e.from)) return `edge from unknown node "${e.from}"`;
    if (!nodeIds.has(e.to)) return `edge to unknown node "${e.to}"`;
  }
  return null;
}

/** Drop edges to/from unknown nodes and nodes in unknown lanes (best-effort repair). */
function pruneSpec(s: SwimlaneSpec): SwimlaneSpec {
  const laneIds = new Set(s.lanes.map(l => l.id));
  const nodes = s.nodes.filter(n => laneIds.has(n.lane));
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges = (s.edges || []).filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));
  return { ...s, nodes, edges };
}

export async function generateSwimlane(
  model: CompanyGovernanceModel,
  opts: { language?: 'ar' | 'en'; focus?: string; signal?: AbortSignal } = {},
): Promise<SwimlaneSpec> {
  const ar = opts.language !== 'en';
  const sys = [
    'You are a senior governance analyst that designs precise cross-functional SWIMLANE flow diagrams (RACI-style approval routing).',
    'Each lane is an org role or unit. Each node sits in the lane of WHO performs it.',
    'Node types: "start" (the trigger), "process" (an action/إجراء), "decision" (a yes/no checkpoint/قرار), "approve" (an approval granted/اعتماد), "reject" (a rejection or return/رفض-إرجاع), "end" (final outcome/نهاية).',
    'Edges: kind "approve" for the success path, kind "reject" for rejection/return-for-rework, "flow" for neutral steps. A decision node should have one approve edge forward and one reject edge (often looping back to an earlier process).',
    ar ? 'All titles and labels in Arabic, short (2-5 words).' : 'All titles and labels in English, short.',
    'Keep node/lane ids ASCII (n1, n2, laneA...). Ground every lane/node strictly in the provided model — do NOT invent roles or steps.',
    'Model a realistic approval/routing process (e.g. purchase request, document approval, hiring) using the model\'s authorities chain and procedures.',
  ].join(' ');
  const prompt = [
    opts.focus ? `Focus the flow on: ${opts.focus}` : 'Pick the most important approval/routing process implied by the model.',
    '',
    'Governance model (single source of truth):',
    modelDigest(model),
    '',
    `Return JSON SwimlaneSpec { title, lanes[{id,title,subtitle?}], nodes[{id,lane,label,type}], edges[{from,to,label?,kind?}] }.`,
    'Order lanes top-to-bottom by seniority/flow. 4-8 lanes, 6-16 nodes is ideal.',
  ].filter(Boolean).join('\n');

  const MAX_TRIES = 3;
  let lastErr = '';
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const repair = attempt === 0 ? '' :
      `\n\nYour previous spec was INVALID: ${lastErr}\nFix it: every node.lane must exist in lanes; every edge.from/to must exist in nodes.`;
    try {
      const res = await generateJson<SwimlaneSpec>(prompt + repair, SPEC_SCHEMA, {
        systemInstruction: sys, signal: opts.signal, temperature: attempt === 0 ? 0.3 : 0.15,
      });
      const pruned = pruneSpec(res);
      const err = validateSpec(pruned);
      if (!err) return { ...pruned, title: (pruned.title || '').trim() || (ar ? 'مخطط المسارات' : 'Swimlane') };
      lastErr = err;
      console.warn(`[swimlane] invalid spec (try ${attempt + 1}/${MAX_TRIES}): ${err}`);
    } catch (e: any) {
      if (opts.signal?.aborted) throw e;
      lastErr = String(e?.message || e).slice(0, 300);
      console.warn(`[swimlane] generation attempt ${attempt + 1} threw: ${lastErr}`);
    }
  }
  console.warn('[swimlane] AI failed after retries — using deterministic model-derived fallback.');
  return deterministicSwimlane(model, ar);
}

// ---------------------------------------------------------------------------------
//  Natural-language editing — the P8 "edit by chatting" surface for swimlanes, at
//  parity with editMermaidWithAI (services/geminiService.ts). Unlike generateSwimlane
//  above, a final failure THROWS instead of silently degrading to a deterministic
//  fallback: silently discarding the user's explicit edit instruction would be far
//  more confusing than a visible error the chat UI can show and let them retry.
// ---------------------------------------------------------------------------------

export interface SwimlaneEditAttachment { data: string; mimeType: string; name?: string }

const isTransientSwimlaneErr = (err: any): boolean => {
  const s = String(err?.message || err || '');
  return /GENJSON_EMPTY|GENJSON_PARSE|503|429|overload|unavailable|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|deadline|timeout/i.test(s);
};

const swimlaneSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Strip fences / pull the outermost JSON object out of a response that may carry preamble text. */
function extractSpecJson(raw: string): string {
  const stripped = (raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { JSON.parse(stripped); return stripped; } catch { /* fall through to extraction */ }
  const start = stripped.indexOf('{');
  if (start === -1) throw new Error('GENJSON_PARSE: no JSON object found in response');
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') { depth--; if (depth === 0) return stripped.slice(start, i + 1); }
  }
  throw new Error('GENJSON_PARSE: unterminated JSON object in response');
}

// Multimodal JSON generation (text + optional image/PDF reference attachments) against
// SPEC_SCHEMA. generateJson (agentOrchestrator) has no attachment support, so this is a
// dedicated sibling — same retry-on-transient-error shape, called directly via
// @google/genai like geminiService's editMermaidWithAI does.
async function generateSwimlaneEditJson(
  promptText: string,
  systemInstruction: string,
  attachments: SwimlaneEditAttachment[],
  signal?: AbortSignal,
): Promise<any> {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
  const parts = [
    { text: promptText },
    ...attachments.map(a => ({ inlineData: { data: a.data, mimeType: a.mimeType } })),
  ];
  const retries = 2;
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error('ABORTED');
    try {
      const res = await ai.models.generateContent({
        model: MODELS.TEXT,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction,
          temperature: 0.3,
          responseMimeType: 'application/json',
          responseSchema: SPEC_SCHEMA,
          maxOutputTokens: 16000,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });
      const raw = (res.text || '').trim();
      if (!raw) throw new Error('GENJSON_EMPTY: model returned no content (blocked or truncated)');
      return JSON.parse(extractSpecJson(raw));
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw new Error('ABORTED');
      if (isTransientSwimlaneErr(err) && attempt < retries) {
        await swimlaneSleep(700 * (attempt + 1) + Math.floor(Math.random() * 300));
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error('GENJSON_EMPTY: unknown failure');
}

/**
 * Edit an EXISTING SwimlaneSpec in natural language — the swimlane counterpart of
 * editMermaidWithAI. Returns the full updated spec; ids the instruction doesn't ask
 * to change are preserved verbatim (the prompt instructs the model to keep them, and
 * pruneSpec/validateSpec only ever DROP dangling references, never rewrite ids).
 * Throws `INVALID_SWIMLANE: <reason>` after MAX_TRIES failed attempts — callers must
 * surface this to the user rather than silently discarding their instruction.
 */
export async function editSwimlaneWithAI(
  spec: SwimlaneSpec,
  instruction: string,
  opts: { attachments?: SwimlaneEditAttachment[]; language?: 'ar' | 'en'; signal?: AbortSignal } = {},
): Promise<SwimlaneSpec> {
  const ar = opts.language !== 'en';
  const atts = opts.attachments || [];
  const sys = [
    'You are an editor for an existing SWIMLANE flow diagram (RACI-style approval routing) in an Arabic-first corporate-governance app.',
    'You receive the CURRENT SwimlaneSpec as JSON and an instruction, optionally with reference images/files.',
    'Return ONLY the COMPLETE updated SwimlaneSpec JSON matching the schema — no markdown fences, no prose, no commentary.',
    'Node types: "start", "process", "decision", "approve", "reject", "end". Edge kind: "flow", "approve", "reject".',
    'CRITICAL: keep the SAME id for every lane/node the instruction does NOT ask to add, remove or rename — do not regenerate ids gratuitously. New lanes/nodes need new ASCII ids not already used in the spec (e.g. n7, laneD).',
    'Every node.lane MUST reference an existing (or newly added) lane id. Every edge.from/to MUST reference an existing (or newly added) node id.',
    ar ? 'All titles and labels in Arabic, short (2-5 words).' : 'All titles and labels in English, short.',
    'Apply ONLY the requested edit — preserve every lane, node and edge the instruction does not ask to change.',
    atts.length ? 'When reference images/files are provided, read their structure/text faithfully and reflect it in the diagram.' : '',
  ].filter(Boolean).join(' ');

  const promptBase = [
    'CURRENT SWIMLANE SPEC (JSON):',
    JSON.stringify(spec),
    '',
    `INSTRUCTION (${ar ? 'Arabic' : 'English'}):`,
    instruction.trim() || (ar ? 'حسِّن المخطط واجعله أوضح.' : 'Improve and clarify the diagram.'),
    '',
    'Return ONLY the full updated SwimlaneSpec JSON: { title, lanes[{id,title,subtitle?}], nodes[{id,lane,label,type}], edges[{from,to,label?,kind?}] }.',
  ].join('\n');

  const MAX_TRIES = 3;
  let lastErr = '';
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (opts.signal?.aborted) throw new Error('ABORTED');
    const repair = attempt === 0 ? '' :
      `\n\nYour previous spec was INVALID: ${lastErr}\nFix it: every node.lane must exist in lanes; every edge.from/to must exist in nodes.`;
    try {
      const res = await generateSwimlaneEditJson(promptBase + repair, sys, atts, opts.signal);
      const pruned = pruneSpec(res as SwimlaneSpec);
      const err = validateSpec(pruned);
      if (!err) return { ...pruned, title: (pruned.title || '').trim() || spec.title };
      lastErr = err;
      console.warn(`[swimlane] edit produced invalid spec (try ${attempt + 1}/${MAX_TRIES}): ${err}`);
    } catch (e: any) {
      if (opts.signal?.aborted) throw e;
      lastErr = String(e?.message || e).slice(0, 300);
      console.warn(`[swimlane] edit attempt ${attempt + 1} threw: ${lastErr}`);
    }
  }
  throw new Error(`INVALID_SWIMLANE: ${lastErr || (ar ? 'تعذّر إنتاج مخطط صالح من هذا الطلب.' : 'could not produce a valid diagram from that request.')}`);
}

/** Guaranteed-valid swimlane built purely from the model (authorities chain, else a procedure). */
export function deterministicSwimlane(model: CompanyGovernanceModel, ar = true): SwimlaneSpec {
  const roleTitle = (id: string) => model.roles.find(r => r.id === id)?.title || id;
  const LEVEL_ORDER: Record<string, number> = { recommend: 0, execute: 1, approve: 2, inform: 3 };

  const auths = [...(model.authorities || [])].sort(
    (a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9));

  if (auths.length) {
    // One lane per distinct role on the authority chain, in level order.
    const laneOrder: string[] = [];
    auths.forEach(a => { if (a.roleId && !laneOrder.includes(a.roleId)) laneOrder.push(a.roleId); });
    const lanes: SwimLane[] = laneOrder.map(rid => ({ id: rid, title: roleTitle(rid) }));
    const firstLane = laneOrder[0] || 'main';
    if (!lanes.length) lanes.push({ id: 'main', title: model.companyName });
    const nodes: SwimNode[] = [{ id: 'start', lane: firstLane, label: ar ? 'بداية الطلب' : 'Request', type: 'start' }];
    const edges: SwimEdge[] = [];
    let prev = 'start';
    auths.forEach((a, i) => {
      const lane = a.roleId && laneOrder.includes(a.roleId) ? a.roleId : firstLane;
      const dec = `d${i}`;
      nodes.push({ id: dec, lane, label: a.decision, type: 'decision' });
      edges.push({ from: prev, to: dec, kind: 'flow' });
      // reject loops back to the previous decision/start
      edges.push({ from: dec, to: prev, label: ar ? 'رفض' : 'Reject', kind: 'reject' });
      prev = dec;
    });
    const endLane = laneOrder[laneOrder.length - 1] || firstLane;
    nodes.push({ id: 'end', lane: endLane, label: ar ? 'اعتماد نهائي' : 'Approved', type: 'end' });
    edges.push({ from: prev, to: 'end', label: ar ? 'اعتماد' : 'Approve', kind: 'approve' });
    return { title: ar ? 'مسار الاعتماد' : 'Approval routing', lanes, nodes, edges };
  }

  // No authorities → linearize the richest procedure across its unit lane.
  const proc = (model.procedures || []).slice().sort((a, b) => (b.steps?.length || 0) - (a.steps?.length || 0))[0];
  const laneId = proc?.unitId || 'main';
  const laneName = model.orgUnits.find(u => u.id === proc?.unitId)?.name || model.companyName;
  const lanes: SwimLane[] = [{ id: laneId, title: laneName }];
  const nodes: SwimNode[] = [{ id: 'start', lane: laneId, label: ar ? 'بداية' : 'Start', type: 'start' }];
  const edges: SwimEdge[] = [];
  let prev = 'start';
  // FIX C — كان .slice(0,12) يقصّ الإجراءات الطويلة بصمت (الخطوات بعد 12 تختفي).
  // ارفع السقف لتغطية الإجراء كاملاً؛ وعند تجاوز سقف عالٍ جدًا (نادر) اعرض عقدة
  // «+N خطوة إضافية» بدل الحذف الصامت حتى لا يُفهَم المخطط على أنه مكتمل.
  const STEP_CAP = 60;
  const allSteps = proc?.steps || [];
  const shown = allSteps.slice(0, STEP_CAP);
  shown.forEach((s, i) => {
    const id = `s${i}`;
    nodes.push({ id, lane: laneId, label: s, type: 'process' });
    edges.push({ from: prev, to: id, kind: 'flow' });
    prev = id;
  });
  if (allSteps.length > STEP_CAP) {
    const moreId = 'more';
    const n = allSteps.length - STEP_CAP;
    nodes.push({ id: moreId, lane: laneId, label: ar ? `+${n} خطوة إضافية` : `+${n} more steps`, type: 'process' });
    edges.push({ from: prev, to: moreId, kind: 'flow' });
    prev = moreId;
  }
  nodes.push({ id: 'end', lane: laneId, label: ar ? 'نهاية' : 'End', type: 'end' });
  edges.push({ from: prev, to: 'end', kind: 'approve' });
  return { title: proc?.title || (ar ? 'مخطط المسار' : 'Flow'), lanes, nodes, edges };
}

// ---------------------------------------------------------------------------------
//  Layout — assign each node a (lane row, column) then place orthogonal arrows
// ---------------------------------------------------------------------------------

const LANE_LABEL_W = 168;  // right gutter (RTL) holding lane titles
const COL_W = 210;
const NODE_W = 156;
const NODE_H = 62;
const ROW_GAP = 16;        // vertical gap when multiple nodes stack in one lane/col
const LANE_PAD = 22;       // vertical padding inside a lane band
const HEADER_H = 92;       // legend + title strip
const SIDE_PAD = 40;       // left padding (flow end)

interface Placed extends SwimNode { col: number; row: number; x: number; y: number; }

/** Longest-path column from start nodes using only forward (non-reject) edges. */
function assignColumns(spec: SwimlaneSpec): Map<string, number> {
  const col = new Map<string, number>();
  spec.nodes.forEach(n => col.set(n.id, 0));
  const fwd = spec.edges.filter(e => e.kind !== 'reject');
  // iterate to a fixpoint (cap to node count to tolerate cycles)
  for (let pass = 0; pass < spec.nodes.length + 2; pass++) {
    let changed = false;
    for (const e of fwd) {
      const c = (col.get(e.from) ?? 0) + 1;
      if (c > (col.get(e.to) ?? 0)) { col.set(e.to, c); changed = true; }
    }
    if (!changed) break;
  }
  return col;
}

function layout(spec: SwimlaneSpec) {
  const laneIndex = new Map(spec.lanes.map((l, i) => [l.id, i]));
  const col = assignColumns(spec);
  const maxCol = Math.max(0, ...spec.nodes.map(n => col.get(n.id) ?? 0));
  const totalCols = maxCol + 1;

  // group nodes by (lane,col) to stack overlaps
  const cell = new Map<string, SwimNode[]>();
  spec.nodes.forEach(n => {
    const k = `${n.lane}|${col.get(n.id) ?? 0}`;
    (cell.get(k) || cell.set(k, []).get(k)!).push(n);
  });

  // lane heights: max stack in any column of that lane
  const laneStack = new Map<string, number>();
  spec.lanes.forEach(l => {
    let max = 1;
    for (let c = 0; c < totalCols; c++) max = Math.max(max, (cell.get(`${l.id}|${c}`) || []).length);
    laneStack.set(l.id, max);
  });
  const laneH = (id: string) => (laneStack.get(id)! * NODE_H) + ((laneStack.get(id)! - 1) * ROW_GAP) + LANE_PAD * 2;

  // lane top offsets
  const laneTop = new Map<string, number>();
  let y = HEADER_H;
  spec.lanes.forEach(l => { laneTop.set(l.id, y); y += laneH(l.id); });
  const totalH = y + 16;

  const contentW = totalCols * COL_W;
  const totalW = SIDE_PAD + contentW + LANE_LABEL_W;
  // RTL: column 0 at the RIGHT of the content area, flow runs leftward.
  const colCenterX = (c: number) => SIDE_PAD + contentW - (c * COL_W) - COL_W / 2;

  const placed = new Map<string, Placed>();
  spec.nodes.forEach(n => {
    const c = col.get(n.id) ?? 0;
    const stack = cell.get(`${n.lane}|${c}`)!;
    const row = stack.indexOf(n);
    const top = laneTop.get(n.lane)!;
    const stackH = stack.length * NODE_H + (stack.length - 1) * ROW_GAP;
    const startY = top + (laneH(n.lane) - stackH) / 2;
    placed.set(n.id, {
      ...n, col: c, row,
      x: colCenterX(c),
      y: startY + row * (NODE_H + ROW_GAP) + NODE_H / 2,
    });
  });

  return { placed, laneIndex, laneTop, laneH, totalW, totalH, contentW };
}

// ---------------------------------------------------------------------------------
//  SVG render
// ---------------------------------------------------------------------------------

const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Wrap label into ≤maxLines tspans of ~maxChars; ellipsis on overflow. */
function tspans(label: string, cx: number, cy: number, fill: string, maxChars = 18, maxLines = 3): string {
  const words = (label || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; if (lines.length === maxLines) break; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (cur !== last || words.join(' ').length > lines.join(' ').length) {
      lines[maxLines - 1] = (last.length > maxChars - 1 ? last.slice(0, maxChars - 1) : last) + '…';
    }
  }
  const lh = 15;
  const startY = cy - ((lines.length - 1) * lh) / 2;
  return lines.map((ln, i) =>
    `<tspan x="${cx}" y="${startY + i * lh}">${esc(ln)}</tspan>`).join('');
}

function nodeShape(p: Placed): string {
  const c = NODE_FILL[p.type];
  const { x, y } = p;
  const txt = (cx: number, cy: number) =>
    `<text text-anchor="middle" dominant-baseline="middle" direction="rtl" font-size="12.5" font-weight="700" fill="${c.text}">${tspans(p.label, cx, cy, c.text)}</text>`;

  if (p.type === 'start') {
    const r = 30;
    return `<g><circle cx="${x}" cy="${y}" r="${r}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>`
      + `<text text-anchor="middle" dominant-baseline="middle" direction="rtl" font-size="11.5" font-weight="700" fill="${c.text}">${tspans(p.label, x, y, c.text, 12, 2)}</text></g>`;
  }
  if (p.type === 'decision') {
    const w = NODE_W / 2 + 14, h = NODE_H / 2 + 12;
    const pts = `${x},${y - h} ${x + w},${y} ${x},${y + h} ${x - w},${y}`;
    return `<g><polygon points="${pts}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>${txt(x, y)}</g>`;
  }
  // process / approve / reject / end → rounded rect
  return `<g><rect x="${x - NODE_W / 2}" y="${y - NODE_H / 2}" width="${NODE_W}" height="${NODE_H}" rx="12" `
    + `fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>${txt(x, y)}</g>`;
}

function halfW(t: SwimNodeType) { return t === 'decision' ? NODE_W / 2 + 14 : t === 'start' ? 30 : NODE_W / 2; }
function halfH(t: SwimNodeType) { return t === 'decision' ? NODE_H / 2 + 12 : t === 'start' ? 30 : NODE_H / 2; }

const EDGE_STYLE: Record<SwimEdgeKind, { stroke: string; dash: string; marker: string }> = {
  flow:    { stroke: '#64748b', dash: '', marker: 'arrow-flow' },
  approve: { stroke: '#16a34a', dash: '', marker: 'arrow-approve' },
  reject:  { stroke: '#dc2626', dash: '6 5', marker: 'arrow-reject' },
};

/** Orthogonal route. RTL: forward flow goes right→left (source LEFT → target RIGHT). */
function edgePath(s: Placed, t: Placed, kind: SwimEdgeKind): { d: string; lx: number; ly: number } {
  const forward = t.col > s.col || (t.col === s.col && t.row > s.row);
  if (kind === 'reject' || !forward) {
    // backward/reject: leave source TOP, travel up to a channel, over to target, down to target TOP.
    const sx = s.x, sy = s.y - halfH(s.type);
    const tx = t.x, ty = t.y - halfH(t.type);
    const chan = Math.min(sy, ty) - 26;
    const d = `M ${sx} ${sy} L ${sx} ${chan} L ${tx} ${chan} L ${tx} ${ty}`;
    return { d, lx: (sx + tx) / 2, ly: chan - 6 };
  }
  // forward: exit source LEFT, enter target RIGHT
  const sx = s.x - halfW(s.type), sy = s.y;
  const tx = t.x + halfW(t.type), ty = t.y;
  if (Math.abs(sy - ty) < 4) {
    return { d: `M ${sx} ${sy} L ${tx} ${ty}`, lx: (sx + tx) / 2, ly: sy - 7 };
  }
  const midX = (sx + tx) / 2;
  const d = `M ${sx} ${sy} L ${midX} ${sy} L ${midX} ${ty} L ${tx} ${ty}`;
  return { d, lx: midX, ly: (sy + ty) / 2 - 7 };
}

const LEGEND: { type: SwimNodeType; ar: string; en: string }[] = [
  { type: 'process', ar: 'إجراء', en: 'Process' },
  { type: 'decision', ar: 'قرار', en: 'Decision' },
  { type: 'approve', ar: 'اعتماد', en: 'Approve' },
  { type: 'reject', ar: 'رفض / إرجاع', en: 'Reject' },
  { type: 'end', ar: 'نهاية', en: 'End' },
];

export function renderSwimlaneSvg(spec: SwimlaneSpec, opts: { language?: 'ar' | 'en' } = {}): string {
  const ar = opts.language !== 'en';
  const { placed, laneIndex, laneTop, laneH, totalW, totalH } = layout(spec);

  // lane bands + right-gutter titles (RTL)
  let bands = '';
  spec.lanes.forEach(l => {
    const ci = (laneIndex.get(l.id)! % LANE_COLORS.length);
    const col = LANE_COLORS[ci];
    const top = laneTop.get(l.id)!, h = laneH(l.id);
    bands += `<rect x="0" y="${top}" width="${totalW}" height="${h}" fill="${col.bg}" stroke="#e2e8f0" stroke-width="1"/>`;
    // lane title box on the RIGHT
    const lx = totalW - LANE_LABEL_W;
    bands += `<rect x="${lx}" y="${top}" width="${LANE_LABEL_W}" height="${h}" fill="${col.band}" stroke="#e2e8f0" stroke-width="1"/>`;
    bands += `<text x="${lx + LANE_LABEL_W / 2}" y="${top + h / 2}" text-anchor="middle" dominant-baseline="middle" `
      + `direction="rtl" font-size="13.5" font-weight="800" fill="${col.text}">${tspans(l.title, lx + LANE_LABEL_W / 2, top + h / 2, col.text, 14, 2)}</text>`;
  });

  // edges first (under nodes)
  let edgeSvg = '';
  spec.edges.forEach(e => {
    const s = placed.get(e.from), t = placed.get(e.to);
    if (!s || !t) return;
    const kind: SwimEdgeKind = e.kind || 'flow';
    const st = EDGE_STYLE[kind];
    const { d, lx, ly } = edgePath(s, t, kind);
    edgeSvg += `<path d="${d}" fill="none" stroke="${st.stroke}" stroke-width="2" ${st.dash ? `stroke-dasharray="${st.dash}"` : ''} marker-end="url(#${st.marker})"/>`;
    if (e.label) {
      edgeSvg += `<g><rect x="${lx - e.label.length * 4 - 4}" y="${ly - 9}" width="${e.label.length * 8 + 8}" height="16" rx="4" fill="#ffffff" opacity="0.92"/>`
        + `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" direction="rtl" font-size="10.5" font-weight="700" fill="${st.stroke}">${esc(e.label)}</text></g>`;
    }
  });

  let nodeSvg = '';
  spec.nodes.forEach(n => { const p = placed.get(n.id); if (p) nodeSvg += nodeShape(p); });

  // header: title (right) + legend (left)
  const title = `<text x="${totalW - 16}" y="30" text-anchor="end" direction="rtl" font-size="17" font-weight="900" fill="#0f172a">${esc(spec.title)}</text>`;
  let legend = '';
  let lxp = 16;
  LEGEND.forEach(item => {
    const c = NODE_FILL[item.type];
    const label = ar ? item.ar : item.en;
    if (item.type === 'decision') {
      legend += `<polygon points="${lxp + 10},14 ${lxp + 20},22 ${lxp + 10},30 ${lxp},22" fill="${c.fill}" stroke="${c.stroke}"/>`;
    } else {
      legend += `<rect x="${lxp}" y="14" width="20" height="16" rx="4" fill="${c.fill}" stroke="${c.stroke}"/>`;
    }
    legend += `<text x="${lxp + 26}" y="22" dominant-baseline="middle" direction="rtl" font-size="11.5" font-weight="700" fill="#334155">${esc(label)}</text>`;
    lxp += 26 + label.length * 8 + 22;
  });
  // arrow legend
  legend += `<line x1="${lxp}" y1="22" x2="${lxp + 26}" y2="22" stroke="#16a34a" stroke-width="2" marker-end="url(#arrow-approve)"/>`
    + `<text x="${lxp + 32}" y="22" dominant-baseline="middle" direction="rtl" font-size="11" font-weight="700" fill="#16a34a">${ar ? 'موافقة' : 'approve'}</text>`;
  lxp += 32 + (ar ? 'موافقة' : 'approve').length * 8 + 18;
  legend += `<line x1="${lxp}" y1="22" x2="${lxp + 26}" y2="22" stroke="#dc2626" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#arrow-reject)"/>`
    + `<text x="${lxp + 32}" y="22" dominant-baseline="middle" direction="rtl" font-size="11" font-weight="700" fill="#dc2626">${ar ? 'رفض/إرجاع' : 'reject'}</text>`;

  const defs = Object.values(EDGE_STYLE).map(s =>
    `<marker id="${s.marker}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`
    + `<path d="M 0 0 L 10 5 L 0 10 z" fill="${s.stroke}"/></marker>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" font-family="system-ui,'Segoe UI',sans-serif">`
    + `<defs>${defs}</defs>`
    + `<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#ffffff"/>`
    + `<line x1="0" y1="${HEADER_H - 4}" x2="${totalW}" y2="${HEADER_H - 4}" stroke="#e2e8f0" stroke-width="1"/>`
    + bands + edgeSvg + nodeSvg + title + legend
    + `</svg>`;
}

/** Render the swimlane spec → PNG data URL (white bg, 2x) for PDF/Word embedding. */
export async function swimlaneToPng(
  spec: SwimlaneSpec,
  opts: { scale?: number; language?: 'ar' | 'en' } = {},
): Promise<{ png: string; width: number; height: number }> {
  const scale = opts.scale ?? 2;
  const svg = renderSwimlaneSvg(spec, { language: opts.language });
  const m = svg.match(/width="(\d+)" height="(\d+)"/);
  const w = m ? parseInt(m[1], 10) : 1200;
  const h = m ? parseInt(m[2], 10) : 800;
  return await new Promise((resolve, reject) => {
    const img = new Image();
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
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
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('swimlane svg img load failed')); };
    img.src = url;
  });
}

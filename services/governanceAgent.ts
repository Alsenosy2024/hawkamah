// ===========================================================================
//  Governance Reasoning Agent — a ReAct-style loop:
//    planner → tool registry → reasoning scratchpad → verifier → guardrails.
//  Unlike the one-shot command-parser (proposeModelActions), the agent plans
//  multiple steps, observes results, validates its own edits, and self-corrects
//  before finishing. It operates on a CLONED working model; the caller is
//  responsible for the admin gate, pre-run snapshot, and persistence.
// ===========================================================================

import { Type } from '@google/genai';
import { generateJson } from './agentOrchestrator';
import { retrieve } from './governanceService';
import { proposeModelActions, applyActions } from './governanceActions';
import { analyzeIntegrity } from './governanceValidation';
import { generateGovernanceDoc, generateBulkDoc, editArtifact, type BulkScope } from './governanceEngine';
import { generateMermaid, guardMermaidLabels, sanitizeMermaid } from './diagramService';
import { exportDocx } from './exportService';
import type {
  CompanyGovernanceModel, DocChunk, Language, ReferenceProject, GeneratedArtifact, GovDiagramKind, GovAgentDiagram,
  GovAction, GovAgentStep, GovAgentResult, GovToolCall, GovToolName, IntegrityIssue,
} from '../types';

const DIAGRAM_KINDS: GovDiagramKind[] = ['flowchart', 'swimlane', 'state', 'orgchart', 'raci'];
function pickDiagramKind(hint?: string): GovDiagramKind {
  const h = (hint || '').toLowerCase();
  if (/raci|مسؤول|صلاحي/.test(h)) return 'raci';
  if (/org|هيكل|تنظيم/.test(h)) return 'orgchart';
  if (/swim|مسار|قسم|إدار/.test(h)) return 'swimlane';
  if (/state|حال/.test(h)) return 'state';
  return DIAGRAM_KINDS.includes(h as GovDiagramKind) ? (h as GovDiagramKind) : 'flowchart';
}

export interface AgentCallbacks {
  onStep?: (step: GovAgentStep) => void;     // streamed as each step resolves
  onThought?: (thought: string) => void;     // planner's reasoning for the step
}

// Cross-stage tools — callbacks the host (GovernanceCenter) passes so the agent
// can chain stages in ONE run (e.g. "generate policy → rebuild → validate →
// sync canvas"). They receive the agent's in-run working model and return a
// (possibly reconciled) model / issues — the host owns persistence, the agent
// never touches Firestore directly. All optional; absent → tool reports n/a.
export interface StageTools {
  rebuildModel?: (working: CompanyGovernanceModel, signal?: AbortSignal)
    => Promise<CompanyGovernanceModel | void> | CompanyGovernanceModel | void;
  revalidate?: (working: CompanyGovernanceModel) => IntegrityIssue[] | void;
  syncCanvas?: (working: CompanyGovernanceModel, signal?: AbortSignal)
    => Promise<string | void> | string | void;   // returns a short status (e.g. diagram title)
}

export interface RunAgentParams {
  instruction: string;
  model: CompanyGovernanceModel;
  chunks?: DocChunk[];
  language?: Language;
  sector?: string;                       // industry lens (construction-wise, not IT)
  referenceProjects?: ReferenceProject[]; // prior real projects as a basis
  autoApply?: boolean;            // apply proposed actions without a separate gate (admin-only UI)
  maxSteps?: number;             // guardrail (default 8)
  signal?: AbortSignal;
  crossStageContext?: string;     // summary of other stages (assurance gaps, library refs) for planning
  stageTools?: StageTools;        // host callbacks for cross-stage chaining (rebuild/revalidate/sync_canvas)
}

const TOOLS: GovToolName[] = [
  'read_model', 'query_knowledge', 'propose_actions', 'apply_actions',
  'validate', 'generate_document', 'generate_bulk', 'edit_document', 'export_manual', 'build_diagram',
  'rebuild_model', 'revalidate', 'sync_canvas', 'finish',
];

// Cross-stage tools are only offered to the planner when the host wired them in.
function toolsFor(st?: StageTools): GovToolName[] {
  const cross: GovToolName[] = [];
  if (st?.rebuildModel) cross.push('rebuild_model');
  if (st?.revalidate) cross.push('revalidate');
  if (st?.syncCanvas) cross.push('sync_canvas');
  if (!cross.length) return TOOLS.filter(t => !['rebuild_model', 'revalidate', 'sync_canvas'].includes(t));
  return TOOLS.filter(t => !['rebuild_model', 'revalidate', 'sync_canvas'].includes(t) || cross.includes(t));
}

const BULK_SCOPES: BulkScope[] = ['policies', 'procedures', 'departments', 'authorities', 'kpis'];
function pickBulkScope(hint?: string): BulkScope {
  const h = (hint || '').toLowerCase();
  if (/procedure|إجراء|اجراء/.test(h)) return 'procedures';
  if (/depart|إدار|اقسام|قسم/.test(h)) return 'departments';
  if (/author|صلاحي|تفويض|اعتماد/.test(h)) return 'authorities';
  if (/kpi|مؤشر|قياس|أداء/.test(h)) return 'kpis';
  return BULK_SCOPES.includes(h as BulkScope) ? (h as BulkScope) : 'policies';
}

// HIGH: narrow a bulk run to a domain when the user names one ("سياسات الموارد البشرية"
// only, not ALL policies). Match the hint against each element's name/domain/owner;
// return the matched ids, or undefined to mean "all" (generateBulkDoc's wanted()).
function normAr(s: string): string {
  return (s || '').toLowerCase().replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function pickBulkIds(model: CompanyGovernanceModel, scope: BulkScope, hint?: string): string[] | undefined {
  const h = normAr(hint || '');
  if (!h) return undefined;
  // Drop generic scope words so "كل سياسات HR" doesn't match every policy on "سياسات".
  const generic = new Set(['كل', 'جميع', 'سياسات', 'سياسه', 'اجراءات', 'اجراء', 'ادارات', 'اداره', 'قسم', 'اقسام',
    'صلاحيات', 'صلاحيه', 'مؤشرات', 'مؤشر', 'وثيقه', 'وثائق', 'دليل', 'ولد', 'انشئ', 'policies', 'procedures', 'departments', 'authorities', 'kpis', 'all', 'generate']);
  const terms = h.split(' ').filter(w => w.length >= 3 && !generic.has(w));
  if (!terms.length) return undefined;
  const hay = (...xs: (string | undefined)[]) => normAr(xs.filter(Boolean).join(' '));
  const match = (text: string) => terms.some(tm => text.includes(tm));
  let ids: string[] = [];
  if (scope === 'policies') ids = (model.policies || []).filter(p => match(hay(p.title, p.domain))).map(p => p.id);
  else if (scope === 'procedures') ids = (model.procedures || []).filter(p => match(hay(p.title, p.purpose, model.orgUnits.find(u => u.id === p.unitId)?.name))).map(p => p.id);
  else if (scope === 'authorities') ids = (model.authorities || []).filter(a => match(hay(a.decision, model.roles.find(r => r.id === a.roleId)?.title))).map(a => a.id);
  else if (scope === 'kpis') ids = (model.kpis || []).filter(k => match(hay(k.name, model.orgUnits.find(u => u.id === k.unitId)?.name))).map(k => k.id);
  else ids = (model.orgUnits || []).filter(u => match(hay(u.name, u.mandate))).map(u => u.id);
  // Only narrow if the keyword actually selects a PROPER subset; else generate all.
  return ids.length ? ids : undefined;
}

const plannerSchema = {
  type: Type.OBJECT,
  properties: {
    thought: { type: Type.STRING },                 // reasoning for THIS step
    tool: { type: Type.STRING },                     // one of TOOLS
    query: { type: Type.STRING },                    // for query_knowledge
    instruction: { type: Type.STRING },              // for propose_actions (sub-instruction)
    docType: { type: Type.STRING },                  // for generate_document / export_manual hint
    scope: { type: Type.STRING },                    // for generate_bulk: policies|procedures|departments|authorities|kpis
    finalAnswer: { type: Type.STRING },              // required when tool === 'finish'
  },
  required: ['thought', 'tool'],
};

function modelDigest(m: CompanyGovernanceModel): string {
  return [
    `الشركة: ${m.companyName}`,
    `الوحدات (${(m.orgUnits || []).length}): ${(m.orgUnits || []).map(u => u.name).join('، ') || '—'}`,
    `الأدوار (${(m.roles || []).length}): ${(m.roles || []).map(r => r.title).join('، ') || '—'}`,
    `السياسات (${(m.policies || []).length}): ${(m.policies || []).map(p => `${p.title}[${p.domain}]`).join('، ') || '—'}`,
    `الإجراءات (${(m.procedures || []).length}): ${(m.procedures || []).map(p => p.title).join('، ') || '—'}`,
    `الصلاحيات (${(m.authorities || []).length}): ${(m.authorities || []).map(a => `${a.decision}→${a.level}`).join('، ') || '—'}`,
    `المؤشرات (${(m.kpis || []).length}): ${(m.kpis || []).map(k => k.name).join('، ') || '—'}`,
    `اللجان (${(m.committees || []).length}): ${(m.committees || []).map(c => c.name).join('، ') || '—'}`,
    `الاجتماعات (${(m.meetings || []).length}): ${(m.meetings || []).map(mt => mt.type).join('، ') || '—'}`,
    `الفجوات المفتوحة: ${(m.gaps || []).filter(g => !g.resolved).map(g => g.area).join('، ') || '—'}`,
  ].join('\n');
}

function issuesDigest(issues: IntegrityIssue[]): string {
  if (!issues.length) return 'لا مشاكل سلامة. ✅';
  return issues.slice(0, 12).map(i => `- [${i.severity}] ${i.kind}: ${i.message}`).join('\n');
}

/** Run the reasoning loop. Returns the (possibly mutated) working model + trace. */
export async function runGovernanceAgent(p: RunAgentParams, cb: AgentCallbacks = {}): Promise<GovAgentResult> {
  const ar = (p.language || 'ar') === 'ar';
  const maxSteps = Math.max(2, Math.min(p.maxSteps || 8, 14));
  let working: CompanyGovernanceModel = JSON.parse(JSON.stringify(p.model));
  const appliedActions: GovAction[] = [];
  const steps: GovAgentStep[] = [];
  const scratch: string[] = [];                 // observations history fed back to planner
  let lastProposed: GovAction[] = [];
  let finalAnswer = '';
  const generatedDocuments: GeneratedArtifact[] = [];
  const generatedDiagrams: GovAgentDiagram[] = [];
  const exportedFiles: string[] = [];

  const tools = toolsFor(p.stageTools);                 // cross-stage tools only when the host wired them
  const hasCross = tools.includes('rebuild_model') || tools.includes('revalidate') || tools.includes('sync_canvas');
  const crossDocAr = hasCross
    ? `\n- rebuild_model: أعِد بناء/مصالحة النموذج من المصادر مع دمج تعديلاتك (يُحدِّث النموذج العامل). استخدمه بعد إضافات كبيرة لإعادة الاتساق قبل التحقق.
- revalidate: أعِد فحص السلامة عبر المرحلة (assurance) واعرض الفجوات المتبقية.
- sync_canvas: زامِن الكانفاس/المخطط مع النموذج الحالي ليعكس آخر تعديلاتك.`
    : '';

  const sys = ar
    ? `أنت وكيل حوكمة يفكّر خطوة بخطوة (planner→tool→observation→verify). لديك أدوات: ${tools.join(', ')}.
- read_model: اقرأ ملخص النموذج الحالي.
- query_knowledge: ابحث في وثائق المصدر (مرّر query).
- propose_actions: اقترح تعديلات منظّمة على النموذج (مرّر instruction فرعي دقيق).
- apply_actions: طبّق آخر تعديلات مقترحة على النموذج.
- validate: افحص سلامة النموذج (تشغيل تلقائي بعد كل apply).
- generate_document: ولّد وثيقة حوكمة كاملة فعلية مستندة للنموذج والأدلة (مرّر docType=عنوان الوثيقة، instruction=هدفها). تُنتَج فعلاً وتُتاح في النتيجة.
- generate_bulk: ولّد كتلة وثائق كاملة دفعة واحدة بالتوازي (مرّر scope=policies|procedures|departments|authorities|kpis). استخدمها حين يطلب المستخدم "كل السياسات/الإجراءات/الإدارات/الصلاحيات/المؤشرات" — تُنتج مجموعة وثائق مترابطة فعلية.
- edit_document: عدّل آخر وثيقة مولّدة (مرّر instruction=وصف التعديل المطلوب، docType=عنوان القسم المستهدف اختيارياً). يُعيد كتابة القسم/الأقسام المعنية فقط مع الحفاظ على الباقي — استخدمه حين يطلب المستخدم "عدّل/غيّر/أضف إلى/احذف من" وثيقة قائمة.
- build_diagram: ابنِ مخطّطاً فعلياً (docType=النوع: flowchart/swimlane/state/orgchart/raci، instruction=التركيز). يُنتَج Mermaid صالح فعلاً.
- export_manual: صدّر آخر وثيقة مولّدة كملف Word فعلي.${crossDocAr}
- finish: أنهِ وأعد finalAnswer يلخّص ما تم.
خطّط أدنى عدد خطوات. لا تخترع كيانات. بعد apply راجع نتيجة validate وصحّح إن ظهرت مشاكل حرجة قبل finish.${hasCross ? ' عند سلسلة عبر المراحل (توليد ← بناء ← تحقق) استخدم rebuild_model ثم revalidate ثم sync_canvas بالترتيب.' : ''}`
    : `You are a step-by-step governance agent (planner→tool→observation→verify). Tools: ${tools.join(', ')}. Plan minimal steps, never invent entities, self-correct after validate, then finish with a finalAnswer.${hasCross ? ' For cross-stage chaining (generate → rebuild → validate) use rebuild_model then revalidate then sync_canvas in order.' : ''}`;

  const runStart = Date.now();

  for (let i = 0; i < maxSteps; i++) {
    if (p.signal?.aborted) break;
    const stepStart = Date.now();

    const prompt = [
      `الهدف من المستخدم: "${p.instruction}"`,
      '=== النموذج الحالي ===',
      modelDigest(working),
      p.crossStageContext ? '=== سياق المراحل الأخرى ===\n' + p.crossStageContext : '',
      scratch.length ? '=== سجل الملاحظات (الخطوات السابقة) ===\n' + scratch.join('\n') : '(لا خطوات بعد)',
      `خطّط الخطوة ${i + 1}. أعد JSON: { thought, tool, query?, instruction?, finalAnswer? }. اختر أداة واحدة من: ${tools.join(', ')}.`,
    ].filter(Boolean).join('\n\n');

    // Planner with one retry — a planner failure is SURFACED as an error step
    // (never a silent break), so the user sees exactly why the agent stopped.
    let plan: any = null;
    let planErr = '';
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
      try {
        plan = await generateJson(prompt, plannerSchema, { systemInstruction: sys, signal: p.signal, temperature: 0.2 });
      } catch (e: any) {
        planErr = e?.message || String(e);
        if (p.signal?.aborted) break;
      }
    }
    if (!plan) {
      const msg = ar ? `تعذّر التخطيط للخطوة ${i + 1}: ${planErr}` : `Planning failed at step ${i + 1}: ${planErr}`;
      const errStep: GovAgentStep = {
        index: i, thought: '', status: 'error', observation: msg,
        toolCall: { tool: 'finish', reason: 'planner-error' },
        durationMs: Date.now() - stepStart,
      };
      steps.push(errStep);
      cb.onStep?.(errStep);
      finalAnswer = ar
        ? `توقّف الوكيل عند الخطوة ${i + 1} — ${msg}. ${appliedActions.length ? `طُبّق قبلها ${appliedActions.length} تعديل.` : ''}`
        : `Agent stopped at step ${i + 1} — ${msg}.`;
      break;
    }

    const toolName = (tools.includes(plan.tool) ? plan.tool : 'finish') as GovToolName;
    const toolCall: GovToolCall = { tool: toolName, args: { query: plan.query, instruction: plan.instruction, docType: plan.docType, scope: plan.scope }, reason: plan.thought };
    cb.onThought?.(plan.thought || '');

    const step: GovAgentStep = { index: i, thought: plan.thought || '', toolCall, status: 'acting' };
    let observation = '';

    try {
      switch (toolName) {
        case 'read_model':
          observation = modelDigest(working);
          break;

        case 'query_knowledge': {
          const q = plan.query || p.instruction;
          const rc = p.chunks?.length ? await retrieve(q, p.chunks, 12, p.signal) : [];
          observation = rc.length
            ? rc.map((r, n) => `[مصدر ${n + 1}] ${r.chunk.docName}›${r.chunk.headingPath}: ${r.chunk.text.slice(0, 220)}`).join('\n')
            : 'لا أدلة مسترجعة.';
          break;
        }

        case 'propose_actions': {
          const sub = plan.instruction || p.instruction;
          lastProposed = await proposeModelActions(sub, working, p.language, p.signal);
          observation = lastProposed.length
            ? `اقتُرح ${lastProposed.length} تعديل: ${lastProposed.map(a => `${a.type}(${a.name || a.title || a.decision || a.kind || ''})`).join('، ')}`
            : 'لم يُقترح أي تعديل.';
          break;
        }

        case 'apply_actions': {
          if (!lastProposed.length) { observation = 'لا تعديلات مقترحة للتطبيق — استخدم propose_actions أولاً.'; break; }
          if (p.autoApply === false) { observation = 'التطبيق التلقائي معطّل — التعديلات بانتظار اعتماد المستخدم.'; break; }
          const res = applyActions(working, lastProposed, 'agent');
          working = res.model;
          // Record the actions actually applied (skips are interleaved, so the
          // old positional `lastProposed.slice(0, res.applied)` recorded the wrong
          // ones — e.g. a skipped middle action shown as applied, a real one dropped).
          appliedActions.push(...res.appliedActions);
          // ---- verifier: auto-validate after every apply ----
          const issues = analyzeIntegrity(working);
          const crit = issues.filter(x => x.severity === 'high' || x.severity === 'critical');
          observation = `طُبّق ${res.applied}${res.skipped.length ? `، تُخطّي ${res.skipped.length} (${res.skipped.slice(0, 3).join('؛ ')})` : ''}. فحص السلامة: ${crit.length ? `${crit.length} مشكلة حرجة →\n${issuesDigest(crit)}` : 'سليم ✅'}`;
          lastProposed = [];
          break;
        }

        case 'validate': {
          const issues = analyzeIntegrity(working);
          observation = issuesDigest(issues);
          break;
        }

        case 'generate_document': {
          const title = (plan.docType || plan.instruction || (ar ? 'وثيقة حوكمة' : 'Governance document')).slice(0, 120);
          const goal = plan.instruction || p.instruction;
          const doc = await generateGovernanceDoc({
            docTitle: title, goal, model: working,
            chunks: (p.chunks as DocChunk[]) || [], language: p.language, signal: p.signal,
            sector: p.sector, referenceProjects: p.referenceProjects,
          });
          generatedDocuments.push(doc);
          observation = ar
            ? `✅ وُلِّدت وثيقة فعلية "${doc.title}" (${doc.sections?.length || 0} قسم). متاحة في نتيجة الوكيل للتصدير.`
            : `✅ Generated real document "${doc.title}" (${doc.sections?.length || 0} sections).`;
          break;
        }
        case 'generate_bulk': {
          const scope = pickBulkScope(plan.scope || plan.docType || plan.instruction);
          const ids = pickBulkIds(working, scope, plan.instruction || plan.docType);
          const doc = await generateBulkDoc({
            scope, model: working, chunks: (p.chunks as DocChunk[]) || [],
            language: p.language, signal: p.signal, ids,
            sector: p.sector, referenceProjects: p.referenceProjects,
          });
          generatedDocuments.push(doc);
          const subsetNote = ids ? (ar ? ` (مجموعة فرعية: ${ids.length})` : ` (subset: ${ids.length})`) : '';
          observation = ar
            ? `✅ وُلِّدت كتلة وثائق فعلية "${doc.title}" (${doc.sections?.length || 0} وثيقة/قسم، النطاق: ${scope}${subsetNote}). متاحة في نتيجة الوكيل.`
            : `✅ Generated bulk document set "${doc.title}" (${doc.sections?.length || 0} sections, scope: ${scope}${subsetNote}).`;
          break;
        }
        case 'edit_document': {
          const target = generatedDocuments[generatedDocuments.length - 1];
          if (!target) { observation = ar ? 'لا وثيقة لتعديلها — ولّد وثيقة أولاً عبر generate_document أو generate_bulk.' : 'No document to edit — generate one first.'; break; }
          const edited = await editArtifact({
            artifact: target, instruction: plan.instruction || p.instruction,
            model: working, chunks: (p.chunks as DocChunk[]) || [], language: p.language, signal: p.signal,
            sector: p.sector, referenceProjects: p.referenceProjects,
          });
          generatedDocuments[generatedDocuments.length - 1] = edited;   // replace in place (latest reflects the edit)
          const touched = edited.sections.filter(s => s.status === 'done').length;
          observation = ar
            ? `✅ عُدِّلت الوثيقة "${edited.title}" (حُرِّر ${touched} قسم وفق التعليمات). النسخة المحدّثة متاحة في النتيجة.`
            : `✅ Edited document "${edited.title}" (${touched} section(s) revised).`;
          break;
        }
        case 'build_diagram': {
          const kind = pickDiagramKind(plan.docType || plan.instruction);
          const d = await generateMermaid(working, kind, { language: ar ? 'ar' : 'en', focus: plan.instruction, signal: p.signal });
          const mermaid = guardMermaidLabels(sanitizeMermaid(d.mermaid));
          generatedDiagrams.push({ title: d.title, mermaid, kind });
          observation = ar ? `✅ بُني مخطّط فعلي "${d.title}" (نوع: ${kind}).` : `✅ Built real diagram "${d.title}" (${kind}).`;
          break;
        }
        case 'export_manual': {
          const art = generatedDocuments[generatedDocuments.length - 1];
          if (!art) { observation = ar ? 'لا وثيقة لتصديرها — استخدم generate_document أولاً.' : 'No document to export — call generate_document first.'; break; }
          try {
            await exportDocx(art, { companyName: working.companyName, language: p.language });
            const fname = `${(art.title || 'document').replace(/[\\/:*?"<>|]/g, '_')}.docx`;
            exportedFiles.push(fname);
            observation = ar ? `✅ صُدِّرت "${art.title}" كملف Word (${fname}).` : `✅ Exported "${art.title}" as Word (${fname}).`;
          } catch (ex: any) {
            observation = (ar ? 'تعذّر التصدير في هذا السياق: ' : 'Export failed in this context: ') + (ex?.message || ex);
          }
          break;
        }

        case 'rebuild_model': {
          if (!p.stageTools?.rebuildModel) { observation = ar ? 'إعادة البناء غير متاحة في هذا السياق.' : 'Rebuild not available here.'; break; }
          const before = (working.orgUnits?.length || 0) + (working.roles?.length || 0) + (working.policies?.length || 0) + (working.procedures?.length || 0);
          const next = await p.stageTools.rebuildModel(working, p.signal);
          if (next) working = next;
          const after = (working.orgUnits?.length || 0) + (working.roles?.length || 0) + (working.policies?.length || 0) + (working.procedures?.length || 0);
          observation = ar
            ? `✅ أُعيد بناء النموذج ومصالحته (${before}→${after} كيان جوهري). شغّل revalidate للتأكد.`
            : `✅ Model rebuilt & reconciled (${before}→${after} core entities). Run revalidate next.`;
          break;
        }
        case 'revalidate': {
          const issues = p.stageTools?.revalidate ? (p.stageTools.revalidate(working) || analyzeIntegrity(working)) : analyzeIntegrity(working);
          const crit = issues.filter(x => x.severity === 'high' || x.severity === 'critical');
          observation = (ar ? 'إعادة فحص السلامة عبر المرحلة:\n' : 'Cross-stage re-validation:\n')
            + (crit.length ? `${crit.length} ${ar ? 'مشكلة حرجة' : 'critical'} →\n${issuesDigest(crit)}` : issuesDigest(issues));
          break;
        }
        case 'sync_canvas': {
          if (!p.stageTools?.syncCanvas) { observation = ar ? 'مزامنة الكانفاس غير متاحة في هذا السياق.' : 'Canvas sync not available here.'; break; }
          const title = await p.stageTools.syncCanvas(working, p.signal);
          observation = ar
            ? `✅ تمت مزامنة الكانفاس مع النموذج${title ? ` ("${title}")` : ''}.`
            : `✅ Canvas synced to the model${title ? ` ("${title}")` : ''}.`;
          break;
        }

        case 'finish':
          finalAnswer = plan.finalAnswer || (ar ? 'اكتملت المهمة.' : 'Task complete.');
          observation = finalAnswer;
          break;
      }
      step.status = 'done';
    } catch (e: any) {
      step.status = 'error';
      observation = `خطأ: ${e?.message || e}`;
    }

    step.observation = observation;
    step.durationMs = Date.now() - stepStart;
    steps.push(step);
    cb.onStep?.(step);
    // Planner context keeps thought + a longer observation window (the FULL
    // observation lives untruncated on the step itself / in traceMarkdown).
    scratch.push(`خطوة ${i + 1}: [${toolName}] ${plan.thought ? `فكرة: ${String(plan.thought).slice(0, 160)} → ` : ''}${observation.slice(0, 600)}`);

    if (toolName === 'finish') break;
  }

  if (!finalAnswer) {
    finalAnswer = appliedActions.length
      ? (ar ? `طُبّق ${appliedActions.length} تعديل على النموذج.` : `Applied ${appliedActions.length} change(s).`)
      : (ar ? 'لم تُطبَّق تعديلات.' : 'No changes applied.');
  }

  const integrityAfter = analyzeIntegrity(working);
  // GAP4: when autoApply is off and the agent proposed actions it could not apply,
  // surface them so the caller can route to the user-approval gate.
  const pendingActions = (p.autoApply === false && lastProposed.length) ? lastProposed : undefined;
  const totalDurationMs = Date.now() - runStart;
  const traceMarkdown = buildTraceMarkdown(p.instruction, steps, finalAnswer, appliedActions, integrityAfter, totalDurationMs, ar);
  return {
    steps, finalAnswer, appliedActions, model: working, integrityAfter,
    generatedDocuments, generatedDiagrams, exportedFiles, pendingActions,
    traceMarkdown, totalDurationMs,
  };
}

// Full audit-grade run trace: every thought, tool, args, UNTRUNCATED observation
// and per-step duration — exportable as Word/PDF from the copilot.
function buildTraceMarkdown(
  instruction: string, steps: GovAgentStep[], finalAnswer: string,
  applied: GovAction[], integrity: IntegrityIssue[], totalMs: number, ar: boolean,
): string {
  const sec = (ms?: number) => ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`;
  const lines: string[] = [
    ar ? `# أثر تنفيذ وكيل الحوكمة` : `# Governance Agent Run Trace`,
    ar ? `**الهدف:** ${instruction}` : `**Goal:** ${instruction}`,
    ar ? `**عدد الخطوات:** ${steps.length} · **الزمن الكلي:** ${sec(totalMs)}` : `**Steps:** ${steps.length} · **Total:** ${sec(totalMs)}`,
  ];
  for (const s of steps) {
    const status = s.status === 'error' ? '⚠️' : '✅';
    lines.push(`## ${ar ? 'خطوة' : 'Step'} ${s.index + 1} — ${s.toolCall?.tool || '?'} ${status} (${sec(s.durationMs)})`);
    if (s.thought) lines.push(`**${ar ? 'التفكير' : 'Thought'}:** ${s.thought}`);
    const args = s.toolCall?.args && Object.entries(s.toolCall.args).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' · ');
    if (args) lines.push(`**${ar ? 'المعطيات' : 'Args'}:** ${args}`);
    if (s.observation) lines.push(`**${ar ? 'النتيجة' : 'Observation'}:**\n\n${s.observation}`);
  }
  lines.push(`## ${ar ? 'الخلاصة' : 'Final answer'}`);
  lines.push(finalAnswer || '—');
  if (applied.length) {
    lines.push(`## ${ar ? 'التعديلات المطبّقة' : 'Applied actions'} (${applied.length})`);
    lines.push(applied.map(a => `- ${a.type}: ${a.title || a.name || a.decision || a.kind || ''}`).join('\n'));
  }
  const crit = integrity.filter(x => x.severity === 'high' || x.severity === 'critical');
  lines.push(`## ${ar ? 'فحص السلامة النهائي' : 'Final integrity'}`);
  lines.push(crit.length ? issuesDigest(crit) : (ar ? 'سليم ✅' : 'Clean ✅'));
  return lines.join('\n\n');
}

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Type } from '@google/genai';
import { db, auth } from '../firebase';
import { doc, setDoc, deleteDoc } from 'firebase/firestore';
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import type {
  Language, OrganizationDocument, AdminSettings, CompanyGovernanceModel,
  GovProgress, ArtifactSection, ThinkingStep, ReferenceProject, ProvenanceRef,
  GovDiagram, GovDiagramKind, GovGap, GovDocumentRecord, GovModelSnapshot,
  IntegrityIssue, MaturityReport, CoverageRow, FrameworkAlignment, GovAction,
  TraceChain, GovAgentStep, DocChunk, GeneratedArtifact,
} from '../types';
import { ingestDocument, summarizeSentiment } from '../services/ingestionService';
import { extractFileText } from '../services/fileExtraction';
import { buildAggregatedContext } from '../services/assessmentAggregatorService';
import {
  extractReferenceProjects, draftToReferenceProject, artifactKindLabel,
  type ReferenceDraft, type BatchProgress,
} from '../services/referenceProjectExtraction';
import {
  saveChunks, saveNodes, loadChunks, loadModel, saveModel, invalidateChunkCache,
  loadReferenceProjects, saveReferenceProject, deleteReferenceProject, seedStandardsLibrary, deleteDocChunks,
  saveDiagram, loadDiagrams, deleteDiagram,
  saveGovDocument, loadGovDocuments, deleteGovDocument,
  saveSnapshot, loadSnapshots, deleteSnapshot,
} from '../services/governanceService';
import {
  buildModel, generateGovernanceDoc, generateBulkDoc, generateGapFix, editArtifact,
  industryLens, referenceProjectsBlock,
  GovernanceDocument, type BulkScope,
} from '../services/governanceEngine';
import { generateMermaid, mermaidToFlow, modelToFlow, diagramsToImages, autoLayout } from '../services/diagramService';
import { exportDocx, exportPdfViaPrint, exportPdfDirect, exportGovernanceManual, exportWorkflowManual, exportJobDescriptions, exportPoliciesManual, exportArtifactsBatch, exportArtifactsZip, type BatchFormat, type BatchMode } from '../services/exportService';
import { generateJson } from '../services/agentOrchestrator';
import { GOV_DOC_CATALOG, CATALOG_CATEGORIES, recommendDocuments, type DocCatalogEntry } from '../services/governanceDocCatalog';
import { analyzeIntegrity, maturity as computeMaturity, coverageMatrix, mergeModels, traceEntity } from '../services/governanceValidation';
import { alignAll, standardsLens } from '../services/governanceFrameworks';
import { proposeModelActions, applyActions, appendAudit } from '../services/governanceActions';
import { buildCharter, buildRiskRegister, buildRoadmap } from '../services/governanceArtifacts';
import { runGovernanceAgent } from '../services/governanceAgent';
import { askGovernance } from '../services/governanceQa';
import Markdown from './Markdown';
import ThinkingTrace from './ThinkingTrace';
import ArtifactProgress from './ArtifactProgress';
import MermaidView from './MermaidView';
import SwimlaneView from './SwimlaneView';
import { generateSwimlane } from '../services/swimlaneService';
import GovernanceCanvas from './GovernanceCanvas';
import GovCopilot from './GovCopilot';
import ProjectsStage from './ProjectsStage';
import DepartmentBuilder from './DepartmentBuilder';
import type { GovStageKey } from '../services/governanceChat';
import { useToast } from './ToastProvider';
import { UI } from '../services/designTokens';
import { MODELS } from '../constants/models';

type DocCategory = OrganizationDocument['category'];

interface Props {
  documents: OrganizationDocument[];
  settings: AdminSettings;
  language: Language;
  onBack: () => void;
  onAddDocument: (doc: Omit<OrganizationDocument, 'id' | 'uploadedAt' | 'uploadedByEmail' | 'uploadedByName'>) => void | Promise<void> | Promise<OrganizationDocument>;
  onDeleteDocument: (id: string) => void | Promise<void>;
  onUpdateSettings: (s: AdminSettings) => void | Promise<void>;
  /** مخرجات الاستبيانات والتقييمات — مصدر بيانات داخل مركز الحوكمة. */
  allAssessments?: any[];
}

let _idc = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(_idc++).toString(36)}`;
const ADMIN_ACTOR = 'ahmed0ibrahim@gmail.com';

const CAT_LABEL = (c: DocCategory, ar: boolean): string => ({
  identity: ar ? 'الهوية' : 'Identity',
  current_state: ar ? 'الوضع الحالي' : 'Current state',
  general: ar ? 'عام' : 'General',
  infrastructure: ar ? 'البنية' : 'Infrastructure',
}[c] || c);

const SEV_COLOR: Record<string, string> = {
  low: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  high: 'bg-orange-50 text-orange-700 border-orange-200',
  critical: 'bg-rose-50 text-rose-700 border-rose-200',
};

const DIAG_KINDS: { kind: GovDiagramKind; ar: string; en: string; icon: string }[] = [
  { kind: 'flowchart', ar: 'تدفق الإجراءات', en: 'Procedure flow', icon: '🔀' },
  { kind: 'swimlane', ar: 'مسارات المسؤوليات', en: 'Responsibility lanes', icon: '🏊' },
  { kind: 'state', ar: 'مخطط الحالات', en: 'State diagram', icon: '🔄' },
  { kind: 'orgchart', ar: 'الهيكل التنظيمي', en: 'Org chart', icon: '🏢' },
  { kind: 'raci', ar: 'مصفوفة RACI', en: 'RACI matrix', icon: '🧮' },
];

const LEVEL_AR: Record<string, string> = {
  recommend: 'يوصي (C)', approve: 'يعتمد (A)', execute: 'ينفّذ (R)', inform: 'يُبلَّغ (I)',
};
const STATUS_AR: Record<string, string> = { draft: 'مسودة', in_review: 'قيد المراجعة', approved: 'معتمد' };

// Library folders: doc kind → {emoji, ar, en}. Unknown kinds fall back to a generic folder.
const KIND_FOLDER: Record<string, { icon: string; ar: string; en: string }> = {
  governance:  { icon: '📘', ar: 'أدلة الحوكمة', en: 'Governance manuals' },
  policy:      { icon: '📋', ar: 'السياسات', en: 'Policies' },
  procedure:   { icon: '🔧', ar: 'الإجراءات', en: 'Procedures' },
  workflow:    { icon: '🔁', ar: 'سلاسل العمليات', en: 'Workflows' },
  orgchart:    { icon: '🏢', ar: 'الهياكل التنظيمية', en: 'Org structures' },
  jobdesc:     { icon: '🧰', ar: 'الوصف الوظيفي', en: 'Job descriptions' },
  gapfix:      { icon: '🩹', ar: 'معالجات الفجوات', en: 'Gap fixes' },
  charter:     { icon: '📜', ar: 'المواثيق', en: 'Charters' },
};
const folderFor = (kind: string) => KIND_FOLDER[kind] || { icon: '📁', ar: kind || 'أخرى', en: kind || 'Other' };

const GovernanceCenter: React.FC<Props> = ({ documents, settings, language, onBack, onAddDocument, onDeleteDocument, onUpdateSettings, allAssessments = [] }) => {
  const ar = language === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);
  const toast = useToast();
  // Unified toast: routes legacy alertMsg() messages to the shared toast system,
  // variant inferred from content (failures/prerequisites → error, else success).
  const alertMsg = (msg: string) => {
    if (!msg) return;
    if (/فشل|failed|error|لا توجد|أولاً|first|مطلوب|required/i.test(msg)) toast.error(msg);
    else toast.success(msg);
  };

  const activeClient = settings.clientProfiles?.find(c => c.id === settings.activeClientProfileId);
  const tenantId = settings.activeClientProfileId || 'default';
  const companyName = activeClient?.name || settings.companyName || 'الشركة';
  const sector = activeClient?.industry;

  // W7: owner-defined 6-stage flow (المدخلات → الواقع الراهن → الهيكل التنظيمي → البناء →
  // التحقق → المكتبة). `id` is DECOUPLED from array position so every existing stage
  // body (stage===N) needs no renumbering. النموذج (id 1) and الإدارات (id 5) keep their
  // bodies but are reached as detail views via in-stage buttons, not top-level pills.
  const STAGES = [
    { id: 0, ar: 'المدخلات', en: 'Inputs', icon: '📥' },
    { id: 6, ar: 'الواقع الراهن', en: 'Current state', icon: '📊' },
    { id: 7, ar: 'الهيكل التنظيمي', en: 'Org structure', icon: '🏢' },
    { id: 2, ar: 'البناء', en: 'Build', icon: '🏗️' },
    { id: 3, ar: 'التحقق', en: 'Assurance', icon: '✅' },
    { id: 4, ar: 'المكتبة', en: 'Library', icon: '📚' },
  ];
  const [stage, setStage] = useState(0);
  const [buildTab, setBuildTab] = useState<'diagrams' | 'docs'>('diagrams');
  const [libTab, setLibTab] = useState<'docs' | 'refs' | 'history'>('docs');
  const [docMode, setDocMode] = useState<'batch' | 'custom' | 'bulk'>('batch');
  // Project-first gate: until a project (company) is selected, force the Projects view.
  const projectSelected = !!settings.activeClientProfileId;
  // P1-1: always open on the Projects view first (project = root context). The user
  // confirms/opens a project explicitly before moving into Sources.
  const [showProjects, setShowProjects] = useState(true);
  // If the active project is cleared (e.g. deleted), bounce back to the Projects view.
  useEffect(() => { if (!projectSelected) setShowProjects(true); }, [projectSelected]);
  // A1: reset stage + show projects view when tenant changes (prevents stale UI from prev project)
  useEffect(() => { setStage(0); setShowProjects(true); }, [tenantId]);
  const gotoStage = (s: number) => { setShowProjects(false); setStage(s); };

  const [model, setModel] = useState<CompanyGovernanceModel | null>(null);
  const [chunkCount, setChunkCount] = useState<number>(0);
  const [ingestedChunks, setIngestedChunks] = useState<DocChunk[]>([]); // for sources list display
  // P0-1: persistent authorization/data-failure banner. Set true whenever a Firestore
  // read/write in this center is rejected (permission-denied) or indexing silently saves
  // 0 chunks — stops the UI from implying everything is fine when the data layer failed.
  const [permissionError, setPermissionError] = useState(false);
  const [sentimentAvg, setSentimentAvg] = useState<number | undefined>(undefined); // ج4 — doc tone → maturity
  const [refProjects, setRefProjects] = useState<ReferenceProject[]>([]);
  const [busy, setBusy] = useState<string>('');
  const [progress, setProgress] = useState<GovProgress | null>(null);
  // ZIP download ready state — set after generation completes; user clicks to trigger
  // the actual download (fresh user gesture bypasses Edge gesture-expiry block).
  const [zipReady, setZipReady] = useState<{ url: string; fileName: string; count: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // generation state
  const [docTitle, setDocTitle] = useState('دليل الحوكمة والهيكل المؤسسي');
  const [docGoal, setDocGoal] = useState('وثيقة شاملة للهيكل التنظيمي والسياسات والإجراءات ومصفوفة الصلاحيات والفجوات وخطة التنفيذ.');
  const [genSections, setGenSections] = useState<ArtifactSection[]>([]);
  const [genProgress, setGenProgress] = useState<any>(null);
  const [thoughts, setThoughts] = useState<ThinkingStep[]>([]);
  const [genDoc, setGenDoc] = useState<GovernanceDocument | null>(null);
  const [generating, setGenerating] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [revising, setRevising] = useState(false);
  // W7 — الواقع الراهن: feedback canvas text + the most-recent diagnostic (kept locally
  // so the just-generated report shows immediately without re-fetching `allAssessments`).
  const [diagFeedback, setDiagFeedback] = useState('');
  const [localDiagnostic, setLocalDiagnostic] = useState<any>(null);
  // N6 — interactive current-state: owner picks length + depth + which axes before generating.
  const DIAG_AXES = ['القيادة والحوكمة', 'الاستراتيجية', 'الموارد البشرية والكفاءات', 'العمليات والإجراءات', 'إدارة المخاطر والامتثال', 'الأداء والمؤشرات', 'التحول الرقمي', 'ثقافة المنظمة'];
  const [diagPages, setDiagPages] = useState<'concise' | 'standard' | 'detailed' | 'comprehensive'>('standard');
  const [diagDepth, setDiagDepth] = useState<'executive' | 'analytical' | 'deep'>('analytical');
  const [diagAxes, setDiagAxes] = useState<string[]>(DIAG_AXES.slice(0, 6));
  const [diagOptsOpen, setDiagOptsOpen] = useState(false);

  // CRITICAL #4: bulk gen / fix loops fire onSection+onThought dozens of times across
  // 50+ docs. Raw setState per call = render storm (jank, dropped frames, frozen stop
  // button). Coalesce into ref buffers flushed on a 120ms timer; cap thoughts at 200.
  const sectionsBuf = useRef<ArtifactSection[] | null>(null);
  const thoughtsBuf = useRef<ThinkingStep[]>([]);
  const flushTimer = useRef<any>(null);
  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      if (sectionsBuf.current) { setGenSections(sectionsBuf.current); sectionsBuf.current = null; }
      if (thoughtsBuf.current.length) {
        const add = thoughtsBuf.current; thoughtsBuf.current = [];
        setThoughts(prev => { const n = [...prev, ...add]; return n.length > 200 ? n.slice(n.length - 200) : n; });
      }
    }, 120);
  }, []);
  const pushSection = useCallback((s: ArtifactSection[]) => { sectionsBuf.current = [...s]; scheduleFlush(); }, [scheduleFlush]);
  const pushThought = useCallback((txt: string) => { thoughtsBuf.current.push({ id: uid('th'), text: txt }); scheduleFlush(); }, [scheduleFlush]);
  const resetGenBuffers = useCallback(() => {
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    sectionsBuf.current = null; thoughtsBuf.current = [];
  }, []);
  useEffect(() => () => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    abortRef.current?.abort(); // abort any in-flight gen/build on unmount
  }, []);

  // diagram state
  const [diagrams, setDiagrams] = useState<GovDiagram[]>([]);
  const [activeDiag, setActiveDiag] = useState<GovDiagram | null>(null);
  const [diagBusy, setDiagBusy] = useState<GovDiagramKind | null>(null);
  const [canvasMode, setCanvasMode] = useState(false);
  const [savingCanvas, setSavingCanvas] = useState(false);

  // reference project form
  const [showRefForm, setShowRefForm] = useState(false);
  const [rp, setRp] = useState({ name: '', sector: '', summary: '', content: '', tags: '' });
  // batch reference-library ingest (م4)
  const [refDrafts, setRefDrafts] = useState<ReferenceDraft[]>([]);
  const [refBatchBusy, setRefBatchBusy] = useState(false);
  const [refBatchProg, setRefBatchProg] = useState<BatchProgress | null>(null);
  const refBatchInputRef = useRef<HTMLInputElement>(null);
  const [seedBusy, setSeedBusy] = useState<string>('');

  // Pre-seed the institutional standards map (ISO + frameworks + regulations) into
  // the reference library so the build/generation always has standards to pull from.
  const handleSeedStandards = async () => {
    setSeedBusy(t('تحميل المعايير…', 'Seeding standards…'));
    try {
      const { added, total } = await seedStandardsLibrary(
        (cur, tot, name) => setSeedBusy(t(`تحميل المعايير ${cur}/${tot}: ${name}`, `Seeding ${cur}/${tot}: ${name}`)),
      );
      await loadAll();
      alertMsg(added > 0
        ? t(`أُضيفت ${added} حزمة معايير للمكتبة (إجمالي ${total}). أصبحت متاحة للبناء والتوليد.`,
            `Added ${added} standards packs to the library (of ${total}). Now available to build & generation.`)
        : t(`المعايير محمّلة بالفعل (${total} حزمة).`, `Standards already seeded (${total} packs).`));
    } catch (e: any) {
      alertMsg(t('فشل تحميل المعايير: ', 'Seeding standards failed: ') + (e?.message || e));
    } finally { setSeedBusy(''); }
  };

  // ---- Written assessment upload (non-digital paper/image/PDF → AI analysis) ----
  const handleUploadWrittenAssessment = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadingWrittenAssess(true);
    let saved = 0;
    const schema = {
      type: Type.OBJECT,
      properties: {
        employeeName: { type: Type.STRING },
        jobTitle: { type: Type.STRING },
        totalScore: { type: Type.NUMBER },
        strengths: { type: Type.STRING },
        weaknesses: { type: Type.STRING },
        recommendations: { type: Type.STRING },
        competencyScores: {
          type: Type.ARRAY,
          items: { type: Type.OBJECT, properties: { competency: { type: Type.STRING }, score: { type: Type.NUMBER } }, required: ['competency', 'score'] },
        },
      },
      required: ['totalScore', 'strengths', 'weaknesses'],
    };
    for (const file of Array.from(files)) {
      try {
        const extracted = await extractFileText(file);
        const content = (extracted.text || '').trim();
        if (!content) { toast.error(t(`تعذّر قراءة ${file.name}`, `Could not read ${file.name}`)); continue; }
        const prompt = `أنت محلّل تقييمات موارد بشرية. حلّل هذا التقييم الورقي المُرفَق وعالج محتواه فقط — ممنوع اختراع أي معلومة.
استخرج:
- اسم الموظف (employeeName) — إن وُجد في المحتوى
- المسمى الوظيفي (jobTitle) — إن وُجد
- الدرجة الإجمالية (totalScore) كرقم 0-100 مستنتج من الدرجات الفعلية
- نقاط القوة (strengths) — نصاً وصفياً من التقييم
- نقاط الضعف (weaknesses) — نصاً وصفياً من التقييم
- التوصيات (recommendations) — نصاً وصفياً
- درجات الكفاءات (competencyScores) — مصفوفة {competency, score} إن ذُكرت أبعاد بدرجات

=== محتوى التقييم (${file.name}) ===
${content.slice(0, 8000)}`;
        const result = await generateJson<any>(prompt, schema as any, { temperature: 0.1 });
        if (!result) continue;
        const clamp = (n: any) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
        const assessId = String(uid('wasmt'));
        const rec = {
          id: assessId, userId: 'written_assessment',
          userName: result.employeeName || file.name.replace(/\.[^.]+$/, ''),
          userEmail: '', jobTitle: result.jobTitle || companyName,
          numQuestions: 0, assessmentType: 'survey',
          timestamp: new Date().toISOString(), responses: [], workplaceAnswers: null,
          sourceType: 'written_paper', sourceFile: file.name,
          reportData: {
            totalScore: clamp(result.totalScore),
            technicalScore: clamp(result.totalScore), behavioralScore: clamp(result.totalScore),
            strengths: result.strengths || '', weaknesses: result.weaknesses || '',
            recommendations: result.recommendations || '',
            sources: [file.name],
            competencyScores: Array.isArray(result.competencyScores)
              ? result.competencyScores.map((c: any) => ({ competency: String(c.competency || ''), score: clamp(c.score) })).filter((c: any) => c.competency)
              : [],
            gapReport: { competencyGaps: [], overallGapSummary: '', developmentPlan: '' },
            jobFitRatings: [],
          },
        };
        await setDoc(doc(db, 'assessments', assessId), rec);
        saved++;
      } catch (e: any) {
        console.error('written assessment upload failed:', e);
        toast.error(t(`فشل تحليل ${file.name}: `, `Failed to analyze ${file.name}: `) + (e?.message || e));
      }
    }
    if (saved > 0) { await loadAll(); toast.success(t(`✅ تم تحليل وحفظ ${saved} تقييم ورقي.`, `✅ ${saved} written assessment(s) analyzed and saved.`)); }
    setUploadingWrittenAssess(false);
    if (writtenAssessInputRef.current) writtenAssessInputRef.current.value = '';
  };

  // file upload (stage 0)
  const fileRef = useRef<HTMLInputElement>(null);
  // whole-folder picker — webkitdirectory set imperatively (not a typed React prop).
  const folderRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = folderRef.current;
    if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', ''); }
  }, []);
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState<{ name: string; content: string; category: DocCategory; size: string; type: string } | null>(null);
  const [pasteName, setPasteName] = useState('');
  const [pasteContent, setPasteContent] = useState('');
  const [pasteCat, setPasteCat] = useState<DocCategory>('current_state');
  // مخرجات الاستبيانات والتقييمات كمصدر بيانات (stage 0) — تُحقن في بناء النموذج.
  const [injectAssessments, setInjectAssessments] = useState(true);
  // written assessment upload (image/PDF of non-digital paper assessments)
  const writtenAssessInputRef = useRef<HTMLInputElement>(null);
  const [uploadingWrittenAssess, setUploadingWrittenAssess] = useState(false);
  // library sub-tab: split standards vs reference projects
  const [libRefTab, setLibRefTab] = useState<'standards' | 'projects'>('projects');
  // FIX A — تعليمات/برومبت مخصّص يحقنه المالك قبل بناء الهيكل (stage 7).
  const [buildInstructions, setBuildInstructions] = useState('');

  // bulk generation (stage 3)
  const [bulkScope, setBulkScope] = useState<BulkScope>('procedures');

  // model-bound canvas (stage 2 — direct from model)
  const [modelCanvas, setModelCanvas] = useState(false);
  const [modelCanvasNodes, setModelCanvasNodes] = useState<any[]>([]);
  const [modelCanvasEdges, setModelCanvasEdges] = useState<any[]>([]);

  // rebuild merge toggle (#9)
  const [mergeOnRebuild, setMergeOnRebuild] = useState(true);
  const [snapshots, setSnapshots] = useState<GovModelSnapshot[]>([]);

  // sources exclusion + view toggle
  const [excludedDocIds, setExcludedDocIds] = useState<Set<string>>(new Set());
  const [srcView, setSrcView] = useState<'list' | 'map'>('list');

  // gov_documents library (#3/#4/#14)
  const [govDocs, setGovDocs] = useState<GovDocumentRecord[]>([]);
  const [genDocKind, setGenDocKind] = useState<GovDocumentRecord['kind']>('governance');

  // creation checklist (multi-select doc kinds + per-item page counts) — covers full catalog
  const [createSel, setCreateSel] = useState<Record<string, { on: boolean; pages: number }>>(() => {
    const init: Record<string, { on: boolean; pages: number }> = {};
    for (const d of GOV_DOC_CATALOG) {
      init[d.key] = { on: d.priority === 'critical', pages: d.defaultPages };
    }
    return init;
  });
  const [catFilter, setCatFilter] = useState<string>('');
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchLog, setBatchLog] = useState<string[]>([]);

  // assurance (#5/#7/#13) — derived, memoized
  const [trace, setTrace] = useState<TraceChain | null>(null);

  // gap→fix (#6)
  const [fixingGap, setFixingGap] = useState<string | null>(null);

  // agentic actions (#10)
  const [actionInput, setActionInput] = useState('');
  const [proposedActions, setProposedActions] = useState<GovAction[]>([]);
  const [proposing, setProposing] = useState(false);

  // reasoning agent loop (Track C)
  const [agentInput, setAgentInput] = useState('');
  const [agentSteps, setAgentSteps] = useState<GovAgentStep[]>([]);
  const [agentAnswer, setAgentAnswer] = useState('');
  const [agentTrace, setAgentTrace] = useState('');
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentAutoApply, setAgentAutoApply] = useState(true);

  // Q&A (#11)
  const [qaQuestion, setQaQuestion] = useState('');
  const [qaAnswer, setQaAnswer] = useState('');
  const [qaSources, setQaSources] = useState<ProvenanceRef[]>([]);
  const [qaBusy, setQaBusy] = useState(false);

  // ── مخرجات الاستبيانات والتقييمات كمصدر بيانات ─────────────────────────
  // التقييمات ذات التقرير، الاستبيانات الخاصة بهذا المشروع أولاً.
  const projectAssessments = (allAssessments || []).filter((a: any) => a && a.reportData);
  const surveyAssessments = projectAssessments.filter((a: any) =>
    a.assessmentType === 'survey' && (a.jobTitle === companyName || a.jobTitle === activeClient?.name));
  const assessmentsForSource = [
    ...surveyAssessments,
    ...projectAssessments.filter((a: any) => !surveyAssessments.includes(a)),
  ];
  // م4 — feed buildModel an aggregated, statistically meaningful digest across ALL
  // assessments (scales past a handful, no first-record bias), then append a few raw
  // exemplars for qualitative color.
  const buildAssessmentContext = (): string => {
    const aggregate = buildAggregatedContext(assessmentsForSource);
    const exemplars = assessmentsForSource.slice(0, 5).map((a: any) => {
      const r = a.reportData || {};
      const comps = (r.competencyScores || []).map((c: any) => `${c.competency}:${c.score}%`).join('، ');
      const gaps = (r.gapReport?.competencyGaps || []).map((g: any) => `${g.skill} (مطلوب ${g.required}/فعلي ${g.actual})`).join('، ');
      return `• ${a.userName || a.jobTitle} [${a.assessmentType}] الدرجة ${r.totalScore ?? '—'}%\n  قوة: ${r.strengths || ''}\n  ضعف: ${r.weaknesses || ''}\n  توصيات: ${r.recommendations || ''}${comps ? `\n  كفاءات: ${comps}` : ''}${gaps ? `\n  فجوات: ${gaps}` : ''}`;
    }).join('\n\n');

    // extract verbal interview transcripts (raw speech) — these carry richer qualitative
    // evidence than the statistical summary alone; inject up to 5 transcripts, 2000 chars each.
    const verbalAssessments = assessmentsForSource.filter((a: any) =>
      a.assessmentType === 'verbal' &&
      Array.isArray(a.responses) && a.responses.length > 0 &&
      typeof a.responses[0]?.selectedAnswer === 'string' &&
      a.responses[0].selectedAnswer.trim().length > 30
    );
    const transcriptBlock = verbalAssessments.slice(0, 5).map((a: any) => {
      const raw = (a.responses[0]?.selectedAnswer || '').trim().slice(0, 2000);
      return `مقابلة: ${a.userName || a.jobTitle} — ${new Date(a.timestamp || 0).toLocaleDateString('ar')}\n${raw}`;
    }).join('\n\n---\n\n');

    return [
      aggregate && `— ملخص مجمّع —\n${aggregate}`,
      exemplars && `— نماذج فردية —\n${exemplars}`,
      transcriptBlock && `— مقابلات صوتية مُفرَّغة (نصوص حرفية) —\n${transcriptBlock}`,
    ].filter(Boolean).join('\n\n');
  };

  // N1 — representative digest of the REAL uploaded chunks (round-robin per document,
  // same sampling spirit as buildModel) so the current-state report is grounded in the
  // company's actual documents, not the company name. Returns { digest, docNames }.
  const buildChunkDigest = (chunks: any[], maxChars = 14000): { digest: string; docNames: string[] } => {
    if (!chunks?.length) return { digest: '', docNames: [] };
    const byDoc = new Map<string, any[]>();
    for (const c of chunks) {
      const k = c.docName || c.docId || '—';
      (byDoc.get(k) || byDoc.set(k, []).get(k)!).push(c);
    }
    const docNames = Array.from(byDoc.keys());
    const queues = Array.from(byDoc.values()).map(arr =>
      [...arr].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)));
    const lines: string[] = [];
    let used = 0, idx = 0, drained = 0;
    while (drained < queues.length && used < maxChars) {
      const q = queues[idx % queues.length];
      idx++;
      if (!q.length) { drained++; continue; }
      drained = 0;
      const c = q.shift();
      const head = c.headingPath ? `[${c.docName} › ${c.headingPath}]` : `[${c.docName}]`;
      const body = (c.text || '').slice(0, 700);
      const piece = `${head}\n${body}`;
      if (used + piece.length > maxChars) break;
      lines.push(piece); used += piece.length;
    }
    return { digest: lines.join('\n\n'), docNames };
  };

  // P0-1: explicit error classifier — replaces alertMsg's keyword guessing, which routed
  // FirebaseError "Missing or insufficient permissions" (matches no keyword) to a GREEN
  // success toast. permission-denied surfaces with .code intact from governanceService.
  const isPermissionErr = (e: any): boolean => {
    const code = e?.code || e?.cause?.code;
    if (code === 'permission-denied' || code === 'unauthenticated') return true;
    const msg = (e?.message || String(e || '')).toLowerCase();
    return /permission-denied|insufficient permissions|missing or insufficient|unauthenticated/.test(msg);
  };
  // Always-red surfacing for any governance data failure. Never silent, never green.
  // In dev mode: permission errors are expected (no Firebase auth) — log only, no banner.
  const surfaceError = (e: any, fallback: string) => {
    if (isPermissionErr(e)) {
      if (!import.meta.env.DEV) {
        setPermissionError(true);
        toast.error(t('أنت غير مخوّل لحفظ/تحميل بيانات الحوكمة. سجّل الدخول بحساب أدمن معتمد.',
                      'You are not authorized to save/load governance data. Sign in with an approved admin account.'));
      }
    } else {
      toast.error(fallback + (e?.message || e));
    }
  };

  // Returns the loaded chunk count (>=0) on success, or -1 if the load failed (surfaced).
  const loadAll = useCallback(async (): Promise<number> => {
    try {
      const [m, ch, rps, dgs, gds, snaps] = await Promise.all([
        loadModel(tenantId), loadChunks(tenantId), loadReferenceProjects(), loadDiagrams(tenantId),
        loadGovDocuments(tenantId), loadSnapshots(tenantId),
      ]);
      setModel(m); setChunkCount(ch.length); setIngestedChunks(ch); setRefProjects(rps); setDiagrams(dgs);
      setGovDocs(gds); setSnapshots(snaps);
      setSentimentAvg(ch.length ? summarizeSentiment(ch).score : undefined); // ج4
      setPermissionError(false); // load succeeded — clear any stale banner
      return ch.length;
    } catch (e) {
      console.warn('gov load failed', e);
      surfaceError(e, t('فشل تحميل بيانات الحوكمة: ', 'Failed to load governance data: '));
      return -1;
    }
  }, [tenantId]);

  // ---- derived assurance (#5/#7) ----
  const integrity = useMemo<IntegrityIssue[]>(() => model ? analyzeIntegrity(model) : [], [model]);
  const maturityReport = useMemo<MaturityReport | null>(() => model ? computeMaturity(model, integrity, sentimentAvg) : null, [model, integrity, sentimentAvg]);
  const coverage = useMemo<CoverageRow[]>(() => model ? coverageMatrix(model) : [], [model]);
  const alignment = useMemo<FrameworkAlignment[]>(() => model ? alignAll(model) : [], [model]);

  // ---- N5: governance-process artifacts (charter / risk register / roadmap) + model-level sign-off ----
  const [charterArt, setCharterArt] = useState<GeneratedArtifact | null>(null);
  const riskArt = useMemo<GeneratedArtifact | null>(() => model ? buildRiskRegister(model) : null, [model]);
  const roadmapArt = useMemo<GeneratedArtifact | null>(() => model ? buildRoadmap(model) : null, [model]);
  // model approved iff the last governance-affecting audit action is an 'approve_model'.
  const modelApproved = useMemo<boolean>(() => {
    const log = model?.auditLog || [];
    let lastApprove = -1, lastChange = -1;
    log.forEach((e, i) => {
      if (e.action === 'approve_model') lastApprove = i;
      else if (/rebuild|rollback|agent|gapfix|apply/i.test(e.action)) lastChange = i;
    });
    return lastApprove > lastChange && lastApprove !== -1;
  }, [model]);

  const exportArt = async (art: GeneratedArtifact, fmt: 'docx' | 'pdf') => {
    setBusy(t('تجهيز التصدير', 'Preparing export'));
    try {
      const opts = { language, companyName, logoUrl: settings.logoUrl } as any;
      if (fmt === 'docx') await exportDocx(art, opts); else await exportPdfViaPrint(art, opts);
    } catch (e: any) { alertMsg(t('فشل التصدير: ', 'Export failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };
  const genCharter = async () => {
    if (!model) { alertMsg(t('ابنِ النموذج أولاً.', 'Build the model first.')); return; }
    setBusy(t('توليد الميثاق', 'Generating charter'));
    try { setCharterArt(await buildCharter(model)); }
    catch (e: any) { alertMsg(t('فشل توليد الميثاق: ', 'Charter failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };
  const approveModel = async () => {
    if (!model) return;
    const m = appendAudit(model, ADMIN_ACTOR, 'approve_model', `اعتماد النموذج v${model.version} — ${companyName}`);
    try {
      await saveModel(m); setModel(m);
      toast.success(t('✅ تم اعتماد النموذج رسميًا — انتقل لتوليد الوثائق.', 'Model approved — moving to document generation.'));
      // N8: the CTA promises «والانتقال للتنفيذ» — actually take the user there
      // (Build → document generation) instead of just toasting.
      setStage(2); setBuildTab('docs');
    }
    catch (e: any) { alertMsg(t('فشل الاعتماد: ', 'Approval failed: ') + (e?.message || e)); }
  };

  useEffect(() => { loadAll(); }, [loadAll]);

  // DEV-ONLY visual-review seed. When running `vite dev` with `?seed=1` in the URL and
  // Firestore is unreachable (anonymous auth disabled on the project), inject a synthetic
  // governance model + chunks so the later stages unlock and render for visual review.
  // Tree-shaken out of production (guarded by import.meta.env.DEV) and never persisted.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (new URLSearchParams(window.location.search).get('seed') !== '1') return;
    if (model) return; // real data already loaded — don't clobber
    let cancelled = false;
    import('../services/devSeed').then(({ makeSeedModel, makeSeedChunks }) => {
      if (cancelled) return;
      const seeded = makeSeedModel(tenantId, companyName);
      const chunks = makeSeedChunks(tenantId);
      setModel(seeded);
      setChunkCount(chunks.length);
      setIngestedChunks(chunks);
      setSentimentAvg(0.1);
      setPermissionError(false);
    });
    return () => { cancelled = true; };
  }, [tenantId, companyName, model]);

  const stop = () => { abortRef.current?.abort(); setBusy(''); setGenerating(false); };

  // ---- Ingest all org documents for this tenant ----
  const handleIngest = async () => {
    const docs = documents.filter(d => (d.content || '').trim().length > 50 && !excludedDocIds.has(d.id));
    if (!docs.length) { alertMsg(t('لا توجد وثائق ذات محتوى نصي لاستيرادها.', 'No documents with text content to ingest.')); return; }
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    setBusy(t('استيراد الوثائق', 'Ingesting documents'));
    try {
      let totalChunks = 0;
      const allChunks: DocChunk[] = [];
      for (let i = 0; i < docs.length; i++) {
        const d = docs[i];
        setProgress({ phase: 'ingest', current: i + 1, total: docs.length, label: `${t('وثيقة', 'doc')} ${i + 1}/${docs.length}: ${d.name}` });
        await deleteDocChunks(tenantId, d.id).catch(() => {});
        const res = await ingestDocument({
          tenantId, docId: d.id, docName: d.name, content: d.content,
          signal: ac.signal, onProgress: setProgress,
        });
        if (ac.signal.aborted) break;
        await saveChunks(res.chunks);
        if (res.nodes.length) await saveNodes(res.nodes);
        totalChunks += res.chunks.length;
        allChunks.push(...res.chunks);
        // optimistic live update so the sources list and chunk count refresh per-doc
        setChunkCount(allChunks.length);
        setIngestedChunks([...allChunks]);
      }
      const loadedCount = await loadAll();
      setProgress(null);
      if (!ac.signal.aborted) {
        // P0-1: post-save verification — if we computed chunks but the reload shows 0
        // persisted, the write was silently rejected (permissions/connection). Never
        // report success with a contradictory 0 counter.
        if (totalChunks > 0 && loadedCount === 0 && !import.meta.env.DEV) {
          setPermissionError(true);
          toast.error(t(
            `الفهرسة لم تُحفَظ: حُسبت ${totalChunks} مقطع لكن 0 محفوظ في القاعدة — تحقق من الصلاحيات أو الاتصال.`,
            `Indexing not saved: ${totalChunks} chunks computed but 0 persisted — check permissions or connection.`));
          return;
        }
        const s = summarizeSentiment(allChunks);
        setSentimentAvg(allChunks.length ? s.score : undefined); // ج4
        const tone = s.label === 'positive' ? t('إيجابية', 'positive')
          : s.label === 'negative' ? t('سلبية', 'negative')
          : s.label === 'mixed' ? t('مختلطة', 'mixed') : t('محايدة', 'neutral');
        alertMsg(t(
          `تم استيراد ${docs.length} وثيقة (${totalChunks} مقطع). النبرة العامة: ${tone} (😊${s.positive} · 😐${s.neutral} · 😟${s.negative} · ⚖️${s.mixed}). تم توليد المتجهات وتحليل النبرة والكيانات تلقائيًا.`,
          `Ingested ${docs.length} docs (${totalChunks} chunks). Overall tone: ${tone} (😊${s.positive} · 😐${s.neutral} · 😟${s.negative} · ⚖️${s.mixed}). Embeddings, sentiment & entities auto-processed.`));
      }
    } catch (e: any) {
      surfaceError(e, t('فشل الاستيراد: ', 'Ingest failed: '));
    } finally { setBusy(''); setProgress(null); }
  };

  // ---- Build the governance model ----
  const handleBuild = async () => {
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    setBusy(t('بناء النموذج', 'Building model'));
    try {
      // Ingest verbal interview transcripts as retrievable DocChunks so the RAG
      // pipeline can cite real employee speech alongside uploaded documents.
      // Skip if already ingested (detected by docId prefix 'interview_').
      const verbalToIngest = assessmentsForSource.filter((a: any) =>
        a.assessmentType === 'verbal' && a.id &&
        Array.isArray(a.responses) && a.responses.length > 0 &&
        typeof a.responses[0]?.selectedAnswer === 'string' &&
        a.responses[0].selectedAnswer.trim().length > 30
      );
      if (verbalToIngest.length > 0) {
        let existingChunks: { docId: string }[] = [];
        try { existingChunks = await loadChunks(tenantId); } catch { /* ignore */ }
        const ingestedDocIds = new Set(existingChunks.map((c: any) => c.docId));
        for (const a of verbalToIngest) {
          const docId = `interview_${a.id}`;
          if (ingestedDocIds.has(docId)) continue;
          if (ac.signal.aborted) break;
          try {
            const transcript = (a.responses[0]?.selectedAnswer || '').trim();
            const docName = `مقابلة: ${a.userName || a.jobTitle}`;
            const res = await ingestDocument({ tenantId, docId, docName, content: transcript, signal: ac.signal });
            await saveChunks(res.chunks);
            invalidateChunkCache(tenantId);
          } catch (e) { console.warn('interview ingest failed', e); }
        }
      }

      const rawChunks = await loadChunks(tenantId);
      const chunks = excludedDocIds.size > 0 ? rawChunks.filter(c => !excludedDocIds.has(c.docId)) : rawChunks;
      if (!chunks.length) { alertMsg(t('استورد الوثائق أولاً.', 'Ingest documents first.')); setBusy(''); return; }
      const fresh = await buildModel({
        tenantId, companyName, chunks, referenceProjects: refProjects,
        sector, language, signal: ac.signal, onProgress: setProgress,
        assessmentContext: injectAssessments && assessmentsForSource.length ? buildAssessmentContext() : undefined,
        customInstructions: buildInstructions.trim() || undefined,
      });
      if (ac.signal.aborted) { setBusy(''); setProgress(null); return; }
      let m = fresh;
      let mergeMsg = '';
      // #9 — snapshot current model + merge edits forward instead of overwriting
      if (model) {
        try {
          await saveSnapshot({
            id: uid('snap'), tenantId, version: model.version || 1,
            at: new Date().toISOString(), reason: 'pre-rebuild', model,
          });
        } catch (e) { console.warn('snapshot failed', e); }
        if (mergeOnRebuild) {
          const merged = mergeModels(model, fresh);
          m = merged.model;
          // saveModel owns versioning — don't pre-increment here
          m = appendAudit(m, ADMIN_ACTOR, 'rebuild_merge', `+${merged.stats.added} جديد · ${merged.stats.updated} محدث · ${merged.stats.kept} محفوظ`);
          mergeMsg = t(` (دمج: +${merged.stats.added} جديد، ${merged.stats.updated} محدّث، ${merged.stats.kept} محفوظ)`,
                       ` (merge: +${merged.stats.added} new, ${merged.stats.updated} updated, ${merged.stats.kept} kept)`);
        }
      }
      await saveModel(m);
      setModel(m);
      await loadAll();
      setProgress(null);
      const rawGapCount = m.gaps.length;

      // ── Auto-fix open gaps silently ──────────────────────────────
      const openGaps = (m.gaps || []).filter((g: GovGap) => !g.resolved);
      if (openGaps.length > 0 && !ac.signal.aborted) {
        setBusy(t(`إغلاق ${openGaps.length} فجوة تلقائياً…`, `Auto-fixing ${openGaps.length} gap(s)…`));
        try {
          const fixChunks = await loadChunks(tenantId);
          let fm: CompanyGovernanceModel = JSON.parse(JSON.stringify(m));
          let fixedCount = 0;
          for (const gap of openGaps) {
            if (ac.signal.aborted) break;
            try {
              setProgress({ phase: 'section', current: fixedCount + 1, total: openGaps.length,
                label: t(`إغلاق: ${gap.area}`, `Fixing gap: ${gap.area}`) });
              const res = await generateGapFix({ gap, model: fm, chunks: fixChunks, language, signal: ac.signal });
              if (ac.signal.aborted) break;
              fm.policies = [...(fm.policies || []), res.policy];
              fm.procedures = [...(fm.procedures || []), res.procedure];
              const docId = uid('govdoc');
              fm.gaps = (fm.gaps || []).map((g: GovGap) =>
                g.id === gap.id ? { ...g, resolved: true, resolvedByDocId: docId } : g);
              fm = appendAudit(fm, 'system', 'auto_gapfix', `أغلق فجوة "${gap.area}" تلقائياً`);
              const rec: GovDocumentRecord = {
                id: docId, tenantId, kind: 'gapfix',
                title: res.doc.title, goal: res.doc.goal, scope: gap.area,
                status: 'draft', version: fm.version || 1,
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                sections: res.doc.sections,
                executiveSummary: res.doc.executiveSummary,
                citations: res.doc.citations, comments: [],
              };
              await saveGovDocument(rec);
              fixedCount++;
            } catch { /* skip unfixable — continue */ }
          }
          if (fixedCount > 0) {
            await saveModel(fm);
            setModel(fm);
            await loadAll();
            toast.success(t(`✅ أُغلقت ${fixedCount} من ${openGaps.length} فجوة تلقائياً وحُفظت في المكتبة.`,
                            `✅ ${fixedCount} of ${openGaps.length} gap(s) auto-fixed and saved to library.`));
          }
        } catch { /* non-critical */ }
        setProgress(null);
      }

      alertMsg(t(`اكتمل النموذج: ${m.orgUnits.length} وحدة، ${m.roles.length} دور، ${m.policies.length} سياسة، ${(m.authorities||[]).length} صلاحية، ${(m.kpis||[]).length} مؤشر، ${rawGapCount} فجوة → أُغلقت تلقائياً.${mergeMsg}`,
              `Model built: ${m.orgUnits.length} units, ${m.roles.length} roles, ${m.policies.length} policies, ${(m.authorities||[]).length} authorities, ${(m.kpis||[]).length} KPIs, ${rawGapCount} gaps → auto-fixed.${mergeMsg}`));
      gotoStage(1); // navigate to Model stage automatically after build
    } catch (e: any) {
      surfaceError(e, t('فشل بناء النموذج: ', 'Build failed: '));
    } finally { setBusy(''); setProgress(null); }
  };

  // P0-3: landing on the Model stage with indexed chunks but no model → build once,
  // automatically, instead of showing an empty state. autoBuiltRef stops loops (and
  // stops a failed build from retrying forever); resets when a fresh ingest happens.
  const autoBuiltRef = useRef(false);
  useEffect(() => { if (chunkCount === 0) autoBuiltRef.current = false; }, [chunkCount]);
  useEffect(() => {
    if (!showProjects && (stage === 1 || stage === 7) && chunkCount > 0 && !model && !busy && !autoBuiltRef.current && !permissionError) {
      autoBuiltRef.current = true;
      handleBuild();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showProjects, stage, chunkCount, model, busy, permissionError]);

  // ---- Diagrams ----
  const handleGenDiagram = async (kind: GovDiagramKind) => {
    if (!model) { alertMsg(t('ابنِ النموذج أولاً.', 'Build the model first.')); return; }
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    setDiagBusy(kind); setCanvasMode(false);
    try {
      let diag: GovDiagram;
      if (kind === 'swimlane') {
        const spec = await generateSwimlane(model, { language: ar ? 'ar' : 'en', signal: ac.signal });
        diag = { id: uid('diag'), tenantId, kind, title: spec.title, mermaid: '', swimlane: spec, updatedAt: Date.now() };
      } else {
        const { title, mermaid } = await generateMermaid(model, kind, { language: ar ? 'ar' : 'en', signal: ac.signal });
        diag = { id: uid('diag'), tenantId, kind, title, mermaid, updatedAt: Date.now() };
      }
      setActiveDiag(diag);
      try { await saveDiagram(diag); await loadAll(); } catch { /* Firestore optional in dev */ }
    } catch (e: any) {
      alertMsg(t('فشل توليد المخطط: ', 'Diagram generation failed: ') + (e?.message || e));
    } finally { setDiagBusy(null); }
  };

  const handleConvertToCanvas = () => {
    if (!activeDiag) return;
    let nodes = activeDiag.flowNodes, edges = activeDiag.flowEdges;
    if (!nodes?.length) {
      const g = mermaidToFlow(activeDiag.mermaid);
      nodes = g.nodes; edges = g.edges;
      setActiveDiag({ ...activeDiag, flowNodes: nodes, flowEdges: edges });
    }
    setCanvasMode(true);
  };

  const handleSaveCanvas = async (nodes: any[], edges: any[], mermaid: string) => {
    if (!activeDiag) return;
    setSavingCanvas(true);
    try {
      const updated: GovDiagram = { ...activeDiag, flowNodes: nodes, flowEdges: edges, mermaid, updatedAt: Date.now() };
      await saveDiagram(updated);
      setActiveDiag(updated);
      await loadAll();
    } catch (e: any) {
      alertMsg(t('فشل حفظ الـCanvas: ', 'Canvas save failed: ') + (e?.message || e));
    } finally { setSavingCanvas(false); }
  };

  const handleDeleteDiagram = async (id: string) => {
    if (!confirm(t('حذف هذا المخطط؟', 'Delete this diagram?'))) return;
    await deleteDiagram(id);
    if (activeDiag?.id === id) { setActiveDiag(null); setCanvasMode(false); }
    await loadAll();
  };

  // ---- Generate a long, cited governance document ----
  const handleGenerate = async () => {
    if (!model) { alertMsg(t('ابنِ النموذج أولاً.', 'Build the model first.')); return; }
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    setGenerating(true); setGenDoc(null); setThoughts([]); setGenSections([]); setGenProgress(null); resetGenBuffers();
    try {
      const chunks = await loadChunks(tenantId);
      const doc = await generateGovernanceDoc({
        docTitle, goal: docGoal, model, chunks, referenceProjects: refProjects,
        sector, language, signal: ac.signal,
        onProgress: setGenProgress,
        onThought: (txt) => pushThought(txt),
        onSection: (s) => pushSection(s),
      });
      setGenDoc(doc);
    } catch (e: any) {
      alertMsg(t('فشل التوليد: ', 'Generation failed: ') + (e?.message || e));
    } finally { setGenerating(false); }
  };

  // ---- Canvas feedback: revise the generated doc in place via owner notes ----
  const handleReviseGenDoc = async () => {
    if (!genDoc) return;
    const instruction = feedbackText.trim();
    if (!instruction) { alertMsg(t('اكتب ملاحظاتك أولاً.', 'Write your notes first.')); return; }
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    setRevising(true); setThoughts([]); setGenProgress(null);
    try {
      const chunks = await loadChunks(tenantId);
      const edited = await editArtifact({
        artifact: genDoc, instruction, model: model!, chunks,
        language, sector, referenceProjects: refProjects, signal: ac.signal,
        onProgress: setGenProgress,
        onThought: (txt) => pushThought(txt),
        onSection: (s) => pushSection(s),
      });
      setGenDoc(edited as GovernanceDocument);
      setFeedbackText('');
    } catch (e: any) {
      alertMsg(t('فشل التعديل: ', 'Revision failed: ') + (e?.message || e));
    } finally { setRevising(false); }
  };

  // ---- Creation checklist: generate the selected doc kinds from the full catalog ----
  const handleCreateBatch = async () => {
    if (!model) { alertMsg(t('ابنِ النموذج أولاً.', 'Build the model first.')); return; }
    const picked = GOV_DOC_CATALOG.filter(d => createSel[d.key]?.on);
    if (!picked.length) { alertMsg(t('اختر نوعاً واحداً على الأقل.', 'Select at least one type.')); return; }
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    setBatchRunning(true); setGenerating(true); setBatchLog([]);
    let okCount = 0;
    try {
      const chunks = await loadChunks(tenantId).catch(() => [] as any[]);
      // shared cross-doc fact memory → coherent names/numbers across all docs in the batch
      const sharedFacts: string[] = [];
      setGenDoc(null); setThoughts([]); setGenSections([]); setGenProgress(null); resetGenBuffers();

      // bounded concurrency pool (cap 3) with retry/backoff — parallel but rate-safe
      const CONCURRENCY = 3;
      const MAX_RETRY = 2;
      let cursor = 0;
      let activeLabel = '';

      const genOne = async (d: typeof picked[number]) => {
        const pages = Math.max(1, createSel[d.key]?.pages || 8);
        setBatchLog(prev => [...prev, t(`⏳ توليد «${d.ar}» (~${pages} صفحة)...`, `⏳ Generating "${d.en}" (~${pages}p)...`)]);
        for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
          if (ac.signal.aborted) return;
          try {
            const doc = await generateGovernanceDoc({
              docTitle: d.title, goal: d.goal, model, chunks, referenceProjects: refProjects,
              sector, language, targetPages: pages, kind: d.key, signal: ac.signal,
              sharedFacts,
              // in parallel mode show the live preview of whichever doc reports last
              onProgress: (pr) => { activeLabel = d.ar; setGenProgress(pr as any); },
              onSection: (s) => { if (activeLabel === d.ar) pushSection(s); },
            });
            const rec: GovDocumentRecord = {
              id: uid('govdoc'), tenantId, kind: d.key,
              title: doc.title, goal: doc.goal, scope: `${pages}p`,
              status: 'draft', version: model?.version || 1,
              createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
              sections: doc.sections, executiveSummary: doc.executiveSummary,
              diagrams: doc.diagrams, citations: doc.citations, comments: [],
            };
            await saveGovDocument(rec).catch(() => {});
            setGovDocs(prev => [...prev, rec]); // update in-memory even if Firestore save failed
            setGenDoc(doc);
            okCount++;
            setBatchLog(prev => [...prev, t(`✅ «${d.ar}» جاهزة ومحفوظة بالمكتبة.`, `✅ "${d.en}" done & saved.`)]);
            return;
          } catch (e: any) {
            if (ac.signal.aborted) return;
            if (attempt < MAX_RETRY) {
              const backoff = 800 * Math.pow(2, attempt);
              setBatchLog(prev => [...prev, t(`↻ إعادة محاولة «${d.ar}» (${attempt + 1}/${MAX_RETRY})...`, `↻ Retry "${d.en}" (${attempt + 1}/${MAX_RETRY})...`)]);
              await new Promise(r => setTimeout(r, backoff));
            } else {
              setBatchLog(prev => [...prev, t(`❌ فشل «${d.ar}»: `, `❌ "${d.en}" failed: `) + (e?.message || e)]);
            }
          }
        }
      };

      const worker = async () => {
        while (cursor < picked.length) {
          if (ac.signal.aborted) return;
          const d = picked[cursor++];
          await genOne(d);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, picked.length) }, () => worker()));

      await loadAll().catch(() => {});
      if (okCount) alertMsg(t(`اكتمل توليد ${okCount} وثيقة (بالتوازي) وحُفظت بالمكتبة مع تماسك مرجعي مشترك.`, `Generated ${okCount} document(s) in parallel, saved to library with shared coherence.`));
    } catch (e: any) {
      alertMsg(t('فشل التوليد بالدفعة: ', 'Batch generation failed: ') + (e?.message || e));
    } finally { setBatchRunning(false); setGenerating(false); }
  };

  // ---- File upload directly inside the Governance Center (stage 0) ----
  // Owner's premise is DENSE ingest (30/40/50 interlinked governance files), so the
  // primary upload must accept many files at once. Single file → preview+review path
  // (setExtracted). Multiple → direct batch auto-ingest with bounded concurrency.
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = e.target.files ? Array.from(e.target.files) : [];
    if (files.length === 1) await ingestFile(files[0]);
    else if (files.length > 1) await handleBatchUpload(files);
    if (fileRef.current) fileRef.current.value = '';
  };

  // Accepted ingest extensions (whole-folder picker filters by these).
  const INGEST_EXTS = ['txt', 'md', 'csv', 'json', 'xml', 'htm', 'html', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
    'mp3', 'm4a', 'wav', 'ogg', 'aac', 'flac', 'webm', 'opus']; // + N4 audio interviews

  // Whole-folder upload: take EVERY supported file in the picked directory tree
  // (recursive — webkitRelativePath), no per-file selection. Always batch-ingests,
  // even a single file, so a folder never drops into the review-card path.
  const handleFolderUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const all: File[] = e.target.files ? Array.from(e.target.files) : [];
    // Ignore OS/Drive junk that's never a real document (.DS_Store, dotfiles, the
    // Google-native pointer stubs .gdoc/.gsheet/.gslides which carry no content).
    const JUNK = new Set(['ds_store', 'gdoc', 'gsheet', 'gslides', 'gdraw', 'gform', 'localized']);
    const real = all.filter(f => {
      const base = (f.name.split('/').pop() || f.name);
      if (base.startsWith('.')) return false;
      return !JUNK.has((base.split('.').pop() || '').toLowerCase());
    });
    const files = real.filter(f => INGEST_EXTS.includes((f.name.split('.').pop() || '').toLowerCase()));
    const skipped = real.length - files.length;
    if (folderRef.current) folderRef.current.value = '';

    if (files.length) {
      if (skipped > 0) setBusy(t(`المجلد: ${files.length} ملف مدعوم · تجاوز ${skipped}…`, `Folder: ${files.length} supported · ${skipped} skipped…`));
      await handleBatchUpload(files);
      return;
    }

    // No usable files. Two very different causes → two different messages + recovery.
    if (all.length === 0) {
      // Browser enumerated ZERO entries — classic Google-Drive / iCloud virtual
      // folder (FileProvider) that webkitdirectory can't read. Fall back to the
      // multi-file picker, which DOES materialize cloud files on selection.
      alertMsg(t(
        'تعذّر قراءة محتويات المجلد — غالبًا مجلد سحابي (Google Drive/iCloud) لا يُدعم اختياره كمجلد. سأفتح اختيار الملفات؛ حدِّد الملفات مباشرة (يمكن تحديد الكل بـ ⌘A).',
        'Could not read the folder — likely a cloud folder (Google Drive/iCloud) that can\'t be picked as a directory. Opening the file picker instead; select files directly (⌘A selects all).'));
      setTimeout(() => fileRef.current?.click(), 150);
    } else {
      // Items were found but none had a supported extension — tell the owner WHICH.
      const exts = Array.from(new Set(real.map(f => (f.name.split('.').pop() || '?').toLowerCase()))).slice(0, 12).join('، ');
      alertMsg(t(
        `لا ملفات بصيغة مدعومة في المجلد (${all.length} عنصر${exts ? ` · الصيغ الموجودة: ${exts}` : ''}). المدعوم: PDF, Word, Excel, PowerPoint, نصوص.`,
        `No supported file formats in folder (${all.length} items${exts ? ` · found: ${exts}` : ''}). Supported: PDF, Word, Excel, PowerPoint, text.`));
    }
  };

  const TEXT_EXTS = ['txt', 'md', 'csv', 'json', 'xml', 'htm', 'html'];

  // REAL extraction (no fabrication). Reads the actual bytes per type:
  //   text → decode · docx/pptx → unzip OOXML · xls/xlsx → SheetJS · pdf/images → Gemini inlineData.
  // On empty/failed extraction returns content:'' + a human `error` reason so callers can
  // surface a per-file message and refuse to ingest fabricated text. Never throws (except abort).
  const extractFileContent = async (
    file: File, signal?: AbortSignal,
  ): Promise<{ name: string; content: string; size: string; type: string; error?: string }> => {
    const sizeKB = Math.round(file.size / 1024);
    const baseName = file.name.replace(/\.[^/.]+$/, '');
    const res = await extractFileText(file, signal);
    return {
      name: baseName,
      content: res.text,
      size: `${sizeKB} KB`,
      type: file.type || 'application/octet-stream',
      error: res.error,
    };
  };

  // Single-file path: extract → stage into the review card (user confirms before save).
  const ingestFile = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const isBinary = !TEXT_EXTS.includes(ext);
    if (isBinary) setExtracting(true);
    try {
      const ex = await extractFileContent(file);
      if (!ex.content.trim()) {
        // Real extraction produced nothing — tell the owner WHY, don't stage an empty card.
        alertMsg(t(`تعذّر استخلاص نص من «${file.name}»: ${ex.error || 'لا يوجد نص'}`,
                   `Could not extract text from "${file.name}": ${ex.error || 'no text'}`));
        return;
      }
      setExtracted({ name: ex.name, content: ex.content, size: ex.size, type: ex.type, category: 'current_state' });
    } finally { if (isBinary) setExtracting(false); }
  };

  // Extract + save + chunk/embed/entities for one file, straight to the library
  // (no review card). Returns a per-file outcome so the batch can report partial success.
  const ingestOneToLibrary = async (
    file: File, signal: AbortSignal,
  ): Promise<{ name: string; ok: boolean; chunks: number; err?: string }> => {
    const ex = await extractFileContent(file, signal);
    // Refuse to save fabricated/empty content — surface the real reason instead.
    if (!ex.content.trim()) return { name: ex.name, ok: false, chunks: 0, err: ex.error || t('لا يوجد نص مستخرَج', 'no text extracted') };
    const content = `[ملف مرفوع من مركز الحوكمة | الحجم: ${ex.size} | النوع: ${ex.type}]\n\n${ex.content}`;
    const saved = await onAddDocument({ name: ex.name, category: 'current_state', content });
    if (!(saved && (saved as OrganizationDocument).id)) return { name: ex.name, ok: false, chunks: 0, err: 'save failed' };
    const d = saved as OrganizationDocument;
    await deleteDocChunks(tenantId, d.id).catch(() => {});
    const res = await ingestDocument({ tenantId, docId: d.id, docName: d.name, content, signal });
    if (signal.aborted) return { name: ex.name, ok: false, chunks: 0, err: 'aborted' };
    await saveChunks(res.chunks);
    if (res.nodes.length) await saveNodes(res.nodes);
    return { name: ex.name, ok: true, chunks: res.chunks.length };
  };

  // Multi-file path: bounded-concurrency pool (cap 3 — same ceiling as bulk gen, keeps
  // embedding/Gemile rate-limits sane). One loadAll() at the end, not per-file.
  const handleBatchUpload = async (files: File[]) => {
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    let done = 0, okFiles = 0, okChunks = 0; const fails: string[] = [];
    setBusy(t(`رفع وفهرسة 0/${files.length}…`, `Ingesting 0/${files.length}…`));
    const CAP = 3;
    let idx = 0;
    const worker = async () => {
      while (idx < files.length && !ac.signal.aborted) {
        const f = files[idx++];
        try {
          const r = await ingestOneToLibrary(f, ac.signal);
          if (r.ok) { okFiles++; okChunks += r.chunks; } else fails.push(`${r.name}: ${r.err}`);
        } catch (e: any) { fails.push(`${f.name}: ${e?.message || e}`); }
        done++;
        setBusy(t(`رفع وفهرسة ${done}/${files.length}…`, `Ingesting ${done}/${files.length}…`));
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CAP, files.length) }, () => worker()));
      await loadAll();
      const failTail = fails.length ? t(` — فشل ${fails.length}: ${fails.join(' | ')}`, ` — ${fails.length} failed: ${fails.join(' | ')}`) : '';
      alertMsg(t(`اكتمل رفع ${okFiles}/${files.length} ملف (${okChunks} مقطع مفهرس).${failTail}`,
                 `Uploaded ${okFiles}/${files.length} files (${okChunks} chunks indexed).${failTail}`));
    } catch (e: any) {
      alertMsg(t('فشل الرفع الجماعي: ', 'Batch upload failed: ') + (e?.message || e));
    } finally { setBusy(''); setProgress(null); }
  };

  const confirmExtracted = async () => {
    if (!extracted || !extracted.name.trim() || !extracted.content.trim()) return;
    const content = `[ملف مرفوع من مركز الحوكمة | الحجم: ${extracted.size} | النوع: ${extracted.type}]\n\n${extracted.content}`;
    const saved = await onAddDocument({ name: extracted.name, category: extracted.category, content });
    setExtracted(null);
    // Unified pipeline: ingest the just-saved document immediately (chunk + embed + entities)
    // so it feeds question derivation / reports without a separate "ingest" step.
    if (saved && (saved as OrganizationDocument).id) {
      const d = saved as OrganizationDocument;
      abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
      setBusy(t('استيراد الوثيقة', 'Ingesting document'));
      try {
        await deleteDocChunks(tenantId, d.id).catch(() => {});
        const res = await ingestDocument({ tenantId, docId: d.id, docName: d.name, content, signal: ac.signal, onProgress: setProgress });
        if (!ac.signal.aborted) {
          await saveChunks(res.chunks);
          if (res.nodes.length) await saveNodes(res.nodes);
          await loadAll();
          alertMsg(t(`تم رفع واستيراد "${d.name}" (${res.chunks.length} مقطع).`, `Uploaded & ingested "${d.name}" (${res.chunks.length} chunks).`));
        }
      } catch (e: any) {
        alertMsg(t('تم الحفظ لكن فشل الاستيراد التلقائي: ', 'Saved but auto-ingest failed: ') + (e?.message || e));
      } finally { setBusy(''); setProgress(null); }
    }
  };

  // ---- Bulk generation: complete policies / procedures / all departments ----
  const handleBulkGenerate = async () => {
    if (!model) { alertMsg(t('ابنِ النموذج أولاً.', 'Build the model first.')); return; }
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    setGenerating(true); setGenDoc(null); setThoughts([]); setGenSections([]); setGenProgress(null); resetGenBuffers();
    try {
      const chunks = await loadChunks(tenantId);
      const doc = await generateBulkDoc({
        scope: bulkScope, model, chunks, language, sector, referenceProjects: refProjects, signal: ac.signal,
        onProgress: setGenProgress,
        onThought: (txt) => pushThought(txt),
        onSection: (s) => pushSection(s),
      });
      setGenDoc(doc);
      setGenDocKind('governance');
      // BUG-3 fix: auto-save bulk generated documents to library so they survive page refresh.
      // GovF16: also persist a PARTIAL set (e.g. aborted mid-run) as long as ≥1 section
      // finished — otherwise minutes of generation are silently lost on stop.
      const doneCount = (doc.sections || []).filter(s => s.status === 'done').length;
      if (doc.complete || doneCount > 0) {
        try {
          await persistGenDocInner(doc, 'governance', bulkScope);
          alertMsg(doc.complete
            ? t('اكتمل التوليد وحُفظ في المكتبة.', 'Generation complete and saved to library.')
            : t(`حُفظت ${doneCount} وثيقة مكتملة (توقّف التوليد قبل الاكتمال).`, `Saved ${doneCount} completed doc(s) (generation stopped early).`));
        } catch { /* library save optional — doc still in state */ }
      }
    } catch (e: any) {
      alertMsg(t('فشل التوليد الكمي: ', 'Bulk generation failed: ') + (e?.message || e));
    } finally { setGenerating(false); }
  };

  const handleExport = async (fmt: 'docx' | 'pdf') => {
    if (!genDoc) return;
    const opts = { language, companyName, logoUrl: settings.logoUrl } as any;
    try {
      // embed diagrams (PNG) into the exported artifact
      let toExport = genDoc;
      if (diagrams.length && !genDoc.diagrams?.length) {
        setBusy(t('تجهيز الرسومات للتصدير', 'Rendering diagrams for export'));
        const imgs = await diagramsToImages(diagrams.map(d => ({ title: d.title, mermaid: d.mermaid, swimlane: d.swimlane })));
        toExport = { ...genDoc, diagrams: imgs };
        setGenDoc(toExport);
        setBusy('');
      }
      if (fmt === 'docx') await exportDocx(toExport, opts);
      else exportPdfViaPrint(toExport, opts);
    } catch (e: any) { setBusy(''); alertMsg(t('فشل التصدير: ', 'Export failed: ') + (e?.message || e)); }
  };

  // FIX 2 — branded, organized PDF of the current-state diagnostic. Builds a
  // GeneratedArtifact AST from reportData, then routes through exportPdfDirect so
  // the report carries the owner's identity (logo + company name) + Arabic RTL.
  const exportDiagnosticPdf = async () => {
    const rd = latestDiagnostic?.reportData;
    if (!rd) return;
    const reportTitle = docTitle || companyName;
    const clean = (s: any) => String(s ?? '').trim();
    const sections: any[] = [];
    const push = (title: string, content: string) => {
      if (content.trim()) sections.push({ id: uid('sec'), title, content, status: 'done' });
    };
    let overview = `**${t('الدرجة الكلية', 'Overall score')}:** ${Math.round(rd.totalScore)}%`;
    if (rd.technicalScore != null) overview += `\n\n**${t('المحور الفني', 'Technical')}:** ${Math.round(rd.technicalScore)}%`;
    if (rd.behavioralScore != null) overview += `\n\n**${t('المحور السلوكي', 'Behavioral')}:** ${Math.round(rd.behavioralScore)}%`;
    if (Array.isArray(rd.competencyScores) && rd.competencyScores.length) {
      overview += `\n\n| ${t('المحور', 'Axis')} | ${t('الدرجة', 'Score')} | ${t('الدليل', 'Evidence')} |\n|---|---|---|\n` +
        rd.competencyScores.map((c: any) => `| ${clean(c.competency)} | ${c.score}% | ${clean(c.evidence) || '—'} |`).join('\n');
    }
    push(t('نظرة عامة على النضج', 'Maturity overview'), overview);
    push(t('نقاط القوة', 'Strengths'), clean(rd.strengths));
    push(t('نقاط الضعف', 'Weaknesses'), clean(rd.weaknesses));
    push(t('التوصيات', 'Recommendations'), clean(rd.recommendations));
    if (rd.gapReport) {
      let gap = '';
      if (rd.gapReport.overallGapSummary) gap += `${clean(rd.gapReport.overallGapSummary)}\n\n`;
      if (Array.isArray(rd.gapReport.competencyGaps) && rd.gapReport.competencyGaps.length) {
        gap += `| ${t('المعيار', 'Standard')} | ${t('مطلوب', 'Required')} | ${t('فعلي', 'Actual')} | ${t('الوصف', 'Description')} |\n|---|---|---|---|\n` +
          rd.gapReport.competencyGaps.map((g: any) => `| ${clean(g.skill)} | ${g.required}% | ${g.actual}% | ${clean(g.gapDescription)} |`).join('\n');
      }
      push(t('تقرير الفجوات', 'Gap report'), gap);
      if (rd.gapReport.developmentPlan) push(t('خطة التطوير', 'Development plan'), clean(rd.gapReport.developmentPlan));
    }
    if (Array.isArray(rd.sources) && rd.sources.length) push(t('المصادر', 'Sources'), rd.sources.map((s: any) => `- ${clean(s)}`).join('\n'));
    const artifact: GeneratedArtifact = {
      title: `${t('تقرير الواقع الراهن', 'Current-state report')} — ${reportTitle}`,
      goal: t('تشخيص مرجعي دقيق لواقع حوكمة المؤسسة', 'A precise reference diagnostic of the organization\'s governance current state'),
      language, sections, createdAt: new Date(), complete: true,
    };
    try {
      setBusy(t('تجهيز PDF…', 'Preparing PDF…'));
      await exportPdfDirect(artifact, { language, companyName, logoUrl: settings.logoUrl } as any);
    } catch (e: any) { alertMsg(t('فشل تصدير التقرير: ', 'Report export failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };

  // persist model edits made from the canvas
  const handleModelCanvasChange = async (m: CompanyGovernanceModel) => {
    setModel(m);
    try { await saveModel(m); } catch (e) { console.warn('model save failed', e); }
  };

  // ---- #12 canvas writeback (connect → real authority/edge) + auto-layout ----
  const openModelCanvas = () => {
    if (!model) return;
    const g = modelToFlow(model);
    setModelCanvasNodes(g.nodes); setModelCanvasEdges(g.edges);
    setModelCanvas(v => !v);
  };
  const handleAutoLayout = () => {
    if (!modelCanvasNodes.length) return;
    setModelCanvasNodes(autoLayout(modelCanvasNodes, modelCanvasEdges));
  };

  // ---- #9 rollback to a snapshot ----
  const handleRollback = async (s: GovModelSnapshot) => {
    if (!confirm(t(`استرجاع النموذج إلى نسخة ${new Date(s.at).toLocaleString()}؟ سيُحفظ الوضع الحالي كنسخة.`, `Roll back to ${new Date(s.at).toLocaleString()}? Current state will be snapshotted.`))) return;
    setBusy(t('استرجاع نسخة', 'Rolling back'));
    try {
      if (model) await saveSnapshot({ id: uid('snap'), tenantId, version: model.version || 1, at: new Date().toISOString(), reason: 'pre-rollback', model });
      const restored = appendAudit({ ...s.model, version: (model?.version || s.model.version || 1) + 1 }, ADMIN_ACTOR, 'rollback', `إلى ${s.at}`);
      await saveModel(restored); setModel(restored); await loadAll();
    } catch (e: any) { alertMsg(t('فشل الاسترجاع: ', 'Rollback failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };

  // ---- #6 gap → fix loop ----
  const handleGapFix = async (gap: GovGap) => {
    if (!model) return;
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    setFixingGap(gap.id); setGenerating(true); setGenDoc(null); setThoughts([]); setGenSections([]); setGenProgress(null); resetGenBuffers();
    setStage(2); setBuildTab('docs'); setGenDocKind('gapfix');
    try {
      const chunks = await loadChunks(tenantId);
      const res = await generateGapFix({
        gap, model, chunks, language, signal: ac.signal,
        onProgress: setGenProgress,
        onThought: (txt) => pushThought(txt),
        onSection: (s) => pushSection(s),
      });
      // attach the draft policy/procedure for approve-to-model
      (res.doc as any)._gapFix = { gap, policy: res.policy, procedure: res.procedure };
      setGenDoc(res.doc);
    } catch (e: any) {
      alertMsg(t('فشل توليد الإصلاح: ', 'Gap-fix failed: ') + (e?.message || e));
    } finally { setGenerating(false); setFixingGap(null); }
  };

  // ---- #4 approve a generated gap-fix into the model (policy + procedure + close gap) ----
  const approveGapFixToModel = async () => {
    if (!model || !genDoc || !(genDoc as any)._gapFix) return;
    const { gap, policy, procedure } = (genDoc as any)._gapFix;
    let m: CompanyGovernanceModel = JSON.parse(JSON.stringify(model));
    m.policies = [...(m.policies || []), policy];
    m.procedures = [...(m.procedures || []), procedure];
    const docId = uid('govdoc');
    m.gaps = (m.gaps || []).map((g: GovGap) => g.id === gap.id ? { ...g, resolved: true, resolvedByDocId: docId } : g);
    // saveModel owns versioning — don't pre-increment here
    m = appendAudit(m, ADMIN_ACTOR, 'approve_gapfix', `${policy.title} + ${procedure.title} (أغلق فجوة ${gap.area})`);
    await saveModel(m); setModel(m);
    // persist the generated doc to the library
    await persistGenDoc('gapfix', gap.area, docId);
    await loadAll();
    alertMsg(t('اعتُمد الإصلاح: أُضيفت السياسة والإجراء وأُغلقت الفجوة.', 'Approved: policy + procedure added, gap closed.'));
  };

  // ---- #3 persist current genDoc into gov_documents library ----
  // Inner helper accepts explicit doc (for bulk auto-save without needing genDoc state set yet)
  const persistGenDocInner = async (doc: GovernanceDocument, kind: GovDocumentRecord['kind'], scope?: string, forcedId?: string) => {
    const rec: GovDocumentRecord = {
      id: forcedId || uid('govdoc'), tenantId, kind,
      title: doc.title, goal: doc.goal, scope,
      status: 'draft',
      version: model?.version || 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      sections: doc.sections, executiveSummary: doc.executiveSummary,
      diagrams: doc.diagrams, citations: doc.citations, comments: [],
    };
    await saveGovDocument(rec);
    await loadAll();
    return rec;
  };
  const persistGenDoc = async (kind: GovDocumentRecord['kind'], scope?: string, forcedId?: string) => {
    if (!genDoc) return;
    return persistGenDocInner(genDoc, kind, scope, forcedId);
  };
  const handleSaveToLibrary = async () => {
    if (!genDoc) return;
    setBusy(t('حفظ في المكتبة', 'Saving to library'));
    try { await persistGenDoc(genDocKind); alertMsg(t('حُفظت الوثيقة في المكتبة.', 'Saved to library.')); }
    catch (e: any) { alertMsg(t('فشل الحفظ: ', 'Save failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };

  // ---- map a stored record → exportable artifact (carries embedded diagrams) ----
  const recordToArtifact = (d: GovDocumentRecord): GovernanceDocument => ({
    title: d.title, goal: d.goal || '', language,
    sections: d.sections, executiveSummary: d.executiveSummary,
    diagrams: d.diagrams, citations: d.citations || {},
    createdAt: new Date(d.createdAt), complete: d.status === 'approved',
  } as GovernanceDocument);

  // ---- reopen a stored doc back into the generation view (preview + edit + export) ----
  const reopenDoc = (d: GovDocumentRecord) => {
    setGenDoc(recordToArtifact(d)); setGenDocKind(d.kind); setStage(2); setBuildTab('docs');
  };

  // ---- #6/#8 batch export: all docs (or one folder) merged or separate, Word/PDF ----
  const [batchFmt, setBatchFmt] = useState<BatchFormat>('docx');
  const [batchMode, setBatchMode] = useState<BatchMode>('separate');
  const handleBatchExport = async (recs: GovDocumentRecord[], bundleTitle: string) => {
    if (!recs.length) { alertMsg(t('لا توجد وثائق للتصدير.', 'No documents to export.')); return; }
    setBusy(t('تجهيز التصدير', 'Preparing export'));
    try {
      const opts = { language, companyName, logoUrl: settings.logoUrl } as any;
      const arts = recs.map(recordToArtifact);
      await exportArtifactsBatch(arts, opts, { format: batchFmt, mode: batchMode, bundleTitle });
    } catch (e: any) { alertMsg(t('فشل التصدير: ', 'Export failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };

  // ---- R5 #2: ZIP export — version-named root folder, per-type subfolders ----
  // Generation takes ~25s for 43 docs. We do NOT call downloadBlob inside exportArtifactsZip
  // because Edge blocks programmatic a.click() after the user gesture expires (~5s).
  // Instead: generate → store blobURL in state → render a button the user clicks (fresh gesture).
  const handleZipExport = async (recs: GovDocumentRecord[]) => {
    if (!recs.length) { alertMsg(t('لا توجد وثائق للتصدير.', 'No documents to export.')); return; }
    setZipReady(null); // clear previous ready state
    setBusy(t('تجهيز حزمة المجلدات', 'Building folder package'));
    try {
      const opts = { language, companyName, logoUrl: settings.logoUrl } as any;
      const items = recs.map(d => ({ artifact: recordToArtifact(d), kind: d.kind }));
      const res = await exportArtifactsZip(items, opts, {
        format: batchFmt, projectName: companyName, version: model?.version || 1,
      });
      const url = URL.createObjectURL(res.blob);
      setZipReady({ url, fileName: res.fileName, count: res.written });
    } catch (e: any) { alertMsg(t('فشل تصدير الحزمة: ', 'Package export failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };

  // ---- #14 approval workflow ----
  const setDocStatus = async (d: GovDocumentRecord, status: GovDocumentRecord['status']) => {
    const rec = { ...d, status, updatedAt: new Date().toISOString() };
    await saveGovDocument(rec);
    if (model) {
      const m = appendAudit(model, ADMIN_ACTOR, `doc_${status}`, d.title);
      await saveModel(m); setModel(m);
    }
    await loadAll();
  };
  const addDocComment = async (d: GovDocumentRecord, text: string) => {
    if (!text.trim()) return;
    const rec: GovDocumentRecord = { ...d, updatedAt: new Date().toISOString(), comments: [...(d.comments || []), { id: uid('cmt'), at: new Date().toISOString(), author: ADMIN_ACTOR, text: text.trim() }] };
    await saveGovDocument(rec); await loadAll();
  };
  const removeDoc = async (id: string) => {
    if (!confirm(t('حذف هذه الوثيقة من المكتبة؟', 'Delete this document from the library?'))) return;
    await deleteGovDocument(id); await loadAll();
  };

  // ---- #8 rich governance manual export ----
  const handleExportManual = async () => {
    if (!genDoc || !model) { alertMsg(t('ولّد وثيقة أولاً.', 'Generate a document first.')); return; }
    setBusy(t('تصدير الدليل الكامل', 'Exporting full manual'));
    try {
      let toExport = genDoc;
      if (diagrams.length && !genDoc.diagrams?.length) {
        const imgs = await diagramsToImages(diagrams.map(d => ({ title: d.title, mermaid: d.mermaid, swimlane: d.swimlane })));
        toExport = { ...genDoc, diagrams: imgs }; setGenDoc(toExport);
      }
      await exportGovernanceManual(model, toExport, { language, companyName, logoUrl: settings.logoUrl } as any, {
        maturity: maturityReport || undefined, alignment,
        approvedBy: ADMIN_ACTOR, effectiveDate: new Date().toISOString().slice(0, 10),
      });
    } catch (e: any) { alertMsg(t('فشل التصدير: ', 'Export failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };

  // ---- sample-matching manuals (built straight from the model) ----
  const handleExportWorkflow = async () => {
    if (!model) { alertMsg(t('ابنِ النموذج أولاً.', 'Build the model first.')); return; }
    setBusy(t('تصدير دليل دورة العمل', 'Exporting workflow manual'));
    try { await exportWorkflowManual(model, { language, companyName, logoUrl: settings.logoUrl } as any); }
    catch (e: any) { alertMsg(t('فشل التصدير: ', 'Export failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };
  const handleExportJDs = async () => {
    if (!model) { alertMsg(t('ابنِ النموذج أولاً.', 'Build the model first.')); return; }
    setBusy(t('تصدير دليل الأوصاف الوظيفية', 'Exporting job descriptions'));
    try { await exportJobDescriptions(model, { language, companyName, logoUrl: settings.logoUrl } as any); }
    catch (e: any) { alertMsg(t('فشل التصدير: ', 'Export failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };
  const handleExportPolicies = async () => {
    if (!model) { alertMsg(t('ابنِ النموذج أولاً.', 'Build the model first.')); return; }
    setBusy(t('تصدير دليل السياسات', 'Exporting policies manual'));
    try { await exportPoliciesManual(model, { language, companyName, logoUrl: settings.logoUrl } as any); }
    catch (e: any) { alertMsg(t('فشل التصدير: ', 'Export failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };

  // ---- #10 agentic model actions ----
  const handlePropose = async () => {
    if (!model || !actionInput.trim()) return;
    setProposing(true); setProposedActions([]);
    try {
      const acts = await proposeModelActions(actionInput.trim(), model, language);
      setProposedActions(acts);
      if (!acts.length) alertMsg(t('لم يُقترح أي تعديل. أعد الصياغة.', 'No actions proposed. Rephrase.'));
    } catch (e: any) { alertMsg(t('فشل الاقتراح: ', 'Propose failed: ') + (e?.message || e)); }
    finally { setProposing(false); }
  };
  const handleApplyActions = async () => {
    if (!model || !proposedActions.length) return;
    setBusy(t('تطبيق التعديلات', 'Applying actions'));
    try {
      await saveSnapshot({ id: uid('snap'), tenantId, version: model.version || 1, at: new Date().toISOString(), reason: 'pre-apply-actions', model });
      const res = applyActions(model, proposedActions, ADMIN_ACTOR);
      // saveModel owns versioning — don't pre-increment here
      await saveModel(res.model); setModel(res.model);
      setProposedActions([]); setActionInput('');
      await loadAll();
      alertMsg(t(`طُبّق ${res.applied} تعديل${res.skipped.length ? `، تُخطّي ${res.skipped.length}` : ''}.`, `Applied ${res.applied}${res.skipped.length ? `, skipped ${res.skipped.length}` : ''}.`));
    } catch (e: any) { alertMsg(t('فشل التطبيق: ', 'Apply failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };

  // ---- #11 Q&A ----
  const handleAsk = async () => {
    if (!qaQuestion.trim()) return;
    if (!model) { alertMsg(t('ابنِ النموذج أولاً لتفعيل البحث السياقي.', 'Build the model first to enable contextual Q&A.')); return; }
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    setQaBusy(true); setQaAnswer(''); setQaSources([]);
    try {
      const chunks = await loadChunks(tenantId);
      const res = await askGovernance(
        { question: qaQuestion.trim(), model, chunks, language, signal: ac.signal },
        {
          onThought: () => {},
          onAnswer: (chunk) => setQaAnswer(prev => prev + chunk),
          onDone: () => {},
          onError: () => setQaAnswer(prev => prev || t('تعذّر الرد.', 'Failed.')),
        },
      );
      setQaSources(res.sources || []);
    } catch (e: any) { setQaAnswer(t('تعذّر الرد: ', 'Failed: ') + (e?.message || e)); }
    finally { setQaBusy(false); }
  };

  // ---- reasoning agent loop (Track C) ----
  const handleRunAgent = async () => {
    if (!model || !agentInput.trim()) return;
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    setAgentRunning(true); setAgentSteps([]); setAgentAnswer(''); setAgentTrace('');
    try {
      const chunks = await loadChunks(tenantId);
      if (agentAutoApply) {
        await saveSnapshot({ id: uid('snap'), tenantId, version: model.version || 1, at: new Date().toISOString(), reason: 'pre-agent-run', model });
      }
      // cross-stage planning context: open gaps (assurance) + available library refs
      const openGaps = (model.gaps || []).filter(g => !g.resolved).slice(0, 8).map(g => `[${g.severity}] ${g.area}`).join('، ');
      const libRefs = refProjects.slice(0, 10).map(r => r.name).filter(Boolean).join('، ');
      const crossStageContext = [
        openGaps ? t(`فجوات مفتوحة (التحقق): ${openGaps}`, `Open gaps (assurance): ${openGaps}`) : '',
        libRefs ? t(`المكتبة المرجعية المتاحة: ${libRefs}`, `Reference library available: ${libRefs}`) : '',
      ].filter(Boolean).join('\n');
      const res = await runGovernanceAgent(
        {
          instruction: agentInput.trim(), model, chunks, language,
          sector, referenceProjects: refProjects,
          autoApply: agentAutoApply, signal: ac.signal,
          crossStageContext: crossStageContext || undefined,
          // Cross-stage tools — pure/reconcile in-run; the host persists res.model
          // at the end, so these never clobber React state mid-run.
          stageTools: {
            // reconcile the agent's working edits against the latest canonical model
            rebuildModel: (working) => mergeModels(model, working).model,
            // assurance re-check across the working model
            revalidate: (working) => analyzeIntegrity(working),
            // refresh the active canvas/diagram from the working model
            syncCanvas: async (working, signal) => {
              if (signal?.aborted) return;
              const kind: GovDiagramKind = activeDiag?.kind || 'flowchart';
              if (kind === 'swimlane') {
                const spec = await generateSwimlane(working, { language: ar ? 'ar' : 'en', signal });
                if (signal?.aborted) return;
                const diag: GovDiagram = activeDiag
                  ? { ...activeDiag, title: spec.title, mermaid: '', swimlane: spec, flowNodes: undefined, flowEdges: undefined, updatedAt: Date.now() }
                  : { id: uid('diag'), tenantId, kind, title: spec.title, mermaid: '', swimlane: spec, updatedAt: Date.now() };
                try { await saveDiagram(diag); } catch { /* best-effort */ }
                setActiveDiag(diag);
                return spec.title;
              }
              const { title, mermaid } = await generateMermaid(working, kind, { language: ar ? 'ar' : 'en', signal });
              if (signal?.aborted) return;
              const diag: GovDiagram = activeDiag
                ? { ...activeDiag, title, mermaid, flowNodes: undefined, flowEdges: undefined, updatedAt: Date.now() }
                : { id: uid('diag'), tenantId, kind, title, mermaid, updatedAt: Date.now() };
              try { await saveDiagram(diag); } catch { /* keep going — canvas refresh is best-effort */ }
              setActiveDiag(diag);
              return title;
            },
          },
        },
        { onStep: (s) => setAgentSteps(prev => [...prev, s]) },
      );
      setAgentAnswer(res.finalAnswer || '');
      setAgentTrace(res.traceMarkdown || '');
      if (agentAutoApply && res.appliedActions.length && res.model) {
        // saveModel owns versioning — don't pre-increment here (loadAll reloads the canonical version)
        const next = appendAudit(res.model, ADMIN_ACTOR, 'agent', `${res.appliedActions.length} تعديل`);
        await saveModel(next); setModel(next); await loadAll();
      }
      // GAP4: agent proposed actions under manual-approval mode — surface them in the review gate
      if (!agentAutoApply && res.pendingActions?.length) {
        setProposedActions(res.pendingActions);
        setAgentAnswer(prev => `${prev}\n\n${t(`📋 ${res.pendingActions!.length} تعديل مقترح بانتظار اعتمادك في وضع «تعديل النموذج».`, `📋 ${res.pendingActions!.length} proposed change(s) awaiting your approval in Edit-model mode.`)}`);
      }
      // persist any documents the agent generated into the library so they surface in UI
      const docs = res.generatedDocuments || [];
      if (docs.length) {
        for (const art of docs) {
          const rec: GovDocumentRecord = {
            id: uid('govdoc'), tenantId, kind: 'governance',
            title: art.title, goal: (art as any).goal || agentInput.trim(), scope: 'agent',
            status: 'draft', version: model.version || 1,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            sections: art.sections, executiveSummary: art.executiveSummary,
            diagrams: art.diagrams, citations: (art as any).citations || {}, comments: [],
          };
          try { await saveGovDocument(rec); } catch { /* keep going */ }
        }
        await loadAll();
        const made = [
          docs.length ? t(`📄 ${docs.length} وثيقة محفوظة في المكتبة`, `📄 ${docs.length} doc(s) saved to library`) : '',
          (res.generatedDiagrams?.length || 0) ? t(`📊 ${res.generatedDiagrams!.length} مخطّط`, `📊 ${res.generatedDiagrams!.length} diagram(s)`) : '',
          (res.exportedFiles?.length || 0) ? t(`💾 ${res.exportedFiles!.length} ملف مُصدَّر`, `💾 ${res.exportedFiles!.length} exported file(s)`) : '',
        ].filter(Boolean).join(' · ');
        if (made) setAgentAnswer(prev => `${prev}\n\n${made}`);
      }
    } catch (e: any) { setAgentAnswer(t('فشل الوكيل: ', 'Agent failed: ') + (e?.message || e)); }
    finally { setAgentRunning(false); }
  };

  // ---- #13 trace an entity ----
  const handleTrace = (kind: 'unit' | 'role' | 'policy' | 'procedure', id: string) => {
    if (!model) return;
    setTrace(traceEntity(model, kind, id));
  };

  const handleAddRef = async () => {
    if (!rp.name.trim() || !rp.content.trim()) { alertMsg(t('الاسم والمحتوى مطلوبان.', 'Name & content required.')); return; }
    setBusy(t('حفظ المشروع المرجعي', 'Saving reference'));
    try {
      const proj: ReferenceProject = {
        id: uid('proj'), name: rp.name.trim(), sector: rp.sector.trim() || 'عام',
        companySize: 'medium', artifactKind: 'policy_manual',
        summary: rp.summary.trim() || rp.name.trim(), content: rp.content.trim(),
        tags: rp.tags.split(',').map(s => s.trim()).filter(Boolean),
        createdAt: new Date().toISOString(),
      };
      await saveReferenceProject(proj);
      setRp({ name: '', sector: '', summary: '', content: '', tags: '' });
      setShowRefForm(false);
      await loadAll();
    } catch (e: any) { alertMsg(t('فشل الحفظ: ', 'Save failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };

  // v6-D: reference projects now have a managed home — delete is wired so the
  // library never becomes a write-only dumping ground.
  const handleDeleteRef = async (id: string, name: string) => {
    if (!window.confirm(t(`حذف المرجع «${name}» نهائيًا؟`, `Permanently delete reference “${name}”?`))) return;
    // optimistic removal then persist
    setRefProjects(prev => prev.filter(p => p.id !== id));
    try {
      await deleteReferenceProject(id);
    } catch (e: any) {
      alertMsg(t('فشل الحذف: ', 'Delete failed: ') + (e?.message || e));
      await loadAll(); // restore truth on failure
    }
  };

  // ---- م4: BATCH reference-library ingest (drop 10/20/30 → auto-classify) ----
  const handleRefBatchFiles = async (files: File[]) => {
    if (!files.length) return;
    abortRef.current?.abort(); const ac = new AbortController(); abortRef.current = ac;
    setRefBatchBusy(true); setRefDrafts([]);
    setRefBatchProg({ current: 0, total: files.length, fileName: '', phase: 'read' });
    try {
      const drafts = await extractReferenceProjects(
        files, (p) => setRefBatchProg(p), ac.signal, 3,
      );
      // keep auto sort: group by artifactKind then sector for a tidy review list
      drafts.sort((a, b) => (a.artifactKind + a.sector).localeCompare(b.artifactKind + b.sector, 'ar'));
      setRefDrafts(drafts);
      const okN = drafts.filter(d => d.ok).length;
      alertMsg(t(`تم تحليل ${drafts.length} ملف (${okN} مصنّف تلقائيًا). راجِع ثم احفظ.`,
                 `Analyzed ${drafts.length} files (${okN} auto-classified). Review then save.`));
    } catch (e: any) {
      alertMsg(t('فشل التحليل الجماعي: ', 'Batch analysis failed: ') + (e?.message || e));
    } finally { setRefBatchBusy(false); setRefBatchProg(null); }
  };

  const updateRefDraft = (idx: number, patch: Partial<ReferenceDraft>) =>
    setRefDrafts(prev => prev.map((d, i) => i === idx ? { ...d, ...patch } : d));

  const removeRefDraft = (idx: number) =>
    setRefDrafts(prev => prev.filter((_, i) => i !== idx));

  const handleSaveRefDrafts = async () => {
    const usable = refDrafts.filter(d => d.content.trim() && d.name.trim());
    const failed = refDrafts.filter(d => !(d.content.trim() && d.name.trim()));
    if (!usable.length) {
      // Tell the owner WHY each draft can't be saved (empty extraction / missing name),
      // never a blanket "no valid drafts".
      const why = failed.slice(0, 10)
        .map(d => `${d.fileName}: ${d.error || (!d.content.trim() ? t('لا نص مستخرَج', 'no text') : t('بدون اسم', 'no name'))}`)
        .join(' | ');
      alertMsg(t(`لا مسودة صالحة للحفظ${why ? ` — ${why}` : ''}`, `No saveable drafts${why ? ` — ${why}` : ''}`));
      return;
    }
    setBusy(t('حفظ المكتبة', 'Saving library'));
    try {
      let n = 0;
      for (const d of usable) {
        await saveReferenceProject(draftToReferenceProject(d));
        n++;
      }
      setRefDrafts([]);
      await loadAll();
      alertMsg(t(`حُفظ ${n} مرجع في المكتبة (مع توليد المتجهات تلقائيًا).`, `Saved ${n} references (auto-embedded).`));
    } catch (e: any) { alertMsg(t('فشل الحفظ: ', 'Save failed: ') + (e?.message || e)); }
    finally { setBusy(''); }
  };

  // Ported from AdminPanel: generate an executive reality/EFQM diagnostic from the
  // uploaded sources and write it into the shared `assessments` repository — now a
  // governance-pipeline action living in the Library stage.
  const [surveyBusy, setSurveyBusy] = useState(false);
  const triggerAutoSurveyReport = async (feedback?: string) => {
    const targetComp = companyName;
    const reportTitle = docTitle || targetComp;
    // N1 — GROUND the report in real inputs. Pull actual chunks + survey/interview
    // responses. If there is NOTHING to ground on, refuse to fabricate a 70-95 score.
    let chunks: any[] = [];
    try { chunks = await loadChunks(tenantId); } catch { chunks = ingestedChunks || []; }
    const { digest, docNames } = buildChunkDigest(chunks);
    const surveyCtx = assessmentsForSource.length ? buildAssessmentContext() : '';
    if (!digest && !surveyCtx) {
      toast.error(t('لا مدخلات لبناء تقرير الواقع الراهن — ارفع ملفات أو شغّل الاستبيان أولاً.',
                    'No inputs to build the current-state report — upload files or run the survey first.'));
      return;
    }
    setSurveyBusy(true);
    const respCount = assessmentsForSource.length;
    // N6 — interactive shaping: owner-chosen length / depth / axes feed the brief.
    const pagesMap = { concise: 'موجز (~صفحة واحدة، نقاط مركّزة)', standard: 'قياسي (2–3 صفحات)', detailed: 'مفصّل (4–8 صفحات، تحليل لكل محور)', comprehensive: 'شامل استشاري (10–100 صفحة، هيكل McKinsey/PwC بجداول وأبعاد متعمقة وخارطة طريق)' };
    const depthMap = { executive: 'تنفيذي (للإدارة العليا، خلاصات وقرارات)', analytical: 'تحليلي (أدلة + تفسير لكل نقطة)', deep: 'عميق (تحليل جذري + مقارنة معيارية + جداول + أرقام)' };
    const isComprehensive = diagPages === 'comprehensive';
    const axesLine = diagAxes.length ? diagAxes.join('، ') : DIAG_AXES.slice(0, 6).join('، ');
    // A — inject ALL inputs as evaluation lenses, but keep the RESULT grounded only
    // in the company's own evidence (chunks + survey/interviews). Standards, sector
    // and reference projects are CRITERIA/method, never sources of fabricated facts.
    const sectorBlock = industryLens(sector);
    const refsBlock = referenceProjectsBlock(refProjects, sector);
    const stdBlock = standardsLens();
    const comprehensiveStructure = isComprehensive ? `
      هيكل التقرير الاستشاري الشامل (McKinsey/PwC — إلزامي):
      1. ملخص تنفيذي (Executive Summary) — صفحة واحدة: أهم 3 اكتشافات + الدرجة الإجمالية + الأولوية الواحدة.
      2. منهجية التقييم — مصادر البيانات المستخدمة (الوثائق/الاستبيانات)، الأطر المعيارية، قيود التحليل.
      3. صورة الشركة ومحيطها — القطاع، الحجم، الخصائص البارزة من الأدلة.
      4. تحليل كل محور على حدة (لكل محور من: ${axesLine}):
         - الوضع الحالي (مع استشهادات)
         - نقاط القوة الموثّقة
         - الفجوات والتحديات (مسنودة بدليل)
         - المقارنة المعيارية (Benchmarking مقابل المعايير المرجعية)
         - الدرجة (0-100) مع تبرير
      5. مصفوفة الأولويات الاستراتيجية — جدول: المحور / الدرجة / الأولوية / التأثير المتوقع.
      6. خارطة طريق التحسين (Quick wins / Medium-term / Long-term) — جدول.
      7. التوصيات التنفيذية — مرتّبة بالأولوية، لكل توصية: الإجراء + المسؤول المقترح + المدة.
      8. الملاحق — مصادر الأدلة + مسرد المعايير المستخدمة.

      اكتب بعمق استشاري حقيقي: كل ادعاء يحمل مصدره، كل فجوة مرتبطة بمعيار، كل توصية مبرّرة. استخدم جداول Markdown حيثما أضافت وضوحاً.
    ` : '';
    const prompt = `
      أنت مستشار حوكمة مؤسسية من الدرجة الأولى (مستوى McKinsey/PwC/KPMG). أعدّ تقرير «الواقع الراهن» لـ "${targetComp}" مبنيًّا **حصريًّا** على أدلة الشركة الفعلية أدناه (مقتطفات مستنداتها + ملخص ردود استبياناتها/مقابلاتها). ممنوع منعًا باتًا اختلاق أي واقعة أو رقم غير وارد في تلك الأدلة.

      مواصفات التقرير:
      - الطول: ${pagesMap[diagPages]}
      - العمق: ${depthMap[diagDepth]}
      - المحاور التي تُغطّى صراحةً (نظّم القوة/الضعف والدرجات حولها): ${axesLine}
      ${comprehensiveStructure}

      قواعد الإسناد (إلزامية):
      - كل نقطة قوة/ضعف تُسنَد لما ورد فعلاً في الأدلة؛ اذكر اسم المستند/المصدر بين قوسين داخل النص.
      - أي ادعاء بلا دليل في الأدلة = احذفه. لا تعمّم ولا تفترض أن الشركة تقنية.
      - استخدم «المعايير المرجعية» و«عدسة القطاع» كأدوات تقييم فقط: قِس النضج مقابلها واربط كل فجوة بالمعيار المناسب — لكن لا تنقل منها وقائع وكأنها واقع الشركة.
      - استلهم البنية وأفضل الممارسات من «المشاريع المرجعية» كمنهج، دون نقل بيانات شركة أخرى.
      - الدرجات (totalScore و competencyScores و technicalScore و behavioralScore) تعكس نضج ما ورد فعلاً في الأدلة لا أرقامًا اعتباطية؛ ولكل محور competencyScores اذكر evidence (سطر دليل من المدخلات).
      - gaps: لكل فجوة اذكر المعيار (skill)، القيمة المرجعية المعقولة لذلك المعيار (required)، والقيمة الفعلية المستنتجة من الأدلة (actual)، ووصفًا مُسنَدًا (gapDescription). لا فجوات بلا دليل.
      - sources: أسماء المستندات/المصادر التي استشهدت بها فعلاً.

      ${sectorBlock}
      ${stdBlock}
      ${refsBlock}

      ${digest ? `— أدلة من مستندات الشركة (${docNames.length} مستند) —\n${digest}` : '— لا مستندات مرفوعة —'}

      ${surveyCtx ? `— ملخص ردود الاستبيانات/المقابلات (${respCount} مصدر) —\n${surveyCtx}` : '— لا ردود استبيان —'}
      ${feedback && feedback.trim() ? `\n\n      ملاحظات المراجع — أعد الصياغة بدقة أعلى مع مراعاتها حرفيًّا: ${feedback.trim()}` : ''}

      أعد JSON عربيًّا بالحقول: totalScore, technicalScore, behavioralScore (أرقام 0-100), strengths, weaknesses, recommendations, overallGapSummary, developmentPlan, sources (مصفوفة أسماء), competencyScores (مصفوفة {competency, score, evidence}), gaps (مصفوفة {skill, required, actual, gapDescription}).
    `;
    const reportSchema = {
      type: Type.OBJECT,
      properties: {
        totalScore: { type: Type.NUMBER },
        technicalScore: { type: Type.NUMBER },
        behavioralScore: { type: Type.NUMBER },
        strengths: { type: Type.STRING },
        weaknesses: { type: Type.STRING },
        recommendations: { type: Type.STRING },
        overallGapSummary: { type: Type.STRING },
        developmentPlan: { type: Type.STRING },
        sources: { type: Type.ARRAY, items: { type: Type.STRING } },
        competencyScores: {
          type: Type.ARRAY,
          items: { type: Type.OBJECT, properties: { competency: { type: Type.STRING }, score: { type: Type.NUMBER }, evidence: { type: Type.STRING } }, required: ['competency', 'score'] },
        },
        gaps: {
          type: Type.ARRAY,
          items: { type: Type.OBJECT, properties: { skill: { type: Type.STRING }, required: { type: Type.NUMBER }, actual: { type: Type.NUMBER }, gapDescription: { type: Type.STRING } }, required: ['skill', 'gapDescription'] },
        },
      },
      required: ['totalScore', 'strengths', 'weaknesses', 'recommendations'],
    };
    try {
      // retry the grounded call up to 3× — transient API failures shouldn't drop the report.
      // ROUTE through generateJson: it sets thinkingConfig (MEDIUM) so gemini-3.5-flash's
      // default thinking doesn't starve the JSON output to empty (the root cause of the
      // "تعذر إنشاء التقرير" failure), and it handles empty/fenced responses robustly.
      let parsed: any = null; let lastErr: any = null;
      for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
        try {
          const cand = await generateJson<any>(prompt, reportSchema, { temperature: 0.2 });
          if (typeof cand.totalScore !== 'number' || !cand.strengths || !cand.weaknesses || !cand.recommendations) {
            throw new Error('AI returned an incomplete diagnostic (missing score or narrative).');
          }
          parsed = cand;
        } catch (e) { lastErr = e; if (attempt < 2) await new Promise(r => setTimeout(r, 800 * (attempt + 1))); }
      }
      if (!parsed) throw lastErr || new Error('diagnostic failed');

      const clamp = (n: any) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
      const citedSources: string[] = Array.isArray(parsed.sources) && parsed.sources.length
        ? parsed.sources.map((s: any) => String(s)).filter(Boolean)
        : docNames;
      const score = clamp(parsed.totalScore);
      // GROUNDED competency axes — straight from the model's evidence-backed output,
      // no synthetic ×0.9/×1.02 spread. Fall back to the axes covered if none returned.
      const competencyScores = Array.isArray(parsed.competencyScores) && parsed.competencyScores.length
        ? parsed.competencyScores.map((c: any) => ({ competency: String(c.competency || '').trim(), score: clamp(c.score), evidence: c.evidence ? String(c.evidence) : undefined })).filter((c: any) => c.competency)
        : [];
      const competencyGaps = Array.isArray(parsed.gaps)
        ? parsed.gaps.map((g: any) => ({ skill: String(g.skill || '').trim(), required: clamp(g.required ?? 90), actual: clamp(g.actual ?? score), gapDescription: String(g.gapDescription || '').trim() })).filter((g: any) => g.skill && g.gapDescription)
        : [];
      const assessmentId = String(uid('asmt'));
      const customReport = {
        id: assessmentId,
        userId: 'corporate_analyst',
        userName: ar ? `استبيان الواقع الراهن وحوكمة التميز: ${reportTitle}` : `Reality Assessment & Governance: ${reportTitle}`,
        userEmail: 'audit@governance.ai',
        jobTitle: targetComp,
        numQuestions: chunks.length,
        assessmentType: 'survey',
        timestamp: new Date().toISOString(),
        responses: [],
        workplaceAnswers: null,
        // A provenance: record exactly which inputs + lenses grounded this diagnostic.
        sourceProvenance: { docCount: docNames.length, responseCount: respCount, citedDocs: citedSources, sector: sector || '', standardsApplied: true },
        reportData: {
          totalScore: score,
          technicalScore: parsed.technicalScore != null ? clamp(parsed.technicalScore) : score,
          behavioralScore: parsed.behavioralScore != null ? clamp(parsed.behavioralScore) : score,
          strengths: parsed.strengths,
          weaknesses: parsed.weaknesses,
          recommendations: parsed.recommendations,
          sources: citedSources,
          competencyScores,
          gapReport: {
            competencyGaps,
            overallGapSummary: parsed.overallGapSummary ? String(parsed.overallGapSummary) : '',
            developmentPlan: parsed.developmentPlan ? String(parsed.developmentPlan) : '',
          },
          jobFitRatings: [],
        },
      };
      await setDoc(doc(db, 'assessments', assessmentId), customReport);
      setLocalDiagnostic(customReport); // show immediately in the الواقع الراهن stage
      toast.success(t(`✅ تقرير الواقع الراهن مبني على ${docNames.length} مستند + ${respCount} رد ومُقيَّم مقابل المعايير. المصادر: ${citedSources.slice(0,4).join('، ')}${citedSources.length>4?'…':''}`,
                      `✅ Current-state grounded in ${docNames.length} docs + ${respCount} responses, scored vs standards.`));
    } catch (err: any) {
      console.error('Auto survey report failed:', err);
      toast.error(ar ? '⚠️ تعذّر توليد تقرير الواقع الراهن — لم يُحفظ أي تقرير. أعد المحاولة.' : '⚠️ Failed to generate the diagnostic — nothing was saved. Please retry.');
    } finally {
      setSurveyBusy(false);
    }
  };

  const ProvBadge: React.FC<{ refs: ProvenanceRef[] }> = ({ refs }) =>
    refs?.length ? (
      <span className="inline-flex items-center gap-1 text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2 py-0.5"
            title={refs.map(r => `${r.docName || ''} › ${r.label}`).join('\n')}>
        🔗 {refs.length} {t('مصدر', 'src')}
      </span>
    ) : <span className="text-[10px] text-slate-400">{t('بلا سند', 'no source')}</span>;

  const unitName = (id?: string) => model?.orgUnits.find(u => u.id === id)?.name || '—';

  // W7 — most-recent reality diagnostic: the locally-generated one wins (instant), else
  // the latest survey-type assessment carrying reportData from the shared repository.
  const latestDiagnostic = useMemo(() => {
    if (localDiagnostic) return localDiagnostic;
    return [...(allAssessments || [])]
      .filter((a: any) => a?.reportData && (a.assessmentType === 'survey' || a.userName?.includes?.('الواقع')))
      .sort((a: any, b: any) => String(b?.timestamp || '').localeCompare(String(a?.timestamp || '')))[0] || null;
  }, [localDiagnostic, allAssessments]);

  // Project-first gating: every numbered stage requires an active project.
  const canGo = (s: number) =>
    !projectSelected ? false :
    s === 0 ? true :
    s === 6 ? (chunkCount > 0 || !!model) :   // الواقع الراهن — needs indexed sources
    s === 7 ? (chunkCount > 0 || !!model) :   // الهيكل التنظيمي — builds/draws from sources
    s === 1 ? chunkCount > 0 || !!model :
    s === 2 ? !!model :
    s === 3 ? !!model :
    s === 4 ? !!model :
    s === 5 ? !!model :
    true;

  return (
    <div dir={ar ? 'rtl' : 'ltr'} className="fixed inset-0 z-40 bg-slate-100 dark:bg-slate-900 text-slate-800 dark:text-slate-100 flex flex-col animate-fade-in">
      {/* top bar */}
      <header className="shrink-0 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700" style={{boxShadow:'var(--hw-shadow-sm)'}}>
        <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3">
          <div className="min-w-0">
            <h1 className="text-xl font-black text-slate-800 dark:text-slate-100 flex items-center gap-2 tracking-tight">🏛️ {t('مركز الحوكمة', 'Governance Center')}</h1>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
              {t('الشركة', 'Tenant')}: <span className="font-bold text-emerald-600 dark:text-emerald-400">{companyName}</span>
              {sector ? ` · ${sector}` : ''} · {chunkCount} {t('مقطع', 'chunks')}
              {model ? ` · ${t('نموذج v', 'model v')}${model.version}` : ` · ${t('بلا نموذج', 'no model')}`}
            </p>
          </div>
          <button onClick={onBack} className="hw-btn hw-btn-sm hw-btn-ghost shrink-0">
            ← {t('بوابة الإدارة', 'Admin Hub')}
          </button>
        </div>
        {/* pill stage nav */}
        <nav className="px-3 sm:px-5 pb-3 overflow-x-auto">
          <div className="hw-tabs-pill inline-flex">
            {/* Stage 0 — المشاريع (project-first gate, always reachable) */}
            <button onClick={() => setShowProjects(true)}
              className={`hw-tab-pill${showProjects ? ' hw-tab-active' : ''}`}>
              <span className={`inline-flex items-center justify-center w-4.5 h-4.5 rounded-full text-[10px] font-black leading-none px-1.5 py-0.5 ${showProjects ? 'bg-white/20 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400'}`}>1</span>
              <span>🏢 {t('المشاريع', 'Projects')}</span>
            </button>
            {STAGES.map((s, i) => {
              const active = !showProjects && stage === s.id;
              const enabled = canGo(s.id);
              // bug 15: explain WHY a stage is locked instead of a dead, silent tab.
              const lockReason = enabled ? undefined
                : !projectSelected ? t('اختر مشروعاً نشطاً أولاً.', 'Select an active project first.')
                : (s.id === 6 || s.id === 7) ? t('افهرس المصادر أولاً لفتح هذه المرحلة.', 'Index sources first to unlock this stage.')
                : t('ابنِ نموذج الحوكمة أولاً لفتح هذه المرحلة.', 'Build the governance model first to unlock this stage.');
              return (
                <button key={s.id} onClick={() => enabled && gotoStage(s.id)} disabled={!enabled} title={lockReason}
                  className={`hw-tab-pill${active ? ' hw-tab-active' : ''}`}>
                  <span className={`inline-flex items-center justify-center rounded-full text-[10px] font-black leading-none px-1.5 py-0.5 ${active ? 'bg-white/20 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400'}`}>{i + 2}</span>
                  <span>{s.icon} {t(s.ar, s.en)}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </header>

      {/* P0-1: persistent authorization / data-failure banner — stays until a load succeeds */}
      {permissionError && (
        <div className="shrink-0 px-4 sm:px-6 py-2.5 bg-rose-50 dark:bg-rose-900/30 border-b border-rose-300 dark:border-rose-700">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="font-bold text-rose-700 dark:text-rose-300 text-sm flex items-center gap-2">
              ⛔ {t('أنت غير مخوّل لحفظ/تحميل بيانات الحوكمة. سجّل الدخول بحساب أدمن معتمد.',
                    'Not authorized to save/load governance data. Sign in with an approved admin account.')}
            </span>
            <span className="flex items-center gap-2 shrink-0">
              {!auth.currentUser && (
                <button
                  onClick={async () => {
                    try {
                      await signInWithPopup(auth, new GoogleAuthProvider());
                      setPermissionError(false);
                      await loadAll();
                      toast.success(t('تم تسجيل الدخول — أعيد تحميل البيانات', 'Signed in — data reloaded'));
                    } catch (e: any) {
                      console.warn('banner sign-in failed', e?.code, e);
                      toast.error(t(`فشل تسجيل الدخول${e?.code ? ` (${e.code})` : ''}`, `Sign-in failed${e?.code ? ` (${e.code})` : ''}`));
                    }
                  }}
                  className="text-xs bg-emerald-600 text-white px-3 py-1 rounded-lg font-bold"
                >
                  🔑 {t('تسجيل الدخول', 'Sign in')}
                </button>
              )}
              <button onClick={() => loadAll()} className="text-xs bg-rose-600 text-white px-3 py-1 rounded-lg font-bold">
                ↻ {t('إعادة المحاولة', 'Retry')}
              </button>
            </span>
          </div>
        </div>
      )}

      {/* busy banner */}
      {(busy || progress) && (
        <div className="shrink-0 px-4 sm:px-6 py-2 bg-emerald-50 dark:bg-emerald-900/30 border-b border-emerald-200 dark:border-emerald-800">
          <div className="flex items-center justify-between">
            <span className="font-bold text-emerald-700 dark:text-emerald-300 text-sm flex items-center gap-2"><span className="animate-spin">⏳</span> {busy}</span>
            <button onClick={stop} className="text-xs bg-rose-600 text-white px-3 py-1 rounded-lg font-bold">⏹ {t('إيقاف', 'Stop')}</button>
          </div>
          {progress && (
            <div className="mt-1.5">
              {(['ingest','embed','sentiment','entities'] as const).includes(progress.phase as any) && (
                <div className="flex items-center gap-1 mb-1.5 flex-wrap">
                  {([
                    { k: 'ingest', ar: '📄 تقطيع', en: '📄 Chunk' },
                    { k: 'embed', ar: '🧬 متجهات', en: '🧬 Embed' },
                    { k: 'sentiment', ar: '🎭 النبرة', en: '🎭 Sentiment' },
                    { k: 'entities', ar: '🕸️ الكيانات', en: '🕸️ Entities' },
                  ] as const).map((p, idx, arr) => {
                    const order = arr.findIndex(x => x.k === progress.phase);
                    const state = idx < order ? 'done' : idx === order ? 'active' : 'todo';
                    return (
                      <span key={p.k} className={`text-[9px] font-bold px-2 py-0.5 rounded-full border ${state === 'active' ? 'bg-emerald-600 text-white border-emerald-600 animate-pulse' : state === 'done' ? 'bg-emerald-100 text-emerald-700 border-emerald-300' : 'bg-slate-100 text-slate-400 border-slate-200'}`}>
                        {state === 'done' ? '✓ ' : ''}{ar ? p.ar : p.en}
                      </span>
                    );
                  })}
                </div>
              )}
              <div className="text-[11px] text-slate-600 mb-1">{progress.label}</div>
              <div className="h-2 bg-emerald-100 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progress.total ? Math.round(progress.current / progress.total * 100) : 0}%` }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* stage content */}
      <main className="flex-1 overflow-auto p-4 sm:p-6">
        <div className="max-w-6xl mx-auto">

          {/* STAGE 0 — المشاريع (project-first gate) */}
          {showProjects && (
            <ProjectsStage settings={settings} language={language} onUpdateSettings={onUpdateSettings}
              onOpenProject={() => gotoStage(0)} />
          )}

          {/* STAGE 0 — sources */}
          {!showProjects && stage === 0 && (
            <section className="space-y-5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <StageHead icon="📥" title={t(`مصادر الحوكمة · ${companyName}`, `Governance sources · ${companyName}`)}
                  desc={t('ثلاث فئات تُغذّي بناء النموذج: مركز ملفات المشروع · مشاريع مرجعية · مخرجات الاستبيانات. الملفات معزولة لكل مشروع. استبعد أي مصدر من المشاركة في البناء بالضغط على 🚫.', 'Three categories feed the model build: project file center · reference projects · survey outputs. Files are isolated per project. Exclude any source from the build with 🚫.')} />
                <div className="flex gap-1 shrink-0 mt-1">
                  <button onClick={() => setSrcView('list')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all ${srcView === 'list' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-slate-800 text-slate-500 border-slate-200 dark:border-slate-700'}`}>
                    ☰ {t('قائمة', 'List')}
                  </button>
                  <button onClick={() => setSrcView('map')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all ${srcView === 'map' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-slate-800 text-slate-500 border-slate-200 dark:border-slate-700'}`}>
                    🗺️ {t('خريطة', 'Map')}
                  </button>
                </div>
              </div>

              {/* Hidden file/folder pickers — mounted in BOTH list & map views so
                  the map-view "إضافة ملف" / "رفع مجلد" buttons have live refs. */}
              <input ref={fileRef} type="file" multiple className="hidden" onChange={handleFileUpload}
                accept=".txt,.md,.csv,.json,.xml,.htm,.html,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.mp3,.m4a,.wav,.ogg,.aac,.flac,.webm,.opus,audio/*" />
              {/* whole-folder picker — webkitdirectory attr set imperatively in effect */}
              <input ref={folderRef} type="file" multiple className="hidden" onChange={handleFolderUpload} />

              {/* ── MAP VIEW ─────────────────────────────────── */}
              {srcView === 'map' && (
                <div dir="rtl" className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5 space-y-4">
                  <div>
                    <div className="text-xs font-black text-slate-500 dark:text-slate-400 uppercase tracking-wide">{t('معمارية المدخلات والمسار', 'Inputs & pipeline architecture')}</div>
                    <div className="text-[12px] text-slate-500 dark:text-slate-400 mt-1">{t('أربعة مدخلات مستقلة تتجمّع في «تقرير الواقع الراهن»، ثم يتدفّق المسار باستمرار إلى «الهيكل التنظيمي» فـ«البناء».', 'Four independent inputs converge into the current-state report, then flow continuously into structure, then build.')}</div>
                  </div>

                  {/* ── 4 parallel INPUTS (RTL grid) ── */}
                  <div className="text-[11px] font-black text-slate-400 dark:text-slate-500">① {t('المدخلات (مستقلة)', 'Inputs (independent)')}</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                    {/* Input 1 — surveys & interviews */}
                    <div className="rounded-xl border-2 border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/10 p-3 space-y-2 flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">📊</span>
                        <span className="font-black text-amber-700 dark:text-amber-300 text-sm leading-tight">{t('الاستبيانات والمقابلات', 'Surveys & interviews')}</span>
                        <span className="mr-auto text-[11px] font-mono text-amber-600 dark:text-amber-400">{assessmentsForSource.length}</span>
                      </div>
                      <div className="space-y-1 max-h-40 overflow-auto flex-1">
                        {assessmentsForSource.slice(0, 8).map((a: any, i: number) => (
                          <div key={a.id || i} className="flex items-center gap-2 text-xs rounded-lg px-2 py-1 bg-white dark:bg-slate-900 border border-amber-100 dark:border-amber-900">
                            <span className="truncate flex-1 text-slate-700 dark:text-slate-200">{a.userName || a.jobTitle}</span>
                            <span className="text-[10px] text-amber-600 dark:text-amber-400">{a.assessmentType === 'survey' ? (ar ? 'استبيان' : 'survey') : (ar ? 'تقييم' : 'assess')}</span>
                          </div>
                        ))}
                        {assessmentsForSource.length > 8 && <div className="text-amber-500 text-[10px] text-center">+{assessmentsForSource.length - 8} {t('أخرى', 'more')}</div>}
                        {!assessmentsForSource.length && <div className="text-slate-400 text-xs">{t('لا ردود بعد', 'No responses yet')}</div>}
                      </div>
                      <label className="flex items-center gap-2 w-full text-xs font-bold text-amber-600 border border-amber-200 dark:border-amber-700 rounded-lg py-1.5 px-2 cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-900/40">
                        <input type="checkbox" checked={injectAssessments} onChange={e => setInjectAssessments(e.target.checked)} className="w-3.5 h-3.5 accent-amber-600" />
                        {t('حقن في التقرير', 'Inject into report')}
                      </label>
                    </div>

                    {/* Input 2 — files & attachments */}
                    <div className="rounded-xl border-2 border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 p-3 space-y-2 flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">📁</span>
                        <span className="font-black text-emerald-700 dark:text-emerald-300 text-sm leading-tight">{t('الملفات والمرفقات', 'Files & attachments')}</span>
                        <span className="mr-auto text-[11px] font-mono text-emerald-600 dark:text-emerald-400">{documents.length - excludedDocIds.size}/{documents.length}</span>
                      </div>
                      <div className="space-y-1 max-h-40 overflow-auto flex-1">
                        {documents.map(d => (
                          <div key={d.id} className={`flex items-center gap-2 text-xs rounded-lg px-2 py-1 border ${excludedDocIds.has(d.id) ? 'opacity-40 bg-rose-50 dark:bg-rose-900/10 border-rose-200 dark:border-rose-800' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'}`}>
                            <span className="truncate flex-1 text-slate-700 dark:text-slate-200">{d.name}</span>
                            <button title={excludedDocIds.has(d.id) ? t('تضمين', 'Include') : t('استبعاد', 'Exclude')}
                              onClick={() => setExcludedDocIds(prev => { const n = new Set(prev); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n; })}
                              className="shrink-0 text-base">{excludedDocIds.has(d.id) ? '✅' : '🚫'}</button>
                          </div>
                        ))}
                        {!documents.length && <div className="text-slate-400 text-xs">{t('لا ملفات بعد', 'No files yet')}</div>}
                      </div>
                      <div className="flex gap-1.5">
                        <button onClick={() => fileRef.current?.click()} disabled={extracting || !!busy}
                          className="flex-1 text-xs font-bold text-emerald-600 border border-emerald-200 dark:border-emerald-700 rounded-lg py-1.5 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 disabled:opacity-50">
                          ⬆️ {t('ملف', 'File')}
                        </button>
                        <button onClick={() => folderRef.current?.click()} disabled={extracting || !!busy}
                          className="flex-1 text-xs font-bold text-emerald-600 border border-emerald-200 dark:border-emerald-700 rounded-lg py-1.5 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 disabled:opacity-50">
                          📁 {t('مجلد', 'Folder')}
                        </button>
                      </div>
                    </div>

                    {/* Input 3 — standards (alone) */}
                    <div className="rounded-xl border-2 border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-900/10 p-3 space-y-2 flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">📏</span>
                        <span className="font-black text-violet-700 dark:text-violet-300 text-sm leading-tight">{t('المعايير لوحدها', 'Standards alone')}</span>
                      </div>
                      <div className="space-y-1 max-h-40 overflow-auto flex-1">
                        {['ISO', 'COSO', 'EFQM', t('التنظيمات', 'Regulations'), t('المعايير المهنية', 'Professional bodies')].map((s, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs rounded-lg px-2 py-1 bg-white dark:bg-slate-900 border border-violet-100 dark:border-violet-900">
                            <span className="truncate flex-1 text-slate-700 dark:text-slate-200">{s}</span>
                            <span className="text-[10px] text-violet-500">{t('معيار تقييم', 'criterion')}</span>
                          </div>
                        ))}
                      </div>
                      <button onClick={handleSeedStandards} disabled={!!seedBusy}
                        className="w-full text-xs font-bold text-violet-600 border border-violet-200 dark:border-violet-700 rounded-lg py-1.5 hover:bg-violet-100 dark:hover:bg-violet-900/40 disabled:opacity-50">
                        {seedBusy ? '⏳' : '📥 ' + t('تحميل خريطة المعايير', 'Seed standards map')}
                      </button>
                    </div>

                    {/* Input 4 — reference projects */}
                    <div className="rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-3 space-y-2 flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">🏛️</span>
                        <span className="font-black text-slate-700 dark:text-slate-200 text-sm leading-tight">{t('المشاريع المرجعية', 'Reference projects')}</span>
                        <span className="mr-auto text-[11px] font-mono text-slate-500">{refProjects.length}</span>
                      </div>
                      <div className="space-y-1 max-h-40 overflow-auto flex-1">
                        {refProjects.map(p => (
                          <div key={p.id} className="flex items-center gap-2 text-xs rounded-lg px-2 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                            <span className="truncate flex-1 text-slate-700 dark:text-slate-200">{p.name}</span>
                            <span className="text-emerald-500 text-[10px]">{p.sector || ''}</span>
                          </div>
                        ))}
                        {!refProjects.length && <div className="text-slate-400 text-xs">{t('لا مشاريع مرجعية', 'No ref projects')}</div>}
                      </div>
                      <button onClick={() => setStage(4)} className="w-full text-xs font-bold text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 rounded-lg py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700">
                        + {t('إدارة في المكتبة', 'Manage in library')}
                      </button>
                    </div>
                  </div>

                  {/* ── convergence ── */}
                  <div className="flex flex-col items-center gap-0.5">
                    <span className="text-2xl text-slate-300 dark:text-slate-600 leading-none">↓</span>
                    <span className="text-[11px] font-black text-slate-400 dark:text-slate-500">{t('تتجمّع كلها في', 'all converge into')}</span>
                  </div>

                  {/* ── current-state report node (full width) ── */}
                  <button onClick={() => gotoStage(6)} className="w-full rounded-xl border-2 border-emerald-400 dark:border-emerald-600 bg-emerald-100 dark:bg-emerald-900/30 p-3 flex items-center justify-center gap-3 hover:bg-emerald-200 dark:hover:bg-emerald-900/50 transition-colors">
                    <span className="text-2xl">📋</span>
                    <span className="font-black text-emerald-700 dark:text-emerald-300 text-base">② {t('تقرير الواقع الراهن', 'Current-state report')}</span>
                    {chunkCount > 0 && <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400">{chunkCount} {t('مقطع', 'chunks')}</span>}
                  </button>

                  {/* ── continuous pipeline (RTL): report ← structure ← build ── */}
                  <div className="flex flex-col items-center gap-0.5">
                    <span className="text-2xl text-slate-300 dark:text-slate-600 leading-none">↓</span>
                    <span className="text-[11px] font-black text-slate-400 dark:text-slate-500">{t('ثم يتدفّق باستمرار', 'then flows continuously')}</span>
                  </div>
                  <div className="flex items-stretch gap-2">
                    <button onClick={() => gotoStage(7)} className="flex-1 rounded-xl border-2 border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 p-3 flex flex-col items-center gap-1 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors">
                      <span className="text-xl">🏗️</span>
                      <span className="font-black text-blue-700 dark:text-blue-300 text-sm">③ {t('الهيكل التنظيمي', 'Org structure')}</span>
                    </button>
                    <div className="flex items-center text-2xl text-slate-300 dark:text-slate-600">←</div>
                    <button onClick={() => gotoStage(2)} className="flex-1 rounded-xl border-2 border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 flex flex-col items-center gap-1 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors">
                      <span className="text-xl">🧱</span>
                      <span className="font-black text-amber-700 dark:text-amber-300 text-sm">④ {t('البناء', 'Build')}</span>
                    </button>
                  </div>

                  {/* Action bar */}
                  <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100 dark:border-slate-700">
                    <button onClick={handleIngest} disabled={!!busy || generating}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-sm disabled:opacity-50">
                      ↻ {t('فهرسة المصادر', 'Index sources')}
                    </button>
                    {excludedDocIds.size > 0 && (
                      <button onClick={() => setExcludedDocIds(new Set())}
                        className="px-4 py-2 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-sm">
                        ✅ {t('تضمين الكل', 'Include all')} (-{excludedDocIds.size})
                      </button>
                    )}
                    <span className="self-center text-xs text-slate-500 dark:text-slate-400 font-mono">
                      {chunkCount} {t('مقطع مفهرس', 'indexed chunks')}
                    </span>
                  </div>
                </div>
              )}

              {/* ── LIST VIEW ─────────────────────────────────── */}
              {srcView === 'list' && (<>

              {/* الفئة 1 — ملفات الشركة والملفات السابقة */}
              <div className="text-xs font-black text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5 pt-1">
                <span className="text-base">📁</span> {t('١ · مركز ملفات المشروع', '1 · Project file center')}
              </div>
              <div className="grid sm:grid-cols-4 gap-3">
                <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                  <div className="text-3xl font-black text-emerald-600 dark:text-emerald-400">{documents.length}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{t('وثيقة متاحة', 'docs available')}</div>
                </div>
                <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                  <div className="text-3xl font-black text-emerald-600 dark:text-emerald-400">{chunkCount}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{t('مقطع مفهرس', 'indexed chunks')}</div>
                </div>
                <button onClick={() => fileRef.current?.click()} disabled={extracting || !!busy}
                  className="rounded-2xl border-2 border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/30 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 p-4 text-start disabled:opacity-50 transition-colors">
                  <div className="text-lg font-black text-emerald-700 dark:text-emerald-300">{extracting ? '⏳' : '⬆️'} {t('رفع ملفات', 'Upload files')}</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{extracting ? t('استخلاص…', 'extracting…') : t('ملف واحد للمعاينة · عدة ملفات = فهرسة تلقائية', 'one to review · many = auto-index')}</div>
                </button>
                <button onClick={() => folderRef.current?.click()} disabled={extracting || !!busy}
                  className="rounded-2xl border-2 border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/30 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 p-4 text-start disabled:opacity-50 transition-colors">
                  <div className="text-lg font-black text-emerald-700 dark:text-emerald-300">📁 {t('رفع مجلد كامل', 'Upload folder')}</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{t('المجلد كله دفعة واحدة · فهرسة تلقائية بلا اختيار', 'whole folder at once · auto-index, no picking')}</div>
                </button>
                <button onClick={handleIngest} disabled={!!busy || generating}
                  className="rounded-2xl border-2 border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/30 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 p-4 text-start disabled:opacity-50 transition-colors">
                  <div className="text-lg font-black text-emerald-700 dark:text-emerald-300">↻ {t('استيراد / فهرسة', 'Ingest / index')}</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{t('تقطيع + متجهات + كيانات', 'chunk + vectors + entities')}</div>
                </button>
              </div>

              {/* Indexed documents list — shows after ingest */}
              {ingestedChunks.length > 0 && (() => {
                const seen = new Map<string, DocChunk>();
                for (const c of ingestedChunks) if (!seen.has(c.docId)) seen.set(c.docId, c);
                const byDoc = Array.from(seen.values());
                return (
                  <div className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 p-4">
                    <div className="font-bold text-emerald-700 dark:text-emerald-300 text-sm mb-2">
                      ✅ {t('الوثائق المفهرسة', 'Indexed documents')} ({byDoc.length})
                    </div>
                    <div className="space-y-1 max-h-[28vh] overflow-auto">
                      {byDoc.map(c => (
                        <div key={c.docId} className="flex items-center justify-between gap-2 text-sm py-1 border-b border-emerald-100 dark:border-emerald-800/40 last:border-0">
                          <span className="truncate text-slate-700 dark:text-slate-200">📄 {c.docName}</span>
                          <span className="text-[11px] text-emerald-600 dark:text-emerald-400 shrink-0 font-mono">
                            {ingestedChunks.filter(x => x.docId === c.docId).length} {t('مقطع', 'chunks')}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Manual paste — for content without a file (single place, same ingest pipeline) */}
              <details className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                <summary className="font-bold text-slate-700 dark:text-slate-200 text-sm cursor-pointer">✍️ {t('لصق نص يدوي (بدون ملف)', 'Paste text manually (no file)')}</summary>
                <div className="mt-3 space-y-2">
                  <input value={pasteName} onChange={e => setPasteName(e.target.value)} placeholder={t('اسم المستند', 'Document name')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-sm font-bold" />
                  <div className="flex gap-2 flex-wrap">
                    {(['identity','current_state','general','infrastructure'] as DocCategory[]).map(c => (
                      <button key={c} onClick={() => setPasteCat(c)}
                        className={`px-3 py-1 rounded-lg text-xs font-bold border ${pasteCat === c ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-600'}`}>
                        {CAT_LABEL(c, ar)}
                      </button>
                    ))}
                  </div>
                  <textarea value={pasteContent} onChange={e => setPasteContent(e.target.value)} rows={6} placeholder={t('الصق المحتوى هنا…', 'Paste content here…')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-sm" />
                  <button onClick={() => {
                    if (!pasteName.trim() || !pasteContent.trim()) { alertMsg(t('أدخل اسماً ومحتوى.', 'Enter a name and content.')); return; }
                    setExtracted({ name: pasteName.trim(), content: pasteContent.trim(), category: pasteCat, size: `${Math.round(pasteContent.length / 1024)} KB`, type: 'text/plain' });
                    setPasteName(''); setPasteContent('');
                  }} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-sm">
                    {t('مراجعة ثم حفظ', 'Review then save')}
                  </button>
                </div>
              </details>

              {extracted && (
                <div className="rounded-2xl border-2 border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/20 p-4 space-y-2">
                  <div className="font-bold text-emerald-800 dark:text-emerald-200 text-sm">✨ {t('مراجعة المستند قبل الحفظ', 'Review document before saving')}</div>
                  <input value={extracted.name} onChange={e => setExtracted({ ...extracted, name: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-sm font-bold" placeholder={t('اسم المستند', 'Document name')} />
                  <div className="flex gap-2 flex-wrap">
                    {(['identity','current_state','general','infrastructure'] as DocCategory[]).map(c => (
                      <button key={c} onClick={() => setExtracted({ ...extracted, category: c })}
                        className={`px-3 py-1 rounded-lg text-xs font-bold border ${extracted.category === c ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-600'}`}>
                        {CAT_LABEL(c, ar)}
                      </button>
                    ))}
                  </div>
                  <textarea value={extracted.content} onChange={e => setExtracted({ ...extracted, content: e.target.value })} rows={6}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-sm" />
                  <div className="flex gap-2">
                    <button onClick={confirmExtracted} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-sm">{t('حفظ بالسحابة', 'Save to cloud')}</button>
                    <button onClick={() => setExtracted(null)} className="px-4 py-2 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-lg text-sm">{t('إلغاء', 'Cancel')}</button>
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                <div className="font-bold text-slate-700 dark:text-slate-200 text-sm mb-2">{t('الوثائق', 'Documents')}</div>
                <div className="space-y-1 max-h-[40vh] overflow-auto">
                  {documents.map(d => (
                    <div key={d.id} className={`flex items-center justify-between gap-2 text-sm py-1 border-b border-slate-100 dark:border-slate-700 ${excludedDocIds.has(d.id) ? 'opacity-50' : ''}`}>
                      <span className="truncate text-slate-700 dark:text-slate-200">{d.name}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[11px] text-slate-400">{(d.content || '').length} {t('حرف', 'chars')}</span>
                        <button title={excludedDocIds.has(d.id) ? t('تضمين في البناء', 'Include in build') : t('استبعاد من البناء', 'Exclude from build')}
                          onClick={() => setExcludedDocIds(prev => { const n = new Set(prev); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n; })}
                          className="text-base leading-none">{excludedDocIds.has(d.id) ? '✅' : '🚫'}</button>
                        <button onClick={async () => { if (confirm(t('حذف هذه الوثيقة؟', 'Delete this document?'))) { await onDeleteDocument(d.id); await deleteDocChunks(tenantId, d.id).catch(() => {}); await loadAll(); } }}
                          className="text-rose-400 hover:text-rose-600 text-xs">🗑</button>
                      </span>
                    </div>
                  ))}
                  {!documents.length && <div className="text-slate-400 text-sm">{t('لا توجد وثائق. ارفع ملفًا للبدء.', 'No documents. Upload a file to start.')}</div>}
                </div>
              </div>

              {/* الفئة 2 — قوالب ونماذج مشاريع سابقة */}
              <div className="text-xs font-black text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5 pt-2">
                <span className="text-base">📐</span> {t('٢ · قوالب ونماذج مشاريع سابقة', '2 · Templates from previous projects')}
              </div>
              <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 flex items-center justify-between gap-3">
                <div className="flex gap-6">
                  <div>
                    <div className="text-2xl font-black text-emerald-600 dark:text-emerald-400">{refProjects.filter(p => !p.id.startsWith('std_')).length}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{t('مشروع مرجعي', 'reference projects')}</div>
                  </div>
                  <div>
                    <div className="text-2xl font-black text-indigo-600 dark:text-indigo-400">{refProjects.filter(p => p.id.startsWith('std_')).length}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{t('معيار مرجعي', 'standards')}</div>
                  </div>
                </div>
                <button onClick={() => setStage(4)} className="px-4 py-2 rounded-lg text-xs font-bold border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 whitespace-nowrap">
                  {t('إدارة في المكتبة ←', 'Manage in Library ←')}
                </button>
              </div>

              {/* الفئة 3 — مخرجات الاستبيانات والتقييمات */}
              <div className="text-xs font-black text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5 pt-2">
                <span className="text-base">📊</span> {t('٣ · مخرجات الاستبيانات والتقييمات', '3 · Survey & assessment outputs')}
              </div>
              <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-xs text-slate-500 dark:text-slate-400 max-w-md">
                    {t('نتائج تقييمات الموظفين والاستبيانات (نقاط القوة/الضعف/الفجوات/التوصيات) تُستخدم كمصدر بيانات يُحقن في بناء النموذج.', 'Employee assessment & survey results (strengths/weaknesses/gaps/recommendations) used as a source injected into model build.')}
                  </div>
                  <label className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-200 cursor-pointer shrink-0">
                    <input type="checkbox" checked={injectAssessments} onChange={e => setInjectAssessments(e.target.checked)}
                      className="w-4 h-4 accent-emerald-600" />
                    {t('حقن في بناء النموذج', 'Inject into model build')}
                  </label>
                </div>
                <div className="space-y-1 max-h-[34vh] overflow-auto">
                  {assessmentsForSource.map((a: any, i: number) => {
                    const r = a.reportData || {};
                    const isSurvey = a.assessmentType === 'survey';
                    const isWritten = a.sourceType === 'written_paper';
                    return (
                      <details key={a.id || i} className="border-b border-slate-100 dark:border-slate-700 last:border-0">
                        <summary className="flex items-center justify-between gap-2 text-sm py-1.5 cursor-pointer list-none">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className={`inline-block px-1.5 py-0.5 text-[9px] font-black rounded uppercase leading-none shrink-0 ${isSurvey ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'}`}>
                              {isWritten ? '📄' : isSurvey ? (ar ? 'استبيان' : 'survey') : (ar ? 'تقييم' : 'assess')}
                            </span>
                            <span className="truncate text-slate-700 dark:text-slate-200">{a.userName || a.jobTitle}</span>
                          </span>
                          <span className="flex items-center gap-2 shrink-0">
                            {typeof r.totalScore === 'number' && <span className="text-[11px] font-black text-emerald-600 dark:text-emerald-400">{Math.round(r.totalScore)}%</span>}
                            <span className="text-[10px] text-slate-400">{a.timestamp ? new Date(a.timestamp).toLocaleDateString(ar ? 'ar-EG' : 'en-US') : ''}</span>
                            <button onClick={async (e) => { e.preventDefault(); if (confirm(t('حذف هذا التقييم؟', 'Delete this assessment?'))) { await deleteDoc(doc(db, 'assessments', a.id)).catch(() => {}); await loadAll(); } }}
                              className="text-rose-400 hover:text-rose-600 text-xs leading-none">🗑</button>
                          </span>
                        </summary>
                        <div className="pb-2 ps-2 text-xs text-slate-600 dark:text-slate-300 space-y-0.5">
                          {r.strengths && <div>💪 {r.strengths}</div>}
                          {r.weaknesses && <div>⚠️ {r.weaknesses}</div>}
                          {r.recommendations && <div>🎯 {r.recommendations}</div>}
                          {isWritten && a.sourceFile && <div className="text-slate-400">📄 {a.sourceFile}</div>}
                        </div>
                      </details>
                    );
                  })}
                  {!assessmentsForSource.length && <div className="text-slate-400 text-sm">{t('لا توجد مخرجات تقييمات بعد — شغّل تقييماً أو ولّد تقرير تميز من المكتبة.', 'No assessment outputs yet — run an assessment or generate a diagnostic in the Library.')}</div>}
                </div>
                {/* Written assessment upload */}
                <input ref={writtenAssessInputRef} type="file" multiple className="hidden"
                  accept="image/*,.pdf,.jpg,.jpeg,.png,.webp"
                  onChange={e => handleUploadWrittenAssessment(e.target.files)} />
                <button onClick={() => writtenAssessInputRef.current?.click()} disabled={uploadingWrittenAssess}
                  className="mt-1 w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-dashed border-emerald-300 dark:border-emerald-700 bg-emerald-50/40 dark:bg-emerald-900/10 text-emerald-700 dark:text-emerald-300 text-xs font-bold hover:bg-emerald-50 disabled:opacity-50">
                  {uploadingWrittenAssess ? '⏳ ' + t('يحلّل التقييم الورقي…', 'Analysing paper assessment…') : '📄 ' + t('رفع تقييم ورقي (صورة/PDF)', 'Upload written assessment (image/PDF)')}
                </button>
              </div>
              </>)}

              {/* P0-3: real workflow gate. 0 chunks → disabled with reason. chunks but no
                  model → build automatically then navigate. model exists → navigate. */}
              <StageNav
                next={() => gotoStage(6)}
                nextDisabled={(chunkCount === 0 && !model) || !!busy}
                nextLabel={chunkCount === 0 && !model
                  ? t('افهرس المصادر أولاً', 'Index sources first')
                  : t('التالي: الواقع الراهن', 'Next: current state')}
                nextTitle={chunkCount === 0 && !model
                  ? t('لا توجد مقاطع مفهرسة — شغّل «استيراد الوثائق» لفهرسة المصادر أولاً.',
                      'No indexed chunks — run "Ingest documents" to index sources first.')
                  : undefined}
                ar={ar} />
            </section>
          )}

          {/* STAGE 6 — الواقع الراهن (detailed diagnostic + feedback canvas) */}
          {!showProjects && stage === 6 && (
            <section className="space-y-5">
              <StageHead icon="📊" title={t('الواقع الراهن', 'Current state')}
                desc={t('تقرير تشخيصي مرجعي دقيق يتقاطع مصادر الشركة + المعايير + مخرجات الاستبيان، يغطّي القوة والضعف والفجوات والتوصيات. راجِع وعلّق قبل المتابعة.', 'A precise reference diagnostic crossing company sources + standards + survey outputs — strengths, weaknesses, gaps, recommendations. Review and comment before continuing.')} />

              {/* N6 — interactive shaping: length · depth · axes before generating */}
              <details open={diagOptsOpen} onToggle={(e) => setDiagOptsOpen((e.target as HTMLDetailsElement).open)} className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                <summary className="font-bold text-slate-800 dark:text-slate-100 text-sm cursor-pointer">⚙️ {t('خيارات التقرير (طول · عمق · محاور)', 'Report options (length · depth · axes)')}</summary>
                <div className="mt-3 space-y-3">
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div>
                      <div className="text-[11px] font-bold text-slate-500 mb-1">{t('الطول', 'Length')}</div>
                      <div className="flex gap-1.5">
                        {([['concise', 'موجز'], ['standard', 'قياسي'], ['detailed', 'مفصّل'], ['comprehensive', 'شامل استشاري']] as const).map(([v, lbl]) => (
                          <button key={v} onClick={() => setDiagPages(v)} className={`flex-1 px-2 py-1.5 text-xs font-bold rounded-lg border ${diagPages === v ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-600'}`}>{t(lbl, v)}</button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-bold text-slate-500 mb-1">{t('العمق', 'Depth')}</div>
                      <div className="flex gap-1.5">
                        {([['executive', 'تنفيذي'], ['analytical', 'تحليلي'], ['deep', 'عميق']] as const).map(([v, lbl]) => (
                          <button key={v} onClick={() => setDiagDepth(v)} className={`flex-1 px-2 py-1.5 text-xs font-bold rounded-lg border ${diagDepth === v ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-600'}`}>{t(lbl, v)}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-bold text-slate-500 mb-1">{t('المحاور المطلوبة', 'Axes to cover')} <span className="text-slate-400">({diagAxes.length})</span></div>
                    <div className="flex flex-wrap gap-1.5">
                      {DIAG_AXES.map(ax => {
                        const on = diagAxes.includes(ax);
                        return <button key={ax} onClick={() => setDiagAxes(on ? diagAxes.filter(x => x !== ax) : [...diagAxes, ax])} className={`px-2.5 py-1 text-[11px] font-bold rounded-full border ${on ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700' : 'bg-slate-50 dark:bg-slate-700 text-slate-500 border-slate-200 dark:border-slate-600'}`}>{on ? '✓ ' : ''}{ax}</button>;
                      })}
                    </div>
                  </div>
                </div>
              </details>

              <div className="flex flex-wrap gap-2">
                <button onClick={() => triggerAutoSurveyReport(diagFeedback)} disabled={surveyBusy || (chunkCount === 0 && !model)} className={UI.btnPrimary + ' whitespace-nowrap'}>
                  {surveyBusy ? t('⏳ يولّد التقرير…', '⏳ Generating…') : latestDiagnostic ? t('♻️ إعادة توليد التقرير', '♻️ Regenerate report') : t('🚀 توليد تقرير الواقع الراهن', '🚀 Generate diagnostic')}
                </button>
                {latestDiagnostic?.reportData && (
                  <button onClick={exportDiagnosticPdf} disabled={surveyBusy} className={UI.btnGhost + ' whitespace-nowrap'}
                    title={t('تصدير التقرير PDF مرتّب بهوية الشركة (الشعار + الاسم)', 'Export an organized PDF with the company identity (logo + name)')}>
                    {t('📄 تصدير PDF بالهوية', '📄 Export branded PDF')}
                  </button>
                )}
                {chunkCount === 0 && !model && <span className="text-xs text-amber-600 self-center">{t('افهرس المصادر أولاً من مرحلة المدخلات.', 'Index sources first from the Inputs stage.')}</span>}
              </div>

              {latestDiagnostic?.reportData ? (() => {
                const rd = latestDiagnostic.reportData;
                return (
                  <div className="space-y-4">
                    <div className={UI.sectionAccent + ' flex items-center justify-between'}>
                      <div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">{t('درجة الحوكمة الكلية', 'Overall governance score')}</div>
                        <div className="text-4xl font-black text-emerald-600 dark:text-emerald-400">{Math.round(rd.totalScore)}%</div>
                      </div>
                      {Array.isArray(rd.competencyScores) && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 flex-1 max-w-xl">
                          {rd.competencyScores.map((c: any, i: number) => (
                            <div key={i} className="rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-2 text-center">
                              <div className="text-lg font-black text-emerald-600 dark:text-emerald-400">{c.score}%</div>
                              <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight">{c.competency}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {[['💪 نقاط القوة', '💪 Strengths', rd.strengths], ['⚠️ نقاط الضعف', '⚠️ Weaknesses', rd.weaknesses], ['🎯 التوصيات', '🎯 Recommendations', rd.recommendations]].map(([a, e, body], i) => (
                        <div key={i} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                          <div className="font-black text-slate-700 dark:text-slate-200 text-sm mb-2">{t(a as string, e as string)}</div>
                          <div className="text-[13px] text-slate-600 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">{body as string}</div>
                        </div>
                      ))}
                    </div>
                    {rd.gapReport && (
                      <details open className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                        <summary className="font-black text-slate-700 dark:text-slate-200 text-sm cursor-pointer">📉 {t('تقرير الفجوات وخطة التطوير', 'Gap report & development plan')}</summary>
                        <div className="mt-3 space-y-2 text-[13px] text-slate-600 dark:text-slate-300">
                          {rd.gapReport.overallGapSummary && <p><b>{t('الملخص:', 'Summary:')}</b> {rd.gapReport.overallGapSummary}</p>}
                          {rd.gapReport.developmentPlan && <p><b>{t('خطة التطوير:', 'Development plan:')}</b> {rd.gapReport.developmentPlan}</p>}
                          {Array.isArray(rd.gapReport.competencyGaps) && rd.gapReport.competencyGaps.map((g: any, i: number) => (
                            <div key={i} className="border-t border-slate-100 dark:border-slate-700 pt-2">
                              <b>{g.skill}</b> — {t('مطلوب', 'required')} {g.required}% / {t('فعلي', 'actual')} {g.actual}% — <span className="text-slate-500">{g.gapDescription}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {/* Feedback canvas — comment then regenerate with higher precision */}
                    <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-900/20 p-4">
                      <div className="font-black text-emerald-700 dark:text-emerald-300 text-sm mb-2">📝 {t('كانفاس الملاحظات', 'Feedback canvas')}</div>
                      <p className="text-[12px] text-slate-500 dark:text-slate-400 mb-2">{t('اكتب ملاحظاتك على التقرير ثم أعد التوليد — سيُعاد صياغته بدقة أعلى مراعياً ملاحظاتك حرفياً.', 'Write your notes, then regenerate — the report is rewritten with higher precision honoring them.')}</p>
                      <textarea value={diagFeedback} onChange={e => setDiagFeedback(e.target.value)} rows={3}
                        className={UI.textarea + ' w-full'} placeholder={t('مثال: ركّز أكثر على فجوات إدارة المشاريع، أضف بُعد الامتثال التنظيمي…', 'e.g. focus more on project-management gaps, add a regulatory-compliance dimension…')} />
                      <div className="mt-2">
                        <button onClick={() => triggerAutoSurveyReport(diagFeedback)} disabled={surveyBusy || !diagFeedback.trim()} className={UI.btnPrimarySm}>
                          {surveyBusy ? t('⏳ يعيد الصياغة…', '⏳ Rewriting…') : t('♻️ أعد الصياغة بملاحظاتي', '♻️ Rewrite with my notes')}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })() : (
                <div className="text-slate-400 text-sm rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center">
                  {t('لا يوجد تقرير واقع راهن بعد — اضغط «توليد تقرير الواقع الراهن».', 'No diagnostic yet — click "Generate diagnostic".')}
                </div>
              )}

              <StageNav back={() => gotoStage(0)} next={() => gotoStage(7)} nextLabel={t('التالي: الهيكل التنظيمي', 'Next: org structure')} ar={ar} />
            </section>
          )}

          {/* STAGE 7 — الهيكل التنظيمي (build + draw together) */}
          {!showProjects && stage === 7 && (
            <section className="space-y-5">
              <StageHead icon="🏢" title={t('الهيكل التنظيمي', 'Org structure')}
                desc={t('يُبنى ويُرسَم سوياً: شجرة الوحدات التنظيمية التفاعلية + المخطط الهيكلي. مخرجه يغذّي مرحلة البناء.', 'Built and drawn together: an interactive org-unit tree + org chart. Its output feeds the Build stage.')} />

              {/* FIX A — تعليمات/برومبت مخصّص قبل البناء: المالك يوجّه التركيز والأولويات والأسلوب
                  (مع الالتزام بالأدلة)؛ يُحقن في برومبت buildModel عبر customInstructions. */}
              <details className="rounded-2xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-900/20 p-4" open={!!buildInstructions}>
                <summary className="cursor-pointer select-none font-black text-indigo-800 dark:text-indigo-200 text-sm">
                  ⚙️ {t('تعليمات مخصّصة قبل بناء الهيكل (اختياري)', 'Custom instructions before building (optional)')}
                </summary>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 mb-2">
                  {t('وجّه المحلّل: ركّز على إدارات معيّنة، اتبع إطارًا (COSO/EFQM)، أسلوب الأسماء، عمق التفصيل… تُطبَّق مع الالتزام الصارم بأدلة الشركة دون اختراع.', 'Steer the analyst: focus on certain units, follow a framework (COSO/EFQM), naming style, depth… applied strictly against company evidence, no fabrication.')}
                </div>
                <textarea value={buildInstructions} onChange={e => setBuildInstructions(e.target.value)}
                  rows={4} maxLength={4000}
                  placeholder={t('مثال: ركّز على هيكل الإدارة المالية وإدارة المخاطر، استخدم مسميات مطابقة لـ COSO، وأضِف لجنة تدقيق داخلي إن غابت.', 'e.g. Focus on Finance & Risk structure, use COSO-aligned titles, add an Internal Audit committee if missing.')}
                  className="w-full rounded-xl border border-indigo-200 dark:border-indigo-700 bg-white dark:bg-slate-800 p-3 text-sm text-slate-700 dark:text-slate-200 resize-y" dir="rtl" />
                <div className="text-[10px] text-slate-400 mt-1">{buildInstructions.length}/4000</div>
              </details>

              <div className="flex flex-wrap gap-2">
                <button onClick={handleBuild} disabled={!!busy || generating || chunkCount === 0}
                  className={UI.btnPrimary}>
                  {model ? t('♻️ إعادة بناء الهيكل', '♻️ Rebuild structure') : t('🏗️ بناء الهيكل التنظيمي', '🏗️ Build org structure')}
                </button>
                {model && (
                  <button onClick={() => handleGenDiagram('orgchart')} disabled={diagBusy !== null} className={UI.btnGhost}>
                    {diagBusy === 'orgchart' ? t('⏳ يرسم…', '⏳ Drawing…') : t('📐 ارسم المخطط الهيكلي', '📐 Draw org chart')}
                  </button>
                )}
                {model && (
                  <button onClick={() => setStage(1)} className={UI.btnSubtle}>
                    {t('🧩 تفاصيل النموذج الكامل', '🧩 Full model details')}
                  </button>
                )}
                {chunkCount === 0 && !model && <span className="text-xs text-amber-600 self-center">{t('افهرس المصادر أولاً من مرحلة المدخلات.', 'Index sources first from the Inputs stage.')}</span>}
              </div>

              {/* B — editable live canvas: the owner can add/rename/delete units &
                  roles, draw connections, or auto-layout — every edit writes back to
                  the real model. "أرسم بنفسي" + "أعدّل عليه" live here. */}
              {model && (
                <div className="rounded-2xl border-2 border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/20 p-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <div className="font-black text-emerald-800 dark:text-emerald-200 text-sm">✏️ {t('تحرير الهيكل (كانفاس حي)', 'Edit structure (live canvas)')}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">{t('أضِف وحدة/دور، أعد التسمية، احذف، اربط بالسحب، أو رتّب تلقائيًا — كل تعديل يُحفظ في النموذج فورًا.', 'Add a unit/role, rename, delete, drag-connect, or auto-layout — every edit saves to the model instantly.')}</div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {modelCanvas && (
                        <button onClick={handleAutoLayout}
                          className="px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 text-sm font-bold">
                          ⊞ {t('ترتيب تلقائي', 'Auto-layout')}
                        </button>
                      )}
                      <button onClick={openModelCanvas}
                        className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold">
                        {modelCanvas ? t('إخفاء المحرّر', 'Hide editor') : t('✏️ افتح المحرّر', '✏️ Open editor')}
                      </button>
                    </div>
                  </div>
                  {modelCanvas && (
                    <div className="mt-3">
                      <GovernanceCanvas
                        language={language}
                        initialNodes={modelCanvasNodes}
                        initialEdges={modelCanvasEdges}
                        model={model}
                        onModelChange={handleModelCanvasChange}
                      />
                    </div>
                  )}
                </div>
              )}

              {model && model.orgUnits.length > 0 && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                  <div className="font-black text-slate-700 dark:text-slate-200 text-sm mb-3">🌳 {t('شجرة الوحدات التنظيمية', 'Org-unit tree')} <span className="text-slate-400">({model.orgUnits.length})</span></div>
                  <OrgUnitTree units={model.orgUnits} ar={ar} />
                </div>
              )}

              {model && activeDiag && activeDiag.kind === 'orgchart' && activeDiag.mermaid && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
                  <MermaidView mermaid={activeDiag.mermaid} title={activeDiag.title} language={language} />
                </div>
              )}

              {!model && (
                <div className="text-slate-400 text-sm rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center">
                  {t('لم يُبنَ الهيكل بعد — اضغط «بناء الهيكل التنظيمي».', 'No structure yet — click "Build org structure".')}
                </div>
              )}

              <StageNav back={() => gotoStage(6)} next={() => setStage(2)} nextLabel={t('التالي: البناء', 'Next: build')} nextDisabled={!model} ar={ar} />
            </section>
          )}

          {/* STAGE 1 — model */}
          {!showProjects && stage === 1 && (
            <section className="space-y-5">
              <StageHead icon="🧩" title={t('نموذج الحوكمة', 'Governance model')}
                desc={t('المصدر الوحيد للحقيقة: يتقاطع واقع الشركة + ملفاتها + المشاريع السابقة لبناء الوحدات والأدوار والسياسات والفجوات.', 'The single source of truth: company reality + files + previous projects → units, roles, policies, gaps.')} />
              <div className="flex flex-wrap gap-2">
                <button onClick={handleBuild} disabled={!!busy || generating || chunkCount === 0}
                  className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-sm disabled:opacity-50">
                  {model ? t('♻️ إعادة بناء النموذج', '♻️ Rebuild model') : t('🧩 بناء النموذج', '🧩 Build model')}
                </button>
                {chunkCount === 0 && <span className="text-xs text-amber-600 self-center">{t('استورد الوثائق أولاً من مرحلة المصادر.', 'Ingest documents first from the Sources stage.')}</span>}
                {model && (
                  <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 self-center cursor-pointer">
                    <input type="checkbox" checked={mergeOnRebuild} onChange={e => setMergeOnRebuild(e.target.checked)} className="accent-emerald-600" />
                    {t('دمج التعديلات عند إعادة البناء (يحفظ نسخة قبلها)', 'Merge edits on rebuild (snapshots first)')}
                  </label>
                )}
              </div>

              {model ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-7 gap-2 text-center">
                    {[['الوحدات', 'Units', model.orgUnits.length], ['الأدوار', 'Roles', model.roles.length], ['السياسات', 'Policies', model.policies.length], ['الإجراءات', 'Procedures', (model.procedures || []).length], ['الصلاحيات', 'Authorities', (model.authorities || []).length], ['المؤشرات', 'KPIs', (model.kpis || []).length], ['الفجوات', 'Gaps', model.gaps.length]].map(([a, e, n], i) => (
                      <div key={i} className="rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-3">
                        <div className="text-2xl font-black text-emerald-600 dark:text-emerald-400">{n as number}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">{t(a as string, e as string)}</div>
                      </div>
                    ))}
                  </div>
                  {model.orgUnits.length > 0 && (
                    <details open className="rounded-xl border border-slate-200 bg-white p-3">
                      <summary className="font-bold text-slate-700 cursor-pointer text-sm">🏢 {t('الوحدات التنظيمية', 'Org units')}</summary>
                      <div className="mt-2 space-y-1">
                        {model.orgUnits.map(u => (
                          <div key={u.id} className="flex items-center justify-between gap-2 text-sm py-1 border-b border-slate-100">
                            <span><b>{u.name}</b>{u.parentId ? <span className="text-slate-400"> ← {unitName(u.parentId)}</span> : ''} — <span className="text-slate-500">{u.mandate}</span></span>
                            <ProvBadge refs={u.provenance} />
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {model.roles.length > 0 && (
                    <details className="rounded-xl border border-slate-200 bg-white p-3">
                      <summary className="font-bold text-slate-700 cursor-pointer text-sm">👤 {t('الأدوار', 'Roles')}</summary>
                      <div className="mt-2 space-y-1">
                        {model.roles.map(r => (
                          <div key={r.id} className="flex items-center justify-between gap-2 text-sm py-1 border-b border-slate-100">
                            <span><b>{r.title}</b> <span className="text-slate-400">({unitName(r.unitId)})</span> — <span className="text-slate-500">{r.purpose}</span></span>
                            <ProvBadge refs={r.provenance} />
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {model.policies.length > 0 && (
                    <details className="rounded-xl border border-slate-200 bg-white p-3">
                      <summary className="font-bold text-slate-700 cursor-pointer text-sm">📜 {t('السياسات الحالية', 'Existing policies')}</summary>
                      <div className="mt-2 space-y-1">
                        {model.policies.map(pl => (
                          <div key={pl.id} className="flex items-center justify-between gap-2 text-sm py-1 border-b border-slate-100">
                            <span><b>{pl.title}</b> <span className="text-slate-400">[{pl.domain}]</span> — <span className="text-slate-500">{pl.body}</span></span>
                            <ProvBadge refs={pl.provenance} />
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {(model.procedures || []).length > 0 && (
                    <details className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
                      <summary className="font-bold text-slate-700 dark:text-slate-200 cursor-pointer text-sm">⚙️ {t('الإجراءات', 'Procedures')}</summary>
                      <div className="mt-2 space-y-1">
                        {(model.procedures || []).map(pr => (
                          <div key={pr.id} className="flex items-center justify-between gap-2 text-sm py-1 border-b border-slate-100 dark:border-slate-700">
                            <span className="text-slate-700 dark:text-slate-200"><b>{pr.title}</b> <span className="text-slate-400">[{pr.status}]</span> {pr.unitId ? <span className="text-slate-400">({unitName(pr.unitId)})</span> : ''} — <span className="text-slate-500 dark:text-slate-400">{pr.purpose || `${pr.steps.length} ${t('خطوة', 'steps')}`}</span></span>
                            <ProvBadge refs={pr.provenance} />
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {(model.authorities || []).length > 0 && (
                    <details className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
                      <summary className="font-bold text-slate-700 dark:text-slate-200 cursor-pointer text-sm">🔑 {t('مصفوفة الصلاحيات (RACI)', 'Authorities (RACI)')}</summary>
                      <div className="mt-2 overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead><tr className="text-[11px] text-slate-500 border-b border-slate-200 dark:border-slate-700">
                            <th className="text-start py-1">{t('القرار/الإجراء', 'Decision')}</th>
                            <th className="text-start py-1">{t('الدور', 'Role')}</th>
                            <th className="text-start py-1">{t('المستوى', 'Level')}</th>
                          </tr></thead>
                          <tbody>
                            {(model.authorities || []).map(a => (
                              <tr key={a.id} className="border-b border-slate-100 dark:border-slate-700">
                                <td className="py-1 text-slate-700 dark:text-slate-200">{a.decision}</td>
                                <td className="py-1 text-slate-500">{model.roles.find(r => r.id === a.roleId)?.title || '—'}</td>
                                <td className="py-1"><span className="text-[11px] px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">{LEVEL_AR[a.level] || a.level}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}
                  {(model.kpis || []).length > 0 && (
                    <details className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
                      <summary className="font-bold text-slate-700 dark:text-slate-200 cursor-pointer text-sm">📈 {t('مؤشرات الأداء (KPIs)', 'KPIs')}</summary>
                      <div className="mt-2 space-y-1">
                        {(model.kpis || []).map(k => (
                          <div key={k.id} className="flex items-center justify-between gap-2 text-sm py-1 border-b border-slate-100 dark:border-slate-700">
                            <span className="text-slate-700 dark:text-slate-200"><b>{k.name}</b> {k.unitId ? <span className="text-slate-400">({unitName(k.unitId)})</span> : ''} — <span className="text-slate-500">{k.formula}</span></span>
                            <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 shrink-0">{t('المستهدف', 'target')}: {k.target}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {model.gaps.length > 0 && (
                    <details open className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
                      <summary className="font-bold text-slate-700 dark:text-slate-200 cursor-pointer text-sm">⚠️ {t('الفجوات والمخاطر', 'Gaps & risks')}</summary>
                      <div className="mt-2 space-y-2">
                        {model.gaps.map(g => (
                          <div key={g.id} className={`rounded-lg border p-2 text-sm ${g.resolved ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : SEV_COLOR[g.severity] || SEV_COLOR.medium}`}>
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-bold">{g.resolved ? '✅ ' : ''}{g.area} <span className="text-[10px] uppercase">[{g.severity}]</span></span>
                              <ProvBadge refs={g.provenance} />
                            </div>
                            <div className="text-slate-600 mt-1">{g.description}</div>
                            {g.recommendation && <div className="text-slate-700 mt-1">↪ {g.recommendation}</div>}
                            {g.matchedProjectIds.length > 0 && (
                              <div className="text-[10px] text-emerald-600 mt-1">📚 {t('مبني على', 'based on')}: {g.matchedProjectIds.map(id => refProjects.find(p => p.id === id)?.name || id).join('، ')}</div>
                            )}
                            {!g.resolved && (
                              <button onClick={() => handleGapFix(g)} disabled={generating || !!busy}
                                className="mt-2 px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold disabled:opacity-50">
                                {fixingGap === g.id ? t('⏳ توليد الإصلاح…', '⏳ generating fix…') : t('🛠 ولّد سياسة + إجراء لإغلاقها', '🛠 Generate fix')}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 p-10 text-center text-sm">
                  {busy
                    ? <span className="text-emerald-600 dark:text-emerald-400 font-bold flex items-center justify-center gap-2"><span className="animate-spin">⏳</span> {t('جارٍ بناء النموذج تلقائياً من مصادرك…', 'Building the model automatically from your sources…')}</span>
                    : chunkCount > 0
                      ? <span className="text-slate-500 dark:text-slate-400">{t('اضغط «بناء النموذج» لتوليده من المقاطع المفهرسة.', 'Press "Build model" to generate it from the indexed chunks.')}</span>
                      : <span className="text-amber-600 dark:text-amber-400">{t('لا توجد مقاطع مفهرسة بعد — عُد لمرحلة المصادر واستورد الوثائق أولاً.', 'No indexed chunks yet — go back to Sources and ingest documents first.')}</span>}
                </div>
              )}
              <StageNav back={() => setStage(7)} next={() => setStage(2)} nextLabel={t('التالي: البناء', 'Next: build')} nextDisabled={!model} ar={ar} />
            </section>
          )}

          {/* STAGE 2 — البناء: sub-tabs (diagrams | docs) */}
          {!showProjects && stage === 2 && (
            <div className="mb-2 text-[12px] text-slate-500 dark:text-slate-400 leading-relaxed">
              {t('«البناء» ثلاثة مخرجات من نفس النموذج: ', 'Build = three outputs from one model: ')}
              <span className="font-bold text-emerald-700 dark:text-emerald-300">🎨 {t('مخططات', 'diagrams')}</span>{' · '}
              <span className="font-bold text-emerald-700 dark:text-emerald-300">📑 {t('وثائق', 'documents')}</span>{' · '}
              <span className="font-bold text-emerald-700 dark:text-emerald-300">🏢 {t('حزم الإدارات', 'department packages')}</span>
            </div>
          )}
          {!showProjects && stage === 2 && (
            <div className="hw-tabs-line mb-4">
              <button
                onClick={() => setBuildTab('diagrams')}
                className={buildTab === 'diagrams' ? UI.tabActive : UI.tabIdle}
              >
                🎨 {t('المخططات', 'Diagrams')}
              </button>
              <button
                onClick={() => setBuildTab('docs')}
                className={buildTab === 'docs' ? UI.tabActive : UI.tabIdle}
              >
                📑 {t('توليد الوثائق', 'Document generation')}
              </button>
              {/* W7: الإدارات folded into البناء as an entry into the package builder. */}
              <button
                onClick={() => model && setStage(5)}
                disabled={!model}
                title={!model ? t('ابنِ الهيكل التنظيمي أولاً.', 'Build the org structure first.') : undefined}
                className={UI.tabIdle + ' disabled:opacity-40'}
              >
                🏢 {t('حزم الإدارات', 'Departments')}
              </button>
            </div>
          )}

          {/* STAGE 2 — diagrams & canvas */}
          {!showProjects && stage === 2 && buildTab === 'diagrams' && (
            <section className="space-y-5">
              <StageHead icon="🎨" title={t('الدياجرامات والـCanvas', 'Diagrams & canvas')}
                desc={t('ولّد مخططات SVG عالية الجودة من النموذج، ثم حوّلها لـCanvas تفاعلي تحرّكه وتعدّله وتربطه.', 'Generate high-quality SVG diagrams from the model, then turn them into an interactive canvas you can drag, edit and connect.')} />
              {!model && <div className="text-xs text-amber-600">{t('ابنِ الهيكل التنظيمي أولاً.', 'Build the org structure first.')}</div>}

              {/* Editing the live model now lives in مرحلة «الهيكل التنظيمي» — one home only.
                  Build stage = SVG diagram generation. Pointer sends user there to edit. */}
              {model && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 px-4 py-3 text-[12px] text-slate-600 dark:text-slate-300 flex items-center gap-2">
                  <span>🧷</span>
                  <span>{t('لتحرير الوحدات والأدوار يدويًا، استخدم «كانفاس النموذج الحي» في مرحلة الهيكل التنظيمي. هنا تولّد المخططات فقط.', 'To hand-edit units/roles, use the “live model canvas” in the Org-structure stage. Here you only generate diagrams.')}</span>
                </div>
              )}

              {/* N8: the org chart has ONE home — مرحلة «الهيكل التنظيمي». Excluded here
                  to kill the duplicate generator; a pointer sends the user to its source. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {DIAG_KINDS.filter(k => k.kind !== 'orgchart').map(k => (
                  <button key={k.kind} onClick={() => handleGenDiagram(k.kind)} disabled={!model || diagBusy !== null}
                    className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 hover:bg-emerald-100 p-3 text-start disabled:opacity-50 transition-colors">
                    <div className="text-base font-black text-emerald-700">{k.icon} {t(k.ar, k.en)}</div>
                    <div className="text-[11px] text-slate-500 mt-1">{diagBusy === k.kind ? t('جارٍ التوليد…', 'generating…') : t('توليد SVG', 'generate SVG')}</div>
                  </button>
                ))}
              </div>
              <button onClick={() => setStage(7)}
                className="w-full text-start rounded-xl border border-dashed border-emerald-300 dark:border-emerald-700 bg-white dark:bg-slate-800 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20">
                🏢 {t('المخطط الهيكلي يُبنى ويُحرَّر في مرحلة «الهيكل التنظيمي» — اضغط للانتقال إليها (مصدر واحد، بلا تكرار).', 'The org chart is built & edited in the “Org structure” stage — click to go there (single source, no duplication).')}
              </button>

              {/* saved diagrams */}
              {diagrams.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {diagrams.map(d => (
                    <span key={d.id} className={`inline-flex items-center gap-1 text-xs rounded-full px-3 py-1 border cursor-pointer
                      ${activeDiag?.id === d.id ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-300'}`}
                      onClick={() => { setActiveDiag(d); setCanvasMode(false); }}>
                      {DIAG_KINDS.find(k => k.kind === d.kind)?.icon} {d.title}
                      <button onClick={(e) => { e.stopPropagation(); handleDeleteDiagram(d.id); }} className="ms-1 opacity-60 hover:opacity-100">✕</button>
                    </span>
                  ))}
                </div>
              )}

              {/* active diagram */}
              {activeDiag && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-black text-slate-800">{activeDiag.title}</h3>
                    {activeDiag.kind !== 'swimlane' && (
                      <div className="ms-auto flex gap-1 bg-slate-200 rounded-xl p-1">
                        <button onClick={() => setCanvasMode(false)} className={`px-3 py-1 rounded-lg text-xs font-bold ${!canvasMode ? 'bg-white text-emerald-700 shadow' : 'text-slate-600'}`}>🖼 SVG</button>
                        <button onClick={handleConvertToCanvas} className={`px-3 py-1 rounded-lg text-xs font-bold ${canvasMode ? 'bg-white text-emerald-700 shadow' : 'text-slate-600'}`}>🎛 Canvas</button>
                      </div>
                    )}
                  </div>
                  {activeDiag.kind === 'swimlane' && activeDiag.swimlane ? (
                    <SwimlaneView spec={activeDiag.swimlane} title={activeDiag.title} language={language} />
                  ) : canvasMode ? (
                    <GovernanceCanvas
                      language={language}
                      initialNodes={activeDiag.flowNodes || []}
                      initialEdges={activeDiag.flowEdges || []}
                      onSave={handleSaveCanvas}
                      saving={savingCanvas}
                    />
                  ) : (
                    <MermaidView mermaid={activeDiag.mermaid} title={activeDiag.title} language={language} />
                  )}
                </div>
              )}
              {!activeDiag && model && (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-400 text-sm">
                  {t('اختر نوع مخطط بالأعلى لتوليده.', 'Pick a diagram type above to generate.')}
                </div>
              )}
              <StageNav back={() => setStage(7)} next={() => setBuildTab('docs')} nextLabel={t('التالي: الوثائق', 'Next: documents')} ar={ar} />
            </section>
          )}

          {/* STAGE 3 — doc generation */}
          {!showProjects && stage === 2 && buildTab === 'docs' && (
            <section className="space-y-5">
              <StageHead icon="📑" title={t('توليد الوثائق', 'Document generation')}
                desc={t('وثيقة طويلة مترابطة مُسندة بالمصادر. اختر طريقة الإنشاء ثم اضغط "توليد".', 'A long, coherent, source-cited document. Choose a creation mode then press generate.')} />

              {/* Mode selector — 3 clean options */}
              <div className="flex rounded-2xl border border-slate-200 bg-slate-50 dark:bg-slate-800/40 p-1 gap-1">
                {([
                  { k: 'batch', icon: '🗂️', ar: 'دُفعة محدَّدة', en: 'Batch' },
                  { k: 'custom', icon: '📑', ar: 'وثيقة مخصّصة', en: 'Custom' },
                  { k: 'bulk',   icon: '⚡', ar: 'توليد بالجملة', en: 'Bulk' },
                ] as { k: 'batch' | 'custom' | 'bulk'; icon: string; ar: string; en: string }[]).map(m => (
                  <button key={m.k} onClick={() => setDocMode(m.k)}
                    className={`flex-1 py-2.5 rounded-xl font-bold text-sm transition-all ${docMode === m.k ? 'bg-white dark:bg-slate-700 shadow text-emerald-700 dark:text-emerald-300 border border-emerald-200' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}>
                    {m.icon} {t(m.ar, m.en)}
                  </button>
                ))}
              </div>

              {/* ── BATCH MODE — full catalog picker ── */}
              {docMode === 'batch' && (() => {
                const existingKinds = govDocs.map(d => d.kind);
                const recs = model ? recommendDocuments(model as any, existingKinds) : [];
                const visibleDocs = catFilter
                  ? GOV_DOC_CATALOG.filter(d => d.category === catFilter)
                  : GOV_DOC_CATALOG;
                const selectedCount = GOV_DOC_CATALOG.filter(d => createSel[d.key]?.on).length;
                return (
                  <div className="rounded-2xl border-2 border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/20 p-4 space-y-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="font-black text-emerald-800 dark:text-emerald-200 text-sm">🗂️ {t('فهرس الوثائق المؤسسية', 'Governance Document Catalog')}</div>
                      <div className="flex gap-2 text-[11px]">
                        <button onClick={() => setCreateSel(prev => { const n = {...prev}; GOV_DOC_CATALOG.forEach(d => { n[d.key] = {...n[d.key], on: true}; }); return n; })}
                          className="px-2.5 py-1 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-bold hover:bg-emerald-200 dark:hover:bg-emerald-800/50">
                          {t('تحديد الكل', 'All')}
                        </button>
                        <button onClick={() => setCreateSel(prev => { const n = {...prev}; GOV_DOC_CATALOG.forEach(d => { n[d.key] = {...n[d.key], on: false}; }); return n; })}
                          className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-bold hover:bg-slate-200 dark:hover:bg-slate-600">
                          {t('إلغاء الكل', 'None')}
                        </button>
                      </div>
                    </div>

                    {/* AI Recommendations */}
                    {recs.length > 0 && (
                      <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 p-3 space-y-2">
                        <div className="text-[11px] font-black text-amber-700 dark:text-amber-300">✨ {t('مقترحة بالذكاء الاصطناعي بناءً على نموذجك', 'AI-recommended based on your model')}</div>
                        <div className="flex flex-wrap gap-1.5">
                          {recs.slice(0, 6).map(r => {
                            const entry = GOV_DOC_CATALOG.find(d => d.key === r.key);
                            if (!entry) return null;
                            return (
                              <button key={r.key}
                                onClick={() => setCreateSel(prev => ({ ...prev, [r.key]: { ...prev[r.key], on: true } }))}
                                title={r.reason}
                                className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold border transition-all ${createSel[r.key]?.on ? 'bg-amber-500 text-white border-amber-500' : 'bg-white dark:bg-slate-800 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/30'}`}>
                                {entry.icon} {t(entry.ar, entry.en)}
                                {r.priority === 'critical' && <span className="text-rose-500">●</span>}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Category filter */}
                    <div className="flex flex-wrap gap-1.5">
                      <button onClick={() => setCatFilter('')}
                        className={`px-3 py-1 rounded-full text-[11px] font-bold border transition-all ${catFilter === '' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:border-emerald-400'}`}>
                        {t('الكل', 'All')} ({GOV_DOC_CATALOG.length})
                      </button>
                      {CATALOG_CATEGORIES.map(cat => {
                        const count = GOV_DOC_CATALOG.filter(d => d.category === cat.key).length;
                        return (
                          <button key={cat.key} onClick={() => setCatFilter(cat.key)}
                            className={`px-3 py-1 rounded-full text-[11px] font-bold border transition-all ${catFilter === cat.key ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:border-emerald-400'}`}>
                            {cat.icon} {t(cat.ar, cat.en)} ({count})
                          </button>
                        );
                      })}
                    </div>

                    {/* Catalog list */}
                    <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                      {visibleDocs.map(d => {
                        const sel = createSel[d.key] || { on: false, pages: d.defaultPages };
                        const isRec = recs.some(r => r.key === d.key);
                        return (
                          <div key={d.key} className={`flex items-center gap-2.5 rounded-xl border p-2.5 transition-all ${sel.on ? 'border-emerald-400 bg-white dark:bg-slate-800 shadow-sm' : 'border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-800/40'}`}>
                            <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                              <input type="checkbox" checked={sel.on}
                                onChange={e => setCreateSel(prev => ({ ...prev, [d.key]: { ...sel, on: e.target.checked } }))}
                                className="w-4 h-4 accent-emerald-600 shrink-0" />
                              <span className="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{d.icon} {t(d.ar, d.en)}</span>
                              {isRec && <span className="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-700">✨ {t('مقترح', 'Rec')}</span>}
                              {d.priority === 'critical' && <span className="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-700">{t('أساسي', 'Core')}</span>}
                            </label>
                            <div className={`flex items-center gap-1.5 shrink-0 ${sel.on ? '' : 'opacity-40'}`}>
                              <span className="text-[10px] text-slate-400">{t('ص', 'pg')}</span>
                              <input type="number" min={1} max={100} value={sel.pages} disabled={!sel.on}
                                onChange={e => setCreateSel(prev => ({ ...prev, [d.key]: { ...sel, pages: Math.max(1, Math.min(100, parseInt(e.target.value) || 1)) } }))}
                                className="w-14 px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-sm text-center font-bold" />
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Footer */}
                    <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-emerald-200 dark:border-emerald-800">
                      <span className="text-[11px] text-slate-500 dark:text-slate-400 flex-1">
                        {selectedCount > 0 ? t(`${selectedCount} وثيقة محددة للتوليد`, `${selectedCount} docs selected`) : t('لم تُحدَّد وثيقة بعد', 'No docs selected')}
                      </span>
                      {!batchRunning ? (
                        <button onClick={handleCreateBatch} disabled={!model || !!busy || selectedCount === 0}
                          className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-sm disabled:opacity-50">
                          🗂️ {t('إنشاء المُحدَّد', 'Create selected')} {selectedCount > 0 ? `(${selectedCount})` : ''}
                        </button>
                      ) : (
                        <button onClick={stop} className="px-5 py-2.5 bg-rose-600 text-white font-bold rounded-xl text-sm">⏹ {t('إيقاف', 'Stop')}</button>
                      )}
                    </div>
                    {batchLog.length > 0 && (
                      <div className="rounded-lg bg-white/70 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 p-2 text-[11px] space-y-0.5 max-h-32 overflow-auto">
                        {batchLog.map((l, i) => <div key={i} className="text-slate-600 dark:text-slate-300">{l}</div>)}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── CUSTOM MODE ── */}
              {docMode === 'custom' && (
                <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 space-y-3">
                  <div className="font-black text-slate-800 dark:text-slate-200 text-sm">📑 {t('وثيقة مخصّصة', 'Custom document')}</div>
                  <input value={docTitle} onChange={e => setDocTitle(e.target.value)} placeholder={t('عنوان الوثيقة', 'Document title')} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-sm font-bold" />
                  <textarea value={docGoal} onChange={e => setDocGoal(e.target.value)} rows={3} placeholder={t('هدف الوثيقة وما تتضمّنه', 'Document goal and contents')} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-sm resize-none" />
                  <div className="flex flex-wrap gap-2 pt-1">
                    {!generating ? (
                      <button onClick={handleGenerate} disabled={!model || !!busy}
                        className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-sm disabled:opacity-50">
                        📑 {t('توليد', 'Generate')}
                      </button>
                    ) : (
                      <button onClick={stop} className="px-5 py-2.5 bg-rose-600 text-white font-bold rounded-xl text-sm">⏹ {t('إيقاف', 'Stop')}</button>
                    )}
                    {genDoc && (
                      <>
                        <button onClick={() => handleExport('docx')} className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-sm">⬇ Word</button>
                        <button onClick={() => handleExport('pdf')} className="px-4 py-2.5 bg-rose-500 hover:bg-rose-600 text-white font-bold rounded-xl text-sm">⬇ PDF</button>
                        <button onClick={handleSaveToLibrary} disabled={!!busy} className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-sm disabled:opacity-50">💾 {t('حفظ', 'Save')}</button>
                        {(genDoc as any)._gapFix && (
                          <button onClick={approveGapFixToModel} disabled={!!busy} className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-sm disabled:opacity-50">✅ {t('اعتماد في النموذج', 'Approve to model')}</button>
                        )}
                      </>
                    )}
                  </div>
                  {model && (
                    <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200 dark:border-slate-700">
                      <span className="text-xs text-slate-500 dark:text-slate-400 self-center font-bold">{t('أدلّة جاهزة:', 'Ready manuals:')}</span>
                      <button onClick={handleExportManual} disabled={!model || !!busy} className="px-3.5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded-xl text-xs disabled:opacity-50">📘 {t('دليل الحوكمة', 'Full manual')}</button>
                      <button onClick={handleExportWorkflow} disabled={!!busy} className="px-3.5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded-xl text-xs disabled:opacity-50">🔄 {t('دورة العمل', 'Workflow')}</button>
                      <button onClick={handleExportJDs} disabled={!!busy} className="px-3.5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded-xl text-xs disabled:opacity-50">👤 {t('الأوصاف الوظيفية', 'Job desc.')}</button>
                      <button onClick={handleExportPolicies} disabled={!!busy} className="px-3.5 py-2 bg-amber-700 hover:bg-amber-800 text-white font-bold rounded-xl text-xs disabled:opacity-50">📋 {t('السياسات', 'Policies')}</button>
                    </div>
                  )}
                </div>
              )}

              {/* ── BULK MODE ── */}
              {docMode === 'bulk' && (
                <div className="rounded-2xl border-2 border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/20 p-4 space-y-3">
                  <div className="font-black text-amber-800 dark:text-amber-200 text-sm">⚡ {t('توليد بالجملة', 'Bulk generation')}</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{t('يولّد كل الكيانات دفعة واحدة مُسندة بالنموذج والمصادر. قد يستغرق وقتاً.', 'Generates all entities at once, grounded in the model. May take a while.')}</div>
                  <div className="flex flex-wrap gap-2">
                    {([['policies', 'السياسات', 'Policies', '📜'], ['procedures', 'الإجراءات', 'Procedures', '⚙️'], ['departments', 'الإدارات', 'Departments', '🏢'], ['authorities', 'الصلاحيات', 'Authorities', '🔑'], ['kpis', 'المؤشرات', 'KPIs', '📈']] as [BulkScope, string, string, string][]).map(([sc, a, e, ic]) => (
                      <button key={sc} onClick={() => setBulkScope(sc)}
                        className={`px-4 py-2 rounded-xl text-sm font-bold border ${bulkScope === sc ? 'bg-amber-600 text-white border-amber-600' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-600'}`}>
                        {ic} {t(a, e)}
                      </button>
                    ))}
                  </div>
                  <div className="pt-1">
                    {generating ? (
                      <button onClick={stop} className="px-5 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-sm">
                        ⏹ {t('إيقاف التوليد', 'Stop generation')}
                      </button>
                    ) : (
                      <button onClick={handleBulkGenerate} disabled={!model || !!busy}
                        className="px-5 py-2.5 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-xl text-sm disabled:opacity-50">
                        ⚡ {t('توليد الآن', 'Generate now')}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Generation progress + output — always shown when active */}
              {(generating || thoughts.length > 0) && <ThinkingTrace thoughts={thoughts} active={generating} language={language} />}
              {(generating || genSections.length > 0) && <ArtifactProgress progress={genProgress} sections={genSections} language={language} />}

              {genDoc && (
                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 max-h-[60vh] overflow-auto">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-lg font-black text-slate-800 dark:text-slate-100">{genDoc.title}</h3>
                    {!genDoc.complete && <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2 py-1 rounded-lg">⚠️ {t('جزئية', 'Partial')}</span>}
                  </div>
                  {genDoc.executiveSummary && (
                    <Markdown text={genDoc.executiveSummary} rtl={ar} className="mb-4 p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg text-sm leading-relaxed" />
                  )}
                  {genDoc.sections.map(s => (
                    <div key={s.id} className="mb-5 pb-4 border-b border-slate-100 dark:border-slate-700 last:border-0">
                      <Markdown text={s.content} rtl={ar} className="text-sm leading-relaxed text-slate-700 dark:text-slate-200" />
                      {genDoc.citations[s.id]?.length > 0 && (
                        <div className="mt-2 text-[10px] text-emerald-600 dark:text-emerald-400">
                          🔗 {t('المصادر', 'Sources')}: {genDoc.citations[s.id].map((c, i) => `[${i + 1}] ${c.docName || ''}›${c.label}`).join(' · ')}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Canvas feedback — reply with notes, revise the doc in place */}
                  <div className="mt-5 pt-4 border-t-2 border-dashed border-emerald-200 dark:border-emerald-800">
                    <div className="flex items-center gap-2 mb-2 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                      ✍️ {t('ملاحظاتك على الوثيقة', 'Your notes on the document')}
                    </div>
                    <textarea
                      value={feedbackText}
                      onChange={e => setFeedbackText(e.target.value)}
                      disabled={revising}
                      dir={ar ? 'rtl' : 'ltr'}
                      rows={3}
                      placeholder={t('مثال: عدّل قسم نطاق العمل ليناسب شركة مقاولات، وأضف SLA لكل إجراء، وارجع للمشاريع المرجعية.', 'e.g. Rewrite the scope section for a construction firm, add SLA per procedure, cite reference projects.')}
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 p-3 text-sm leading-relaxed resize-y focus:ring-2 focus:ring-emerald-400 outline-none"
                    />
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={handleReviseGenDoc}
                        disabled={revising || !feedbackText.trim()}
                        className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold disabled:opacity-40"
                      >
                        {revising ? t('⏳ جارٍ التعديل...', '⏳ Revising...') : t('🔁 طبّق الملاحظات', '🔁 Apply notes')}
                      </button>
                      {revising && (
                        <button onClick={() => abortRef.current?.abort()}
                          className="px-3 py-2 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-sm font-bold">
                          {t('إيقاف', 'Stop')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
              <StageNav back={() => setBuildTab('diagrams')} next={() => setStage(3)} nextLabel={t('التالي: التحقق', 'Next: assurance')} ar={ar} />
            </section>
          )}

          {/* STAGE 5 — assurance & intelligence */}
          {!showProjects && stage === 3 && (
            <section className="space-y-5">
              <StageHead icon="🧠" title={t('التحقق والذكاء', 'Assurance & intelligence')}
                desc={t('محرك التماسك + درجة النضج + محاذاة الأطر + التعديل الذكي + اسأل حوكمتك + التتبّع + المكتبة والاعتماد.', 'Integrity engine + maturity + framework alignment + agentic edits + Q&A + traceability + library & approval.')} />
              {!model ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-400 text-sm">{t('ابنِ النموذج أولاً.', 'Build the model first.')}</div>
              ) : (
                <div className="space-y-5">

                  {/* Maturity */}
                  {maturityReport && (
                    <div className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/20 p-4">
                      <div className="flex items-center justify-between">
                        <div className="font-black text-emerald-800 dark:text-emerald-200 text-sm">📊 {t('درجة نضج الحوكمة', 'Governance maturity')}</div>
                        <div className="text-2xl font-black text-emerald-700 dark:text-emerald-300">{maturityReport.overall}% · {maturityReport.label}</div>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
                        {maturityReport.domains.map(d => (
                          <div key={d.domain} className="rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-2">
                            <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1"><span>{d.domain}</span><span className="font-bold">{d.score}%</span></div>
                            <div className="h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${d.score}%` }} /></div>
                            <div className="text-[10px] text-slate-400 mt-0.5">{d.label}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* N5 — governance-process artifacts: charter · risk register · roadmap + model sign-off */}
                  <div className="rounded-2xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-900/20 p-4 space-y-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="font-black text-indigo-800 dark:text-indigo-200 text-sm">🏛 {t('خطوات الحوكمة الرسمية', 'Governance-process artifacts')}</div>
                      <div className={`text-[11px] px-2.5 py-1 rounded-full font-bold ${modelApproved ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'}`}>
                        {modelApproved ? `✅ ${t('النموذج معتمد', 'Model approved')} v${model.version}` : `⏳ ${t('بانتظار الاعتماد', 'Awaiting approval')}`}
                      </div>
                    </div>
                    <div className="grid sm:grid-cols-3 gap-3">
                      {/* Charter */}
                      <div className="rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-3 flex flex-col">
                        <div className="font-bold text-slate-800 dark:text-slate-100 text-sm mb-1">📜 {t('ميثاق الحوكمة', 'Charter')}</div>
                        <div className="text-[11px] text-slate-500 mb-2 flex-1">{t('الأهداف والنطاق والرعاة — مولّد من النموذج.', 'Objectives, scope, sponsors — from the model.')}</div>
                        {!charterArt ? (
                          <button onClick={genCharter} disabled={!!busy} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg disabled:opacity-50">⚙️ {t('توليد', 'Generate')}</button>
                        ) : (
                          <div className="flex gap-1.5">
                            <button onClick={() => exportArt(charterArt, 'docx')} disabled={!!busy} className="flex-1 px-2 py-1.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold rounded-lg disabled:opacity-50">Word</button>
                            <button onClick={() => exportArt(charterArt, 'pdf')} disabled={!!busy} className="flex-1 px-2 py-1.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold rounded-lg disabled:opacity-50">PDF</button>
                          </div>
                        )}
                      </div>
                      {/* Risk register */}
                      <div className="rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-3 flex flex-col">
                        <div className="font-bold text-slate-800 dark:text-slate-100 text-sm mb-1">⚠️ {t('سجل المخاطر', 'Risk register')}</div>
                        <div className="text-[11px] text-slate-500 mb-2 flex-1">{t(`مشتق من ${(model.gaps||[]).length} فجوة — احتمال/أثر/تخفيف/مالك.`, `From ${(model.gaps||[]).length} gaps — likelihood/impact/owner.`)}</div>
                        {riskArt && <div className="flex gap-1.5">
                          <button onClick={() => exportArt(riskArt, 'docx')} disabled={!!busy} className="flex-1 px-2 py-1.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold rounded-lg disabled:opacity-50">Word</button>
                          <button onClick={() => exportArt(riskArt, 'pdf')} disabled={!!busy} className="flex-1 px-2 py-1.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold rounded-lg disabled:opacity-50">PDF</button>
                        </div>}
                      </div>
                      {/* Roadmap */}
                      <div className="rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-3 flex flex-col">
                        <div className="font-bold text-slate-800 dark:text-slate-100 text-sm mb-1">🗺 {t('خارطة الطريق', 'Roadmap')}</div>
                        <div className="text-[11px] text-slate-500 mb-2 flex-1">{t('معالجة الفجوات على 3 مراحل زمنية.', 'Gaps across 3 time horizons.')}</div>
                        {roadmapArt && <div className="flex gap-1.5">
                          <button onClick={() => exportArt(roadmapArt, 'docx')} disabled={!!busy} className="flex-1 px-2 py-1.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold rounded-lg disabled:opacity-50">Word</button>
                          <button onClick={() => exportArt(roadmapArt, 'pdf')} disabled={!!busy} className="flex-1 px-2 py-1.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold rounded-lg disabled:opacity-50">PDF</button>
                        </div>}
                      </div>
                    </div>
                    {!modelApproved && (
                      <button onClick={approveModel} disabled={!!busy} className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl text-sm disabled:opacity-50">✅ {t('اعتماد النموذج رسميًا والانتقال للتنفيذ', 'Approve model & proceed to execution')}</button>
                    )}
                  </div>

                  {/* Integrity issues */}
                  <details open className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                    <summary className="font-black text-slate-800 dark:text-slate-100 text-sm cursor-pointer">🔍 {t('محرك التماسك', 'Integrity engine')} <span className="text-slate-400">({integrity.length})</span></summary>
                    <div className="mt-2 space-y-1">
                      {integrity.length === 0 && <div className="text-sm text-emerald-600">✅ {t('لا مشاكل تماسك مكتشفة.', 'No integrity issues found.')}</div>}
                      {integrity.map(iss => (
                        <div key={iss.id} className={`rounded-lg border p-2 text-sm ${SEV_COLOR[iss.severity] || SEV_COLOR.medium}`}>
                          <div className="font-bold">{iss.message} <span className="text-[10px] uppercase">[{iss.severity}]</span></div>
                          {iss.fixHint && <div className="text-slate-600 text-xs mt-0.5">↪ {iss.fixHint}</div>}
                        </div>
                      ))}
                    </div>
                  </details>

                  {/* Coverage matrix */}
                  {coverage.length > 0 && (
                    <details className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                      <summary className="font-black text-slate-800 dark:text-slate-100 text-sm cursor-pointer">🗂 {t('مصفوفة التغطية', 'Coverage matrix')}</summary>
                      <div className="mt-2 overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead><tr className="text-[11px] text-slate-500 border-b border-slate-200 dark:border-slate-700">
                            <th className="text-start py-1">{t('الوحدة', 'Unit')}</th>
                            <th className="py-1">{t('أدوار', 'Roles')}</th><th className="py-1">{t('سياسات', 'Pol')}</th>
                            <th className="py-1">{t('إجراءات', 'Proc')}</th><th className="py-1">{t('صلاحيات', 'Auth')}</th><th className="py-1">KPIs</th>
                          </tr></thead>
                          <tbody>
                            {coverage.map(r => (
                              <tr key={r.unitId} className="border-b border-slate-100 dark:border-slate-700 text-center">
                                <td className="text-start py-1 text-slate-700 dark:text-slate-200">{r.unitName}</td>
                                {[r.roles, r.policies, r.procedures, r.authorities, r.kpis].map((n, i) => (
                                  <td key={i} className={`py-1 ${n === 0 ? 'text-rose-500 font-bold' : 'text-slate-600'}`}>{n}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}

                  {/* Framework alignment */}
                  <details className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                    <summary className="font-black text-slate-800 dark:text-slate-100 text-sm cursor-pointer">🧭 {t('محاذاة الأطر المرجعية', 'Framework alignment')}</summary>
                    <div className="mt-2 space-y-3">
                      {alignment.map(fw => (
                        <div key={fw.frameworkId}>
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-bold text-slate-700 dark:text-slate-200">{fw.frameworkName}</span>
                            <span className="font-black text-emerald-600">{fw.score}%</span>
                          </div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {fw.controls.map(c => (
                              <span key={c.code} title={`${c.title}${c.evidence ? ' — ' + c.evidence : ''}`}
                                className={`text-[10px] px-2 py-0.5 rounded-full border ${c.state === 'covered' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : c.state === 'partial' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                                {c.code}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>

                  {/* Traceability (#13) */}
                  <details className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                    <summary className="font-black text-slate-800 dark:text-slate-100 text-sm cursor-pointer">🧬 {t('التتبّع الترابطي', 'Traceability')}</summary>
                    <div className="mt-2">
                      <div className="text-[11px] text-slate-500 mb-1">{t('اختر وحدة لعرض كل المرتبط بها:', 'Pick a unit to trace everything linked:')}</div>
                      <div className="flex flex-wrap gap-1">
                        {model.orgUnits.map(u => (
                          <button key={u.id} onClick={() => handleTrace('unit', u.id)}
                            className="text-xs px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-emerald-100 text-slate-700 dark:text-slate-200 font-bold">{u.name}</button>
                        ))}
                      </div>
                      {trace && (
                        <div className="mt-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-3 text-sm space-y-1">
                          <div className="font-black text-emerald-700 dark:text-emerald-300">{trace.rootLabel}</div>
                          {trace.roles.length > 0 && <div>👤 {t('أدوار', 'Roles')}: {trace.roles.map(r => r.title).join('، ')}</div>}
                          {trace.policies && (trace as any).policy && <div>📜 {t('سياسة', 'Policy')}: {(trace as any).policy.title}</div>}
                          {trace.procedures.length > 0 && <div>⚙️ {t('إجراءات', 'Procedures')}: {trace.procedures.map(p => p.title).join('، ')}</div>}
                          {trace.authorities.length > 0 && <div>🔑 {t('صلاحيات', 'Authorities')}: {trace.authorities.map(a => `${a.decision} (${LEVEL_AR[a.level] || a.level})`).join('، ')}</div>}
                          {trace.kpis.length > 0 && <div>📈 KPIs: {trace.kpis.map(k => `${k.name}=${k.target}`).join('، ')}</div>}
                          {trace.gaps.length > 0 && <div>⚠️ {t('فجوات', 'Gaps')}: {trace.gaps.map(g => g.area).join('، ')}</div>}
                        </div>
                      )}
                    </div>
                  </details>

                </div>
              )}
              <StageNav back={() => setStage(2)} next={() => setStage(4)} nextLabel={t('التالي: المكتبة', 'Next: library')} ar={ar} />
            </section>
          )}

          {/* STAGE 4 — reference library */}
          {!showProjects && stage === 4 && (
            <section className="space-y-5">
              <StageHead icon="📚" title={t('المكتبة المرجعية', 'Reference library')}
                desc={t('مشاريع حوكمة سابقة تُطابَق بالتشابه الدلالي + السياق لإثراء التوصيات وسد الفجوات.', 'Previous governance projects matched by semantic similarity + context to enrich recommendations and close gaps.')} />

              <div className="hw-tabs-line mb-4">
                <button onClick={() => setLibTab('docs')} className={libTab === 'docs' ? UI.tabActive : UI.tabIdle}>
                  📚 {t('الوثائق المولّدة', 'Generated docs')} <span className="opacity-60">({govDocs.length})</span>
                </button>
                <button onClick={() => setLibTab('refs')} className={libTab === 'refs' ? UI.tabActive : UI.tabIdle}>
                  📥 {t('المراجع والمعايير', 'References & standards')} <span className="opacity-60">({refProjects.length})</span>
                </button>
                <button onClick={() => setLibTab('history')} className={libTab === 'history' ? UI.tabActive : UI.tabIdle}>
                  🕑 {t('السجل والتدقيق', 'History & audit')}
                </button>
              </div>

              {libTab === 'refs' && (<>
              {/* v6-D: dedicated reference-projects home. Diagnostic generation lives in
                  the current-state stage — this tab is purely import → review → manage. */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 px-4 py-3 text-[12px] text-slate-600 dark:text-slate-300 flex items-start gap-2">
                <span>📚</span>
                <span>{t('هذا هو مقرّ المشاريع والمعايير المرجعية. كل مرجع تحفظه هنا يُسحب تلقائيًا أثناء بناء النموذج وتوليد الوثائق (مطابقة دلالية بالقطاع). استورد جماعيًا، راجِع التصنيف، ثم تصفّح وأدِر أدناه.', 'This is the home for reference projects & standards. Every reference saved here is auto-pulled during model build & document generation (sector-aware semantic match). Import in bulk, review the classification, then browse & manage below.')}</span>
              </div>

              {/* Pre-seeded institutional standards (ISO + frameworks + regulations) */}
              <div className="rounded-2xl border-2 border-emerald-300 dark:border-emerald-700 bg-gradient-to-l from-emerald-50 to-white dark:from-emerald-900/20 dark:to-slate-800 p-5">
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1">
                    <div className="font-extrabold text-sm text-emerald-800 dark:text-emerald-200">📐 {t('المعايير المرجعية المؤسسية', 'Institutional standards')}</div>
                    <div className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{t('حمّل خريطة المعايير الكاملة (ISO، COSO، EFQM، التنظيمات، المعايير المهنية) لـ16 إدارة دفعة واحدة — تُخزَّن في المكتبة ويأخذ منها البناء والتوليد تلقائيًا.', 'Load the full standards map (ISO, COSO, EFQM, regulations, professional bodies) for 16 departments — stored in the library and pulled automatically by build & generation.')}</div>
                  </div>
                  <button onClick={handleSeedStandards} disabled={!!seedBusy}
                    className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold rounded-xl text-sm whitespace-nowrap">
                    {seedBusy ? '⏳ ' + seedBusy : t('📥 تحميل المعايير للمكتبة', '📥 Seed standards')}
                  </button>
                </div>
              </div>

              {/* م4 — batch drop: 10/20/30 files → auto-classify */}
              <div className="rounded-2xl border-2 border-dashed border-emerald-300 dark:border-emerald-700 bg-emerald-50/40 dark:bg-emerald-900/10 p-5">
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1">
                    <div className="font-extrabold text-sm text-emerald-800 dark:text-emerald-200">📥 {t('استيراد جماعي ذكي للمكتبة', 'Smart batch import')}</div>
                    <div className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{t('أسقط 10 أو 20 أو 30 ملفًا دفعة واحدة — يُصنَّف كل ملف تلقائيًا (النوع، القطاع، الحجم، الوسوم) ويُرتَّب للمراجعة.', 'Drop 10/20/30 files at once — each is auto-classified (kind, sector, size, tags) and ordered for review.')}</div>
                  </div>
                  <input ref={refBatchInputRef} type="file" multiple className="hidden"
                    accept=".txt,.md,.csv,.json,.xml,.htm,.html,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.mp3,.m4a,.wav,.ogg,.aac,.flac,.webm,.opus,image/*,audio/*"
                    onChange={e => { const fs = Array.from(e.target.files || []) as File[]; if (fs.length) handleRefBatchFiles(fs); if (refBatchInputRef.current) refBatchInputRef.current.value = ''; }} />
                  <button onClick={() => refBatchInputRef.current?.click()} disabled={refBatchBusy}
                    className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold rounded-xl text-sm whitespace-nowrap">
                    {refBatchBusy ? t('⏳ يحلّل…', '⏳ Analyzing…') : t('📂 اختر ملفات متعددة', '📂 Choose files')}
                  </button>
                </div>
                {refBatchProg && (
                  <div className="mt-3">
                    <div className="text-[11px] text-emerald-700 dark:text-emerald-300 mb-1">
                      {refBatchProg.phase === 'read' ? t('قراءة', 'Reading') : t('تصنيف', 'Classifying')}: {refBatchProg.fileName} — {refBatchProg.current}/{refBatchProg.total}
                    </div>
                    <div className="h-2 bg-emerald-100 dark:bg-emerald-900/40 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 transition-all" style={{ width: `${refBatchProg.total ? Math.round(refBatchProg.current / refBatchProg.total * 100) : 0}%` }} />
                    </div>
                  </div>
                )}
              </div>

              {/* batch review list — editable before save */}
              {refDrafts.length > 0 && (
                <div className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-white dark:bg-slate-800 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="font-black text-sm text-slate-800 dark:text-slate-100">🔍 {t('مراجعة التصنيف التلقائي', 'Review auto-classification')} <span className="text-slate-400">({refDrafts.length})</span></div>
                    <div className="flex gap-2">
                      <button onClick={() => setRefDrafts([])} className="px-3 py-1.5 text-xs rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-bold">{t('إلغاء', 'Discard')}</button>
                      <button onClick={handleSaveRefDrafts} disabled={!!busy} className="px-4 py-1.5 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-50">💾 {t('حفظ الكل بالمكتبة', 'Save all')}</button>
                    </div>
                  </div>
                  <div className="space-y-2 max-h-[420px] overflow-auto">
                    {refDrafts.map((d, i) => (
                      <div key={i} className={`rounded-xl border p-3 ${d.ok ? 'border-slate-200 dark:border-slate-700' : 'border-amber-300 bg-amber-50/50 dark:bg-amber-900/10'}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-[10px] text-slate-400 shrink-0">📄 {d.fileName}</span>
                          {!d.ok && <span className="text-[10px] text-amber-600 font-bold">⚠ {t('راجِع يدويًا', 'review')}</span>}
                          <button onClick={() => removeRefDraft(i)} className="ms-auto text-rose-400 hover:text-rose-600 text-xs">🗑</button>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <input value={d.name} onChange={e => updateRefDraft(i, { name: e.target.value })} placeholder={t('الاسم', 'Name')} className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-xs" />
                          <input value={d.sector} onChange={e => updateRefDraft(i, { sector: e.target.value })} placeholder={t('القطاع', 'Sector')} className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-xs" />
                          <select value={d.artifactKind} onChange={e => updateRefDraft(i, { artifactKind: e.target.value as ReferenceDraft['artifactKind'] })} className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-xs">
                            {(['regulation','policy','contract','meeting_minutes','org_chart','brand','profile','survey','assessment','policy_manual','org_design','authority_matrix','kpi_framework','other'] as ReferenceDraft['artifactKind'][]).map(k => (
                              <option key={k} value={k}>{artifactKindLabel(k, ar)}</option>
                            ))}
                          </select>
                          <select value={d.companySize} onChange={e => updateRefDraft(i, { companySize: e.target.value as ReferenceDraft['companySize'] })} className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-xs">
                            {(['small','medium','large','enterprise'] as ReferenceDraft['companySize'][]).map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <input value={d.summary} onChange={e => updateRefDraft(i, { summary: e.target.value })} placeholder={t('ملخص', 'Summary')} className="w-full mt-2 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-xs" />
                        {d.tags.length > 0 && <div className="mt-1.5">{d.tags.map(tg => <span key={tg} className="inline-block text-[10px] bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 rounded-full px-2 py-0.5 m-0.5">{tg}</span>)}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <button onClick={() => setShowRefForm(s => !s)} className="px-5 py-2.5 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-sm">
                {showRefForm ? t('إغلاق النموذج', 'Close form') : t('✍️ إضافة مرجع يدوي (اختياري)', '✍️ Add one manually (optional)')}
              </button>
              {showRefForm && (
                <div className="rounded-2xl border border-emerald-200 bg-white p-4 space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input value={rp.name} onChange={e => setRp({ ...rp, name: e.target.value })} placeholder={t('اسم المشروع/الشركة', 'Project/company name')} className="px-3 py-2 rounded-lg border border-slate-300 text-sm" />
                    <input value={rp.sector} onChange={e => setRp({ ...rp, sector: e.target.value })} placeholder={t('القطاع', 'Sector')} className="px-3 py-2 rounded-lg border border-slate-300 text-sm" />
                    <input value={rp.tags} onChange={e => setRp({ ...rp, tags: e.target.value })} placeholder={t('وسوم (مفصولة بفاصلة)', 'tags, comma-separated')} className="px-3 py-2 rounded-lg border border-slate-300 text-sm" />
                  </div>
                  <input value={rp.summary} onChange={e => setRp({ ...rp, summary: e.target.value })} placeholder={t('ملخص قصير', 'Short summary')} className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm" />
                  <textarea value={rp.content} onChange={e => setRp({ ...rp, content: e.target.value })} placeholder={t('المحتوى القابل لإعادة الاستخدام (سياسة/هيكل/مصفوفة...)', 'reusable content (policy/structure/matrix...)')} rows={5} className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm" />
                  <button onClick={handleAddRef} disabled={!!busy} className="px-4 py-2 bg-emerald-600 text-white font-bold rounded-lg text-sm disabled:opacity-50">{t('حفظ', 'Save')}</button>
                </div>
              )}
              {/* v6-D: managed browse — grouped by sector, delete wired, auto-used badge */}
              {/* Sub-tabs: standards vs reference projects */}
              <div className="hw-tabs-line mb-2">
                <button onClick={() => setLibRefTab('projects')} className={libRefTab === 'projects' ? UI.tabActive : UI.tabIdle}>
                  📐 {t('مشاريع مرجعية', 'Reference projects')} <span className="opacity-60">({refProjects.filter(p => !p.id.startsWith('std_')).length})</span>
                </button>
                <button onClick={() => setLibRefTab('standards')} className={libRefTab === 'standards' ? UI.tabActive : UI.tabIdle}>
                  🏛 {t('المعايير', 'Standards')} <span className="opacity-60">({refProjects.filter(p => p.id.startsWith('std_')).length})</span>
                </button>
              </div>
              {(() => {
                const usedRefIds = new Set<string>(
                  (model?.gaps || []).flatMap((g: any) => g.matchedProjectIds || []),
                );
                const filtered = libRefTab === 'standards'
                  ? refProjects.filter(p => p.id.startsWith('std_'))
                  : refProjects.filter(p => !p.id.startsWith('std_'));
                const bySector = filtered.reduce<Record<string, ReferenceProject[]>>((acc, p) => {
                  const k = (p.sector || '').trim() || t('عام', 'General');
                  (acc[k] = acc[k] || []).push(p);
                  return acc;
                }, {});
                const sectors = Object.keys(bySector).sort();
                if (!filtered.length) {
                  return <div className="text-slate-400 text-sm">
                    {libRefTab === 'standards'
                      ? t('لا توجد معايير بعد — انقر «تحميل المعايير للمكتبة» أعلاه.', 'No standards yet — click "Seed standards" above.')
                      : t('لا توجد مشاريع مرجعية بعد — استورد ملفات أو أضف مرجعًا يدويًا.', 'No reference projects yet — import files or add one manually.')}
                  </div>;
                }
                return (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="font-black text-slate-700 dark:text-slate-200">
                        {libRefTab === 'standards' ? '🏛 ' + t('المعايير المحفوظة', 'Saved standards') : '📚 ' + t('المشاريع المرجعية', 'Reference projects')}
                        <span className="text-slate-400 ms-1">({filtered.length})</span>
                      </span>
                      {usedRefIds.size > 0 && <span className="text-emerald-600 dark:text-emerald-400">✅ {t(`${usedRefIds.size} مُستخدَم في النموذج الحالي`, `${usedRefIds.size} used in current model`)}</span>}
                    </div>
                    {sectors.map(sec => (
                      <div key={sec}>
                        <div className="text-[11px] font-black text-slate-500 dark:text-slate-400 mb-1.5 flex items-center gap-1.5">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          {sec} <span className="text-slate-400 font-normal">({bySector[sec].length})</span>
                        </div>
                        <div className="grid sm:grid-cols-2 gap-2">
                          {bySector[sec].map(p => {
                            const used = usedRefIds.has(p.id);
                            return (
                              <div key={p.id} className={`group relative rounded-xl border bg-white dark:bg-slate-800 p-3 ${used ? 'border-emerald-300 dark:border-emerald-700' : 'border-slate-200 dark:border-slate-700'}`}>
                                <button onClick={() => handleDeleteRef(p.id, p.name)} title={t('حذف المرجع', 'Delete reference')}
                                  className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 transition-opacity text-rose-400 hover:text-rose-600 text-sm">🗑</button>
                                <div className="font-bold text-slate-800 dark:text-slate-100 text-sm pe-6">
                                  {p.name}
                                  {used && <span className="ms-1.5 align-middle text-[9px] font-black px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700">✅ {t('مُستخدَم', 'In use')}</span>}
                                </div>
                                {p.summary && <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">{p.summary}</div>}
                                {p.tags.length > 0 && <div className="mt-1">{p.tags.map(tg => <span key={tg} className="inline-block text-[10px] bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 rounded-full px-2 py-0.5 m-0.5">{tg}</span>)}</div>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
              </>)}

              {libTab === 'docs' && (
              /* Generated documents library + approval (moved from Assurance) */
              <details open className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                <summary className="font-black text-slate-800 dark:text-slate-100 text-sm cursor-pointer">📚 {t('مكتبة الوثائق المولّدة', 'Generated documents library')} <span className="text-slate-400">({govDocs.length})</span></summary>
                <div className="mt-2 space-y-3">
                  {govDocs.length === 0 && <div className="text-sm text-slate-400">{t('لا وثائق محفوظة بعد. ولّد وثيقة ثم "احفظ بالمكتبة".', 'No saved documents yet. Generate then "Save to library".')}</div>}

                  {/* Batch-export toolbar (#6/#8): Word/PDF × merged/separate, then export all */}
                  {govDocs.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700 p-2">
                      <span className="text-[11px] font-black text-slate-500">{t('تصدير', 'Export')}</span>
                      <select value={batchFmt} onChange={e => setBatchFmt(e.target.value as BatchFormat)} className="text-xs px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 font-bold">
                        <option value="docx">{t('Word (.docx)', 'Word (.docx)')}</option>
                        <option value="pdf">{t('PDF', 'PDF')}</option>
                        <option value="html">{t('HTML تفاعلي', 'Interactive HTML')}</option>
                      </select>
                      <select value={batchMode} onChange={e => setBatchMode(e.target.value as BatchMode)} className="text-xs px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 font-bold">
                        <option value="separate">{t('ملفات منفصلة', 'Separate files')}</option>
                        <option value="merged">{t('ملف مجمّع', 'One merged file')}</option>
                      </select>
                      <button onClick={() => handleBatchExport(govDocs, t('وثائق الحوكمة', 'governance_documents'))} disabled={!!busy} className="text-xs px-3 py-1 rounded-lg bg-emerald-600 text-white font-bold disabled:opacity-50">⬇️ {t('تصدير الكل', 'Export all')} ({govDocs.length})</button>
                      <button onClick={() => { setZipReady(null); handleZipExport(govDocs); }} disabled={!!busy} title={t('حزمة مجلدات منظَّمة باسم الإصدار، مقسومة حسب النوع', 'Organized folder package named by version, split by type')} className="text-xs px-3 py-1 rounded-lg bg-indigo-600 text-white font-bold disabled:opacity-50">🗂️ {t(`حزمة مجلدات (v${model?.version || 1})`, `Folder package (v${model?.version || 1})`)}</button>
                      {zipReady && (
                        <a
                          href={zipReady.url}
                          download={zipReady.fileName}
                          onClick={() => setTimeout(() => { URL.revokeObjectURL(zipReady.url); setZipReady(null); }, 2000)}
                          className="text-xs px-3 py-1 rounded-lg bg-emerald-500 text-white font-bold animate-pulse"
                        >
                          ⬇️ {t(`حمّل الحزمة (${zipReady.count} وثيقة)`, `Download package (${zipReady.count} docs)`)}
                        </a>
                      )}
                    </div>
                  )}

                  {/* Folders by document type (#9) */}
                  {(Object.entries(govDocs.reduce<Record<string, GovDocumentRecord[]>>((acc, d) => {
                    (acc[d.kind] = acc[d.kind] || []).push(d); return acc;
                  }, {})) as [string, GovDocumentRecord[]][]).map(([kind, recs]) => {
                    const f = folderFor(kind);
                    return (
                      <details key={kind} open className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/40 dark:bg-slate-900/30">
                        <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer text-sm font-black text-slate-700 dark:text-slate-200">
                          <span>{f.icon} {ar ? f.ar : f.en} <span className="text-slate-400 font-bold">({recs.length})</span></span>
                          <button onClick={(e) => { e.preventDefault(); handleBatchExport(recs, ar ? f.ar : f.en); }} disabled={!!busy} className="text-[11px] px-2 py-1 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-bold disabled:opacity-50">⬇️ {t('تصدير المجلد', 'Export folder')}</button>
                        </summary>
                        <div className="px-3 pb-3 space-y-2">
                          {recs.map(d => (
                            <div key={d.id} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-bold text-slate-800 dark:text-slate-100 text-sm">{d.title} <span className={`text-[10px] px-2 py-0.5 rounded-full ${d.status === 'approved' ? 'bg-emerald-50 text-emerald-700' : d.status === 'in_review' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{STATUS_AR[d.status]}</span></span>
                                <span className="text-[10px] text-slate-400 shrink-0">v{d.version} · {new Date(d.updatedAt).toLocaleDateString()}</span>
                              </div>
                              <div className="flex flex-wrap gap-1 mt-2">
                                <button onClick={() => reopenDoc(d)} className="text-xs px-2 py-1 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-bold">👁 {t('استعراض/تحرير', 'Preview/edit')}</button>
                                <button onClick={() => handleBatchExport([d], d.title)} className="text-xs px-2 py-1 rounded-lg bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 font-bold">⬇️ {t('تصدير', 'Export')}</button>
                                {d.status !== 'in_review' && <button onClick={() => setDocStatus(d, 'in_review')} className="text-xs px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-bold">⏳ {t('للمراجعة', 'To review')}</button>}
                                {d.status !== 'approved' && <button onClick={() => setDocStatus(d, 'approved')} className="text-xs px-2 py-1 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-bold">✅ {t('اعتماد', 'Approve')}</button>}
                                <button onClick={() => { const c = window.prompt(t('أضف تعليقاً', 'Add a comment')); if (c) addDocComment(d, c); }} className="text-xs px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-bold">💬 {t('تعليق', 'Comment')}{d.comments?.length ? ` (${d.comments.length})` : ''}</button>
                                <button onClick={() => removeDoc(d.id)} className="text-xs px-2 py-1 rounded-lg text-rose-400 hover:text-rose-600">🗑</button>
                              </div>
                              {d.comments && d.comments.length > 0 && (
                                <div className="mt-2 space-y-1">
                                  {d.comments.map(c => (
                                    <div key={c.id} className="text-[11px] text-slate-500 border-s-2 border-slate-200 dark:border-slate-700 ps-2">{c.text} <span className="text-slate-400">· {new Date(c.at).toLocaleDateString()}</span></div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    );
                  })}
                </div>
              </details>
              )}

              {libTab === 'history' && (<>
              {snapshots.length === 0 && (!model?.auditLog || model.auditLog.length === 0) && (
                <div className="text-slate-400 text-sm">{t('لا يوجد سجل بعد — النسخ والتدقيق تظهر هنا بعد أول اعتماد أو تعديل.', 'No history yet — snapshots & audit appear here after the first approval or edit.')}</div>
              )}
              {/* History: snapshots / rollback (moved from Assurance) */}
              {snapshots.length > 0 && (
                <details className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                  <summary className="font-black text-slate-800 dark:text-slate-100 text-sm cursor-pointer">🕑 {t('النسخ والاسترجاع', 'Snapshots & rollback')} <span className="text-slate-400">({snapshots.length})</span></summary>
                  <div className="mt-2 space-y-1">
                    {snapshots.map(s => (
                      <div key={s.id} className="flex items-center justify-between gap-2 text-sm py-1 border-b border-slate-100 dark:border-slate-700">
                        <span className="text-slate-600 dark:text-slate-300">v{s.version} · {s.reason} · <span className="text-slate-400">{new Date(s.at).toLocaleString()}</span></span>
                        <span className="flex gap-1 shrink-0">
                          <button onClick={() => handleRollback(s)} className="text-xs px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-bold">↩ {t('استرجاع', 'Restore')}</button>
                          <button onClick={async () => { await deleteSnapshot(s.id); await loadAll(); }} className="text-rose-400 hover:text-rose-600 text-xs">🗑</button>
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Audit log (moved from Assurance) */}
              {model?.auditLog && model.auditLog.length > 0 && (
                <details className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                  <summary className="font-black text-slate-800 dark:text-slate-100 text-sm cursor-pointer">📜 {t('سجل التدقيق', 'Audit log')} <span className="text-slate-400">({model.auditLog.length})</span></summary>
                  <div className="mt-2 space-y-1 max-h-64 overflow-auto">
                    {[...model.auditLog].reverse().map(a => (
                      <div key={a.id} className="text-[11px] text-slate-500 border-b border-slate-100 dark:border-slate-700 py-1">
                        <span className="text-slate-400">{new Date(a.at).toLocaleString()}</span> · <span className="font-bold text-slate-600 dark:text-slate-300">{a.actor}</span> · <span className="text-emerald-600">{a.action}</span> — {a.detail}
                      </div>
                    ))}
                  </div>
                </details>
              )}
              </>)}

              <StageNav back={() => setStage(3)} ar={ar} />
            </section>
          )}

          {/* STAGE 5 — department packages */}
          {!showProjects && stage === 5 && model && (
            <section className="space-y-5">
              <StageHead icon="🏢" title={t('حزم الإدارات', 'Department Packages')}
                desc={t('توليد الحزمة الكاملة لكل إدارة: الهدف، الهيكل، السياسات، الإجراءات، المؤشرات، الوصف الوظيفي، RACI، سجل المخاطر.', 'Generate a full package per department: goal, org chart, policies, procedures, KPIs, job descriptions, RACI, risk register.')} />
              <DepartmentBuilder model={model} tenantId={tenantId} language={language} />
              <StageNav back={() => setStage(2)} ar={ar} />
            </section>
          )}

        </div>
      </main>

      <GovCopilot
        stageKey={(showProjects ? 'projects' : stage === 0 ? 'sources' : stage === 1 ? 'model' : stage === 6 ? 'assurance' : stage === 7 ? 'model' : stage === 2 ? (buildTab === 'docs' ? 'generation' : 'diagrams') : stage === 3 ? 'assurance' : stage === 4 ? 'library' : 'library') as GovStageKey}
        stageLabel={showProjects ? t('المشاريع', 'Projects') : (() => { const s = STAGES.find(x => x.id === stage); return s ? t(s.ar, s.en) : ''; })()}
        model={model}
        language={language}
        logoUrl={settings.logoUrl}
        tenantId={tenantId}
        stateSnapshot={{
          documentsCount: documents.length,
          chunkCount,
          modelBuilt: !!model,
          activeProjectName: companyName,
          permissionError,
        }}
        extraContext={`${chunkCount} ${t('مقطع', 'chunks')}، ${diagrams.length} ${t('مخطط', 'diagrams')}`}
        actionInput={actionInput}
        setActionInput={setActionInput}
        onPropose={handlePropose}
        proposing={proposing}
        proposedActions={proposedActions}
        onApplyActions={handleApplyActions}
        onDiscardActions={() => { setProposedActions([]); setActionInput(''); }}
        applyBusy={!!busy}
        agentInput={agentInput}
        setAgentInput={setAgentInput}
        onRunAgent={handleRunAgent}
        agentRunning={agentRunning}
        agentSteps={agentSteps}
        agentAnswer={agentAnswer}
        agentTrace={agentTrace}
        agentAutoApply={agentAutoApply}
        setAgentAutoApply={setAgentAutoApply}
      />
    </div>
  );
};

const StageHead: React.FC<{ icon: string; title: string; desc: string }> = ({ icon, title, desc }) => (
  <div>
    <h2 className="text-2xl font-black text-slate-800 dark:text-slate-100">{icon} {title}</h2>
    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-3xl">{desc}</p>
  </div>
);

const StageNav: React.FC<{ back?: () => void; next?: () => void; nextLabel?: string; nextDisabled?: boolean; nextTitle?: string; ar: boolean }> = ({ back, next, nextLabel, nextDisabled, nextTitle, ar }) => (
  <div className="flex items-center justify-between pt-2">
    {back ? <button onClick={back} className="px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-sm">{ar ? '→ السابق' : '← Back'}</button> : <span />}
    {next && <button onClick={next} disabled={nextDisabled} title={nextTitle} className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-sm disabled:opacity-40 disabled:cursor-not-allowed">{nextLabel} {ar ? '←' : '→'}</button>}
  </div>
);

// Recursive interactive org-unit tree. Roots = units with no parent (or whose
// parent is missing from the set). Renders nested mandate-annotated branches.
const OrgUnitTree: React.FC<{ units: any[]; ar: boolean }> = ({ units, ar }) => {
  const byParent = new Map<string, any[]>();
  const ids = new Set(units.map(u => u.id));
  for (const u of units) {
    const key = (u.parentId && ids.has(u.parentId)) ? u.parentId : '__root__';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(u);
  }
  const Branch: React.FC<{ unit: any; depth: number }> = ({ unit, depth }) => {
    const children = byParent.get(unit.id) || [];
    return (
      <div className={depth > 0 ? 'border-r-2 border-emerald-200 dark:border-emerald-800 pr-3 mr-1' : ''}>
        <div className="flex items-baseline gap-2 py-1">
          <span className="text-emerald-500">{children.length ? '▾' : '•'}</span>
          <span className="font-bold text-slate-700 dark:text-slate-200 text-sm">{unit.name}</span>
          {unit.mandate && <span className="text-[12px] text-slate-500 dark:text-slate-400">— {unit.mandate}</span>}
        </div>
        {children.length > 0 && (
          <div className="mt-1 space-y-1">
            {children.map(c => <Branch key={c.id} unit={c} depth={depth + 1} />)}
          </div>
        )}
      </div>
    );
  };
  const roots = byParent.get('__root__') || [];
  if (!roots.length) return <div className="text-slate-400 text-sm">{ar ? 'لا توجد وحدات.' : 'No units.'}</div>;
  return <div className="space-y-1" dir={ar ? 'rtl' : 'ltr'}>{roots.map(r => <Branch key={r.id} unit={r} depth={0} />)}</div>;
};

export default GovernanceCenter;

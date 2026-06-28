import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { 
  Language, 
  Screen, 
  Question, 
  UserResponse, 
  AssessmentConfig, 
  User, 
  OrganizationDocument, 
  AdminSettings,
  WorkEnvironmentAnswers,
  SurveyScope,
  AssessmentKind,
  AffectSignal,
  toKindArray
} from './types';
import type { ProctorSummary } from './services/proctorCore';
import HomeScreen from './components/HomeScreen';
import SetupScreen from './components/SetupScreen';
import AssessmentScreen from './components/AssessmentScreen';
import VerbalAssessmentScreen from './components/VerbalAssessmentScreen';
import EmployeeOnboarding from './components/EmployeeOnboarding';
import MonitoredSurveyScreen from './components/MonitoredSurveyScreen';
import ResultsScreen from './components/ResultsScreen';
import AdminPanel from './components/AdminPanel';
import GovernanceCenter from './components/GovernanceCenter';
import PublicSurveyScreen from './components/PublicSurveyScreen';
import EmployeePortalScreen from './components/EmployeePortalScreen';
import { PaperAssessmentPortal } from './components/PaperAssessmentPortal';
import { OnlineAssessmentPortal } from './components/OnlineAssessmentPortal';
import UnifiedAssessmentPortal from './components/UnifiedAssessmentPortal';
import PublicReviewScreen from './components/PublicReviewScreen';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider, useToast } from './components/ToastProvider';
import { buildFontCss } from './services/designTokens';
import { generateQuestions } from './services/geminiService';
import { compileChunkContext, migrateSettings, activeProjectSurvey } from './services/governanceService';
import { TRANSLATIONS } from './constants';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import { onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signInWithEmailAndPassword } from 'firebase/auth';

// Allow-listed administrator accounts permitted to open the Admin Hub.
const ADMIN_EMAILS = ['ahmed0ibrahim@gmail.com', 'karm92000@gmail.com', 'alsenosy15@gmail.com'];
import { collection, doc, getDoc, getDocs, setDoc, deleteDoc } from 'firebase/firestore';

const BATCH_SIZE = 10;
// Start the test FAST: generate a tiny first batch (shown immediately), then refill
// the remaining questions in steady background chunks while the candidate answers —
// instead of waiting on one big 10-question (or 30-question) call up front.
const FIRST_BATCH = 3;     // tiny first batch → interview/exam starts in ~15-20s
const REFILL_CHUNK = 7;    // background refill size (fewer calls vs. steady supply)

// Progressively fetch the remaining questions in REFILL_CHUNK-sized pieces, appending
// each as it arrives so the question feed keeps flowing. Stops on error/empty (the
// candidate simply keeps whatever loaded). Cross-batch dedup avoids repeated scenarios.
async function fetchRemainingInChunks(
  params: {
    jobTitle: string; total: number; firstBatchTexts: string[];
    language: Language; jobDescription?: string; orgContext?: string;
    theories?: { birkman: boolean; holland: boolean; psychTech: boolean; bloomTaxonomy: boolean };
  },
  onChunk: (qs: Question[]) => void,
): Promise<void> {
  const asked = [...params.firstBatchTexts];
  let have = params.firstBatchTexts.length;
  while (have < params.total) {
    const n = Math.min(REFILL_CHUNK, params.total - have);
    let chunk: Question[];
    try {
      chunk = await generateQuestions(
        params.jobTitle, n, params.language, false,
        params.jobDescription, params.orgContext, params.theories, asked,
      );
    } catch (err) {
      console.error('background question chunk failed (keeping loaded questions):', err);
      break;
    }
    if (!chunk.length) break;        // guard against a 0-length response (no spin)
    onChunk(chunk);
    asked.push(...chunk.map(q => q.questionText));
    have += chunk.length;
  }
}

// Effect-bridge: App owns the `error` state but cannot call useToast in its own
// body (it renders the provider). This child lives under <ToastProvider> and
// surfaces every error as a unified toast.
const RootErrorToast: React.FC<{ error: string | null }> = ({ error }) => {
  const toast = useToast();
  useEffect(() => {
    if (error) toast.error(error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);
  return null;
};

// Default Pre-seeded Organization files for Axiom Corp
const DEFAULT_DOCUMENTS: OrganizationDocument[] = [
  {
    id: '1',
    name: 'المؤسسة كشريك معرفي ورقمي (Identity & Vision)',
    category: 'identity',
    uploadedAt: '2026-06-06T09:00:00Z',
    content: 'رؤية ورسالة شركة ريمكس للتحول الرقمي المتميز:\nنسعى لنكون المرجع والذراع المعرفي والتقني الأول في الشرق الأوسط لميكنة العمليات الإدارية وتحليل أداء الموارد البشرية. قيمنا ترتكز على الشفافية والمساءلة الإدارية وضمان أعلى مستويات الفهم المعرفي (Bloom\'s Cognitive Levels) وجودة المخرجات التقنية.'
  },
  {
    id: '2',
    name: 'تشخيص الواقع الراهن والتحديات الهيكلية (Actual Current State)',
    category: 'current_state',
    uploadedAt: '2026-06-06T09:01:00Z',
    content: 'الواقع الراهن للمؤسسة وتوصيات التدقيق الداخلي:\nممارسات العمل الحالية تواجه تحديًا محوريًا في تكدس الموافقات (Workflows) لتعدد المستويات الإدارية الطولية وتداخل المسؤوليات بين الأقسام المساندة والمكاتب التنفيذية. تهدف مساعي التطوير الهيكلي إلى إعادة هندسة الإجراءات ودمج الإدارات التشابهية لتبسيط العمليات وتقليل فترات انتظار المراجعين والشركاء.'
  },
  {
    id: '3',
    name: 'البنية الرقمية وتجهيز النظم القائمة (Digital Infrastructure)',
    category: 'infrastructure',
    uploadedAt: '2026-06-06T09:02:00Z',
    content: 'تفصيل الجاهزية التكنولوجية:\nتمتلك الشركة بنية تحتية مقبولة من جهة الخوادم والأجهزة، ولكنها تفتقد نظام تخطيط موارد المؤسسات الموحد (Unified ERP Cloud System) مما يخلق فجوات حقيقية بين إدارة المشتريات وإدارات العمليات وإدارة تتبع كفاءة الموظفين. التحول التدريجي المخطط له يستهدف دمج كافة السيرفرات والمشروعات سحابيًا.'
  }
];

const DEFAULT_SETTINGS: AdminSettings = {
  questionCount: 30, // Admins set questions. Standard counts: 30, 40, or 50.
  theories: {
    birkman: true,
    holland: true,
    psychTech: true,
    bloomTaxonomy: true
  },
  fontFamily: 'Thmanyah Sans',
  logoUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIiBmaWxsPSJub25lIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgcng9IjI1IiBmaWxsPSIjMGYxNzJhIi8+PGNpcmNsZSBjeD0iNTAiIGN5PSI1MCIgcj0iMjgiIHN0cm9rZT0iIzE0YjhhNiIgc3Ryb2tlLXdpZHRoPSI4Ii8+PGNpcmNsZSBjeD0iNTAiIGN5PSI1MCIgcj0iMTQiIHN0cm9rZT0iIzEwYjk4MSIgc3Ryb2tlLXdpZHRoPSI2Ii8+PHBhdGggZD0iTTQ0IDUwaDEyIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+',
  companyName: 'Ailigent.ai',
  activeClientProfileId: 'remix_corp',
  aiPresetPersona: 'executive',
  clientProfiles: [
    {
      id: 'remix_corp',
      name: 'شركة ريمكس للتحول الرقمي',
      logoUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIiBmaWxsPSJub25lIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgcng9IjI1IiBmaWxsPSIjZjhmYWZjIiBzdHJva2U9IiNlMmU4ZjAiIHN0cm9rZS13aWR0aD0iMiIvPjxwYXRoIGQ9Ik0zMCAzNWwyNSAxNS0yNSAxNSIgc3Ryb2tlPSIjNGY0NmU1IiBzdHJva2Utd2lkdGg9IjEwIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48cGF0aCBkPSJNNDUgMzVsMjUgMTUtMjUgMTUiIHN0cm9rZT0iI2Y1OWUwYiIgc3Ryb2tlLXdpZHRoPSIxMCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PC9zdmc+',
      description: 'شركة رائدة جهة التميز والميكنة الإدارية وتطوير النظم الرقمية.',
      industry: 'التقنية والخدمات السحابية',
      uploadedAt: '2026-06-06T12:00:00Z'
    }
  ]
};

const App: React.FC = () => {
  // Navigation & General Workspace States
  const [isAdminPortal, setIsAdminPortal] = useState<boolean>(false);
  const [isGovCenter, setIsGovCenter] = useState<boolean>(false);
  const [currentScreen, setCurrentScreen] = useState<Screen>(Screen.HOME);
  const [language, setLanguage] = useState<Language>('ar'); // Default to Arabic for user requirements
  const [user, setUser] = useState<User | null>(null);
  const [assessmentConfig, setAssessmentConfig] = useState<AssessmentConfig | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [responses, setResponses] = useState<UserResponse[]>([]);
  const [workplaceAnswers, setWorkplaceAnswers] = useState<WorkEnvironmentAnswers | undefined>(undefined);
  // B3 — integrity summary from the in-app survey's live proctoring (persisted with the result).
  const [proctorSummary, setProctorSummary] = useState<ProctorSummary | undefined>(undefined);
  const [verbalAffect, setVerbalAffect] = useState<AffectSignal | undefined>(undefined);  // voice/facial affect from verbal interview
  const [surveyScope, setSurveyScope] = useState<SurveyScope>('both');
  const [isDark, setIsDark] = useState<boolean>(() => document.documentElement.classList.contains('dark'));

  const toggleDark = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('hawkamah-theme', next ? 'dark' : 'light');
  };
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Firestore & local states (with defaults for unauthenticated sandbox views)
  const [documents, setDocuments] = useState<OrganizationDocument[]>(DEFAULT_DOCUMENTS);
  const [settings, setSettings] = useState<AdminSettings>(DEFAULT_SETTINGS);
  const [allAssessments, setAllAssessments] = useState<any[]>([]);

  // Synchronize dynamic Arabic webfont on the document body and all visual text nodes
  useEffect(() => {
    // The on-screen UI brand face is ALWAYS Thmanyah Sans (owner requirement).
    // The stored settings.fontFamily (e.g. 'Almarai') is intentionally NOT used
    // for the live UI — it kept overriding the brand font. It remains available
    // for document/Word exports, which keep their own font (Almarai), untouched.
    const chosenFont = 'Thmanyah Sans';

    // Inject dynamic stylesheet to override button/inputs, browser weights, and tailwind's font-sans
    let fontStyleNode = document.getElementById('dynamic-webfont-style');
    if (!fontStyleNode) {
      fontStyleNode = document.createElement('style');
      fontStyleNode.id = 'dynamic-webfont-style';
      document.head.appendChild(fontStyleNode);
    }
    fontStyleNode.innerHTML = buildFontCss(chosenFont);

    document.body.style.fontFamily = `'${chosenFont}', 'Inter', sans-serif`;
  }, [settings.fontFamily]);

  // DB Sync functions
  const loadCentralData = useCallback(async () => {
    // 1. Load corporate white-label branding settings Robustly
    try {
      const settingsDoc = await getDoc(doc(db, 'settings', 'global_config'));
      if (settingsDoc.exists()) {
        const cloudData = settingsDoc.data() as AdminSettings;
        setSettings(prev => migrateSettings({
          ...prev,
          ...cloudData,
          // Guarantee client array isn't truncated internally
          clientProfiles: cloudData.clientProfiles || prev.clientProfiles || DEFAULT_SETTINGS.clientProfiles
        }));
        
        // Cache locally for offline guest speed
        localStorage.setItem('saas_settings', JSON.stringify(cloudData));
      } else {
        // Try writing if logged in
        if (auth.currentUser) {
          await setDoc(doc(db, 'settings', 'global_config'), DEFAULT_SETTINGS);
        }
        setSettings(DEFAULT_SETTINGS);
      }
    } catch (err) {
      console.warn("Unable to read global settings from Firestore, loading secure local cache:", err);
      const cached = localStorage.getItem('saas_settings');
      if (cached) {
        try {
          setSettings(migrateSettings(JSON.parse(cached)));
        } catch (e) {
          console.warn('[Cache] Corrupted saas_settings, clearing:', e);
          localStorage.removeItem('saas_settings');
          setSettings(DEFAULT_SETTINGS);
        }
      } else {
        setSettings(DEFAULT_SETTINGS);
      }
    }

    // 2. Load documents knowledge base independently
    try {
      const docsSnapshot = await getDocs(collection(db, 'documents'));
      if (docsSnapshot.empty) {
        if (auth.currentUser) {
          // Seed default documents centrally so they exist instantly in Firestore
          for (const docItem of DEFAULT_DOCUMENTS) {
            await setDoc(doc(db, 'documents', docItem.id), docItem);
          }
        }
        setDocuments(DEFAULT_DOCUMENTS);
      } else {
        const fetchedDocs: OrganizationDocument[] = [];
        docsSnapshot.forEach(item => {
          fetchedDocs.push(item.data() as OrganizationDocument);
        });
        fetchedDocs.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
        setDocuments(fetchedDocs);
      }
    } catch (err) {
      console.warn("Unable to read corporate audit documents, falling back to local preseed context:", err);
      setDocuments(DEFAULT_DOCUMENTS);
    }
  }, []);

  const loadAllAssessments = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, 'assessments'));
      const list: any[] = [];
      snap.forEach(dSnap => {
        list.push(dSnap.data());
      });
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setAllAssessments(list);
    } catch (err) {
      console.error("Error loading centralized assessments:", err);
    }
  }, []);

  // Trigger loading centrally immediately on boot
  useEffect(() => {
    loadCentralData();
  }, [loadCentralData]);

  // Monitor Authentication and Sync centrally on change
  useEffect(() => {
    let alive = true;
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const u: User = {
          name: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'الموظف',
          email: firebaseUser.email || '',
          picture: firebaseUser.photoURL || undefined
        };
        if (alive) setUser(u);
        // These awaits can resolve after unmount/logout; gate the chain so we don't
        // setState late on a torn-down tree.
        if (alive) await loadCentralData();
        if (alive) await loadAllAssessments();
      } else {
        if (alive) setUser(null);
        // Do NOT overwrite dynamic branding settings with static arrays on signout!
        // This is crucial so that guest logouts maintain the corporate visual identities.
      }
    });
    return () => { alive = false; unsubscribe(); };
  }, [loadCentralData, loadAllAssessments]);

  // Load Assessments automatically whenever we toggle Admin panel
  useEffect(() => {
    if (isAdminPortal) {
      loadAllAssessments();
    }
  }, [isAdminPortal, loadAllAssessments]);

  // Admin Document Handlers
  const handleAddDocument = useCallback(async (newDoc: Omit<OrganizationDocument, 'id' | 'uploadedAt' | 'uploadedByEmail' | 'uploadedByName'>) => {
    const email = auth.currentUser?.email || user?.email || 'admin@ailigent.ai';
    const name = auth.currentUser?.displayName || user?.name || 'مسؤول النظام';
    const fullDoc: OrganizationDocument = {
      ...newDoc,
      // Collision-proof id: parallel batch/folder ingest (cap 3) fires saves within
      // the same millisecond — a bare Date.now() id made the 2nd doc overwrite the
      // 1st (looked like the source was "rejected"). Add a random suffix.
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      uploadedAt: new Date().toISOString(),
      uploadedByEmail: email,
      uploadedByName: name,
      // W6: stamp the active project so files stay isolated per-project and don't
      // leak into other tenants' source lists. Preserve any explicit tenantId.
      tenantId: newDoc.tenantId || settings.activeClientProfileId || 'default',
    };
    try {
      setDocuments(prev => [fullDoc, ...prev]);
      await setDoc(doc(db, 'documents', fullDoc.id), fullDoc);
    } catch (err) {
      console.error("Firestore Write Document Failed:", err);
      // Roll back the optimistic insert FIRST and signal failure so the ingest
      // pipeline reports it honestly (not a silent "saved" that drops the source).
      setDocuments(prev => prev.filter(d => d.id !== fullDoc.id));
      // handleFirestoreError logs rich diagnostics but ALWAYS throws (firebase.ts);
      // calling it before the rollback made the lines below unreachable, leaving a
      // phantom document in the list and breaking the documented null contract that
      // callers rely on (GovernanceCenter checks `saved && saved.id`; confirmExtracted
      // has no try/catch, so the throw became an unhandled rejection). Keep the
      // diagnostics, but don't let the re-throw escape — honor the null contract.
      try { handleFirestoreError(err, OperationType.WRITE, `documents/${fullDoc.id}`); } catch { /* diagnostics only */ }
      return null;
    }
    return fullDoc;  // returned so callers (e.g. Governance Center) can ingest immediately
  }, [user, settings.activeClientProfileId]);

  const handleDeleteDocument = useCallback(async (id: string) => {
    try {
      setDocuments(prev => prev.filter(doc => doc.id !== id));
      await deleteDoc(doc(db, 'documents', id));
    } catch (err) {
      console.error("Firestore Delete Document Failed:", err);
      handleFirestoreError(err, OperationType.DELETE, `documents/${id}`);
    }
  }, []);

  const handleUpdateSettings = useCallback(async (newSettings: AdminSettings) => {
    try {
      setSettings(newSettings);
      localStorage.setItem('saas_settings', JSON.stringify(newSettings));
      await setDoc(doc(db, 'settings', 'global_config'), newSettings);
    } catch (err) {
      console.error("Firestore Update Settings Failed:", err);
      handleFirestoreError(err, OperationType.WRITE, 'settings/global_config');
    }
  }, []);

  // Candidate Assessment flow triggers
  const handleStart = useCallback(async (loggedInUser: User) => {
    setUser(loggedInUser);
    setCurrentScreen(Screen.SETUP);

    // Write login session to Audit Log (user_logins) in Firestore
    try {
       const loginId = `login_${Date.now()}`;
       await setDoc(doc(db, 'user_logins', loginId), {
         id: loginId,
         uid: auth.currentUser?.uid || 'guest_user',
         userName: loggedInUser.name,
         userEmail: loggedInUser.email,
         timestamp: new Date().toISOString(),
         userAgent: navigator.userAgent || 'Unknown Agent',
         isGuest: !auth.currentUser
       });
    } catch (err) {
       console.error("Failed to write user login log:", err);
    }
  }, []);

  // Compiles Org knowledge documents & selected client company profile content for Gemini
  const compileOrgContext = useCallback(() => {
    let context = '';
    const activeClient = settings.clientProfiles?.find(p => p.id === settings.activeClientProfileId);
    if (activeClient) {
      context += `[EVALUATED TARGET ENTERPRISE PROFILE]:\n`;
      context += `- Company Name: ${activeClient.name}\n`;
      if (activeClient.industry) context += `- Sector/Industry: ${activeClient.industry}\n`;
      if (activeClient.description) context += `- Context & Specific Environment Details: ${activeClient.description}\n`;
      context += `(IMPORTANT: You MUST adapt, ground and contextualize all candidate scenario questions and work-environment diagnostics to target this company's exact operational domain and background!)\n\n`;
    }
    
    // W6: only feed the active project's own files (plus legacy/shared seeds with
    // no tenantId) into generation — never another tenant's documents.
    const activeTenant = settings.activeClientProfileId || 'default';
    const scopedDocs = documents.filter(d => !d.tenantId || d.tenantId === activeTenant);
    if (scopedDocs.length > 0) {
      context += `[KNOWLEDGE BASE DOCUMENTS & STRATEGIC GUIDELINES]:\n`;
      context += scopedDocs.map(doc => `[Document: ${doc.name}]:\n${doc.content}`).join('\n\n');
    }
    return context;
  }, [documents, settings]);

  // W6: documents visible to the active project only — its own files plus legacy/
  // shared seeds (no tenantId). Other tenants' uploads are filtered out so the
  // Governance Center never shows another project's source files.
  const projectDocuments = useMemo(() => {
    const activeTenant = settings.activeClientProfileId || 'default';
    return documents.filter(d => !d.tenantId || d.tenantId === activeTenant);
  }, [documents, settings.activeClientProfileId]);

  const handleGenerateAssessment = useCallback(async (
    jobTitle: string,
    numQuestions: number, // Chosen by Admin (set in state)
    assessmentType: 'text' | 'verbal',
    timerInSeconds?: number,
    jobDescription?: string,
    scope: SurveyScope = 'both',
    companyId?: string
  ) => {
    // Candidate-selected company drives tenant context + survey settings; fall back to admin-active.
    const effCompanyId = companyId || settings.activeClientProfileId;
    // Admin lock: when locked, ignore passed scope/type, force config values.
    // Survey config now lives per-project (chosen project's survey settings).
    const projSurvey = activeProjectSurvey(settings, effCompanyId);
    const launchCfg = projSurvey.surveyLaunchConfig;
    const locked = !!launchCfg?.locked;
    const effScope: SurveyScope = locked ? launchCfg!.scope : scope;
    // F1: even in open (non-locked) mode, respect the kinds the admin configured on
    // the project; only fall back to 'competency' when nothing was ever set.
    const assessmentKinds: AssessmentKind[] = toKindArray(
      locked ? launchCfg!.assessmentKind : (launchCfg?.assessmentKind || 'competency')
    );

    setIsLoading(true);
    setError(null);
    setSurveyScope(effScope);
    setAssessmentConfig({ jobTitle, numQuestions, assessmentType, timerInSeconds, jobDescription, surveyScope: effScope, assessmentKind: assessmentKinds });

    // Environment-only: no person assessment — go straight to the workplace survey.
    if (effScope === 'environment') {
      setQuestions([]);
      setResponses([]);
      setCurrentScreen(Screen.SURVEY);
      setIsLoading(false);
      return;
    }

    // Prefer the unified Governance Center chunk context (uploads ingested there); fall back to raw docs.
    const tenantId = effCompanyId || 'default';
    let chunkCtx = '';
    try { chunkCtx = await compileChunkContext(tenantId, 12000); } catch { /* fall back below */ }
    const orgContext = chunkCtx || compileOrgContext();

    if (assessmentType === 'verbal') {
      // Deterministic verbal interview: pre-generate questions using the same
      // batching strategy as the text path (first BATCH_SIZE questions → show
      // screen immediately → fetch remaining async) so a 30-question interview
      // doesn't hit the 90s API timeout in a single blocking call.
      const verbalFirstBatch = Math.min(numQuestions, FIRST_BATCH);
      try {
        const firstBatch = await generateQuestions(
          jobTitle, verbalFirstBatch, language, true, jobDescription, orgContext, projSurvey.theories
        );
        setQuestions(firstBatch);
        setCurrentScreen(Screen.ONBOARDING);
        setIsLoading(false);

        // Refill the rest in steady background chunks while the candidate answers the
        // first questions — so the interview starts fast and questions keep arriving.
        if (numQuestions > verbalFirstBatch) {
          void fetchRemainingInChunks(
            { jobTitle, total: numQuestions, firstBatchTexts: firstBatch.map(q => q.questionText),
              language, jobDescription, orgContext, theories: projSurvey.theories },
            (chunk) => setQuestions(prev => [...prev, ...chunk]),
          );
        }
      } catch (err) {
        setError(language === 'ar' ? 'فشل بناء أسئلة المقابلة الصوتية. حاول مرة أخرى.' : 'Failed to build the verbal interview questions. Please retry.');
        console.error(err);
        setIsLoading(false);
      }
      return;
    }

    // Load a tiny first batch from Gemini so the assessment starts fast.
    const firstBatchSize = Math.min(numQuestions, FIRST_BATCH);

    try {
      const firstBatchQuestions = await generateQuestions(
        jobTitle,
        firstBatchSize,
        language,
        true,
        jobDescription,
        orgContext,
        projSurvey.theories
      );
      setQuestions(firstBatchQuestions);
      setCurrentScreen(Screen.ONBOARDING);
      setIsLoading(false);

      // Refill outstanding questions progressively in background chunks.
      if (numQuestions > firstBatchSize) {
        void fetchRemainingInChunks(
          { jobTitle, total: numQuestions, firstBatchTexts: firstBatchQuestions.map(q => q.questionText),
            language, jobDescription, orgContext, theories: projSurvey.theories },
          (chunk) => setQuestions(prevQuestions => [...prevQuestions, ...chunk]),
        );
      }
    } catch (err) {
      setError(language === 'ar' ? 'فشل إطعام نظام الذكاء الاصطناعي وبناء الأسئلة. الرجاء محاولة تشغيل التكوينات ثانية.' : 'Failed to generate tailored competency assessment. Try configuring settings again.');
      console.error(err);
      setIsLoading(false);
    }
  }, [language, compileOrgContext, settings]);

  // Finish MCQ Assessment: route to survey (scope 'both') or straight to results (scope 'person').
  const handleTextAssessmentFinish = useCallback((finalResponses: UserResponse[]) => {
    setResponses(finalResponses);
    setCurrentScreen(surveyScope === 'both' ? Screen.SURVEY : Screen.RESULTS);
  }, [surveyScope]);

  // Finish verbal assessment: same scope-aware routing.
  const handleVerbalAssessmentFinish = useCallback((transcript: string, affect?: AffectSignal) => {
      setResponses([{ questionIndex: 0, selectedAnswer: transcript }]);
      setVerbalAffect(affect);  // optional voice/facial affect signal — persisted with the result
      setCurrentScreen(surveyScope === 'both' ? Screen.SURVEY : Screen.RESULTS);
  }, [surveyScope]);

  // Take survey answers, record them, and shift to results screen
  const handleSurveySubmit = useCallback((answers: WorkEnvironmentAnswers, summary?: ProctorSummary) => {
    setWorkplaceAnswers(answers);
    if (summary) setProctorSummary(summary);   // B3 — captured by the in-app survey proctor
    setCurrentScreen(Screen.RESULTS); // Generate report and display dual results
  }, []);

  const handleRestart = useCallback(() => {
    setUser(null);
    setAssessmentConfig(null);
    setQuestions([]);
    setResponses([]);
    setWorkplaceAnswers(undefined);
    setProctorSummary(undefined);
    setVerbalAffect(undefined);
    setSurveyScope('both');
    setError(null);
    setCurrentScreen(Screen.HOME);
    setIsAdminPortal(false);
  }, []);

  // Main UI Screen Renderer
  const renderScreen = () => {
    if (isLoading) {
      return (
        <div className="flex flex-col items-center justify-center h-full space-y-4 py-20 bg-white">
          <svg className="animate-spin h-10 w-10 text-teal-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="text-md text-slate-600 font-bold">{language === 'ar' ? 'جاري إعداد محاكاة الذكاء الاصطناعي وملف الجدارات...' : 'Tailoring your AI benchmark journey...'}</p>
        </div>
      );
    }

    // Forced Overriding for Admin Workspace view
    if (isAdminPortal) {
      const adminEmail = (auth.currentUser?.email || user?.email || '').toLowerCase();
      // DEV-ONLY admin bypass for local governance-path walkthroughs. import.meta.env.DEV
      // is false in `vite build`, so this is dead in the deployed bundle — no manual removal.
      const isAuthorizedAdmin = ADMIN_EMAILS.includes(adminEmail) || import.meta.env.DEV;

      if (!isAuthorizedAdmin) {
        const signInErrorMessage = (code: string): string => {
          const ar = language === 'ar';
          switch (code) {
            case 'auth/network-request-failed':
              return ar
                ? 'تعذّر تسجيل الدخول: مشكلة في الاتصال بالشبكة. تحقّق من الإنترنت وحاول مجددًا.'
                : 'Sign-in failed: network problem. Check your connection and try again.';
            case 'auth/popup-blocked':
            case 'auth/popup-closed-by-user':
            case 'auth/cancelled-popup-request':
              return ar
                ? 'تعذّر فتح نافذة تسجيل الدخول. اسمح بالنوافذ المنبثقة لهذا الموقع ثم أعد المحاولة.'
                : 'Could not open the sign-in window. Allow pop-ups for this site and try again.';
            case 'auth/unauthorized-domain':
              return ar
                ? 'هذا النطاق غير مصرّح له بتسجيل الدخول. أضِف النطاق في إعدادات Firebase Authentication.'
                : 'This domain is not authorized for sign-in. Add it under Firebase Authentication settings.';
            case 'auth/operation-not-allowed':
              return ar
                ? 'تسجيل الدخول بحساب جوجل غير مُفعّل في إعدادات المشروع.'
                : 'Google sign-in is not enabled in the project settings.';
            default:
              return ar
                ? 'فشل تسجيل الدخول. حاول مرة أخرى، وإن استمر الخطأ تحقّق من إعدادات الحساب.'
                : 'Sign-in failed. Please try again; if it persists, check the account settings.';
          }
        };

        const handleAdminSignIn = async () => {
          const provider = new GoogleAuthProvider();
          setError(null);
          try {
            await signInWithPopup(auth, provider);
          } catch (err: any) {
            if (err?.code === 'auth/popup-blocked' || err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') {
              try {
                await signInWithRedirect(auth, provider);
                return;
              } catch (redirErr: any) {
                console.error('Admin sign-in redirect failed:', redirErr);
                setError(signInErrorMessage(redirErr?.code || ''));
                return;
              }
            }
            console.error('Admin sign-in failed:', err);
            setError(signInErrorMessage(err?.code || ''));
          }
        };

        const handleEmailSignIn = async (e: React.FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const email = (fd.get('admin_email') as string || '').trim();
          const password = fd.get('admin_password') as string || '';
          setError(null);
          try {
            await signInWithEmailAndPassword(auth, email, password);
          } catch (err: any) {
            setError(signInErrorMessage(err?.code || ''));
          }
        };

        return (
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-8 animate-fade-in">
            <div className="w-16 h-16 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center mb-5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7" aria-hidden="true">
                <rect x="4" y="11" width="16" height="9" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                <circle cx="12" cy="15.5" r="1.2" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-slate-900 mb-2">
              {language === 'ar' ? 'بوابة الإدارة محمية' : 'Admin Hub is Protected'}
            </h2>
            <p className="text-sm text-slate-500 max-w-md mb-6 leading-relaxed">
              {auth.currentUser
                ? (language === 'ar'
                    ? `الحساب الحالي (${adminEmail}) غير مخوّل للوصول إلى بوابة الإدارة. سجّل الدخول بحساب مسؤول معتمد.`
                    : `The current account (${adminEmail}) is not authorized for the Admin Hub. Please sign in with an approved administrator account.`)
                : (language === 'ar'
                    ? 'يلزم تسجيل الدخول بحساب مسؤول معتمد للوصول إلى بوابة الإدارة.'
                    : 'Sign in with an approved administrator account to access the Admin Hub.')}
            </p>
            <div className="flex flex-col gap-4 w-full max-w-xs">
              <button
                onClick={handleAdminSignIn}
                className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-md shadow-sm transition-colors flex items-center justify-center gap-2"
              >
                {language === 'ar' ? 'تسجيل الدخول بحساب جوجل' : 'Sign in with Google'}
              </button>
              <div className="flex items-center gap-3 text-xs text-slate-400">
                <span className="h-px flex-1 bg-slate-200" />
                {language === 'ar' ? 'أو بإيميل وكلمة مرور' : 'or with email & password'}
                <span className="h-px flex-1 bg-slate-200" />
              </div>
              <form onSubmit={handleEmailSignIn} className="flex flex-col gap-2">
                <input
                  name="admin_email"
                  type="email"
                  required
                  placeholder={language === 'ar' ? 'البريد الإلكتروني' : 'Email'}
                  className="px-4 py-2.5 rounded-xl border border-slate-300 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  dir="ltr"
                />
                <input
                  name="admin_password"
                  type="password"
                  required
                  placeholder={language === 'ar' ? 'كلمة المرور' : 'Password'}
                  className="px-4 py-2.5 rounded-xl border border-slate-300 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  dir="ltr"
                />
                <button
                  type="submit"
                  className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-md shadow-sm transition-colors"
                >
                  {language === 'ar' ? 'دخول' : 'Sign In'}
                </button>
              </form>
              <button
                onClick={() => setIsAdminPortal(false)}
                className="px-6 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-xl transition-colors text-sm"
              >
                {language === 'ar' ? 'العودة لبوابة الموظف' : 'Back to Employee Portal'}
              </button>
            </div>
          </div>
        );
      }

      if (isGovCenter) {
        return (
          <ErrorBoundary>
            <GovernanceCenter
              documents={projectDocuments}
              settings={settings}
              language={language}
              onBack={() => setIsGovCenter(false)}
              onAddDocument={handleAddDocument}
              onDeleteDocument={handleDeleteDocument}
              onUpdateSettings={handleUpdateSettings}
              allAssessments={allAssessments}
            />
          </ErrorBoundary>
        );
      }

      return (
        <AdminPanel
          documents={documents}
          onAddDocument={handleAddDocument}
          onOpenGovernanceCenter={() => setIsGovCenter(true)}
          onDeleteDocument={handleDeleteDocument}
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          language={language}
          allAssessments={allAssessments}
          onRefreshAssessments={loadAllAssessments}
          currentUserEmail={auth.currentUser?.email || user?.email || ''}
          currentUserName={auth.currentUser?.displayName || user?.name || ''}
        />
      );
    }

    switch (currentScreen) {
      case Screen.HOME:
        return <HomeScreen onStart={handleStart} language={language} setLanguage={setLanguage} settings={settings} />;
      case Screen.SETUP:
        return <SetupScreen onGenerate={handleGenerateAssessment} language={language} adminSettings={settings} />;
      case Screen.ONBOARDING:
        if (!assessmentConfig) return null;
        return <EmployeeOnboarding
          assessmentConfig={assessmentConfig}
          questionCount={assessmentConfig.numQuestions}
          language={language}
          surveyScope={surveyScope}
          onStart={() => setCurrentScreen(Screen.ASSESSMENT)}
        />;
      case Screen.ASSESSMENT:
        if (assessmentConfig?.assessmentType === 'verbal') {
          return <VerbalAssessmentScreen
            onFinish={handleVerbalAssessmentFinish}
            language={language}
            config={assessmentConfig}
            questions={questions}
            totalExpected={assessmentConfig.numQuestions}
            voiceCount={assessmentConfig.voiceCount}
          />;
        }
        return <AssessmentScreen 
          questions={questions} 
          onFinish={handleTextAssessmentFinish} 
          language={language} 
          timerInSeconds={assessmentConfig?.timerInSeconds} 
        />;
      case Screen.SURVEY:
        // B3 — proctor the in-app survey too. MonitoredSurveyScreen adds the
        // "begin monitored survey" gesture (screen-share needs one), runs the
        // useProctor engine + overlay, and returns the ProctorSummary on submit.
        return <MonitoredSurveyScreen
          onSubmit={handleSurveySubmit}
          language={language}
          wordLimits={activeProjectSurvey(settings).surveyWordLimits}
          mandatory={activeProjectSurvey(settings).surveyLaunchConfig?.mandatory ?? true}
        />;
      case Screen.RESULTS:
        if (!assessmentConfig) return null;
        return <ResultsScreen 
          assessmentConfig={assessmentConfig}
          questions={questions}
          responses={responses}
          onRestart={handleRestart} 
          language={language}
          user={user ?? { name: 'Guest', email: '' }}
          orgContext={compileOrgContext()}
          workplaceAnswers={workplaceAnswers}
          surveyScope={surveyScope}
          affectSignal={verbalAffect}
          proctorSummary={proctorSummary}
        />;
      default:
        return <HomeScreen onStart={handleStart} language={language} setLanguage={setLanguage} settings={settings} />;
    }
  };
  
  const dir = language === 'ar' ? 'rtl' : 'ltr';

  // The live interview is a wide, screen-filling experience (avatar + thread
  // side by side); everything else stays a readable column. Drives the shell
  // max-width so the app actually uses the widescreen instead of a narrow strip.
  const isMeeting = currentScreen === Screen.ASSESSMENT && assessmentConfig?.assessmentType === 'verbal';
  // W2: actually use the widescreen instead of a narrow centered strip. The admin
  // hub (governance center, tables, diagrams) benefits from the extra width on
  // large monitors; readable prose blocks keep their own inner max-w-prose.
  const isAdminWide = isAdminPortal;
  const shellMax = isMeeting
    ? 'max-w-7xl 2xl:max-w-[1800px]'
    : isAdminWide
      ? 'max-w-6xl xl:max-w-[1500px] 2xl:max-w-[1800px]'
      : 'max-w-5xl xl:max-w-6xl 2xl:max-w-[1500px]';

  // Public survey — ?s=TOKEN bypasses all auth/admin logic
  const surveyToken = new URLSearchParams(window.location.search).get('s');
  if (surveyToken) {
    return (
      <ToastProvider dir={dir}>
        <PublicSurveyScreen token={surveyToken} />
      </ToastProvider>
    );
  }

  // Employee assessment portal — ?emp=TOKEN bypasses all auth/admin logic
  const empToken = new URLSearchParams(window.location.search).get('emp');
  if (empToken) {
    return (
      <ToastProvider dir={dir}>
        <EmployeePortalScreen token={empToken} />
      </ToastProvider>
    );
  }

  // Paper assessment portal — ?paper=TOKEN
  const paperToken = new URLSearchParams(window.location.search).get('paper');
  if (paperToken) {
    return <PaperAssessmentPortal token={paperToken} />;
  }

  // Online proctored assessment portal — ?online=TOKEN
  const onlineToken = new URLSearchParams(window.location.search).get('online');
  if (onlineToken) {
    return <OnlineAssessmentPortal token={onlineToken} />;
  }

  // Unified assessment portal — ?assess=TOKEN
  const assessToken = new URLSearchParams(window.location.search).get('assess');
  if (assessToken) {
    return <UnifiedAssessmentPortal token={assessToken} />;
  }

  // Document reviewer link — ?r=TOKEN (HWK-D3): a shared governance document,
  // opened by a signed-in reviewer who can read it and add comments.
  const reviewToken = new URLSearchParams(window.location.search).get('r');
  if (reviewToken) {
    return <PublicReviewScreen token={reviewToken} />;
  }

  return (
    <ToastProvider dir={dir}>
    <RootErrorToast error={error} />
    <div className="min-h-screen flex flex-col items-center justify-center p-4 md:p-6 bg-slate-50" dir={dir}>

      {/* Instrument top bar — light, hairline */}
      <header className={`w-full ${shellMax} bg-white text-slate-900 rounded-t-2xl px-6 py-5 flex flex-col md:flex-row justify-between items-center gap-5 shadow-sm text-center md:text-start transition-all duration-300`} id="app_header">
        <div className="flex flex-col items-center md:items-start text-center md:text-start w-full md:w-auto">
          <h2 className="flex items-center justify-center md:justify-start">
            <img
              src="/images/ailigent-logo-full.png"
              alt={settings.companyName || 'Ailigent.ai'}
              className="h-11 md:h-12 w-auto object-contain shrink-0"
            />
          </h2>
          <p className="text-[10px] text-slate-500 tracking-wider uppercase font-bold mt-1 text-center md:text-start">
            {language === 'ar' ? 'حَوكمة جدارات القيادة وكفاءة الكوادر المستهدفة' : 'Corporate Governance • Peak Leadership & Talents Benchmarks'}
          </p>
        </div>

        {/* Portal Switch Controls & Lang Wrapper with zero overlapping risk */}
        <div className="flex flex-col sm:flex-row flex-wrap items-center justify-center gap-3 w-full md:w-auto mt-2 md:mt-0">

          {/* Candidate Gate vs Admin control */}
          <div className="bg-slate-100 p-1 rounded-full flex border border-slate-200 w-full sm:w-auto justify-center">
            <button
              onClick={() => {
                setIsAdminPortal(false);
                if (currentScreen === Screen.SETUP) {
                  setCurrentScreen(Screen.HOME);
                }
              }}
              className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all flex items-center justify-center flex-1 sm:flex-none ${
                !isAdminPortal
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              {language === 'ar' ? 'بوابة الموظف' : 'Employee Portal'}
            </button>
            <button
              onClick={() => setIsAdminPortal(true)}
              className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all flex items-center justify-center flex-1 sm:flex-none ${
                isAdminPortal
                  ? 'bg-emerald-700 text-white'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              {language === 'ar' ? 'بوابة الإدارة' : 'Admin Hub'}
            </button>
          </div>

          {/* Lang + Dark mode buttons */}
          <div className="flex gap-2 w-full sm:w-auto">
            <button
              onClick={() => setLanguage(language === 'ar' ? 'en' : 'ar')}
              className="flex-1 sm:flex-none px-4 py-1.5 rounded-md bg-white border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-colors uppercase flex items-center justify-center"
              title="Convert language"
            >
              {language === 'ar' ? 'English' : 'عربي'}
            </button>
            <button
              onClick={toggleDark}
              className="p-2 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors flex items-center justify-center"
              title={isDark ? 'Light mode' : 'Dark mode'}
              aria-label={isDark ? 'Light mode' : 'Dark mode'}
            >
              {isDark ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main canvas container — hairline, minimal lift */}
      <main className={`w-full ${shellMax} bg-white rounded-b-2xl shadow-sm overflow-hidden transition-all duration-300 mb-4 min-h-[660px] ${isMeeting ? 'p-2 sm:p-3 md:p-4' : 'p-6 md:p-8'} flex flex-col justify-start`}>
        {renderScreen()}
      </main>

      {/* Developer copyright references footer */}
      <footer className="text-center py-4 text-slate-400 text-xs font-semibold">
        <p>Dr. Ahmed Alsenosy - د. احمد السنوسي</p>
        <a 
          href="https://www.linkedin.com/in/alsenosy" 
          target="_blank" 
          rel="noopener noreferrer" 
          className="font-bold text-slate-500 hover:text-emerald-600 hover:underline transition-colors mt-0.5 inline-block"
        >
          www.linkedin.com/in/alsenosy
        </a>
      </footer>
    </div>
    </ToastProvider>
  );
};

export default App;

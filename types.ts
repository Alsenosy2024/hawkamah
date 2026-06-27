import type { SwimlaneSpec } from './services/swimlaneService';
export type { SwimlaneSpec };

export type Language = 'en' | 'ar';

export enum Screen {
  HOME = 'HOME',
  SETUP = 'SETUP',
  ONBOARDING = 'ONBOARDING', // Pre-assessment briefing shown to employee before they start
  ASSESSMENT = 'ASSESSMENT',
  SURVEY = 'SURVEY', // New screen for workplace environment survey
  RESULTS = 'RESULTS'
}

export interface JobRole {
  id: number;
  title_en: string;
  title_ar: string;
  category: string;
}

export interface Question {
  questionText: string;
  options: string[];
  correctAnswer: string; // "A", "B", "C", or "D" for text-based
  type: 'Technical' | 'Behavioral';
  framework?: string; // Birkman, Holland, PsychTech, Bloom's Taxonomy
  minWords?: number;  // auto-derived per-question minimum (proportional to complexity, floor 8)
  minChars?: number;  // auto-derived per-question minimum chars (floor 40)
}

export interface UserResponse {
  questionIndex: number;
  selectedAnswer: string; // This can be "A. ..." for text or the full transcript for verbal
}

// === VOICE / FACIAL AFFECT SIGNAL (verbal interview, browser-native, optional) ===
// Captured during the candidate's spoken answer using Web Audio (mic prosody) and,
// when available, the experimental FaceDetector. Everything is best-effort: any field
// can be absent and the whole object is optional so persistence is backward-compatible.

// Per-question affect features. Values are normalized 0..1 unless noted.
export interface AffectPerQuestion {
  questionIndex: number;
  energy: number;        // avg RMS loudness while answering (0..1)
  speechRatio: number;   // fraction of the answering window with voice above noise floor (0..1)
  pitchVar: number;      // rough pitch-variability proxy (0..1) from zero-crossing-rate spread
  facePresent?: number;  // fraction of sampled video frames with a detected face (0..1); omitted if FaceDetector missing
  durationMs: number;    // length of the captured answering window
}

// Whole-interview aggregate emitted alongside the transcript.
export interface AffectSignal {
  perQuestion: AffectPerQuestion[];
  avgEnergy: number;        // mean energy across questions (0..1)
  avgSpeechRatio: number;   // mean speech-vs-silence ratio (0..1)
  avgPitchVar: number;      // mean pitch variability (0..1)
  avgFacePresent?: number;  // mean face-present ratio (0..1); omitted if no facial data captured
  audioAvailable: boolean;  // Web Audio analysis ran at least once
  faceAvailable: boolean;   // FaceDetector ran at least once
}

export interface CompetencyScore {
  competency: string;
  score: number; // Score out of 100
}

export interface Report {
  totalScore: number;
  strengths: string;
  weaknesses: string;
  recommendations: string;
  competencyScores: CompetencyScore[];
}

export interface User {
  name: string;
  email: string;
  picture?: string;
}

export interface AssessmentConfig {
  jobTitle: string;
  numQuestions: number;
  assessmentType: 'text' | 'verbal';
  voiceCount?: number;         // verbal runs: how many questions are SPOKEN (rest written). undefined → ~15% heuristic
  timerInSeconds?: number;
  jobDescription?: string;
  frameworksUsed?: string[];
  surveyScope?: SurveyScope;   // which evaluation(s) this run covers
  assessmentKind?: AssessmentKind | AssessmentKind[]; // behavioral and/or competency (admin-locked, multi-select)
}

// === NEW MODEL TYPES FOR CORPORATE UPGRADE ===

export interface OrganizationDocument {
  id: string;
  name: string;
  category: 'identity' | 'current_state' | 'general' | 'infrastructure';
  content: string;
  uploadedAt: string;
  uploadedByEmail?: string; // Track who uploaded and analyzed the file
  uploadedByName?: string;  // Track name of who uploaded and analyzed the file
  tenantId?: string;        // W6: owning project id. Undefined = legacy/shared seed visible to all projects.
}

export interface EvaluatorReview {
  reviewerName: string;
  reviewerEmail: string;
  rating: number;      // 1 to 5 stars
  comments: string;    // Consultant override comments
  status: 'approved' | 'rejected' | 'needs_revision';
  reviewedAt: string;  // Timestamp
}

// Per-project survey settings — moved OUT of AdminSettings, embedded per project.
// Auto-created (seeded from AdminSettings.defaultSurveyTemplate) when a project is created.
export interface ProjectSurveySettings {
  questionCount: number;
  theories: {
    birkman: boolean;
    holland: boolean;
    psychTech: boolean;
    bloomTaxonomy: boolean;
  };
  surveyScopeDefault?: SurveyScope;
  surveyWordLimits?: { [field: string]: number };
  surveyLaunchConfig?: SurveyLaunchConfig;
}

// Company entity = the unit of a governance engagement. id == tenantId (scoping key).
// Supersedes ClientProfile (kept as an alias for back-compat). Created as the FIRST
// step inside the Governance Center (المشاريع stage), manually or via file auto-extract.
export interface GovProject {
  id: string;
  name: string;
  logoUrl?: string;          // Base64 company logo
  description: string;       // Details / operating scope
  industry?: string;         // Sector
  specialization?: string;   // Explicit specialization (التخصص) when distinct from sector
  vision?: string;           // Identity / vision (الرؤية والهوية)
  mission?: string;          // Optional mission
  jobRoles?: JobRole[];      // Explicit per-company job titles; when empty, derived from `industry` (sector)
  survey?: ProjectSurveySettings; // Per-project survey defaults (auto-seeded)
  createdAt?: string;
  uploadedAt: string;
}

// Back-compat alias — existing imports of ClientProfile keep compiling.
export type ClientProfile = GovProject;

export interface AdminSettings {
  questionCount: number; // Admin is in control: 10, 20, 30, 40, 50
  theories: {
    birkman: boolean;
    holland: boolean;
    psychTech: boolean;
    bloomTaxonomy: boolean;
  };
  fontFamily?: string;  // Dynamic webfont: "Tajawal", "Almarai", "Cairo", etc. (System/Platform font)
  logoUrl?: string;     // Platform Operator Logo represented in Base64
  companyName?: string; // Platform Operator Company name (e.g., Ailigent.ai)
  
  // === Projects (companies under governance) ===
  activeClientProfileId?: string;   // active project id (== tenantId)
  clientProfiles?: GovProject[];    // managed company projects
  aiPresetPersona?: 'academic' | 'executive' | 'technical' | 'supportive'; // Coordinator supervisor model preset

  // === Ailigent global default survey template ===
  // Seeds GovProject.survey when a new project is created. Admin edits this only.
  defaultSurveyTemplate?: ProjectSurveySettings;

  // === LEGACY survey configuration (platform-level) ===
  // Superseded by GovProject.survey. Kept one release for back-compat + migration
  // backfill (governanceService.migrateSettings). Do not remove in the same deploy
  // as the per-project read switch.
  surveyScopeDefault?: SurveyScope;                 // default launch scope
  surveyWordLimits?: { [field: string]: number };   // per-question min words (WorkEnvironmentAnswers keys)
  surveyLaunchConfig?: SurveyLaunchConfig;           // admin-locked launch (type/scope/mandatory)
}

// Which evaluation(s) to launch: the person, the work environment, or both.
export type SurveyScope = 'person' | 'environment' | 'both';

// Assessment flavor the admin locks for employees: behavioral and/or competency-based.
export type AssessmentKind = 'behavioral' | 'competency';

// Normalize legacy single-value or array assessmentKind into a clean array.
// Empty/invalid → defaults to ['competency'].
export function toKindArray(k: AssessmentKind | AssessmentKind[] | undefined | null): AssessmentKind[] {
  const arr = Array.isArray(k) ? k : (k ? [k] : []);
  const valid = arr.filter((x): x is AssessmentKind => x === 'behavioral' || x === 'competency');
  return valid.length ? Array.from(new Set(valid)) : ['competency'];
}

// Admin-locked launch configuration. When locked, the employee cannot change
// type/scope and must answer (mandatory); they only fill answers.
export interface SurveyLaunchConfig {
  locked: boolean;              // employee UI hides type/scope selectors, enforces config
  assessmentKind: AssessmentKind | AssessmentKind[]; // multi-select: one or both
  scope: SurveyScope;           // admin decides; employee cannot pick self-only vs self+org
  mandatory: boolean;           // empty answers blocked; min-words floor enforced
  launchedAt: string;
  launchedByEmail?: string;
}

// === AGENTIC ASSISTANT / EXPORT / LONG-ARTIFACT TYPES ===

export type ExportFormat = 'docx' | 'pdf' | 'pdfDirect' | 'xlsx';

export interface ThinkingStep {
  id: string;
  text: string;
}

export interface ProposedAction {
  format: ExportFormat;
  label: string;          // Arabic button label, e.g. "تصدير Word"
  source: 'message' | 'artifact';
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'agent';
  text: string;
  thoughts: ThinkingStep[];
  thinking: boolean;      // currently producing reasoning
  streaming: boolean;     // response still streaming
  timestamp: Date;
  proposedActions?: ProposedAction[];
  artifact?: GeneratedArtifact;
  artifactProgress?: ArtifactProgress;  // live progress while a long artifact builds
  error?: string;
}

// --- Long artifact generation (chunking → critique → stitch) ---

export interface ArtifactSectionPlan {
  id: string;
  title: string;
  goal: string;           // what this section must cover
}

export interface ArtifactSection {
  id: string;
  title: string;
  content: string;        // Markdown body
  status: 'pending' | 'writing' | 'done' | 'failed';
}

export interface ArtifactDiagram {
  title: string;
  png: string;            // data:image/png;base64 — rasterized Mermaid SVG
  width?: number;
  height?: number;
}

export interface GeneratedArtifact {
  title: string;
  goal: string;
  language: Language;
  sections: ArtifactSection[];
  executiveSummary?: string;
  diagrams?: ArtifactDiagram[];   // embedded into PDF/Word exports
  createdAt: Date;
  complete: boolean;      // false when stopped/partial
}

export type ArtifactPhase = 'outline' | 'section' | 'critique' | 'revise' | 'assemble' | 'done';

export interface ArtifactProgress {
  phase: ArtifactPhase;
  current: number;
  total: number;
  label: string;          // Arabic status line
}

export interface ConsultationRequest {
  id: string;
  clientName: string;
  industry: string;
  consultantName: string; // "Dr. Ahmed Alsenosy"
  requestType: 'restructuring' | 'efqm_audit' | 'capacity_building' | 'vocal_benchmark';
  agendaTopic: string;
  urgency: 'high' | 'medium' | 'normal';
  targetDate: string;
  contactEmails: string;
  additionalNotes?: string;
  status: 'requested' | 'scheduled' | 'report_drafted' | 'completed';
  timestamp: string;
}

export interface JobFitRating {
  jobTitle: string;
  matchPercentage: number;
  reason: string;
}

export interface GapMetric {
  skill: string;
  required: number; // out of 100
  actual: number; // out of 100
  gapDescription: string;
}

export interface GapReport {
  competencyGaps: GapMetric[];
  overallGapSummary: string;
  developmentPlan: string;
}

export interface ExtendedReport extends Report {
  technicalScore: number;
  behavioralScore: number;
  gapReport: GapReport;
  jobFitRatings: JobFitRating[];
  birkmanHollandSummary?: string;
  // Populated ONLY when BOTH assessment kinds (competency + behavioral) are selected:
  // two clearly separated narrative sections rendered as distinct blocks.
  competencySection?: string;   // قسم تحليل الجدارات
  behavioralSection?: string;   // قسم التحليل السلوكي
}

export interface WorkEnvironmentAnswers {
  proceduresAndPolicies: string;       // Evaluation of procedures & policies
  digitalInfrastructure: string;       // Digital readiness and tools
  challengesAndProblems: string;       // Current painpoints faced
  employeeRelationships: string;       // Cooperation and relation with coworkers
  aspirationsAndDevelopment: string;   // Dreams & organizational change opinions
  organizationalReconstructionOpinion: string; // Ideas if structural redesign occurs
  // Adaptive branching: answers to conditionally-revealed follow-up questions,
  // keyed by follow-up id. Optional & backward compatible — static surveys omit it.
  followUps?: { [followUpId: string]: string };
}

export interface WorkEnvironmentReport {
  overallScore: number;               // out of 100
  isoComplianceRate: number;          // %
  efqmExcellenceRate: number;         // %
  infrastructureRating: string;       // "Advanced" | "Intermediate" | "Basic"
  currentStatusSummary: string;       // Assessment of actual state
  keyChallenges: string[];
  operationalAspirations: string;
  recommendationsForManagement: string[];
}

// ---- Public survey token (shared links) ----
// Admin creates a token per project; sharing the URL lets an employee answer the
// workplace survey without logging in. The token is tenant-scoped so a respondent
// never sees other companies' data.
export interface SurveyToken {
  id: string;          // random 16-char alphanumeric = the URL ?s= value
  tenantId: string;    // which project/company this belongs to
  projectId: string;
  companyName: string; // shown at the top of the public survey page
  language: Language;
  createdAt: string;   // ISO timestamp
  createdByEmail?: string;
}

// One employee's public survey response (written by anonymous; read by admin).
export interface PublicSurveyResponse {
  id: string;                       // Firestore auto-ID
  tokenId: string;                  // which token was used
  tenantId: string;
  projectId: string;
  companyName: string;
  answers: WorkEnvironmentAnswers;
  submittedAt: string;              // ISO timestamp
  respondentName?: string;
  respondentEmail?: string;
  respondentJobTitle?: string;
  respondentDepartment?: string;
  analysis?: WorkEnvironmentReport; // lazy AI analysis, stored after admin triggers it
}

// ---- Employee assessment portal types (Track B) ----

export interface EmployeeToken {
  id: string;           // random 16-char token = URL ?emp= value
  tenantId: string;
  projectId: string;
  companyName: string;
  companyLogoUrl?: string;
  language: Language;
  jobRoles?: JobRole[];
  // Per-link survey sizing — chosen at launch from the project card. Older tokens
  // omit these; the portal falls back to sensible defaults (30 questions, 4 voice).
  questionCount?: number;   // total competency questions for this link (e.g. 30/40/50)
  voiceCount?: number;      // how many of those are answered by voice (e.g. 3/4/5)
  // Company context snapshot so questions are grounded in the company's industry
  // even though the public portal has no Firestore project read.
  industry?: string;
  specialization?: string;
  companyDescription?: string;
  createdAt: string;
  createdByEmail?: string;
  active: boolean;
}

// ---- Paper Assessment (تقييم ورقي) types ----

export type PaperDifficulty = 'easy' | 'medium' | 'hard';

// Psychometric frameworks the manager can layer onto the exam — same set the
// employee-assessment system exposes (AdminSettings.theories).
export interface PaperTheories {
  birkman: boolean;    // Birkman Method — environmental fit & social stressors
  holland: boolean;    // Holland RIASEC — occupational-interest match
  psychTech: boolean;  // Psych Tech Scale — standardized behavioral scenarios
  bloom: boolean;      // Bloom's Taxonomy — cognitive level (apply/analyze/evaluate)
}

export const DEFAULT_PAPER_THEORIES: PaperTheories = {
  birkman: false, holland: false, psychTech: false, bloom: false,
};

export interface PaperAssessmentToken {
  id: string;
  tenantId: string;
  projectId: string;
  companyName: string;
  companyLogoUrl?: string;
  language: Language;
  accessEmail: string;
  accessPasswordHash: string;
  createdAt: string;
  active: boolean;
}

export interface PaperQuestion {
  type: 'behavioral' | 'technical';
  text: string;
  options: string[];    // 4 options: "أ. ...", "ب. ...", etc.
  correctAnswer: string; // "أ" | "ب" | "ج" | "د"
  theory?: string;      // which framework drove it: "Birkman" | "Holland" | "Bloom" | ...
  rationale?: string;   // short why-correct note for the model-answer sheet
  isVoice?: boolean;    // if true: TTS reads question + employee records spoken answer
}

export interface EmployeeResponse {
  id: string;
  tokenId: string;
  tenantId: string;
  projectId: string;
  companyName: string;
  employeeName: string;
  employeeEmail: string;
  jobTitle: string;
  department?: string;
  competencyAnswers?: UserResponse[];
  questions?: Question[];
  workplaceAnswers?: WorkEnvironmentAnswers;
  competencyReport?: Record<string, unknown>;
  workEnvReport?: WorkEnvironmentReport;
  submittedAt: string;
  completedInSeconds?: number;
  language: Language;
}

// ---- Department package types (Track D) ----

export type DeptSectionKey = 'goal' | 'orgChart' | 'policies' | 'procedures' | 'kpis' | 'jobDescriptions' | 'raci' | 'riskRegister';

export interface DepartmentSection {
  key: DeptSectionKey;
  titleAr: string;
  content: string;
  status: 'pending' | 'generating' | 'done' | 'error';
}

export interface DepartmentPackage {
  id: string;
  tenantId: string;
  departmentName: string;
  departmentNameAr?: string;
  sections: DepartmentSection[];
  standardsUsed: string[];
  createdAt: string;
  updatedAt: string;
  complete: boolean;
}

// ============================================================================
// === GOVERNANCE CENTER (مركز الحوكمة) ===
// Knowledge-grounded governance engine: ingest files → hierarchical chunks +
// entities → knowledge graph + vector index → generate cited, coherent docs
// from a single Company Governance Model (never from chat directly).
// Multi-tenant: every record is scoped by `tenantId` (= ClientProfile.id).
// ============================================================================

// ---- Ingestion: hierarchical chunks + embeddings + provenance ----

export type DocKind =
  | 'profile' | 'brand' | 'meeting_minutes' | 'record' | 'contract'
  | 'regulation' | 'policy' | 'org_chart' | 'assessment' | 'survey' | 'other';

export interface DocChunk {
  id: string;
  tenantId: string;
  docId: string;
  docName: string;
  docKind: DocKind;
  headingPath: string;     // "اللائحة › الباب الثاني › المادة 5" — hierarchical anchor
  text: string;            // the chunk body
  charStart: number;
  ordinal: number;         // order within the document
  embedding?: number[];    // cosine vector (text-embedding)
  sentiment?: ChunkSentiment;  // auto-derived tone of the chunk (Stage-0 pipeline)
  createdAt: string;
}

// Per-chunk sentiment, derived automatically on ingest.
export type SentimentLabel = 'positive' | 'neutral' | 'negative' | 'mixed';
export interface ChunkSentiment {
  label: SentimentLabel;
  score: number;           // -1 (very negative) .. +1 (very positive)
}

// A citation pointer: every generated statement can resolve back to its origin.
export interface ProvenanceRef {
  kind: 'reality' | 'file' | 'project';   // company reality / company file / previous project
  refId: string;           // chunkId | assessmentId | projectId
  label: string;           // human label, e.g. "اللائحة الداخلية › المادة 5"
  docName?: string;
  similarity?: number;     // when retrieved by vector match
}

// ---- Knowledge graph (lightweight, document-store backed) ----

export type EntityType =
  | 'employee' | 'department' | 'role' | 'policy' | 'procedure'
  | 'authority' | 'kpi' | 'system' | 'risk' | 'process';

export interface KnowledgeNode {
  id: string;
  tenantId: string;
  type: EntityType;
  name: string;
  attributes: Record<string, string>;
  sourceChunkIds: string[];   // provenance: where this entity was seen
}

export interface KnowledgeEdge {
  id: string;
  tenantId: string;
  from: string;            // node id
  to: string;              // node id
  relation: string;        // "reports_to" | "owns" | "governs" | "measures" | "depends_on"
}

// ---- Reference layer: previous projects, matchable by similarity + context ----

export interface ReferenceProject {
  id: string;
  name: string;
  sector: string;
  companySize: 'small' | 'medium' | 'large' | 'enterprise';
  artifactKind: DocKind | 'policy_manual' | 'org_design' | 'authority_matrix' | 'kpi_framework';
  summary: string;
  content: string;         // the reusable governance material
  embedding?: number[];
  tags: string[];
  createdAt: string;
}

export interface MatchResult {
  project: ReferenceProject;
  score: number;           // 0..1 blended (vector + context)
  vectorScore: number;
  contextScore: number;
  rationale: string;       // why it matched (sector/size/kind)
}

// ---- The single source of truth the AI reads/writes (never the raw chat) ----

export interface GovOrgUnit {
  id: string;
  name: string;
  parentId?: string;       // builds the tree
  mandate: string;
  feeds?: string[];        // unit ids this unit feeds (closed-loop workflow "تُغذّي")
  dependsOn?: string[];    // unit ids this unit depends on ("تعتمد على")
  objective?: string;      // الهدف (workflow manual)
  workflow?: GovWorkflowStage[];  // دورة العمل: مرحلة/وصف/مسؤول
  provenance: ProvenanceRef[];
}

// A single workflow stage row (مرحلة / وصف / مسؤول)
export interface GovWorkflowStage {
  stage: string;           // المرحلة
  description: string;      // الوصف
  responsible: string;     // المسؤول (role title or id)
}

// Job-description qualifications block
export interface GovQualifications {
  education?: string;      // المؤهل العلمي
  experience?: string;     // الخبرة العملية
  certifications?: string; // الاعتمادات المهنية المفضلة
}

// Job-description skills block
export interface GovSkills {
  technical?: string[];    // المهارات الفنية
  soft?: string[];         // المهارات الإدارية والشخصية
}

// Job-description work relations block
export interface GovRelations {
  reportsTo?: string;      // يرتبط بـ
  supervises?: string[];   // يشرف على
  interactsWith?: string[];// يتعامل مع
}

export interface GovRole {
  id: string;
  title: string;
  unitId: string;
  purpose: string;
  responsibilities: string[];
  // --- Job-description enrichment (دليل الأوصاف الوظيفية) ---
  managerialLevel?: string;          // المستوى الإداري
  summary?: string;                  // ملخص الوظيفة
  responsibilityGroups?: { theme: string; items: string[] }[]; // مهام مجمّعة بمحاور
  qualifications?: GovQualifications;
  skills?: GovSkills;
  relations?: GovRelations;
  provenance: ProvenanceRef[];
}

export interface GovPolicy {
  id: string;
  title: string;
  domain: string;          // HR / Finance / IT / Governance ...
  body: string;            // the policy text (Markdown)
  status: 'draft' | 'in_review' | 'approved';
  provenance: ProvenanceRef[];
}

export interface GovProcedure {
  id: string;
  title: string;
  unitId?: string;         // owning org unit
  policyId?: string;       // the policy this procedure operationalizes
  purpose: string;
  steps: string[];         // ordered procedure steps
  body: string;            // full procedure text (Markdown), editable "reality"
  status: 'draft' | 'in_review' | 'approved';
  provenance: ProvenanceRef[];
}

export interface GovAuthority {
  id: string;
  decision: string;        // the decision/action being governed
  roleId: string;          // who holds it
  level: 'recommend' | 'approve' | 'execute' | 'inform';
  threshold?: string;      // financial DoA ceiling, e.g. "حتى 50,000 ريال" / "فوق 50,000"
  limit?: string;          // delegation limit text (حدود التفويض)
  provenance: ProvenanceRef[];
}

export interface GovKpi {
  id: string;
  name: string;
  unitId?: string;
  roleId?: string;             // owning role (job-description KPI table)
  formula: string;             // طريقة القياس
  target: string;              // الهدف السنوي
  weight?: number;             // الوزن النسبي (%) — per-role weights sum to 100
  frequency?: string;          // التكرار (سنوي/ربع سنوي/شهري)
  measurementMethod?: string;  // طريقة القياس التفصيلية (if distinct from formula)
  rewards?: string;            // المكافآت والتقديرات المرتبطة
  provenance: ProvenanceRef[];
}

// ---- Governance bodies & meeting cadence (دليل السياسات) ----
export interface GovCommittee {
  id: string;
  name: string;            // اسم اللجنة (لجنة الحوكمة ...)
  members: string[];       // role titles/ids
  mandate: string;         // الغرض
  cadence?: string;        // دورية الاجتماع
  provenance?: ProvenanceRef[];
}

export interface GovMeeting {
  id: string;
  type: string;            // النوع (تنفيذية/إدارية/مراجعة أداء/استراتيجية)
  purpose: string;         // الغرض
  frequency: string;       // التكرار
  attendees: string[];     // الحضور
}

// ---- Maturity assessment module (CMMI dims + SWOT/PESTEL + BSC) ----
export interface GovAssessmentDimension {
  name: string;            // البعد (التخطيط الاستراتيجي ...)
  score: number;           // 0..100
  label: string;           // منخفض جداً / متوسط ...
}

export interface GovSwot {
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  threats: string[];
}

export interface GovPestel {
  political?: string[];
  economic?: string[];
  social?: string[];
  technological?: string[];
  environmental?: string[];
  legal?: string[];
}

export interface GovBscObjective {
  perspective: 'financial' | 'customer' | 'internal' | 'learning'; // البطاقة المتوازنة
  objective: string;
  measure?: string;
  target?: string;
  initiative?: string;
}

export interface GovAssessment {
  id: string;
  tenantId: string;
  dimensions: GovAssessmentDimension[];
  overall: number;          // المتوسط المرجح
  cmmiLevel?: string;       // "1-2 مبدئي مُدار"
  swot?: GovSwot;
  pestel?: GovPestel;
  bsc?: GovBscObjective[];
  createdAt: string;
}

export interface GovGap {
  id: string;
  area: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  recommendation: string;
  matchedProjectIds: string[];   // reference projects proposed as a basis
  provenance: ProvenanceRef[];
  resolved?: boolean;            // closed via the gap→fix loop
  resolvedByDocId?: string;      // the generated gov_document that addresses it
  frameworkRef?: string;         // controlCode if derived from a framework control
}

// ---- Audit / collaboration ----
export interface GovAuditEntry {
  id: string;
  at: string;                    // ISO
  actor: string;                 // email or 'ai' or 'system'
  action: string;                // short verb e.g. 'add_role' | 'approve_policy' | 'apply_actions'
  detail: string;
}

export interface CompanyGovernanceModel {
  tenantId: string;        // = ClientProfile.id (multi-tenant isolation)
  companyName: string;
  orgUnits: GovOrgUnit[];
  roles: GovRole[];
  policies: GovPolicy[];
  procedures: GovProcedure[];
  authorities: GovAuthority[];
  kpis: GovKpi[];
  gaps: GovGap[];
  committees?: GovCommittee[];   // لجان الحوكمة
  meetings?: GovMeeting[];        // أنواع الاجتماعات الرسمية
  assessment?: GovAssessment;     // تقييم النضج (CMMI + SWOT/PESTEL + BSC)
  auditLog?: GovAuditEntry[];    // who/when changed the model
  updatedAt: string;
  version: number;
}

// ---- Stored generated documents library (versioned, reopen/re-export) ----
export type GovDocKind = string;

export interface GovDocumentRecord {
  id: string;
  tenantId: string;
  kind: GovDocKind;
  title: string;
  goal?: string;
  scope?: string;                // bulk scope / gap area / manual
  status: 'draft' | 'in_review' | 'approved';
  version: number;
  createdAt: string;             // ISO
  updatedAt: string;             // ISO
  // serialized GeneratedArtifact payload (createdAt stored as ISO string)
  sections: ArtifactSection[];
  executiveSummary?: string;
  diagrams?: ArtifactDiagram[];
  citations?: Record<string, ProvenanceRef[]>;
  comments?: GovComment[];
}

export interface GovComment {
  id: string;
  at: string;
  author: string;
  text: string;
}

// ---- Version snapshots (merge-on-rebuild / rollback) ----
export interface GovModelSnapshot {
  id: string;
  tenantId: string;
  version: number;
  at: string;                    // ISO
  reason: string;                // 'pre-rebuild' | 'manual' | 'pre-apply-actions' ...
  model: CompanyGovernanceModel;
}

// ---- Integrity engine ----
export type IntegrityKind =
  | 'orphan_role' | 'authority_no_holder' | 'authority_dup_approver'
  | 'procedure_no_policy' | 'policy_no_procedure' | 'unit_no_roles'
  | 'decision_no_approver' | 'kpi_no_owner' | 'duplicate_title' | 'gap_open'
  | 'kpi_weight_sum' | 'unit_isolated' | 'role_no_kpi' | 'role_no_jd'
  | 'authority_no_threshold' | 'no_committee' | 'no_assessment';

export interface IntegrityIssue {
  id: string;
  kind: IntegrityKind;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  entityKind?: 'unit' | 'role' | 'policy' | 'procedure' | 'authority' | 'kpi' | 'gap';
  entityId?: string;
  fixHint?: string;
}

export interface MaturityDomain {
  domain: string;
  score: number;                 // 0..100
  label: string;                 // مبدئي/ناشئ/محدد/مُدار/محسّن
}

export interface MaturityReport {
  overall: number;               // 0..100
  label: string;
  domains: MaturityDomain[];
  issueCount: number;
  critical: number;
}

export interface CoverageRow {
  unitId: string;
  unitName: string;
  roles: number;
  policies: number;
  procedures: number;
  kpis: number;
  authorities: number;
}

// ---- Framework alignment ----
export interface GovControl {
  code: string;
  title: string;
  keywords: string[];
}

export interface GovFramework {
  id: string;
  name: string;
  nameEn: string;
  controls: GovControl[];
}

export type AlignState = 'covered' | 'partial' | 'missing';

export interface ControlAlignment {
  code: string;
  title: string;
  state: AlignState;
  evidence: string;              // what in the model matched
}

export interface FrameworkAlignment {
  frameworkId: string;
  frameworkName: string;
  score: number;                 // 0..100
  controls: ControlAlignment[];
}

// ---- Agentic model-editing actions ----
export type GovActionType =
  | 'add_unit' | 'add_role' | 'add_policy' | 'add_procedure' | 'add_authority' | 'add_kpi'
  | 'add_committee' | 'add_meeting' | 'set_assessment'
  | 'edit_unit' | 'edit_role' | 'edit_policy' | 'edit_procedure' | 'edit_authority' | 'edit_kpi'
  | 'remove';

export interface GovAction {
  type: GovActionType;
  target?: string;               // entity id (edit/remove) or kind for remove
  kind?: 'unit' | 'role' | 'policy' | 'procedure' | 'authority' | 'kpi' | 'committee' | 'meeting';
  // free-form fields used by add_* / edit_*
  name?: string;
  title?: string;
  unit?: string;                 // unit name reference
  policy?: string;               // policy title reference
  role?: string;                 // role title reference
  domain?: string;
  mandate?: string;
  purpose?: string;
  body?: string;
  steps?: string[];
  responsibilities?: string[];
  decision?: string;
  level?: 'recommend' | 'approve' | 'execute' | 'inform';
  formula?: string;
  target_value?: string;
  // enriched fields
  weight?: number;
  frequency?: string;
  rewards?: string;
  measurementMethod?: string;
  threshold?: string;
  limit?: string;
  managerialLevel?: string;
  summary?: string;
  qualifications?: GovQualifications;
  skills?: GovSkills;
  relations?: GovRelations;
  members?: string[];
  cadence?: string;
  attendees?: string[];
  feeds?: string[];
  dependsOn?: string[];
  objective?: string;
  responsibilityGroups?: { theme: string; items: string[] }[];
  assessment?: GovAssessment;
  rationale?: string;
}

// ---- Reasoning agent loop (planner → tools → verify) ----
export type GovToolName =
  | 'read_model' | 'query_knowledge' | 'propose_actions' | 'apply_actions'
  | 'validate' | 'generate_document' | 'generate_bulk' | 'edit_document' | 'export_manual' | 'build_diagram'
  | 'rebuild_model' | 'revalidate' | 'sync_canvas' | 'finish';

export interface GovToolCall {
  tool: GovToolName;
  args?: Record<string, any>;
  reason?: string;               // why the agent chose this tool
}

export interface GovAgentStep {
  index: number;
  thought: string;               // reasoning scratchpad
  toolCall?: GovToolCall;
  observation?: string;          // tool result summary (untruncated)
  status: 'thinking' | 'acting' | 'observing' | 'done' | 'error';
  durationMs?: number;           // wall-clock for this step (planning + tool)
}

export interface GovAgentDiagram {
  title: string;
  mermaid: string;
  kind: GovDiagramKind;
}

export interface GovAgentResult {
  steps: GovAgentStep[];
  finalAnswer: string;
  appliedActions: GovAction[];
  model?: CompanyGovernanceModel; // mutated model (if changed)
  integrityAfter?: IntegrityIssue[];
  generatedDocuments?: GeneratedArtifact[]; // real docs produced by generate_document tool
  generatedDiagrams?: GovAgentDiagram[];     // real diagrams produced by build_diagram tool
  exportedFiles?: string[];                   // filenames exported by export_manual tool
  pendingActions?: GovAction[];               // proposed actions awaiting user approval (autoApply=false)
  traceMarkdown?: string;                     // full exportable run trace (every thought/tool/observation/duration)
  totalDurationMs?: number;                   // wall-clock for the whole run
}

// ---- Traceability ----
export interface TraceChain {
  rootKind: string;
  rootId: string;
  rootLabel: string;
  unit?: { id: string; name: string };
  policy?: { id: string; title: string };
  roles: { id: string; title: string }[];
  procedures: { id: string; title: string }[];
  authorities: { decision: string; level: string; role: string }[];
  kpis: { name: string; target: string }[];
  gaps: { area: string; severity: string }[];
  sources: ProvenanceRef[];
}

// ---- Diagrams & interactive canvas (Mermaid SVG + React Flow graph) ----

export type GovDiagramKind = 'flowchart' | 'swimlane' | 'state' | 'orgchart' | 'raci';

export interface GovFlowNode {
  id: string;
  position: { x: number; y: number };
  data: {
    label: string;
    refKind?: 'unit' | 'role' | 'policy' | 'procedure' | 'authority' | 'kpi';  // bound real model entity
    refId?: string;
  };
  type?: string;
  style?: Record<string, any>;
}

export interface GovFlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  animated?: boolean;
  type?: string;
}

export interface GovDiagram {
  id: string;
  tenantId: string;
  kind: GovDiagramKind;
  title: string;
  mermaid: string;                 // generated Mermaid syntax (source of the SVG)
  swimlane?: SwimlaneSpec;         // custom swimlane spec (kind === 'swimlane'; rendered via SwimlaneView, not Mermaid)
  flowNodes?: GovFlowNode[];       // React Flow graph (editable canvas)
  flowEdges?: GovFlowEdge[];
  sourceRef?: string;              // which model element it was generated from
  updatedAt: number;
}

export type GovPhase = 'reality' | 'knowledge' | 'recommendation' | 'generation';

// Progress event for ingestion / model-building pipelines.
export interface GovProgress {
  // build_* are the structure-build sub-phases surfaced during buildModel (HWK-B6).
  phase: GovPhase | 'ingest' | 'embed' | 'entities' | 'sentiment' | 'match' | 'build_digest' | 'build_extract' | 'build_dedup';
  current: number;
  total: number;
  label: string;
}

// ============================================================================
// === UNIFIED ASSESSMENT SYSTEM (نظام التقييم الموحد) ===
// One shareable link per project → employees self-identify → questions auto-
// generated per job title → optional camera proctoring → results + AI analysis.
// ============================================================================

export interface UnifiedAssessmentToken {
  id: string;
  tenantId: string;
  projectId: string;
  companyName: string;
  companyLogoUrl?: string;

  // --- Field 1-4: Questions ---
  questionCount: number;          // 10 | 15 | 20 | 25 | 30
  behavioralPct: number;          // 20 | 30 | 40 | 50 | 60 | 70
  difficulty: PaperDifficulty;    // 'easy' | 'medium' | 'hard'
  theories?: PaperTheories;       // Birkman / Holland / PsychTech / Bloom

  // --- Field 5-8: Exam settings ---
  secondsPerQuestion: number;     // 45 | 60 | 90 | 120 | 180
  maxAttempts: number;            // 1 | 2 | 3
  passingScore: number;           // 50 | 60 | 70 | 80
  voiceQuestionCount: number;     // 0 | 1 | 2 | 3

  // --- Field 9: Proctoring ---
  cameraProctoring: boolean;

  // --- Field 10: Job titles the employee can pick from ---
  allowedJobTitles: string[];

  // --- Field 11-12: Optional access control ---
  accessCode?: string;            // shared code all employees enter
  expiresAt?: string;             // ISO expiry (optional)

  createdAt: string;
  active: boolean;
}

export interface UnifiedAttempt {
  attemptNumber: number;
  answers: Record<number, string>;        // qIndex → "أ"|"ب"|"ج"|"د"
  voiceAnswers?: Record<number, string>;  // qIndex → transcribed text
  score: number;                          // 0-100 MCQ score
  violations: number;
  cancelled?: boolean;
  jobTitle: string;
  startedAt: string;
  finishedAt: string;
  proctorSummary?: import('./services/proctorCore').ProctorSummary;  // live AI proctoring integrity summary
}

export interface UnifiedEmployeeAnalysis {
  overallScore: number;
  passed: boolean;
  strengths: string[];
  weaknesses: string[];
  behavioralInsights: string;
  recommendations: string;
  competencyScores: { name: string; score: number }[];
}

export interface UnifiedAssessmentResult {
  id?: string;
  tokenId: string;
  tenantId: string;
  projectId: string;
  companyName: string;
  employeeName: string;
  employeeEmail: string;
  jobTitle: string;
  employeeId?: string;  // optional staff/employee number
  attempts: UnifiedAttempt[];
  bestScore: number;
  passed: boolean;
  analysis?: UnifiedEmployeeAnalysis;
  analysisGeneratedAt?: string;
  submittedAt: string;
}

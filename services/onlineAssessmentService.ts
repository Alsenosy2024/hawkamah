// Online Assessment Service — proctored online exam with multi-attempt system.
// Token stored in Firestore `exam_tokens` collection.

import { db } from '../firebase';
import { collection, doc, setDoc, getDoc, addDoc, query, where, getDocs, updateDoc } from 'firebase/firestore';
import type { PaperDifficulty, PaperTheories, PaperQuestion } from '../types';
import { hashPassword } from './paperAssessmentService';

const C_EXAM   = 'exam_tokens';
const C_RESULT = 'exam_results';

export interface ExamToken {
  id: string;
  tenantId: string;
  projectId: string;
  companyName: string;
  companyLogoUrl?: string;
  accessEmail: string;
  accessPasswordHash: string;
  /** @deprecated use allowedJobTitles */
  jobTitle?: string;
  allowedJobTitles?: string[];     // employee picks one at login
  voiceQuestionCount?: number;     // how many questions are spoken (TTS + record)
  passingScore?: number;           // 0–100, default 60
  questionCount: number;
  difficulty: PaperDifficulty;
  behavioralPct: number;
  secondsPerQuestion: number;
  maxAttempts: number;
  theories?: PaperTheories;
  createdAt: string;
  active: boolean;
}

export interface ExamAttempt {
  attemptNumber: number;
  answers: Record<number, string>;        // qIndex → "أ"|"ب"|"ج"|"د"
  voiceAnswers?: Record<number, string>;  // qIndex → transcribed text
  score: number;                          // 0–100, MCQ only
  violations: number;
  cancelled?: boolean;                    // true = terminated by violations
  jobTitle: string;                       // title selected by employee
  startedAt: string;
  finishedAt: string;
  proctorSummary?: import('./proctorCore').ProctorSummary;  // live AI integrity summary (camera + screen)
}

export interface ExamResult {
  id?: string;
  tokenId: string;
  tenantId: string;
  projectId: string;
  companyName: string;
  accessEmail: string;
  employeeName?: string;
  selectedJobTitle?: string;
  attempts: ExamAttempt[];
  bestScore: number;
  submittedAt: string;
}

function genToken(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export async function createExamToken(
  tenantId: string,
  projectId: string,
  companyName: string,
  accessEmail: string,
  accessPassword: string,
  allowedJobTitles: string[],
  opts: {
    questionCount?: number;
    difficulty?: PaperDifficulty;
    behavioralPct?: number;
    secondsPerQuestion?: number;
    maxAttempts?: number;
    companyLogoUrl?: string;
    theories?: PaperTheories;
    voiceQuestionCount?: number;
    passingScore?: number;
  } = {},
): Promise<{ token: string; url: string }> {
  const id = genToken();
  const tok: ExamToken = {
    id,
    tenantId,
    projectId,
    companyName,
    accessEmail: accessEmail.trim().toLowerCase(),
    accessPasswordHash: await hashPassword(accessPassword),
    allowedJobTitles,
    questionCount:      opts.questionCount      ?? 20,
    difficulty:         opts.difficulty          ?? 'medium',
    behavioralPct:      opts.behavioralPct       ?? 50,
    secondsPerQuestion: opts.secondsPerQuestion  ?? 90,
    maxAttempts:        opts.maxAttempts         ?? 3,
    voiceQuestionCount: opts.voiceQuestionCount  ?? 0,
    passingScore:       opts.passingScore        ?? 60,
    createdAt: new Date().toISOString(),
    active: true,
    ...(opts.companyLogoUrl ? { companyLogoUrl: opts.companyLogoUrl } : {}),
    ...(opts.theories        ? { theories: opts.theories }            : {}),
  };
  await setDoc(doc(db, C_EXAM, id), tok);
  const url = `${window.location.origin}/?online=${id}`;
  return { token: id, url };
}

export async function getExamToken(id: string): Promise<ExamToken | null> {
  const snap = await getDoc(doc(db, C_EXAM, id));
  return snap.exists() ? (snap.data() as ExamToken) : null;
}

export async function verifyExamAccess(token: ExamToken, email: string, password: string): Promise<boolean> {
  if (email.trim().toLowerCase() !== token.accessEmail) return false;
  const hash = await hashPassword(password);
  return hash === token.accessPasswordHash;
}

export async function getExamResult(tokenId: string, email: string): Promise<ExamResult | null> {
  const q = query(collection(db, C_RESULT),
    where('tokenId', '==', tokenId),
    where('accessEmail', '==', email.toLowerCase()));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...(d.data() as Omit<ExamResult, 'id'>) };
}

export async function saveExamResult(result: ExamResult): Promise<void> {
  if (result.id) {
    const { id, ...data } = result;
    await updateDoc(doc(db, C_RESULT, id), data as Record<string, unknown>);
  } else {
    const ref = await addDoc(collection(db, C_RESULT), result);
    result.id = ref.id;
  }
}

/** Score MCQ questions only; skip isVoice questions */
export function scoreAttempt(questions: PaperQuestion[], answers: Record<number, string>): number {
  const mcq = questions.map((q, i) => ({ q, i })).filter(({ q }) => !q.isVoice);
  if (!mcq.length) return 0;
  const correct = mcq.filter(({ q, i }) => {
    const chosen = answers[i] ?? '';
    // Guard: an empty correctAnswer (degenerate model output) makes startsWith('')
    // true for every chosen value — which would score the question correct for all
    // candidates. No defined answer ⇒ no one can be correct.
    return !!q.correctAnswer && chosen.trim().startsWith(q.correctAnswer);
  }).length;
  return Math.round((correct / mcq.length) * 100);
}

/** Resolve the effective job titles list from a token (handles legacy single-title tokens) */
export function getEffectiveTitles(tok: ExamToken): string[] {
  if (tok.allowedJobTitles && tok.allowedJobTitles.length > 0) return tok.allowedJobTitles;
  if (tok.jobTitle) return [tok.jobTitle];
  return [];
}

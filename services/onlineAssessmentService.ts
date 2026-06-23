// Online Assessment Service — proctored online exam with 3-attempt system.
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
  jobTitle: string;
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
  attemptNumber: number;           // 1, 2, or 3
  answers: Record<number, string>; // questionIndex → chosen option ("أ"|"ب"|"ج"|"د")
  score: number;                   // 0–100
  violations: number;              // tab-switch + camera violations counted
  startedAt: string;
  finishedAt: string;
}

export interface ExamResult {
  id?: string;
  tokenId: string;
  tenantId: string;
  projectId: string;
  companyName: string;
  accessEmail: string;
  jobTitle: string;
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
  jobTitle: string,
  opts: {
    questionCount?: number;
    difficulty?: PaperDifficulty;
    behavioralPct?: number;
    secondsPerQuestion?: number;
    maxAttempts?: number;
    companyLogoUrl?: string;
    theories?: PaperTheories;
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
    jobTitle,
    questionCount:      opts.questionCount      ?? 20,
    difficulty:         opts.difficulty          ?? 'medium',
    behavioralPct:      opts.behavioralPct       ?? 50,
    secondsPerQuestion: opts.secondsPerQuestion  ?? 90,
    maxAttempts:        opts.maxAttempts         ?? 3,
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

export function scoreAttempt(questions: PaperQuestion[], answers: Record<number, string>): number {
  if (!questions.length) return 0;
  const correct = questions.filter((q, i) => {
    const chosen = answers[i] ?? '';
    // correctAnswer is "أ" | "ب" | "ج" | "د" — match against first char of chosen option
    return chosen.trim().startsWith(q.correctAnswer);
  }).length;
  return Math.round((correct / questions.length) * 100);
}

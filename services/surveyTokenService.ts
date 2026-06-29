// Survey token service — creates shareable public links per project and stores
// anonymous employee responses. Tokens are tenant-scoped so respondents never
// see other companies' data.
import { db } from '../firebase';
import {
  collection, doc, setDoc, getDoc, getDocs, addDoc, query, where,
} from 'firebase/firestore';
import type { SurveyToken, PublicSurveyResponse, WorkEnvironmentAnswers, Language } from '../types';

const C_TOKENS = 'survey_tokens';
const C_RESPONSES = 'survey_responses';

function genToken(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export async function createSurveyToken(
  tenantId: string,
  projectId: string,
  companyName: string,
  language: Language,
  createdByEmail?: string,
  cameraProctoring?: boolean,   // B5: per-link camera + screen proctoring (default OFF in the launch modal)
): Promise<{ token: string; url: string }> {
  const id = genToken();
  const tok: SurveyToken = {
    id, tenantId, projectId, companyName, language,
    ...(cameraProctoring !== undefined ? { cameraProctoring } : {}),
    createdAt: new Date().toISOString(),
    ...(createdByEmail ? { createdByEmail } : {}),
  };
  await setDoc(doc(db, C_TOKENS, id), tok);
  const url = `${window.location.origin}/?s=${id}`;
  return { token: id, url };
}

export async function getSurveyToken(tokenId: string): Promise<SurveyToken | null> {
  const snap = await getDoc(doc(db, C_TOKENS, tokenId));
  if (!snap.exists()) return null;
  const data = snap.data() as SurveyToken & { type?: string };
  if (data.type === 'reviewer') return null;   // HWK-D3: a doc-review token shares this collection
  return data as SurveyToken;
}

export async function getTokensByTenant(tenantId: string): Promise<SurveyToken[]> {
  const q = query(collection(db, C_TOKENS), where('tenantId', '==', tenantId));
  const snap = await getDocs(q);
  // HWK-D3: reviewer tokens live in the same collection (type:'reviewer') — exclude
  // them so the survey UI only ever lists actual survey links.
  return snap.docs.map(d => d.data() as SurveyToken & { type?: string })
    .filter(d => d.type !== 'reviewer') as SurveyToken[];
}

export async function savePublicResponse(
  resp: Omit<PublicSurveyResponse, 'id'>,
): Promise<string> {
  const ref = await addDoc(collection(db, C_RESPONSES), resp);
  return ref.id;
}

export async function getProjectResponses(tenantId: string): Promise<PublicSurveyResponse[]> {
  const q = query(collection(db, C_RESPONSES), where('tenantId', '==', tenantId));
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as PublicSurveyResponse))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

// Patch a response with an AI-generated analysis (admin side, after running analyzeWorkEnvironment).
export async function patchResponseAnalysis(
  responseId: string,
  answers: WorkEnvironmentAnswers,
  report: any,
): Promise<void> {
  const ref = doc(db, C_RESPONSES, responseId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  await setDoc(ref, { ...snap.data(), analysis: report });
}

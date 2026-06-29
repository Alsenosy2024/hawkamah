// Employee portal service — creates company-specific assessment links and stores
// full employee assessment responses (competency + work environment).
import { db } from '../firebase';
import {
  collection, doc, setDoc, getDoc, getDocs, query, where,
} from 'firebase/firestore';
import type { EmployeeToken, EmployeeResponse, Language, GovProject } from '../types';
import firebaseConfig from '../firebase-applet-config.json';

const C_EMP_TOKENS = 'employee_tokens';
const C_EMP_RESPONSES = 'employee_responses';

// ---- Firestore REST helpers (bypasses WebChannel / event-loop freeze) ----
type FsVal =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { arrayValue: { values: FsVal[] } }
  | { mapValue: { fields: Record<string, FsVal> } };

function toFsVal(v: unknown): FsVal {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsVal) } };
  if (typeof v === 'object') {
    const fields: Record<string, FsVal> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val !== undefined) fields[k] = toFsVal(val);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

// ---- Service functions ----

function genToken(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export interface CreateTokenOptions {
  questionCount?: number;   // total questions for this survey link
  voiceCount?: number;      // how many answered by voice
  cameraProctoring?: boolean; // B5: per-link camera + screen proctoring (default ON in the launch modal)
  createdByEmail?: string;
}

export async function createEmployeeToken(
  project: GovProject,
  language: Language,
  options: CreateTokenOptions = {},
): Promise<{ token: string; url: string }> {
  const { questionCount, voiceCount, cameraProctoring, createdByEmail } = options;
  const id = genToken();
  const tok: EmployeeToken = {
    id,
    tenantId: project.id,
    projectId: project.id,
    companyName: project.name,
    companyLogoUrl: project.logoUrl ?? '',
    language,
    jobRoles: project.jobRoles || [],
    // Per-link survey sizing + company context snapshot (W3/W4). Defaults applied
    // at read-time in the portal, so omit when not chosen rather than forcing here.
    ...(questionCount ? { questionCount } : {}),
    ...(voiceCount ? { voiceCount } : {}),
    ...(cameraProctoring !== undefined ? { cameraProctoring } : {}),
    ...(project.industry ? { industry: project.industry } : {}),
    ...(project.specialization ? { specialization: project.specialization } : {}),
    ...(project.description ? { companyDescription: project.description } : {}),
    createdAt: new Date().toISOString(),
    active: true,
    ...(createdByEmail ? { createdByEmail } : {}),
  };
  await setDoc(doc(db, C_EMP_TOKENS, id), tok);
  const url = `${window.location.origin}/?emp=${id}`;
  return { token: id, url };
}

export async function getEmployeeToken(tokenId: string): Promise<EmployeeToken | null> {
  const snap = await getDoc(doc(db, C_EMP_TOKENS, tokenId));
  if (!snap.exists()) return null;
  const tok = snap.data() as EmployeeToken;
  return tok.active !== false ? tok : null;
}

export async function getEmployeeTokensByTenant(tenantId: string): Promise<EmployeeToken[]> {
  const q = query(collection(db, C_EMP_TOKENS), where('tenantId', '==', tenantId));
  const snap = await getDocs(q);
  return snap.docs
    .map(d => d.data() as EmployeeToken)
    .filter(t => t.active !== false);
}

// Uses Firestore REST API (not the JS SDK) to avoid WebChannel blocking the event loop.
// The rule `allow create: if sizeOk()` permits anonymous creates without an auth token.
export async function saveEmployeeResponse(
  resp: Omit<EmployeeResponse, 'id'>,
): Promise<string> {
  const { projectId, firestoreDatabaseId, apiKey } = firebaseConfig as {
    projectId: string; firestoreDatabaseId: string; apiKey: string;
  };
  const url =
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
    `/databases/${firestoreDatabaseId}/documents/${C_EMP_RESPONSES}?key=${apiKey}`;

  const fields: Record<string, FsVal> = {};
  for (const [k, v] of Object.entries(resp as Record<string, unknown>)) {
    if (v !== undefined) fields[k] = toFsVal(v);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => String(res.status));
    throw new Error(`Firestore save failed (${res.status}): ${errText}`);
  }

  const data = await res.json() as { name?: string };
  return data.name?.split('/').pop() ?? '';
}

export async function getEmployeeResponses(tenantId: string): Promise<EmployeeResponse[]> {
  const q = query(collection(db, C_EMP_RESPONSES), where('tenantId', '==', tenantId));
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as EmployeeResponse))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

// Governance Center persistence + retrieval (Phases 0/1/2).
// Single source of truth = CompanyGovernanceModel, stored per-tenant in Firestore.
// Chunks, nodes, edges and reference projects are tenant-scoped collections.
//
// Multi-tenancy: every doc carries `tenantId` (= ClientProfile.id). Collections:
//   gov_models/{tenantId}
//   gov_chunks/{chunkId}          (field tenantId)
//   gov_nodes/{nodeId}            (field tenantId)
//   gov_edges/{edgeId}            (field tenantId)
//   gov_projects/{projectId}      (reference library — shared across tenants)

import {
  collection, doc, setDoc, getDoc, getDocs, query, where, writeBatch, deleteDoc,
} from 'firebase/firestore';
import { db } from '../firebase';
import { embedText, topK, cosine, lexicalScore } from './embeddingService';
import { STANDARDS_MAP, formatStandardsForPrompt } from '../constants/standards';
import { toKindArray } from '../types';
import type {
  CompanyGovernanceModel, DocChunk, KnowledgeNode, KnowledgeEdge,
  ReferenceProject, MatchResult, ProvenanceRef, GovDiagram,
  GovDocumentRecord, GovModelSnapshot,
  AdminSettings, GovProject, ProjectSurveySettings,
} from '../types';

const C_MODELS = 'gov_models';
const C_CHUNKS = 'gov_chunks';
const C_NODES = 'gov_nodes';
const C_EDGES = 'gov_edges';
const C_PROJECTS = 'gov_projects';
const C_DIAGRAMS = 'gov_diagrams';
const C_DOCS = 'gov_documents';
const C_SNAPSHOTS = 'gov_snapshots';

// Firestore rejects nested arrays; embeddings (number[]) are fine as a flat array,
// but we store them under a key. Helper to strip undefined before write.
const clean = <T extends object>(o: T): T => JSON.parse(JSON.stringify(o));

// ---- Projects & per-project survey settings (migration) -----------------------

export const DEFAULT_SURVEY_TEMPLATE: ProjectSurveySettings = {
  questionCount: 20,
  theories: { birkman: true, holland: true, psychTech: true, bloomTaxonomy: true },
  surveyScopeDefault: 'both',
};

/** Deep-clone a survey template (or the global default) for a new project. */
export function seedProjectSurvey(tpl?: ProjectSurveySettings | null): ProjectSurveySettings {
  return JSON.parse(JSON.stringify(tpl || DEFAULT_SURVEY_TEMPLATE));
}

/**
 * One-time, idempotent backfill applied on settings load:
 *  - seed `defaultSurveyTemplate` from legacy platform-level survey fields
 *  - give every project a `survey{}` (from the template) and a `createdAt`
 * Legacy AdminSettings.survey* fields are left intact for one release.
 */
export function migrateSettings(settings: AdminSettings): AdminSettings {
  const s: AdminSettings = JSON.parse(JSON.stringify(settings || {}));
  // Normalize legacy single-value assessmentKind → array (multi-select migration).
  if (s.surveyLaunchConfig && s.surveyLaunchConfig.assessmentKind != null && !Array.isArray(s.surveyLaunchConfig.assessmentKind)) {
    s.surveyLaunchConfig.assessmentKind = toKindArray(s.surveyLaunchConfig.assessmentKind);
  }
  const legacy: ProjectSurveySettings = {
    questionCount: s.questionCount ?? DEFAULT_SURVEY_TEMPLATE.questionCount,
    theories: s.theories ?? DEFAULT_SURVEY_TEMPLATE.theories,
    surveyScopeDefault: s.surveyScopeDefault ?? DEFAULT_SURVEY_TEMPLATE.surveyScopeDefault,
    surveyWordLimits: s.surveyWordLimits,
    surveyLaunchConfig: s.surveyLaunchConfig,
  };
  if (!s.defaultSurveyTemplate) s.defaultSurveyTemplate = seedProjectSurvey(legacy);
  if (Array.isArray(s.clientProfiles)) {
    s.clientProfiles = s.clientProfiles.map((p: GovProject) => ({
      ...p,
      createdAt: p.createdAt || p.uploadedAt,
      survey: p.survey || seedProjectSurvey(s.defaultSurveyTemplate || legacy),
    }));
  }
  return s;
}

/** Resolve the active project's effective survey settings (with legacy fallback). */
export function activeProjectSurvey(settings: AdminSettings, projectId?: string): ProjectSurveySettings {
  const wantId = projectId || settings.activeClientProfileId;
  const p = settings.clientProfiles?.find(x => x.id === wantId);
  if (p?.survey) return p.survey;
  return seedProjectSurvey(settings.defaultSurveyTemplate);
}

// ---- Company Governance Model -------------------------------------------------

export function emptyModel(tenantId: string, companyName: string): CompanyGovernanceModel {
  return {
    tenantId, companyName,
    orgUnits: [], roles: [], policies: [], procedures: [], authorities: [], kpis: [], gaps: [],
    updatedAt: new Date().toISOString(), version: 1,
  };
}

export async function loadModel(tenantId: string): Promise<CompanyGovernanceModel | null> {
  const snap = await getDoc(doc(db, C_MODELS, tenantId));
  if (!snap.exists()) return null;
  const m = snap.data() as CompanyGovernanceModel;
  // backfill fields added after a model was first persisted
  if (!Array.isArray(m.procedures)) m.procedures = [];
  if (!Array.isArray(m.authorities)) m.authorities = [];
  if (!Array.isArray(m.kpis)) m.kpis = [];
  if (!Array.isArray(m.gaps)) m.gaps = [];
  return m;
}

export async function saveModel(model: CompanyGovernanceModel): Promise<void> {
  // Do NOT mutate the caller's object — write a versioned copy to Firestore only.
  const toSave: CompanyGovernanceModel = {
    ...model,
    updatedAt: new Date().toISOString(),
    version: (model.version || 0) + 1,
  };
  await setDoc(doc(db, C_MODELS, model.tenantId), clean(toSave));
}

// ---- Chunks (vector store, client-side similarity) ---------------------------

// GovF10: per-tenant chunk cache. Agent runs, QA, retrieval and context-compile
// each re-loaded ALL chunks (with embeddings) from Firestore — heavy at 30–50 docs.
// Cache the loaded set; invalidate on any chunk write/delete for the tenant.
const _chunkCache = new Map<string, DocChunk[]>();
export function invalidateChunkCache(tenantId?: string): void {
  if (tenantId) _chunkCache.delete(tenantId);
  else _chunkCache.clear();
}

export async function saveChunks(chunks: DocChunk[]): Promise<void> {
  // batched writes (Firestore limit 500/batch)
  for (let i = 0; i < chunks.length; i += 450) {
    const batch = writeBatch(db);
    for (const c of chunks.slice(i, i + 450)) batch.set(doc(db, C_CHUNKS, c.id), clean(c));
    await batch.commit();
  }
  for (const tid of new Set(chunks.map(c => c.tenantId))) invalidateChunkCache(tid);
}

export async function loadChunks(tenantId: string, force = false): Promise<DocChunk[]> {
  if (!force) {
    const hit = _chunkCache.get(tenantId);
    if (hit) return hit;
  }
  const q = query(collection(db, C_CHUNKS), where('tenantId', '==', tenantId));
  const snap = await getDocs(q);
  const chunks = snap.docs.map(d => d.data() as DocChunk);
  _chunkCache.set(tenantId, chunks);
  return chunks;
}

/**
 * Compile a single text context from a tenant's ingested chunks, ordered by
 * document then ordinal, within a character budget. Shared bridge so assessment
 * generation and survey-minimum derivation reason over the SAME ingested
 * knowledge that the governance model is built from (not the raw `documents`).
 * Returns '' when no chunks exist so callers can fall back to raw docs.
 */
export async function compileChunkContext(tenantId: string, maxChars = 12000): Promise<string> {
  const chunks = [...await loadChunks(tenantId)];
  if (!chunks.length) return '';
  chunks.sort((a, b) =>
    a.docName === b.docName ? (a.ordinal - b.ordinal) : a.docName.localeCompare(b.docName));
  const parts: string[] = [];
  let used = 0;
  for (const c of chunks) {
    const piece = `[${c.docName}${c.headingPath ? ' › ' + c.headingPath : ''}]\n${c.text}`;
    if (used + piece.length > maxChars) {
      const remaining = maxChars - used;
      if (remaining > 200) parts.push(piece.slice(0, remaining));
      break;
    }
    parts.push(piece);
    used += piece.length + 2;
  }
  return parts.join('\n\n');
}

export async function deleteDocChunks(tenantId: string, docId: string): Promise<void> {
  const q = query(collection(db, C_CHUNKS), where('tenantId', '==', tenantId), where('docId', '==', docId));
  const snap = await getDocs(q);
  // GovF4: a single large file can produce >500 chunks — paginate under the 500-op batch cap.
  for (let i = 0; i < snap.docs.length; i += 450) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  invalidateChunkCache(tenantId);
}

// ---- Knowledge graph ---------------------------------------------------------

export async function saveNodes(nodes: KnowledgeNode[]): Promise<void> {
  for (let i = 0; i < nodes.length; i += 450) {
    const batch = writeBatch(db);
    for (const n of nodes.slice(i, i + 450)) batch.set(doc(db, C_NODES, n.id), clean(n));
    await batch.commit();
  }
}

export async function loadNodes(tenantId: string): Promise<KnowledgeNode[]> {
  const q = query(collection(db, C_NODES), where('tenantId', '==', tenantId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data() as KnowledgeNode);
}

export async function saveEdges(edges: KnowledgeEdge[]): Promise<void> {
  for (let i = 0; i < edges.length; i += 450) {
    const batch = writeBatch(db);
    for (const e of edges.slice(i, i + 450)) batch.set(doc(db, C_EDGES, e.id), clean(e));
    await batch.commit();
  }
}

export async function loadEdges(tenantId: string): Promise<KnowledgeEdge[]> {
  const q = query(collection(db, C_EDGES), where('tenantId', '==', tenantId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data() as KnowledgeEdge);
}

// ---- Retrieval: semantic + lexical hybrid -----------------------------------

export interface RetrievedChunk { chunk: DocChunk; score: number; }

/** Hybrid retrieval over a tenant's chunks with reranking + adaptive depth (ج5).
 *  - Adaptive depth: when `k` is left at the default, scale it to query richness
 *    and corpus size instead of a hardcoded 6 — short corpora retrieve fewer,
 *    rich queries over a large corpus retrieve more (bounded 4..14).
 *  - Reranking: over-fetch a candidate pool by vector similarity, then re-score
 *    each candidate by a hybrid of vector + lexical-overlap + heading-hit and
 *    keep the top `k`.
 *  - Adaptive cutoff: relative-to-best threshold (not a fixed 0.15 floor), so a
 *    strong query keeps only strong hits and a weak one still returns something. */
export async function retrieve(
  queryText: string, chunks: DocChunk[], k = 6, signal?: AbortSignal,
): Promise<RetrievedChunk[]> {
  if (!chunks.length) return [];
  // Adaptive depth — only when caller used the default (6).
  let depth = k;
  if (k === 6) {
    const qWords = (queryText || '').trim().split(/\s+/).filter(Boolean).length;
    const base = qWords >= 8 ? 9 : qWords >= 4 ? 7 : 5;
    depth = Math.max(4, Math.min(14, Math.min(base, chunks.length)));
  }
  const pool = Math.min(chunks.length, Math.max(depth * 3, 12));
  const ABS_FLOOR = 0.12;     // absolute minimum vector similarity to consider
  const REL = 0.5;            // keep candidates within REL × best combined score

  const haveVectors = chunks.some(c => c.embedding?.length);
  let candidates: RetrievedChunk[] = [];

  if (haveVectors) {
    const qv = await embedText(queryText, signal);
    if (qv.length) {
      let top = topK(qv, chunks, c => c.embedding, pool, ABS_FLOOR);
      // Floor too strict for this corpus/query (common with short Arabic
      // queries) → retry floorless so retrieval never starves a section.
      if (!top.length) top = topK(qv, chunks, c => c.embedding, Math.min(pool, 6), 0);
      // Rerank: blend vector similarity with lexical overlap + heading hit.
      candidates = top.map(s => {
        const lex = lexicalScore(queryText, `${s.item.headingPath} ${s.item.text}`);
        const lexN = Math.min(1, lex / 6);                 // normalize lexical into 0..1
        const headHit = lexicalScore(queryText, s.item.headingPath) > 0 ? 0.08 : 0;
        const combined = 0.7 * s.score + 0.22 * lexN + headHit;
        return { chunk: s.item, score: combined };
      });
    }
  }

  if (!candidates.length) {
    // lexical fallback
    candidates = chunks
      .map(c => ({ chunk: c, score: lexicalScore(queryText, `${c.headingPath} ${c.text}`) }))
      .filter(s => s.score > 0);
  }

  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) return [];
  const best = candidates[0].score;
  const cutoff = best * REL;
  const kept = candidates.filter(c => c.score >= cutoff).slice(0, depth);
  // Never return empty when candidates exist — grounding beats a blank context.
  return kept.length ? kept : candidates.slice(0, Math.min(2, candidates.length));
}

/** Turn retrieved chunks into provenance refs (for citations). */
export function chunksToProvenance(rc: RetrievedChunk[]): ProvenanceRef[] {
  return rc.map(r => ({
    kind: 'file' as const,
    refId: r.chunk.id,
    label: r.chunk.headingPath,
    docName: r.chunk.docName,
    similarity: Number(r.score.toFixed(3)),
  }));
}

// ---- Reference projects (matching previous work) ----------------------------

export async function saveReferenceProject(p: ReferenceProject): Promise<void> {
  // GovF22: don't mutate the caller's object — embed into a local copy.
  const rec: ReferenceProject = p.embedding?.length
    ? p
    : { ...p, embedding: await embedText(`${p.name} ${p.summary} ${p.tags.join(' ')}`) };
  await setDoc(doc(db, C_PROJECTS, rec.id), clean(rec));
}

export async function loadReferenceProjects(): Promise<ReferenceProject[]> {
  const snap = await getDocs(collection(db, C_PROJECTS));
  return snap.docs.map(d => d.data() as ReferenceProject);
}

export async function deleteReferenceProject(id: string): Promise<void> {
  await deleteDoc(doc(db, C_PROJECTS, id));
}

/** Render one STANDARDS_MAP entry into reusable reference-library markdown. */
function standardToContent(s: typeof STANDARDS_MAP[number]): string {
  const L: string[] = [`# المعايير المرجعية — ${s.departmentAr}`, ''];
  if (s.iso.length)          L.push(`## معايير ISO`, ...s.iso.map(x => `- ${x}`), '');
  if (s.frameworks.length)   L.push(`## أطر الحوكمة والتميز`, ...s.frameworks.map(x => `- ${x}`), '');
  if (s.regulations.length)  L.push(`## التنظيمات والقوانين`, ...s.regulations.map(x => `- ${x}`), '');
  if (s.professional.length) L.push(`## المعايير المهنية`, ...s.professional.map(x => `- ${x}`), '');
  L.push(`## حالة الاستخدام`, s.useCase, '');
  if (s.deliverables.length) L.push(`## المخرجات المعيارية`, ...s.deliverables.map(x => `- ${x}`));
  return L.join('\n');
}

/**
 * Pre-seed the reference library with the full institutional standards map
 * (ISO + frameworks + regulations + professional bodies, 16 departments).
 * Idempotent: stable `std_<Department>` ids, skips entries already present so
 * re-running never duplicates. Returns how many were newly written.
 * These become matchable ReferenceProjects the build/generation pulls from.
 */
export async function seedStandardsLibrary(
  onProgress?: (current: number, total: number, name: string) => void,
): Promise<{ added: number; total: number }> {
  const existing = new Set((await getDocs(collection(db, C_PROJECTS))).docs.map(d => d.id));
  let added = 0;
  for (let i = 0; i < STANDARDS_MAP.length; i++) {
    const s = STANDARDS_MAP[i];
    const id = `std_${s.department}`;
    onProgress?.(i + 1, STANDARDS_MAP.length, s.departmentAr);
    if (existing.has(id)) continue;
    const tags = Array.from(new Set([
      ...s.iso, ...s.frameworks, ...s.regulations, ...s.professional,
      s.departmentAr, 'معيار', 'standard', 'ISO',
    ])).slice(0, 24);
    const rec: ReferenceProject = {
      id,
      name: `📐 معايير: ${s.departmentAr}`,
      sector: 'cross-sector',
      companySize: 'enterprise',
      artifactKind: 'policy_manual',
      summary: `معايير ${s.departmentAr}: ${[...s.iso, ...s.frameworks].slice(0, 5).join('، ')}. ${s.useCase}`,
      content: standardToContent(s),
      embedding: await embedText(`${s.departmentAr} ${formatStandardsForPrompt(s)}`),
      tags,
      createdAt: new Date().toISOString(),
    };
    await setDoc(doc(db, C_PROJECTS, id), clean(rec));
    added++;
  }
  return { added, total: STANDARDS_MAP.length };
}

const SIZE_RANK: Record<string, number> = { small: 0, medium: 1, large: 2, enterprise: 3 };

/** Blended match: vector similarity + contextual fit (sector/size/kind). */
export async function matchProjects(
  need: string,
  ctx: { sector?: string; size?: string; kind?: string },
  projects: ReferenceProject[],
  k = 5,
  signal?: AbortSignal,
): Promise<MatchResult[]> {
  const qv = await embedText(need, signal);
  const results: MatchResult[] = projects.map(pr => {
    const vectorScore = qv.length && pr.embedding?.length
      ? cosine(qv, pr.embedding)
      : lexicalScore(need, `${pr.name} ${pr.summary} ${pr.tags.join(' ')}`);

    let contextScore = 0; const reasons: string[] = [];
    if (ctx.sector && pr.sector && pr.sector.toLowerCase() === ctx.sector.toLowerCase()) {
      contextScore += 0.5; reasons.push(`نفس القطاع (${pr.sector})`);
    }
    if (ctx.size && pr.companySize) {
      const d = Math.abs((SIZE_RANK[ctx.size] ?? 1) - (SIZE_RANK[pr.companySize] ?? 1));
      const s = Math.max(0, 0.3 - d * 0.1);
      contextScore += s;
      if (d === 0) reasons.push(`نفس الحجم (${pr.companySize})`);
    }
    if (ctx.kind && pr.artifactKind && String(pr.artifactKind).includes(ctx.kind)) {
      contextScore += 0.2; reasons.push('نفس نوع المخرَج');
    }
    contextScore = Math.min(1, contextScore);
    const score = 0.65 * vectorScore + 0.35 * contextScore;
    return {
      project: pr, score, vectorScore, contextScore,
      rationale: reasons.length ? reasons.join('، ') : 'تشابه دلالي في المحتوى',
    };
  });
  return results.sort((a, b) => b.score - a.score).slice(0, k);
}

// ---- Diagrams (Mermaid + React Flow graph), tenant-scoped --------------------

export async function saveDiagram(d: GovDiagram): Promise<void> {
  d.updatedAt = Date.now();
  await setDoc(doc(db, C_DIAGRAMS, d.id), clean(d));
}

export async function loadDiagrams(tenantId: string): Promise<GovDiagram[]> {
  const q = query(collection(db, C_DIAGRAMS), where('tenantId', '==', tenantId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data() as GovDiagram).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function deleteDiagram(id: string): Promise<void> {
  await deleteDoc(doc(db, C_DIAGRAMS, id)).catch(() => {});
}

// ---- Generated documents library (versioned, reopen / re-export) ------------

export async function saveGovDocument(d: GovDocumentRecord): Promise<void> {
  d.updatedAt = new Date().toISOString();
  await setDoc(doc(db, C_DOCS, d.id), clean(d));
}

export async function loadGovDocuments(tenantId: string): Promise<GovDocumentRecord[]> {
  const q = query(collection(db, C_DOCS), where('tenantId', '==', tenantId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data() as GovDocumentRecord)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// Read a single library document by id (HWK-D3 reviewer view). Reads are
// admin-gated by firestore.rules, so the caller must be a signed-in admin.
export async function getGovDocument(docId: string): Promise<GovDocumentRecord | null> {
  const snap = await getDoc(doc(db, C_DOCS, docId));
  if (!snap.exists()) return null;
  return snap.data() as GovDocumentRecord;
}

export async function deleteGovDocument(id: string): Promise<void> {
  await deleteDoc(doc(db, C_DOCS, id)).catch(() => {});
}

// ---- Model snapshots (merge-on-rebuild / rollback / diff) --------------------

export async function saveSnapshot(s: GovModelSnapshot): Promise<void> {
  await setDoc(doc(db, C_SNAPSHOTS, s.id), clean(s));
  // keep only the latest 20 snapshots per tenant
  await pruneSnapshots(s.tenantId, 20).catch(() => {});
}

export async function loadSnapshots(tenantId: string): Promise<GovModelSnapshot[]> {
  const q = query(collection(db, C_SNAPSHOTS), where('tenantId', '==', tenantId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data() as GovModelSnapshot)
    .sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}

export async function pruneSnapshots(tenantId: string, keep = 20): Promise<void> {
  const all = await loadSnapshots(tenantId);
  const stale = all.slice(keep);
  if (!stale.length) return;
  for (let i = 0; i < stale.length; i += 450) {
    const batch = writeBatch(db);
    stale.slice(i, i + 450).forEach(s => batch.delete(doc(db, C_SNAPSHOTS, s.id)));
    await batch.commit();
  }
}

export async function deleteSnapshot(id: string): Promise<void> {
  await deleteDoc(doc(db, C_SNAPSHOTS, id)).catch(() => {});
}

// ---- Tenant teardown (privacy / re-ingest) ----------------------------------

export async function purgeTenant(tenantId: string): Promise<void> {
  for (const col of [C_CHUNKS, C_NODES, C_EDGES]) {
    const snap = await getDocs(query(collection(db, col), where('tenantId', '==', tenantId)));
    for (let i = 0; i < snap.docs.length; i += 450) {
      const batch = writeBatch(db);
      snap.docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }
  await deleteDoc(doc(db, C_MODELS, tenantId)).catch(() => {});
}

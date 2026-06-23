// Agentic model-editing — the assistant proposes structured GovActions from a
// natural-language instruction; the user reviews; applyActions mutates the model
// deterministically (pure, client-side). Every applied batch appends an audit entry.

import { Type } from '@google/genai';
import { generateJson } from './agentOrchestrator';
import type {
  CompanyGovernanceModel, GovAction, Language, GovAuditEntry,
  GovOrgUnit, GovRole, GovPolicy, GovProcedure, GovAuthority, GovKpi,
  GovCommittee, GovMeeting,
} from '../types';

let _ac = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(_ac++).toString(36)}`;
const norm = (s: string) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();

const actionSchema = {
  type: Type.OBJECT,
  properties: {
    actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING }, // add_unit|add_role|add_policy|add_procedure|add_authority|add_kpi|add_committee|add_meeting|set_assessment|edit_unit|edit_role|edit_policy|edit_procedure|edit_authority|edit_kpi|remove
          target: { type: Type.STRING },
          kind: { type: Type.STRING },
          name: { type: Type.STRING },
          title: { type: Type.STRING },
          unit: { type: Type.STRING },
          policy: { type: Type.STRING },
          role: { type: Type.STRING },
          domain: { type: Type.STRING },
          mandate: { type: Type.STRING },
          purpose: { type: Type.STRING },
          body: { type: Type.STRING },
          steps: { type: Type.ARRAY, items: { type: Type.STRING } },
          responsibilities: { type: Type.ARRAY, items: { type: Type.STRING } },
          decision: { type: Type.STRING },
          level: { type: Type.STRING },
          formula: { type: Type.STRING },
          target_value: { type: Type.STRING },
          rationale: { type: Type.STRING },
          // KPI enrichment
          weight: { type: Type.NUMBER },
          frequency: { type: Type.STRING },
          measurementMethod: { type: Type.STRING },
          rewards: { type: Type.STRING },
          // Authority financial DoA
          threshold: { type: Type.STRING },
          limit: { type: Type.STRING },
          // Role JD
          managerialLevel: { type: Type.STRING },
          summary: { type: Type.STRING },
          qualifications: {
            type: Type.OBJECT,
            properties: {
              education: { type: Type.STRING },
              experience: { type: Type.STRING },
              certifications: { type: Type.STRING },
            },
          },
          skills: {
            type: Type.OBJECT,
            properties: {
              technical: { type: Type.ARRAY, items: { type: Type.STRING } },
              soft: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
          },
          relations: {
            type: Type.OBJECT,
            properties: {
              reportsTo: { type: Type.STRING },
              supervises: { type: Type.ARRAY, items: { type: Type.STRING } },
              interactsWith: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
          },
          responsibilityGroups: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                theme: { type: Type.STRING },
                items: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
            },
          },
          // Unit interconnection
          feeds: { type: Type.ARRAY, items: { type: Type.STRING } },
          dependsOn: { type: Type.ARRAY, items: { type: Type.STRING } },
          objective: { type: Type.STRING },
          // Committee / meeting
          members: { type: Type.ARRAY, items: { type: Type.STRING } },
          cadence: { type: Type.STRING },
          attendees: { type: Type.ARRAY, items: { type: Type.STRING } },
          // Assessment payload (full object)
          assessment: { type: Type.OBJECT, properties: {} },
        },
        required: ['type'],
      },
    },
  },
  required: ['actions'],
};

function modelDigest(m: CompanyGovernanceModel): string {
  return [
    `الوحدات: ${(m.orgUnits || []).map(u => u.name).join('، ') || '—'}`,
    `الأدوار: ${(m.roles || []).map(r => r.title).join('، ') || '—'}`,
    `السياسات: ${(m.policies || []).map(p => p.title).join('، ') || '—'}`,
    `الإجراءات: ${(m.procedures || []).map(p => p.title).join('، ') || '—'}`,
  ].join('\n');
}

/** Ask the LLM to translate an instruction into reviewable structured actions. */
export async function proposeModelActions(
  instruction: string,
  model: CompanyGovernanceModel,
  language?: Language,
  signal?: AbortSignal,
): Promise<GovAction[]> {
  const ar = (language || 'ar') === 'ar';
  const sys = ar
    ? `أنت محرّر نموذج حوكمة. حوّل تعليمات المستخدم إلى عمليات منظّمة (actions) على النموذج الحالي دون تنفيذها. استخدم أسماء الوحدات/السياسات/الأدوار كما هي في النموذج للربط. لا تخترع كيانات غير مطلوبة.\n\nالنموذج الحالي:\n${modelDigest(model)}`
    : `You convert the user's instruction into structured model actions (no execution). Reference existing unit/policy/role names for linking.\n\nCurrent model:\n${modelDigest(model)}`;

  const prompt = ar
    ? `التعليمات: "${instruction}"\nأعد JSON: { actions: [...] }. الأنواع المتاحة: add_unit (مع feeds/dependsOn/objective اختياري), add_role (وصف وظيفي كامل: managerialLevel, summary, responsibilities, responsibilityGroups, qualifications{education,experience,certifications}, skills{technical[],soft[]}, relations{reportsTo,supervises[],interactsWith[]}), add_policy, add_procedure, add_authority (مع threshold/limit للصلاحيات المالية), add_kpi (مع weight 0-100, frequency, measurementMethod, rewards, role للربط), add_committee (name, members[], mandate, cadence), add_meeting (kind=type عبر name, purpose, frequency, attendees[]), set_assessment (assessment object), edit_unit, edit_role, edit_policy, edit_procedure, edit_authority, edit_kpi, remove. لكل عملية أضف rationale قصير.`
    : `Instruction: "${instruction}"\nReturn JSON { actions:[...] }. Types: add_unit, add_role (full JD), add_policy, add_procedure, add_authority (threshold/limit), add_kpi (weight/frequency/measurementMethod/rewards/role), add_committee, add_meeting, set_assessment, edit_unit, edit_role, edit_policy, edit_procedure, edit_authority, edit_kpi, remove.`;

  try {
    const res = await generateJson<{ actions: GovAction[] }>(prompt, actionSchema, { systemInstruction: sys, signal, temperature: 0.2 });
    return (res.actions || []).filter(a => a && a.type);
  } catch {
    return [];
  }
}

export interface ApplyResult {
  model: CompanyGovernanceModel;
  applied: number;
  skipped: string[];
}

/** Deterministically apply reviewed actions to a deep-cloned model. */
export function applyActions(
  model: CompanyGovernanceModel,
  actions: GovAction[],
  actor = 'ai',
): ApplyResult {
  const m: CompanyGovernanceModel = JSON.parse(JSON.stringify(model));
  if (!m.orgUnits) m.orgUnits = []; if (!m.roles) m.roles = [];
  if (!m.policies) m.policies = []; if (!m.procedures) m.procedures = [];
  if (!m.authorities) m.authorities = []; if (!m.kpis) m.kpis = [];
  if (!m.committees) m.committees = []; if (!m.meetings) m.meetings = [];
  if (!m.auditLog) m.auditLog = [];

  const findUnit = (name?: string) => name ? m.orgUnits.find(u => norm(u.name) === norm(name)) : undefined;
  const findRole = (title?: string) => title ? m.roles.find(r => norm(r.title) === norm(title)) : undefined;
  const findPolicy = (title?: string) => title ? m.policies.find(p => norm(p.title) === norm(title)) : undefined;
  const findProc = (title?: string) => title ? m.procedures.find(p => norm(p.title) === norm(title)) : undefined;
  const findAuth = (decision?: string) => decision ? m.authorities.find(x => norm(x.decision) === norm(decision)) : undefined;
  const findKpi = (name?: string) => name ? m.kpis.find(x => norm(x.name) === norm(name)) : undefined;
  const findCommittee = (name?: string) => name ? m.committees!.find(c => norm(c.name) === norm(name)) : undefined;

  const skipped: string[] = [];
  let applied = 0;
  const details: string[] = [];

  for (const a of actions) {
    try {
      switch (a.type) {
        case 'add_unit': {
          if (!a.name) { skipped.push('add_unit بلا اسم'); break; }
          if (findUnit(a.name)) { skipped.push(`الوحدة "${a.name}" موجودة`); break; }
          const u: GovOrgUnit = { id: uid('unit'), name: a.name, mandate: a.mandate || '', parentId: findUnit(a.unit)?.id, provenance: [] };
          if (a.objective) u.objective = a.objective;
          if (a.feeds?.length) u.feeds = a.feeds;
          if (a.dependsOn?.length) u.dependsOn = a.dependsOn;
          m.orgUnits.push(u); applied++; details.push(`+وحدة ${a.name}`); break;
        }
        case 'add_role': {
          if (!a.title) { skipped.push('add_role بلا مسمى'); break; }
          const r: GovRole = { id: uid('role'), title: a.title, unitId: findUnit(a.unit)?.id || '', purpose: a.purpose || '', responsibilities: a.responsibilities || [], provenance: [] };
          if (a.managerialLevel) r.managerialLevel = a.managerialLevel;
          if (a.summary) r.summary = a.summary;
          if (a.responsibilityGroups?.length) r.responsibilityGroups = a.responsibilityGroups;
          if (a.qualifications) r.qualifications = a.qualifications;
          if (a.skills) r.skills = a.skills;
          if (a.relations) r.relations = a.relations;
          m.roles.push(r); applied++; details.push(`+دور ${a.title}`); break;
        }
        case 'add_policy': {
          if (!a.title) { skipped.push('add_policy بلا عنوان'); break; }
          if (findPolicy(a.title)) { skipped.push(`السياسة "${a.title}" موجودة`); break; }
          const p: GovPolicy = { id: uid('pol'), title: a.title, domain: a.domain || 'عام', body: a.body || '', status: 'draft', provenance: [] };
          m.policies.push(p); applied++; details.push(`+سياسة ${a.title}`); break;
        }
        case 'add_procedure': {
          if (!a.title) { skipped.push('add_procedure بلا عنوان'); break; }
          const steps = a.steps || [];
          const pr: GovProcedure = {
            id: uid('proc'), title: a.title, unitId: findUnit(a.unit)?.id, policyId: findPolicy(a.policy)?.id,
            purpose: a.purpose || '', steps, body: a.body || (steps.length ? steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : ''),
            status: 'draft', provenance: [],
          };
          m.procedures.push(pr); applied++; details.push(`+إجراء ${a.title}`); break;
        }
        case 'add_authority': {
          if (!a.decision) { skipped.push('add_authority بلا قرار'); break; }
          const role = findRole(a.role);
          const au: GovAuthority = { id: uid('auth'), decision: a.decision, roleId: role?.id || '', level: (a.level as any) || 'approve', provenance: [] };
          if (a.threshold) au.threshold = a.threshold;
          if (a.limit) au.limit = a.limit;
          m.authorities.push(au); applied++; details.push(`+صلاحية ${a.decision}`); break;
        }
        case 'add_kpi': {
          if (!a.name) { skipped.push('add_kpi بلا اسم'); break; }
          const k: GovKpi = { id: uid('kpi'), name: a.name, unitId: findUnit(a.unit)?.id, formula: a.formula || '', target: a.target_value || '', provenance: [] };
          const krole = findRole(a.role); if (krole) k.roleId = krole.id;
          if (typeof a.weight === 'number') k.weight = a.weight;
          if (a.frequency) k.frequency = a.frequency;
          if (a.measurementMethod) k.measurementMethod = a.measurementMethod;
          if (a.rewards) k.rewards = a.rewards;
          m.kpis.push(k); applied++; details.push(`+مؤشر ${a.name}`); break;
        }
        case 'add_committee': {
          if (!a.name) { skipped.push('add_committee بلا اسم'); break; }
          if (findCommittee(a.name)) { skipped.push(`اللجنة "${a.name}" موجودة`); break; }
          const c: GovCommittee = { id: uid('cmt'), name: a.name, members: a.members || [], mandate: a.mandate || a.purpose || '', cadence: a.cadence || a.frequency, provenance: [] };
          m.committees!.push(c); applied++; details.push(`+لجنة ${a.name}`); break;
        }
        case 'add_meeting': {
          const mtype = a.name || a.title;
          if (!mtype) { skipped.push('add_meeting بلا نوع'); break; }
          const mt: GovMeeting = { id: uid('mtg'), type: mtype, purpose: a.purpose || a.mandate || '', frequency: a.frequency || a.cadence || '', attendees: a.attendees || a.members || [] };
          m.meetings!.push(mt); applied++; details.push(`+اجتماع ${mtype}`); break;
        }
        case 'set_assessment': {
          if (!a.assessment) { skipped.push('set_assessment بلا بيانات'); break; }
          const asmt: any = JSON.parse(JSON.stringify(a.assessment));
          if (!asmt.id) asmt.id = uid('asmt');
          if (!asmt.tenantId) asmt.tenantId = m.tenantId;
          if (!asmt.createdAt) asmt.createdAt = Date.now();
          m.assessment = asmt; applied++; details.push('~تقييم النضج'); break;
        }
        case 'edit_authority': {
          const au = a.target ? m.authorities.find(x => x.id === a.target) : findAuth(a.decision);
          if (!au) { skipped.push('صلاحية غير موجودة للتعديل'); break; }
          if (a.decision) au.decision = a.decision; if (a.level) au.level = a.level as any;
          if (a.threshold) au.threshold = a.threshold; if (a.limit) au.limit = a.limit;
          if (a.role) au.roleId = findRole(a.role)?.id || au.roleId; applied++; details.push(`~صلاحية ${au.decision}`); break;
        }
        case 'edit_kpi': {
          const k = a.target ? m.kpis.find(x => x.id === a.target) : findKpi(a.name);
          if (!k) { skipped.push('مؤشر غير موجود للتعديل'); break; }
          if (a.name) k.name = a.name; if (a.formula) k.formula = a.formula;
          if (a.target_value) k.target = a.target_value;
          if (typeof a.weight === 'number') k.weight = a.weight;
          if (a.frequency) k.frequency = a.frequency;
          if (a.measurementMethod) k.measurementMethod = a.measurementMethod;
          if (a.rewards) k.rewards = a.rewards;
          if (a.role) k.roleId = findRole(a.role)?.id || k.roleId;
          if (a.unit) k.unitId = findUnit(a.unit)?.id || k.unitId; applied++; details.push(`~مؤشر ${k.name}`); break;
        }
        case 'edit_unit': {
          const u = a.target ? m.orgUnits.find(x => x.id === a.target) : findUnit(a.name || a.title);
          if (!u) { skipped.push(`وحدة غير موجودة للتعديل`); break; }
          if (a.name) u.name = a.name; if (a.mandate) u.mandate = a.mandate;
          if (a.unit) u.parentId = findUnit(a.unit)?.id; applied++; details.push(`~وحدة ${u.name}`); break;
        }
        case 'edit_role': {
          const r = a.target ? m.roles.find(x => x.id === a.target) : findRole(a.title);
          if (!r) { skipped.push('دور غير موجود للتعديل'); break; }
          if (a.title) r.title = a.title; if (a.purpose) r.purpose = a.purpose;
          if (a.unit) r.unitId = findUnit(a.unit)?.id || r.unitId;
          if (a.responsibilities) r.responsibilities = a.responsibilities; applied++; details.push(`~دور ${r.title}`); break;
        }
        case 'edit_policy': {
          const p = a.target ? m.policies.find(x => x.id === a.target) : findPolicy(a.title);
          if (!p) { skipped.push('سياسة غير موجودة للتعديل'); break; }
          if (a.title) p.title = a.title; if (a.domain) p.domain = a.domain; if (a.body) p.body = a.body; applied++; details.push(`~سياسة ${p.title}`); break;
        }
        case 'edit_procedure': {
          const pr = a.target ? m.procedures.find(x => x.id === a.target) : findProc(a.title);
          if (!pr) { skipped.push('إجراء غير موجود للتعديل'); break; }
          if (a.title) pr.title = a.title; if (a.purpose) pr.purpose = a.purpose; if (a.body) pr.body = a.body;
          if (a.steps) pr.steps = a.steps;
          if (a.policy) pr.policyId = findPolicy(a.policy)?.id || pr.policyId;
          if (a.unit) pr.unitId = findUnit(a.unit)?.id || pr.unitId; applied++; details.push(`~إجراء ${pr.title}`); break;
        }
        case 'remove': {
          const kind = a.kind; const id = a.target;
          if (!kind || !id) { skipped.push('remove بلا kind/target'); break; }
          const arrName = ({ unit: 'orgUnits', role: 'roles', policy: 'policies', procedure: 'procedures', authority: 'authorities', kpi: 'kpis', committee: 'committees', meeting: 'meetings' } as const)[kind];
          if (!arrName) { skipped.push('نوع غير معروف للحذف'); break; }
          const arr = (m as any)[arrName] as { id: string }[];
          const i = arr.findIndex(x => x.id === id);
          if (i < 0) { skipped.push('العنصر غير موجود للحذف'); break; }
          arr.splice(i, 1); applied++; details.push(`-${kind}`); break;
        }
        default: skipped.push(`نوع غير مدعوم: ${a.type}`);
      }
    } catch (e: any) {
      skipped.push(`خطأ في ${a.type}: ${e?.message || e}`);
    }
  }

  if (applied > 0) {
    const entry: GovAuditEntry = { id: uid('aud'), at: new Date().toISOString(), actor, action: 'apply_actions', detail: details.join('، ').slice(0, 400) };
    m.auditLog!.push(entry);
  }
  return { model: m, applied, skipped };
}

export function appendAudit(model: CompanyGovernanceModel, actor: string, action: string, detail: string): CompanyGovernanceModel {
  const m: CompanyGovernanceModel = JSON.parse(JSON.stringify(model));
  if (!m.auditLog) m.auditLog = [];
  m.auditLog.push({ id: uid('aud'), at: new Date().toISOString(), actor, action, detail: detail.slice(0, 400) });
  return m;
}

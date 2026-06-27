// Governance integrity engine — pure functions over CompanyGovernanceModel.
// No network, no Firestore. Analyzes structural soundness, maturity, coverage,
// merges a freshly-built model into an edited one (preserving manual edits),
// and traces a single entity through the whole governance chain.

import type {
  CompanyGovernanceModel, IntegrityIssue, IntegrityKind, MaturityReport,
  MaturityDomain, CoverageRow, TraceChain, ProvenanceRef,
} from '../types';

let _vc = 0;
const iid = () => `iss_${(_vc++).toString(36)}`;

const norm = (s: string) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// ---------------------------------------------------------------------------
// Integrity analysis
// ---------------------------------------------------------------------------
export function analyzeIntegrity(m: CompanyGovernanceModel): IntegrityIssue[] {
  const out: IntegrityIssue[] = [];
  const roles = m.roles || [];
  const units = m.orgUnits || [];
  const policies = m.policies || [];
  const procedures = m.procedures || [];
  const authorities = m.authorities || [];
  const kpis = m.kpis || [];
  const gaps = m.gaps || [];

  const unitIds = new Set(units.map(u => u.id));
  const roleIds = new Set(roles.map(r => r.id));
  const policyIds = new Set(policies.map(p => p.id));

  // orphan role: no owning unit (or unit missing)
  for (const r of roles) {
    if (!r.unitId || !unitIds.has(r.unitId)) {
      out.push({ id: iid(), kind: 'orphan_role', severity: 'high',
        message: `الدور "${r.title}" غير مرتبط بوحدة تنظيمية.`,
        entityKind: 'role', entityId: r.id, fixHint: 'اربطه بوحدة في الكانفاس أو عدّل unitId.' });
    }
  }

  // authority without a valid holder role
  for (const a of authorities) {
    if (!a.roleId || !roleIds.has(a.roleId)) {
      out.push({ id: iid(), kind: 'authority_no_holder', severity: 'high',
        message: `الصلاحية "${a.decision}" بلا دور حامل.`,
        entityKind: 'authority', entityId: a.id, fixHint: 'عيّن دوراً يحمل هذه الصلاحية.' });
    }
  }

  // decision with no "approve"-level authority (governance weakness)
  const approveByDecision = new Map<string, number>();
  for (const a of authorities) {
    if (a.level === 'approve') approveByDecision.set(norm(a.decision), (approveByDecision.get(norm(a.decision)) || 0) + 1);
  }
  // RACI duplicate approver: same decision approved by >1 role
  for (const [dec, n] of approveByDecision) {
    if (n > 1) {
      const sample = authorities.find(a => norm(a.decision) === dec);
      out.push({ id: iid(), kind: 'authority_dup_approver', severity: 'medium',
        message: `القرار "${sample?.decision || dec}" له ${n} جهات اعتماد — ازدواج صلاحية.`,
        entityKind: 'authority', entityId: sample?.id, fixHint: 'وحّد جهة الاعتماد النهائية.' });
    }
  }
  // decisions referenced but never approved
  const seenDecisions = new Set(authorities.map(a => norm(a.decision)));
  for (const dec of seenDecisions) {
    if (!approveByDecision.has(dec)) {
      const sample = authorities.find(a => norm(a.decision) === dec);
      out.push({ id: iid(), kind: 'decision_no_approver', severity: 'medium',
        message: `القرار "${sample?.decision || dec}" بلا جهة اعتماد (approve).`,
        entityKind: 'authority', entityId: sample?.id, fixHint: 'أضف صلاحية approve لهذا القرار.' });
    }
  }

  // procedure with no governing policy
  for (const pr of procedures) {
    if (!pr.policyId || !policyIds.has(pr.policyId)) {
      out.push({ id: iid(), kind: 'procedure_no_policy', severity: 'medium',
        message: `الإجراء "${pr.title}" لا يستند إلى سياسة.`,
        entityKind: 'procedure', entityId: pr.id, fixHint: 'اربطه بسياسة حاكمة.' });
    }
  }

  // policy with no operationalizing procedure
  const policiesWithProc = new Set(procedures.map(pr => pr.policyId).filter(Boolean) as string[]);
  for (const p of policies) {
    if (!policiesWithProc.has(p.id)) {
      out.push({ id: iid(), kind: 'policy_no_procedure', severity: 'medium',
        message: `السياسة "${p.title}" بلا إجراء تشغيلي يفعّلها.`,
        entityKind: 'policy', entityId: p.id, fixHint: 'ولّد إجراءً من حلقة سد الفجوات.' });
    }
  }

  // unit with no roles
  const unitsWithRoles = new Set(roles.map(r => r.unitId).filter(Boolean) as string[]);
  for (const u of units) {
    if (!unitsWithRoles.has(u.id)) {
      out.push({ id: iid(), kind: 'unit_no_roles', severity: 'low',
        message: `الوحدة "${u.name}" بلا أدوار معرّفة.`,
        entityKind: 'unit', entityId: u.id, fixHint: 'أضف أدواراً للوحدة.' });
    }
  }

  // kpi with no owner (unit OR role)
  for (const k of kpis) {
    const ownedByUnit = k.unitId && unitIds.has(k.unitId);
    const ownedByRole = k.roleId && roleIds.has(k.roleId);
    if (!ownedByUnit && !ownedByRole) {
      out.push({ id: iid(), kind: 'kpi_no_owner', severity: 'low',
        message: `المؤشر "${k.name}" بلا جهة مالكة.`,
        entityKind: 'kpi', entityId: k.id, fixHint: 'عيّن وحدة أو دوراً مالكاً للمؤشر.' });
    }
  }

  // per-role KPI weights should sum to ~100%
  const roleKpiWeights = new Map<string, number>();
  for (const k of kpis) {
    if (k.roleId && typeof k.weight === 'number') {
      roleKpiWeights.set(k.roleId, (roleKpiWeights.get(k.roleId) || 0) + k.weight);
    }
  }
  for (const [rid, sum] of roleKpiWeights) {
    if (Math.abs(sum - 100) > 1) {
      const r = roles.find(x => x.id === rid);
      out.push({ id: iid(), kind: 'kpi_weight_sum', severity: 'medium',
        message: `أوزان مؤشرات الدور "${r?.title || rid}" تجمع ${sum}% بدلاً من 100%.`,
        entityKind: 'role', entityId: rid, fixHint: 'اضبط الأوزان النسبية لتجمع 100%.' });
    }
  }

  // role missing job-description essentials
  for (const r of roles) {
    if (!r.summary && (!r.responsibilities || !r.responsibilities.length) && !r.responsibilityGroups?.length) {
      out.push({ id: iid(), kind: 'role_no_jd', severity: 'low',
        message: `الدور "${r.title}" بلا وصف وظيفي (ملخص/مهام).`,
        entityKind: 'role', entityId: r.id, fixHint: 'ولّد الوصف الوظيفي للدور.' });
    }
  }

  // role with no KPI (neither role-owned nor unit-owned)
  const rolesWithKpi = new Set(kpis.map(k => k.roleId).filter(Boolean) as string[]);
  for (const r of roles) {
    const unitHasKpi = kpis.some(k => k.unitId === r.unitId);
    if (!rolesWithKpi.has(r.id) && !unitHasKpi) {
      out.push({ id: iid(), kind: 'role_no_kpi', severity: 'low',
        message: `الدور "${r.title}" بلا مؤشرات أداء.`,
        entityKind: 'role', entityId: r.id, fixHint: 'أضف KPIs للدور.' });
    }
  }

  // financial decisions with no DoA threshold
  const FIN = /(صرف|اعتماد|عقد|موازنة|ميزانية|شراء|مشتريات|دفع|مالي)/;
  for (const a of authorities) {
    if (a.level === 'approve' && FIN.test(a.decision) && !a.threshold) {
      out.push({ id: iid(), kind: 'authority_no_threshold', severity: 'medium',
        message: `صلاحية اعتماد مالية "${a.decision}" بلا سقف تفويض.`,
        entityKind: 'authority', entityId: a.id, fixHint: 'حدّد سقف الصرف/التفويض المالي.' });
    }
  }

  // isolated unit: no workflow links while others exist
  if (units.length > 1) {
    for (const u of units) {
      const hasLinks = (u.feeds && u.feeds.length) || (u.dependsOn && u.dependsOn.length);
      const referenced = units.some(o => (o.feeds || []).includes(u.id) || (o.dependsOn || []).includes(u.id));
      if (!hasLinks && !referenced) {
        out.push({ id: iid(), kind: 'unit_isolated', severity: 'low',
          message: `الوحدة "${u.name}" معزولة عن دورة العمل (لا تُغذّي ولا تعتمد على غيرها).`,
          entityKind: 'unit', entityId: u.id, fixHint: 'اربطها في مصفوفة الترابط.' });
      }
    }
  }

  // governance bodies / assessment presence
  if (!(m.committees && m.committees.length)) {
    out.push({ id: iid(), kind: 'no_committee', severity: 'low',
      message: 'لا توجد لجنة حوكمة معرّفة.', fixHint: 'أضف لجنة حوكمة (المدير العام + المالي + المشاريع).' });
  }
  if (!m.assessment) {
    out.push({ id: iid(), kind: 'no_assessment', severity: 'low',
      message: 'لا يوجد تقييم نضج مؤسسي مسجّل.', fixHint: 'شغّل موديول التقييم (CMMI + SWOT).' });
  }

  // duplicate titles within a kind
  const dupCheck = (arr: { id: string; title?: string; name?: string }[], kind: IntegrityIssue['entityKind'], label: string) => {
    const seen = new Map<string, string>();
    for (const x of arr) {
      const key = norm(x.title || x.name || '');
      if (!key) continue;
      if (seen.has(key)) {
        out.push({ id: iid(), kind: 'duplicate_title', severity: 'low',
          message: `${label} مكرر بنفس الاسم: "${x.title || x.name}".`,
          entityKind: kind, entityId: x.id, fixHint: 'وحّد العنصرين أو غيّر التسمية.' });
      } else seen.set(key, x.id);
    }
  };
  dupCheck(units as any, 'unit', 'وحدة');
  dupCheck(roles as any, 'role', 'دور');
  dupCheck(policies as any, 'policy', 'سياسة');
  dupCheck(procedures as any, 'procedure', 'إجراء');

  // open gaps
  for (const g of gaps) {
    if (!g.resolved) {
      out.push({ id: iid(), kind: 'gap_open',
        severity: (['low', 'medium', 'high', 'critical'].includes(g.severity) ? g.severity : 'medium') as IntegrityIssue['severity'],
        message: `فجوة مفتوحة: ${g.area} — ${g.description}`,
        entityKind: 'gap', entityId: g.id, fixHint: 'استخدم زر "ولّد الإصلاح" لإغلاقها.' });
    }
  }

  const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
}

// ---------------------------------------------------------------------------
// Maturity score (per governance domain + overall)
// ---------------------------------------------------------------------------
function label(score: number): string {
  if (score >= 85) return 'محسّن';
  if (score >= 70) return 'مُدار';
  if (score >= 50) return 'مُحدَّد';
  if (score >= 30) return 'ناشئ';
  return 'مبدئي';
}

/** @param sentimentAvg optional mean document tone (-1..+1) from chunk sentiment (ج4).
 *  When provided, an "التبني والرضا" domain is added — negative tone drags overall
 *  maturity down even when structure looks complete on paper (adoption risk). */
export function maturity(m: CompanyGovernanceModel, issues?: IntegrityIssue[], sentimentAvg?: number): MaturityReport {
  const iss = issues || analyzeIntegrity(m);
  const units = m.orgUnits || [], roles = m.roles || [], policies = m.policies || [];
  const procedures = m.procedures || [], authorities = m.authorities || [], kpis = m.kpis || [];
  const gaps = m.gaps || [];

  const ratio = (a: number, b: number) => (b <= 0 ? 0 : Math.min(1, a / b));
  const pct = (x: number) => Math.round(x * 100);

  // structure: units have roles
  const unitsWithRoles = new Set(roles.map(r => r.unitId).filter(Boolean) as string[]);
  const structure = units.length ? pct(ratio(units.filter(u => unitsWithRoles.has(u.id)).length, units.length)) : 0;

  // policy coverage: policies have a procedure
  const policiesWithProc = new Set(procedures.map(pr => pr.policyId).filter(Boolean) as string[]);
  const policyDomain = policies.length ? pct(ratio(policies.filter(p => policiesWithProc.has(p.id)).length, policies.length)) : 0;

  // process: procedures linked to a policy
  const procDomain = procedures.length ? pct(ratio(procedures.filter(pr => pr.policyId).length, procedures.length)) : (policies.length ? 0 : 30);

  // authority: decisions have an approver
  const decisions = new Set(authorities.map(a => norm(a.decision)));
  const approved = new Set(authorities.filter(a => a.level === 'approve').map(a => norm(a.decision)));
  const authDomain = decisions.size ? pct(ratio([...decisions].filter(d => approved.has(d)).length, decisions.size)) : 0;

  // measurement: KPIs exist & owned
  const kpiDomain = kpis.length ? pct(ratio(kpis.filter(k => k.unitId).length, kpis.length)) : 0;

  // gap closure
  const gapDomain = gaps.length ? pct(ratio(gaps.filter(g => g.resolved).length, gaps.length)) : 100;

  // governance bodies + assessment + meeting cadence
  let govScore = 0;
  if (m.committees && m.committees.length) govScore += 40;
  if (m.meetings && m.meetings.length) govScore += 25;
  if (m.assessment) govScore += 35;
  const govDomain = Math.min(100, govScore);

  const domains: MaturityDomain[] = [
    { domain: 'الهيكل التنظيمي', score: structure, label: label(structure) },
    { domain: 'السياسات', score: policyDomain, label: label(policyDomain) },
    { domain: 'الإجراءات', score: procDomain, label: label(procDomain) },
    { domain: 'الصلاحيات', score: authDomain, label: label(authDomain) },
    { domain: 'المؤشرات', score: kpiDomain, label: label(kpiDomain) },
    { domain: 'إغلاق الفجوات', score: gapDomain, label: label(gapDomain) },
    { domain: 'الحوكمة والاجتماعات', score: govDomain, label: label(govDomain) },
  ];

  // ج4 — adoption/sentiment domain (only when tone signal is available).
  if (typeof sentimentAvg === 'number' && !Number.isNaN(sentimentAvg)) {
    const adoption = Math.max(0, Math.min(100, Math.round(((sentimentAvg + 1) / 2) * 100)));
    domains.push({ domain: 'التبني والرضا', score: adoption, label: label(adoption) });
  }

  const overall = Math.round(domains.reduce((s, d) => s + d.score, 0) / domains.length);
  const critical = iss.filter(i => i.severity === 'critical').length;

  return { overall, label: label(overall), domains, issueCount: iss.length, critical };
}

// ---------------------------------------------------------------------------
// Coverage matrix (per unit)
// ---------------------------------------------------------------------------
export function coverageMatrix(m: CompanyGovernanceModel): CoverageRow[] {
  const rows: CoverageRow[] = (m.orgUnits || []).map(u => {
    const roles = (m.roles || []).filter(r => r.unitId === u.id);
    const roleIds = new Set(roles.map(r => r.id));
    const procedures = (m.procedures || []).filter(p => p.unitId === u.id);
    const kpis = (m.kpis || []).filter(k => k.unitId === u.id);
    // policies touched by this unit's procedures
    const polIds = new Set(procedures.map(p => p.policyId).filter(Boolean) as string[]);
    const authorities = (m.authorities || []).filter(a => roleIds.has(a.roleId));
    return {
      unitId: u.id, unitName: u.name,
      roles: roles.length, policies: polIds.size, procedures: procedures.length,
      kpis: kpis.length, authorities: authorities.length,
    };
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Merge a freshly rebuilt model into the current (edited) one.
// Preserves manual edits: matches by normalized title/name; keeps existing ids,
// edited bodies/status; adds genuinely-new entities; never silently drops a
// manually-added entity. Returns the merged model (version untouched here).
// ---------------------------------------------------------------------------
export interface MergeStats { added: number; updated: number; kept: number; }

export function mergeModels(
  current: CompanyGovernanceModel,
  fresh: CompanyGovernanceModel,
): { model: CompanyGovernanceModel; stats: MergeStats } {
  const stats: MergeStats = { added: 0, updated: 0, kept: 0 };
  const out: CompanyGovernanceModel = JSON.parse(JSON.stringify(current));

  // --- units (by name) ---
  const unitByName = new Map(out.orgUnits.map(u => [norm(u.name), u]));
  const freshUnitIdToCur = new Map<string, string>(); // fresh.id → current.id
  for (const fu of fresh.orgUnits) {
    const ex = unitByName.get(norm(fu.name));
    if (ex) {
      freshUnitIdToCur.set(fu.id, ex.id);
      // enrich mandate only if current empty
      if (!ex.mandate && fu.mandate) { ex.mandate = fu.mandate; stats.updated++; }
      ex.provenance = mergeProv(ex.provenance, fu.provenance);
      stats.kept++;
    } else {
      const nu = { ...fu };
      freshUnitIdToCur.set(fu.id, nu.id);
      unitByName.set(norm(nu.name), nu);
      out.orgUnits.push(nu);
      stats.added++;
    }
  }
  // remap fresh unit parentIds via name
  out.orgUnits.forEach(u => {
    if (u.parentId && freshUnitIdToCur.has(u.parentId)) u.parentId = freshUnitIdToCur.get(u.parentId);
  });

  // --- roles (by title) ---
  const roleByTitle = new Map(out.roles.map(r => [norm(r.title), r]));
  for (const fr of fresh.roles) {
    const ex = roleByTitle.get(norm(fr.title));
    const mappedUnit = fr.unitId ? (freshUnitIdToCur.get(fr.unitId) || fr.unitId) : '';
    if (ex) {
      if (!ex.unitId && mappedUnit) ex.unitId = mappedUnit;
      if ((!ex.responsibilities || !ex.responsibilities.length) && fr.responsibilities?.length) ex.responsibilities = fr.responsibilities;
      ex.provenance = mergeProv(ex.provenance, fr.provenance);
      stats.kept++;
    } else {
      out.roles.push({ ...fr, unitId: mappedUnit });
      roleByTitle.set(norm(fr.title), out.roles[out.roles.length - 1]);
      stats.added++;
    }
  }

  // --- policies (by title) ---
  const polByTitle = new Map(out.policies.map(p => [norm(p.title), p]));
  const freshPolIdToCur = new Map<string, string>();
  for (const fp of fresh.policies) {
    const ex = polByTitle.get(norm(fp.title));
    if (ex) {
      freshPolIdToCur.set(fp.id, ex.id);
      if (!ex.body && fp.body) { ex.body = fp.body; stats.updated++; }
      ex.provenance = mergeProv(ex.provenance, fp.provenance);
      stats.kept++;
    } else {
      out.policies.push({ ...fp });
      freshPolIdToCur.set(fp.id, fp.id);
      polByTitle.set(norm(fp.title), out.policies[out.policies.length - 1]);
      stats.added++;
    }
  }

  // --- procedures (by title) ---
  const procByTitle = new Map((out.procedures || []).map(p => [norm(p.title), p]));
  if (!out.procedures) out.procedures = [];
  for (const fpr of fresh.procedures || []) {
    const ex = procByTitle.get(norm(fpr.title));
    const mappedUnit = fpr.unitId ? (freshUnitIdToCur.get(fpr.unitId) || fpr.unitId) : undefined;
    const mappedPol = fpr.policyId ? (freshPolIdToCur.get(fpr.policyId) || fpr.policyId) : undefined;
    if (ex) {
      if (!ex.unitId && mappedUnit) ex.unitId = mappedUnit;
      if (!ex.policyId && mappedPol) ex.policyId = mappedPol;
      // keep edited body; only seed if current empty
      if (!ex.body && fpr.body) { ex.body = fpr.body; stats.updated++; }
      if ((!ex.steps || !ex.steps.length) && fpr.steps?.length) ex.steps = fpr.steps;
      ex.provenance = mergeProv(ex.provenance, fpr.provenance);
      stats.kept++;
    } else {
      out.procedures.push({ ...fpr, unitId: mappedUnit, policyId: mappedPol });
      procByTitle.set(norm(fpr.title), out.procedures[out.procedures.length - 1]);
      stats.added++;
    }
  }

  // --- authorities (by decision+role) — additive ---
  if (!out.authorities) out.authorities = [];
  const authKey = (d: string, r: string) => `${norm(d)}|${r}`;
  const authSeen = new Set(out.authorities.map(a => authKey(a.decision, a.roleId)));
  for (const fa of fresh.authorities || []) {
    const mappedRole = fa.roleId; // fresh authorities rarely produced; keep id
    if (!authSeen.has(authKey(fa.decision, mappedRole))) {
      out.authorities.push({ ...fa });
      authSeen.add(authKey(fa.decision, mappedRole));
      stats.added++;
    } else stats.kept++;
  }

  // --- kpis (by name) — additive ---
  if (!out.kpis) out.kpis = [];
  const kpiByName = new Map(out.kpis.map(k => [norm(k.name), k]));
  for (const fk of fresh.kpis || []) {
    if (!kpiByName.has(norm(fk.name))) {
      out.kpis.push({ ...fk });
      kpiByName.set(norm(fk.name), out.kpis[out.kpis.length - 1]);
      stats.added++;
    } else stats.kept++;
  }

  // --- gaps (by area) — keep resolved; add new open ones ---
  if (!out.gaps) out.gaps = []; // legacy/partial models may omit gaps (cf. kpis/committees above)
  const gapByArea = new Map(out.gaps.map(g => [norm(g.area), g]));
  for (const fg of fresh.gaps || []) {
    const ex = gapByArea.get(norm(fg.area));
    if (ex) { stats.kept++; continue; } // never reopen a resolved/edited gap
    out.gaps.push({ ...fg });
    gapByArea.set(norm(fg.area), out.gaps[out.gaps.length - 1]);
    stats.added++;
  }

  // --- committees (by name) — additive ---
  if (!out.committees) out.committees = [];
  const commByName = new Map(out.committees.map(c => [norm(c.name), c]));
  for (const fc of fresh.committees || []) {
    if (!commByName.has(norm(fc.name))) { out.committees.push({ ...fc }); commByName.set(norm(fc.name), fc); stats.added++; }
    else stats.kept++;
  }
  // --- meetings (by type) — additive ---
  if (!out.meetings) out.meetings = [];
  const meetByType = new Map(out.meetings.map(mt => [norm(mt.type), mt]));
  for (const fm of fresh.meetings || []) {
    if (!meetByType.has(norm(fm.type))) { out.meetings.push({ ...fm }); meetByType.set(norm(fm.type), fm); stats.added++; }
    else stats.kept++;
  }
  // --- assessment: keep current if present, else take fresh ---
  if (!out.assessment && fresh.assessment) { out.assessment = fresh.assessment; stats.updated++; }

  out.companyName = current.companyName || fresh.companyName;
  return { model: out, stats };
}

function mergeProv(a?: ProvenanceRef[], b?: ProvenanceRef[]): ProvenanceRef[] {
  const seen = new Set<string>();
  const out: ProvenanceRef[] = [];
  for (const r of [...(a || []), ...(b || [])]) {
    const key = `${r.kind}|${r.refId}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Traceability — follow one entity through the whole chain
// ---------------------------------------------------------------------------
export function traceEntity(
  m: CompanyGovernanceModel,
  kind: 'unit' | 'role' | 'policy' | 'procedure',
  id: string,
): TraceChain | null {
  const units = m.orgUnits || [], roles = m.roles || [], policies = m.policies || [];
  const procedures = m.procedures || [], authorities = m.authorities || [], kpis = m.kpis || [];

  const roleTitle = (rid: string) => roles.find(r => r.id === rid)?.title || rid;
  const base: TraceChain = {
    rootKind: kind, rootId: id, rootLabel: '',
    roles: [], procedures: [], authorities: [], kpis: [], gaps: [], sources: [],
  };

  if (kind === 'unit') {
    const u = units.find(x => x.id === id); if (!u) return null;
    base.rootLabel = u.name; base.unit = { id: u.id, name: u.name };
    const unitRoles = roles.filter(r => r.unitId === u.id);
    base.roles = unitRoles.map(r => ({ id: r.id, title: r.title }));
    base.procedures = procedures.filter(p => p.unitId === u.id).map(p => ({ id: p.id, title: p.title }));
    base.kpis = kpis.filter(k => k.unitId === u.id).map(k => ({ name: k.name, target: k.target }));
    const roleIds = new Set(unitRoles.map(r => r.id));
    base.authorities = authorities.filter(a => roleIds.has(a.roleId)).map(a => ({ decision: a.decision, level: a.level, role: roleTitle(a.roleId) }));
    base.sources = u.provenance || [];
  } else if (kind === 'role') {
    const r = roles.find(x => x.id === id); if (!r) return null;
    base.rootLabel = r.title;
    const u = units.find(x => x.id === r.unitId);
    if (u) base.unit = { id: u.id, name: u.name };
    base.roles = [{ id: r.id, title: r.title }];
    base.authorities = authorities.filter(a => a.roleId === r.id).map(a => ({ decision: a.decision, level: a.level, role: r.title }));
    base.procedures = procedures.filter(p => p.unitId === r.unitId).map(p => ({ id: p.id, title: p.title }));
    base.sources = r.provenance || [];
  } else if (kind === 'policy') {
    const p = policies.find(x => x.id === id); if (!p) return null;
    base.rootLabel = p.title; base.policy = { id: p.id, title: p.title };
    base.procedures = procedures.filter(pr => pr.policyId === p.id).map(pr => ({ id: pr.id, title: pr.title }));
    const unitIds = new Set(base.procedures.map(pr => procedures.find(x => x.id === pr.id)?.unitId).filter(Boolean) as string[]);
    base.roles = roles.filter(r => unitIds.has(r.unitId)).map(r => ({ id: r.id, title: r.title }));
    base.sources = p.provenance || [];
  } else {
    const pr = procedures.find(x => x.id === id); if (!pr) return null;
    base.rootLabel = pr.title;
    const u = units.find(x => x.id === pr.unitId);
    if (u) base.unit = { id: u.id, name: u.name };
    const pol = policies.find(x => x.id === pr.policyId);
    if (pol) base.policy = { id: pol.id, title: pol.title };
    base.procedures = [{ id: pr.id, title: pr.title }];
    base.roles = roles.filter(r => r.unitId === pr.unitId).map(r => ({ id: r.id, title: r.title }));
    base.sources = pr.provenance || [];
  }

  base.gaps = (m.gaps || [])
    .filter(g => !g.resolved && norm(g.area + ' ' + g.description).includes(norm(base.rootLabel)))
    .map(g => ({ area: g.area, severity: g.severity }));

  return base;
}

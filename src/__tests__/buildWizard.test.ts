import { describe, it, expect } from 'vitest';
import {
  isExplicitBuild,
  shouldOpenBuildWizard,
  isDocCreationRequest,
  isLongFormRequest,
  needsWebResearch,
  fallbackBuildPlan,
  mergeProposalIntoFallback,
  planToBuildRequest,
  planToPayload,
  currentStateDigest,
  addPlanItem,
  removePlanItem,
  toggleComponent,
  clampPlanPages,
  DEFAULT_GOV_AXES,
  type BuildPlan,
} from '../../services/governanceChat';
import type { CompanyGovernanceModel } from '../../types';

// ===========================================================================
//  V5 + V16 — the conversational build wizard (pure logic).
//
//  The copilot must propose an EDITABLE plan before generating and let the user
//  change page count / axes / departments / components / notes, and the CONFIRMED
//  plan must be what actually drives generation. These tests pin that contract on
//  the pure half (no React, no network) so the wizard's behavior is independent
//  of the UI.
// ===========================================================================

// A tiny model with two org units (the wizard seeds departments from these).
const model = {
  companyName: 'شركة المقاولات',
  orgUnits: [
    { id: 'u1', name: 'المالية', mandate: '', provenance: [] },
    { id: 'u2', name: 'الموارد البشرية', mandate: '', provenance: [] },
  ],
  roles: [], policies: [], procedures: [], gaps: [],
} as unknown as CompanyGovernanceModel;

describe('isExplicitBuild — opens the wizard on explicit build commands', () => {
  it('matches the owner phrasings', () => {
    expect(isExplicitBuild('ابنِ الهيكل التنظيمي')).toBe(true);
    expect(isExplicitBuild('ابدأ البناء')).toBe(true);
    expect(isExplicitBuild('ولّد الكل')).toBe(true);
    expect(isExplicitBuild('start building the model')).toBe(true);
    expect(isExplicitBuild('generate all departments')).toBe(true);
  });
  it('ignores plain Q&A / empty input', () => {
    expect(isExplicitBuild('ما هي سياسة تضارب المصالح؟')).toBe(false);
    expect(isExplicitBuild('hello')).toBe(false);
    expect(isExplicitBuild('')).toBe(false);
    expect(isExplicitBuild(null)).toBe(false);
  });
  // P5/D4b — «الهيكل التنظيمي» ("the org structure") used to be a BARE
  // alternative, so a pure QUESTION about the structure was hijacked into the
  // build-plan card, contradicting V27. It must require an actual construction
  // verb alongside the noun.
  it('a QUESTION mentioning the org structure is NOT an explicit build (D4b)', () => {
    expect(isExplicitBuild('ما رأيك في الهيكل التنظيمي الحالي؟')).toBe(false);
    expect(isExplicitBuild('هل الهيكل التنظيمي يحتاج تعديلاً؟')).toBe(false);
    expect(isExplicitBuild('لماذا الهيكل التنظيمي معقد جداً؟')).toBe(false);
    // Addendum — confirmed repros from independent verification: an explanation
    // request and a comparison question, neither carrying a build verb.
    expect(isExplicitBuild('اشرح لي الهيكل التنظيمي لشركتنا')).toBe(false);
    expect(isExplicitBuild('ما الفرق بين الهيكل التنظيمي الوظيفي والمصفوفي؟')).toBe(false);
  });
  it('a build verb + the org structure IS an explicit build (D4b)', () => {
    expect(isExplicitBuild('اعمل الهيكل التنظيمي من جديد')).toBe(true);
    expect(isExplicitBuild('أنشئ الهيكل التنظيمي للشركة')).toBe(true);
    expect(isExplicitBuild('صمّم الهيكل التنظيمي المناسب')).toBe(true);
    expect(isExplicitBuild('ابنِ الهيكل التنظيمي')).toBe(true);   // unaffected bare-verb match
    expect(isExplicitBuild('ولّد الهيكل التنظيمي من النموذج')).toBe(true);   // addendum: ولّد was missing
  });
});

describe('isDocCreationRequest — genuine document-creation commands (P5/D4a)', () => {
  it('matches a creation verb + a document noun', () => {
    expect(isDocCreationRequest('اكتب لي دليل حوكمة كامل')).toBe(true);
    expect(isDocCreationRequest('أنشئ سياسة تضارب المصالح')).toBe(true);
    expect(isDocCreationRequest('جهّز تقريراً شاملاً عن الامتثال')).toBe(true);
    expect(isDocCreationRequest('write a complete governance manual')).toBe(true);
  });
  it('rejects questions, even ones that mention a document type', () => {
    expect(isDocCreationRequest('ما رأيك في هذه السياسة؟')).toBe(false);
    expect(isDocCreationRequest('هل التقرير الحالي كافٍ؟')).toBe(false);
    expect(isDocCreationRequest('ما هي أفضل ممارسات الحوكمة؟')).toBe(false);
  });
  it('rejects a creation verb with no document noun, and empty/null input', () => {
    expect(isDocCreationRequest('اكتب')).toBe(false);
    expect(isDocCreationRequest('')).toBe(false);
    expect(isDocCreationRequest(null)).toBe(false);
  });
});

describe('isLongFormRequest — replaces the old bare-noun LONG_RE (P5 addendum, D3/D4a boundary)', () => {
  it('the reported false-positive: a plain yes/no question with a bare noun must NOT be long-form', () => {
    // Confirmed repro: this used to match the old LONG_RE via «سياسة» alone
    // (no verb, no authoring intent) and hijacked the draftStream-vs-ask branch
    // into a 7-8 min /draft for what is just a quick grounded question.
    expect(isLongFormRequest('هل عندنا سياسة لتضارب المصالح؟')).toBe(false);
  });
  it('other bare-noun questions stay short too', () => {
    expect(isLongFormRequest('ما هي أفضل ممارسات الحوكمة؟')).toBe(false);
    expect(isLongFormRequest('هل التقرير الحالي كافٍ؟')).toBe(false);
  });
  it('a genuine authoring command (verb + document noun) IS long-form', () => {
    expect(isLongFormRequest('اكتب لي دليل حوكمة كامل')).toBe(true);
    expect(isLongFormRequest('أنشئ سياسة تضارب المصالح')).toBe(true);
  });
  it('an explicit page/length count alone IS long-form, even with no verb/noun', () => {
    expect(isLongFormRequest('أعطني ذلك في 10 صفحات')).toBe(true);
    expect(isLongFormRequest('اكتب عشر صفحات عن الموضوع')).toBe(true);
  });
  it('a continuation/expansion command alone IS long-form (extends an already-open document)', () => {
    expect(isLongFormRequest('كمّل')).toBe(true);
    expect(isLongFormRequest('أطول من فضلك')).toBe(true);
    expect(isLongFormRequest('continue')).toBe(true);
  });
  it('is false for empty/null input', () => {
    expect(isLongFormRequest('')).toBe(false);
    expect(isLongFormRequest(null)).toBe(false);
  });
});

describe('needsWebResearch — gates the (unbounded-length-risk) web-research path (P5/D3)', () => {
  it('the reported false-positive case: an ordinary doc request must NOT hijack', () => {
    // "دولي" used to match as a substring of "الدولية"; "أفضل الممارسات" was ALSO
    // a standalone match on its own — both are removed now.
    expect(needsWebResearch('اكتب دليل حوكمة وفق أفضل الممارسات الدولية في 10 صفحات')).toBe(false);
    expect(needsWebResearch('اكتب سياسة معايير دولية للشركة')).toBe(false);
    expect(needsWebResearch('write a policy following international best practices')).toBe(false);
  });
  it('still fires for genuine recency/current-facts/market signals', () => {
    expect(needsWebResearch('ابحث في الويب عن أحدث الاتجاهات')).toBe(true);
    expect(needsWebResearch('أعدّ تقريراً عن حالة السوق ٢٠٢٦')).toBe(true);
    expect(needsWebResearch('قارن بيننا وبين المنافسين بالإحصائيات')).toBe(true);
    expect(needsWebResearch('write a report on the latest market trends in 2026')).toBe(true);
  });
  it('is false for a plain request with no research signal', () => {
    expect(needsWebResearch('اكتب سياسة تضارب المصالح')).toBe(false);
    expect(needsWebResearch('')).toBe(false);
    expect(needsWebResearch(null)).toBe(false);
  });
});

describe('shouldOpenBuildWizard — conversational by default (V27)', () => {
  // CONVERSATIONAL MODE (the new default): wizardOn = false. The wizard opens
  // ONLY on a clear, explicit build command; everything else — including a
  // long-doc ask — flows to the normal grounded conversation/draft path.
  it('keeps conversation: a normal question never opens the wizard', () => {
    expect(shouldOpenBuildWizard({ wizardOn: false, text: 'ما هي أفضل ممارسات الحوكمة؟', longForm: false })).toBe(false);
  });
  // P5/D4a — V27 stays the default, but with ONE deliberate, narrow exception:
  // a genuine long document-CREATION command ("اكتب لي دليل حوكمة كامل") must
  // still open the quick-to-confirm plan card even with the wizard OFF — this
  // was V5's exact complaint (a silent 7-8 min autonomous draft with zero
  // chance to adjust scope/length/departments). A long QUESTION/analysis ask
  // that merely mentions a document type stays fully conversational.
  it('a long doc-CREATION command opens the plan even with the wizard OFF (D4a)', () => {
    // "اكتب سياسة تضارب المصالح كاملة" trips the broad long-form heuristic AND is
    // a genuine creation command (اكتب + سياسة, not a question) → must open.
    expect(shouldOpenBuildWizard({ wizardOn: false, text: 'اكتب سياسة تضارب المصالح كاملة', longForm: true })).toBe(true);
    expect(shouldOpenBuildWizard({ wizardOn: false, text: 'اكتب لي دليل حوكمة كامل', longForm: true })).toBe(true);
  });
  it('keeps conversation: a long QUESTION/analysis ask stays conversational (D4a)', () => {
    // Long + mentions a document type, but phrased as a question → not a
    // creation command → stays conversational even with longForm true.
    expect(shouldOpenBuildWizard({ wizardOn: false, text: 'ما رأيك في هذه السياسة الحالية وهل تحتاج تعديلاً؟', longForm: true })).toBe(false);
    // Long + no creation verb at all (pure analysis ask).
    expect(shouldOpenBuildWizard({ wizardOn: false, text: 'حلل لي فجوات الحوكمة الحالية بالتفصيل', longForm: true })).toBe(false);
  });
  it('still honors explicit build intent even in conversational mode', () => {
    expect(shouldOpenBuildWizard({ wizardOn: false, text: 'ابدأ البناء', longForm: false })).toBe(true);
    expect(shouldOpenBuildWizard({ wizardOn: false, text: 'ابنِ الهيكل التنظيمي', longForm: false })).toBe(true);
  });

  // WIZARD MODE (opt-in): wizardOn = true restores the V5/V16 behavior — any
  // long-form/document request OR an explicit build opens the editable plan.
  it('wizard ON: a long-form/document request opens the plan', () => {
    expect(shouldOpenBuildWizard({ wizardOn: true, text: 'اكتب سياسة تضارب المصالح كاملة', longForm: true })).toBe(true);
  });
  it('wizard ON: an explicit build still opens the plan', () => {
    expect(shouldOpenBuildWizard({ wizardOn: true, text: 'ابدأ البناء', longForm: false })).toBe(true);
  });
  it('wizard ON: a plain short question is left as conversation', () => {
    expect(shouldOpenBuildWizard({ wizardOn: true, text: 'ما هو تعريف الحوكمة؟', longForm: false })).toBe(false);
  });
});

describe('fallbackBuildPlan — a complete editable plan with no model call', () => {
  it('seeds departments from the model org units', () => {
    const plan = fallbackBuildPlan({ request: 'ابنِ دليل الحوكمة', model });
    expect(plan.departments).toEqual(['المالية', 'الموارد البشرية']);
    expect(plan.axes).toEqual(DEFAULT_GOV_AXES);
    expect(plan.components.length).toBeGreaterThan(0);
    expect(plan.components.every(c => c.include)).toBe(true);
    expect(plan.title.length).toBeGreaterThan(0);
  });

  it('honors a stated page count (V4) and clamps it', () => {
    expect(fallbackBuildPlan({ request: 'اكتب دليل في 10 صفحات' }).targetPages).toBe(10);
    // no count → a modest default, never a runaway
    expect(fallbackBuildPlan({ request: 'اكتب دليل كامل' }).targetPages).toBe(12);
  });

  it('works with no model (departments empty, user adds them)', () => {
    const plan = fallbackBuildPlan({ request: 'دليل حوكمة', model: null });
    expect(plan.departments).toEqual([]);
  });
});

describe('plan list edits — add / remove departments & axes (V16)', () => {
  it('addPlanItem trims and de-duplicates', () => {
    expect(addPlanItem(['المالية'], '  المالية ')).toEqual(['المالية']);
    expect(addPlanItem(['المالية'], 'المشتريات')).toEqual(['المالية', 'المشتريات']);
  });
  it('removePlanItem is space/case-insensitive', () => {
    expect(removePlanItem(['المالية', 'المشتريات'], ' المالية ')).toEqual(['المشتريات']);
    expect(removePlanItem(['Finance'], 'finance')).toEqual([]);
  });
  it('toggleComponent flips only the targeted component', () => {
    const comps = [
      { id: 'a', title: 'A', include: true },
      { id: 'b', title: 'B', include: true },
    ];
    const next = toggleComponent(comps, 'a');
    expect(next.find(c => c.id === 'a')!.include).toBe(false);
    expect(next.find(c => c.id === 'b')!.include).toBe(true);
  });
  it('clampPlanPages keeps the count in 1..120', () => {
    expect(clampPlanPages(0)).toBe(1);
    expect(clampPlanPages(9999)).toBe(120);
    expect(clampPlanPages(10.6)).toBe(11);
    expect(clampPlanPages(NaN)).toBe(1);
  });
});

describe('mergeProposalIntoFallback — AI proposal never corrupts the plan', () => {
  it('a null/garbage proposal yields the deterministic fallback', () => {
    const fb = fallbackBuildPlan({ request: 'دليل', model });
    expect(mergeProposalIntoFallback(fb, null)).toBe(fb);
    expect(mergeProposalIntoFallback(fb, undefined)).toBe(fb);
  });
  it('a valid proposal is merged, deduped and clamped', () => {
    const fb = fallbackBuildPlan({ request: 'دليل', model });
    const merged = mergeProposalIntoFallback(fb, {
      title: '  دليل حوكمة المقاولات  ',
      targetPages: 999,
      axes: ['القيادة', 'القيادة', 'المخاطر'],
      departments: ['المشتريات'],          // folded in on top of the model units
      components: ['ملخص', 'النطاق'],
      audience: 'العميل',
    });
    expect(merged.title).toBe('دليل حوكمة المقاولات');
    expect(merged.targetPages).toBe(120);                       // clamped
    expect(merged.axes).toEqual(['القيادة', 'المخاطر']);        // deduped
    expect(merged.departments).toEqual(['المالية', 'الموارد البشرية', 'المشتريات']);
    expect(merged.components.map(c => c.title)).toEqual(['ملخص', 'النطاق']);
    expect(merged.components.every(c => c.include)).toBe(true);
  });
});

describe('planToBuildRequest — the confirmed plan drives generation (V5)', () => {
  const base: BuildPlan = {
    title: 'دليل الحوكمة',
    targetPages: 8,
    axes: ['القيادة', 'المخاطر'],
    departments: ['المالية', 'المشتريات'],
    components: [
      { id: 'a', title: 'ملخص تنفيذي', include: true },
      { id: 'b', title: 'الإجراءات', include: true },
      { id: 'c', title: 'ملاحق', include: false },   // excluded → must not appear
    ],
    notes: 'استخدم مصطلحات قطاع المقاولات.',
    audience: 'مجلس الإدارة',
  };

  it('embeds the stated page count so V4 honors the same length', () => {
    const req = planToBuildRequest(base, 'ar');
    expect(req).toContain('8 صفحة');
  });

  it('lists only INCLUDED components', () => {
    const req = planToBuildRequest(base, 'ar');
    expect(req).toContain('ملخص تنفيذي');
    expect(req).toContain('الإجراءات');
    expect(req).not.toContain('ملاحق');
  });

  it('carries departments, axes and mandatory notes into the request', () => {
    const req = planToBuildRequest(base, 'ar');
    expect(req).toContain('المالية');
    expect(req).toContain('المشتريات');
    expect(req).toContain('القيادة');
    expect(req).toContain('استخدم مصطلحات قطاع المقاولات.');
  });

  it('English variant renders cleanly', () => {
    const req = planToBuildRequest({ ...base, title: 'Manual' }, 'en');
    expect(req).toContain('Manual');
    expect(req).toContain('about 8 page');
    expect(req).toContain('Mandatory owner notes');
  });
});

describe('planToPayload — the confirmed plan as the backend structured `plan` field (P5/D1)', () => {
  const base: BuildPlan = {
    title: 'دليل الحوكمة',
    targetPages: 8,
    axes: ['القيادة', 'القيادة', 'المخاطر'],   // duplicate on purpose
    departments: ['المالية', 'المشتريات'],
    components: [
      { id: 'a', title: 'ملخص تنفيذي', include: true },
      { id: 'b', title: 'الإجراءات', include: true },
      { id: 'c', title: 'ملاحق', include: false },   // excluded → must not appear
    ],
    notes: '  استخدم مصطلحات قطاع المقاولات.  ',
    audience: 'مجلس الإدارة',
  };

  it('maps every field onto the backend shape {title, pages, axes, departments, components, notes}', () => {
    const payload = planToPayload(base);
    expect(payload).toEqual({
      title: 'دليل الحوكمة',
      pages: 8,
      axes: ['القيادة', 'المخاطر'],
      departments: ['المالية', 'المشتريات'],
      components: ['ملخص تنفيذي', 'الإجراءات'],
      notes: 'استخدم مصطلحات قطاع المقاولات.',
    });
  });

  it('clamps pages and never includes an excluded component', () => {
    const payload = planToPayload({ ...base, targetPages: 9999 });
    expect(payload.pages).toBe(120);
    expect(payload.components).not.toContain('ملاحق');
  });

  it('agrees with planToBuildRequest — the structured payload and the prose fallback never disagree', () => {
    const payload = planToPayload(base);
    const prose = planToBuildRequest(base, 'ar');
    for (const dept of payload.departments) expect(prose).toContain(dept);
    for (const axis of payload.axes) expect(prose).toContain(axis);
    for (const comp of payload.components) expect(prose).toContain(comp);
  });
});

describe('currentStateDigest — a bounded diagnostic digest for backend grounding (P5/D2)', () => {
  it('returns "" for a null/empty model — never invents a diagnosis', () => {
    expect(currentStateDigest(null)).toBe('');
    expect(currentStateDigest({ ...model, gaps: [] } as CompanyGovernanceModel)).toBe('');
  });

  it('summarizes the maturity assessment (overall + CMMI + dimensions)', () => {
    const withAssessment = {
      ...model,
      assessment: {
        id: 'a1', tenantId: 't1', overall: 42.6, cmmiLevel: '2 مُدار',
        dimensions: [{ name: 'القيادة', score: 55, label: 'متوسط' }],
        createdAt: '',
      },
    } as unknown as CompanyGovernanceModel;
    const digest = currentStateDigest(withAssessment, 'ar');
    expect(digest).toContain('43');            // rounded overall
    expect(digest).toContain('2 مُدار');
    expect(digest).toContain('القيادة');
  });

  it('summarizes open gaps by severity, excludes resolved ones, and caps the list', () => {
    const withGaps = {
      ...model,
      gaps: [
        { id: 'g1', area: 'الامتثال', description: 'فجوة حرجة في الامتثال', severity: 'critical', recommendation: '', matchedProjectIds: [], provenance: [] },
        { id: 'g2', area: 'الموارد', description: 'فجوة محلولة', severity: 'high', recommendation: '', matchedProjectIds: [], provenance: [], resolved: true },
        { id: 'g3', area: 'المخاطر', description: 'فجوة متوسطة', severity: 'medium', recommendation: '', matchedProjectIds: [], provenance: [] },
      ],
    } as unknown as CompanyGovernanceModel;
    const digest = currentStateDigest(withGaps, 'ar');
    expect(digest).toContain('حرجة 1');
    expect(digest).toContain('متوسطة 1');
    expect(digest).not.toContain('فجوة محلولة');   // resolved gap excluded entirely
    expect(digest.length).toBeLessThanOrEqual(3000);
  });
});

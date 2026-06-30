import { describe, it, expect } from 'vitest';
import {
  isExplicitBuild,
  shouldOpenBuildWizard,
  fallbackBuildPlan,
  mergeProposalIntoFallback,
  planToBuildRequest,
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
});

describe('shouldOpenBuildWizard — conversational by default (V27)', () => {
  // CONVERSATIONAL MODE (the new default): wizardOn = false. The wizard opens
  // ONLY on a clear, explicit build command; everything else — including a
  // long-doc ask — flows to the normal grounded conversation/draft path.
  it('keeps conversation: a normal question never opens the wizard', () => {
    expect(shouldOpenBuildWizard({ wizardOn: false, text: 'ما هي أفضل ممارسات الحوكمة؟', longForm: false })).toBe(false);
  });
  it('keeps conversation: a long-doc ask is NOT forced into a build plan', () => {
    // "اكتب سياسة كاملة" trips the broad long-form heuristic but is not an
    // explicit build → in conversational mode it must stay a normal reply/draft.
    expect(shouldOpenBuildWizard({ wizardOn: false, text: 'اكتب سياسة تضارب المصالح كاملة', longForm: true })).toBe(false);
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

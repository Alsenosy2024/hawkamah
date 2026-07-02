import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArtifactSection, CompanyGovernanceModel, GovComment } from '../../types';

// ===========================================================================
//  P9 — truthful AI comment-apply. Production bug: the owner pressed
//  «مراجعة وتطبيق التعليقات (AI)» in the review-comments panel; every open
//  comment (including ones asking to rename a TOC heading, e.g. "remove the
//  word سجل from «سجل المخاطر»") got stamped "AI-applied" and the doc version
//  bumped v17→v18, while the document text was byte-identical to v1.
//
//  Two compounding root causes, both fixed here:
//   1. editArtifact's per-section prompt hard-pinned the OLD section title —
//      a heading/TOC rename was structurally impossible to apply, no matter
//      how well the instruction was understood. resolveSectionTitle/
//      parseLeadingHeading let a real rename be detected and written back.
//   2. The caller (newDocVersion) trusted "editArtifact didn't throw" as
//      "it worked" — stamping EVERY open comment implemented and bumping the
//      version with zero verification that any text actually changed.
//      commentWasApplied/resolveApplyOutcome verify per comment.
//
//  pickEditTargets also gets a truncated-quote title match: a client's text
//  selection can cut a heading mid-word (e.g. "سجل المخاط" ⊂ "سجل المخاطر"),
//  so an anchored comment reliably targets the section it quotes.
// ===========================================================================

vi.mock('../../services/agentOrchestrator', () => ({
  streamChat: vi.fn(),
  generateJson: vi.fn(),
}));

import { streamChat } from '../../services/agentOrchestrator';
import {
  pickEditTargets, parseLeadingHeading, resolveSectionTitle,
  commentWasApplied, resolveApplyOutcome, editArtifact,
} from '../../services/governanceEngine';

const streamChatMock = vi.mocked(streamChat);

const sec = (id: string, title: string, content: string, status: ArtifactSection['status'] = 'done'): ArtifactSection =>
  ({ id, title, content, status });

// ─── pickEditTargets — truncated anchor-quote title matching ──────────────

describe('pickEditTargets — truncated quote matches its section title', () => {
  const sections = [
    sec('s1', 'سجل المخاطر', 'محتوى قسم سجل المخاطر...'),
    sec('s2', 'سياسة الموارد البشرية', 'محتوى آخر لا علاقة له...'),
  ];

  it('a text-selection quote cut mid-word ("سجل المخاط" ⊂ "سجل المخاطر") still targets the section', () => {
    const instruction = 'طبّق ملاحظات المراجعين:\n- في الفقرة التي تحتوي على: "سجل المخاط" — طبّق هذه الملاحظة: "قم بازاله كلمه سجل"';
    expect(pickEditTargets(sections, instruction)).toEqual([0]);
  });

  it('a single-word title truncated below the 3-char word-overlap floor still matches via the quote', () => {
    const singleWordSections = [sec('s1', 'المخاطر', 'محتوى')];
    // "المخا" alone would miss the old word-overlap heuristic (only word >=3
    // chars is "المخاطر" itself, which is NOT a substring of the truncated quote).
    const instruction = 'في الفقرة التي تحتوي على: "المخا" — أعد صياغته';
    expect(pickEditTargets(singleWordSections, instruction)).toEqual([0]);
  });

  it('an unrelated quote does not spuriously single out one section — falls back to the global revision', () => {
    // No title match (exact, overlap, or truncated-quote) → pickEditTargets's
    // existing "no explicit target" fallback: every non-empty section, not a
    // guess at the wrong one.
    const instruction = 'في الفقرة التي تحتوي على: "جدول الاجتماعات" — عدّل هذا';
    expect(pickEditTargets(sections, instruction)).toEqual([0, 1]);
  });

  it('exact (non-truncated) title mentions still match as before', () => {
    expect(pickEditTargets(sections, 'عدّل سياسة الموارد البشرية لإضافة بند جديد')).toEqual([1]);
  });

  it('no target anywhere → falls back to a global revision of every non-empty section', () => {
    expect(pickEditTargets(sections, 'حسّن الأسلوب العام للوثيقة')).toEqual([0, 1]);
  });
});

// ─── parseLeadingHeading / resolveSectionTitle — title-line parsing ───────

describe('parseLeadingHeading', () => {
  it('extracts the heading text from the first "## " line', () => {
    expect(parseLeadingHeading('## سجل المخاطر\n\nمحتوى القسم...')).toBe('سجل المخاطر');
  });

  it('strips wrapping quotes the model sometimes adds', () => {
    expect(parseLeadingHeading('## "سجل المخاطر"\nمحتوى')).toBe('سجل المخاطر');
    expect(parseLeadingHeading('## «سجل المخاطر»\nمحتوى')).toBe('سجل المخاطر');
  });

  it('only recognizes a heading on the very first line — a later "##" is a subsection, not a rename', () => {
    expect(parseLeadingHeading('مقدمة بلا عنوان\n## عنوان فرعي\nمحتوى')).toBeUndefined();
  });

  it('returns undefined when there is no leading heading at all', () => {
    expect(parseLeadingHeading('محتوى مباشر بلا عنوان')).toBeUndefined();
    expect(parseLeadingHeading('')).toBeUndefined();
  });
});

describe('resolveSectionTitle — rename detection', () => {
  it('a genuinely different leading heading is treated as a rename', () => {
    expect(resolveSectionTitle('سجل المخاطر', '## المخاطر\n\nمحتوى معدَّل...')).toBe('المخاطر');
  });

  it('the SAME heading (even with diacritic/whitespace noise) is NOT a rename — keeps the original title', () => {
    expect(resolveSectionTitle('سجل المخاطر', '##   سجل  المخاطر  \n\nمحتوى...')).toBeUndefined();
  });

  it('no leading heading in the model output → no rename (caller keeps the old title)', () => {
    expect(resolveSectionTitle('سجل المخاطر', 'محتوى بلا عنوان على الإطلاق')).toBeUndefined();
  });
});

// ─── commentWasApplied ──────────────────────────────────────────────────

const comment = (over: Partial<GovComment> = {}): GovComment =>
  ({ id: over.id || 'c1', at: '2026-01-01T00:00:00.000Z', author: 'عميل', text: 'قم بإزالة كلمة سجل', ...over });

describe('commentWasApplied — anchored comments', () => {
  it('true when the anchored quote no longer appears in the section that carried it', () => {
    const before = [sec('s1', 'سجل المخاطر', 'مقدمة سجل المخاطر التفصيلي')];
    const after = [sec('s1', 'المخاطر', 'مقدمة المخاطر التفصيلي')];
    const c = comment({ anchor: { quote: 'سجل المخاطر' } });
    expect(commentWasApplied(c, before, after)).toBe(true);
  });

  it('false when the anchored quote is untouched (the reported no-op bug)', () => {
    const before = [sec('s1', 'سجل المخاطر', 'مقدمة سجل المخاطر التفصيلي')];
    const after = [sec('s1', 'سجل المخاطر', 'مقدمة سجل المخاطر التفصيلي')];   // byte-identical
    const c = comment({ anchor: { quote: 'سجل المخاطر' } });
    expect(commentWasApplied(c, before, after)).toBe(false);
  });

  it('false when the quote is not found in ANY section before the edit (stale/unresolvable anchor)', () => {
    const before = [sec('s1', 'عنوان آخر', 'محتوى لا علاقة له')];
    const after = [sec('s1', 'عنوان آخر معدَّل', 'محتوى مختلف تماماً')];
    const c = comment({ anchor: { quote: 'نص غير موجود إطلاقاً' } });
    expect(commentWasApplied(c, before, after)).toBe(false);
  });

  it('a section editArtifact marked failed is never counted as changed, even if the anchor text differs', () => {
    const before = [sec('s1', 'سجل المخاطر', 'مقدمة سجل المخاطر')];
    const after = [sec('s1', 'سجل المخاطر', 'نص مختلف تماماً', 'failed')];
    const c = comment({ anchor: { quote: 'سجل المخاطر' } });
    expect(commentWasApplied(c, before, after)).toBe(false);
  });
});

describe('commentWasApplied — unanchored (free-text) comments', () => {
  it('true when ANY section changed at all', () => {
    const before = [sec('s1', 'أ', 'محتوى أول'), sec('s2', 'ب', 'محتوى ثانٍ')];
    const after = [sec('s1', 'أ', 'محتوى أول'), sec('s2', 'ب', 'محتوى ثانٍ معدَّل')];
    expect(commentWasApplied(comment(), before, after)).toBe(true);
  });

  it('false when nothing changed anywhere', () => {
    const before = [sec('s1', 'أ', 'محتوى أول'), sec('s2', 'ب', 'محتوى ثانٍ')];
    const after = [sec('s1', 'أ', 'محتوى أول'), sec('s2', 'ب', 'محتوى ثانٍ')];
    expect(commentWasApplied(comment(), before, after)).toBe(false);
  });

  it('a title-only rename counts as a change', () => {
    const before = [sec('s1', 'سجل المخاطر', 'محتوى ثابت')];
    const after = [sec('s1', 'المخاطر', 'محتوى ثابت')];
    expect(commentWasApplied(comment(), before, after)).toBe(true);
  });
});

// ─── resolveApplyOutcome ────────────────────────────────────────────────

describe('resolveApplyOutcome', () => {
  it('bumps and marks only the comments that verifiably landed; the rest stay open', () => {
    const before = [sec('s1', 'سجل المخاطر', 'قديم'), sec('s2', 'لا تغيير', 'ثابت')];
    const after = [sec('s1', 'المخاطر', 'جديد'), sec('s2', 'لا تغيير', 'ثابت')];
    const applied = comment({ id: 'applied', anchor: { quote: 'سجل المخاطر' } });
    const notApplied = comment({ id: 'not-applied', anchor: { quote: 'لا تغيير' } });
    const outcome = resolveApplyOutcome(before, after, [applied, notApplied]);
    expect(outcome).toEqual({ bump: true, appliedIds: ['applied'], stillOpenIds: ['not-applied'] });
  });

  it('does not bump when NOTHING verifiably changed — the reported v18 no-op scenario', () => {
    const before = [sec('s1', 'سجل المخاطر', 'ثابت')];
    const after = [sec('s1', 'سجل المخاطر', 'ثابت')];
    const outcome = resolveApplyOutcome(before, after, [comment({ anchor: { quote: 'سجل المخاطر' } })]);
    expect(outcome.bump).toBe(false);
    expect(outcome.appliedIds).toEqual([]);
    expect(outcome.stillOpenIds).toEqual(['c1']);
  });

  it('bumps when every comment applied — none left open', () => {
    const before = [sec('s1', 'قديم', 'محتوى قديم')];
    const after = [sec('s1', 'جديد', 'محتوى جديد')];
    const outcome = resolveApplyOutcome(before, after, [comment()]);
    expect(outcome).toEqual({ bump: true, appliedIds: ['c1'], stillOpenIds: [] });
  });
});

// ─── editArtifact — end-to-end round-trip: rename lands, storage stays consistent ──

const minimalModel = (): CompanyGovernanceModel => ({
  tenantId: 't1', companyName: 'شركة الاختبار',
  orgUnits: [], roles: [], policies: [], procedures: [], authorities: [], kpis: [], gaps: [],
  updatedAt: '2026-01-01T00:00:00.000Z', version: 1,
} as unknown as CompanyGovernanceModel);

beforeEach(() => {
  streamChatMock.mockReset();
});

describe('editArtifact — heading rename round-trip (integration)', () => {
  it('a rename requested in the instruction updates section.title AND content still leads with the new heading (not stripped — matches how every other section stores its heading)', async () => {
    streamChatMock.mockImplementation(async (_req, cb) => {
      cb?.onAnswer?.('## المخاطر\n\nمحتوى القسم بعد إزالة الكلمة المطلوبة.');
      return '';
    });
    const artifact = {
      title: 'دليل الحوكمة', goal: 'اختبار', language: 'ar' as const,
      sections: [sec('s1', 'سجل المخاطر', 'محتوى قسم سجل المخاطر الأصلي.')],
      createdAt: new Date('2026-01-01'), complete: true,
    };
    const out = await editArtifact({
      artifact, model: minimalModel(),
      instruction: 'في الفقرة التي تحتوي على: "سجل المخاط" — قم بازاله كلمه سجل',
    });
    expect(out.sections[0].title).toBe('المخاطر');
    // content keeps embedding its own "## heading" line — same convention as
    // generateGovernanceDoc/generateGapFix — so the artifactToMarkdown/canvas
    // round-trip stays consistent for every section, edited or not.
    expect(out.sections[0].content.startsWith('## المخاطر')).toBe(true);
  });

  it('when the instruction does not ask for a rename, the title is left untouched even if unrelated wording shifts', async () => {
    streamChatMock.mockImplementation(async (_req, cb) => {
      cb?.onAnswer?.('## سجل المخاطر\n\nنص محدَّث بلا أي طلب لتغيير العنوان.');
      return '';
    });
    const artifact = {
      title: 'دليل الحوكمة', goal: 'اختبار', language: 'ar' as const,
      sections: [sec('s1', 'سجل المخاطر', 'محتوى أصلي.')],
      createdAt: new Date('2026-01-01'), complete: true,
    };
    const out = await editArtifact({
      artifact, model: minimalModel(),
      instruction: 'حسّن صياغة قسم سجل المخاطر دون تغيير العنوان',
    });
    expect(out.sections[0].title).toBe('سجل المخاطر');
  });
});

"""BE-1: honoring `target_pages` — the outline section cap + per-section token
budget math that stops "asked 10 pages → got ~100" — AND (P1/D3) the moderate
BOUNDED default used when no target_pages is given at all.

These are pure-math unit tests (no model calls): the previous bug was that the
per-section budget *multiplied* (every section got the whole-doc budget) while
the section count was uncapped, so total output = N_sections × full-doc budget.
The no-target_pages path had the SAME bug in a different guise: it fell back to
SETTINGS.gen_max_sections (40, effectively unbounded) for the outline AND a FLAT
SETTINGS.gen_section_tokens (8192) per section — 40 × 8192 ≈ unbounded regardless
of how small the ask was. That flat/unbounded fallback is intentionally no longer
pinned by this file; the tests below pin the NEW bounded default instead.
"""

from hawkama_copilot.config import SETTINGS
from hawkama_copilot.generation import (
    _DEFAULT_SECTIONS_CAP,
    _DEFAULT_TARGET_PAGES,
    _outline_cap,
    _section_token_budget,
    build_outline,
    generate_document,
)


# --------------------------------------------------------------------------- #
# Outline section-count cap                                                    #
# --------------------------------------------------------------------------- #
def test_outline_cap_bounded_default_when_no_target():
    # P1/D3 — an absent target_pages now falls back to a moderate fixed default
    # (never the old unbounded SETTINGS.gen_max_sections).
    assert _outline_cap(None) == _DEFAULT_SECTIONS_CAP
    assert _outline_cap(0) == _DEFAULT_SECTIONS_CAP
    assert _DEFAULT_SECTIONS_CAP < SETTINGS.gen_max_sections


def test_outline_cap_proportional_to_pages():
    # ~2 pages/section + a small constant for cover/TOC/sources.
    assert _outline_cap(10) == min(SETTINGS.gen_max_sections, max(3, round(10 / 2) + 2))
    assert _outline_cap(10) == 7


def test_outline_cap_has_floor_of_three():
    # Tiny documents still get at least a handful of sections.
    assert _outline_cap(1) == 3
    assert _outline_cap(2) == 3


def test_outline_cap_clamped_to_global_ceiling():
    # A huge ask never exceeds SETTINGS.gen_max_sections (the old uncapped default).
    assert _outline_cap(1000) == SETTINGS.gen_max_sections


# --------------------------------------------------------------------------- #
# Per-section token budget (divide, never multiply)                            #
# --------------------------------------------------------------------------- #
def test_section_budget_bounded_default_when_no_target():
    # P1/D3 — an absent target_pages used to return a FLAT SETTINGS.gen_section_tokens
    # (8192) per section regardless of section count — the root cause of "asked
    # small, got 105 pages" (up to 40 sections × 8192 ≈ unbounded). It now derives
    # from a moderate ASSUMED document length (_DEFAULT_TARGET_PAGES) and divides
    # that whole-doc budget across the actual section count, exactly like the
    # target_pages-given path does.
    whole_doc = int(_DEFAULT_TARGET_PAGES * 450 * 1.6)
    assert _section_token_budget(None) == max(1536, min(whole_doc, SETTINGS.gen_max_output_tokens))
    expected_7 = max(1536, min(whole_doc // 7, SETTINGS.gen_max_output_tokens))
    assert _section_token_budget(None, 7) == expected_7
    assert _section_token_budget(0, 7) == expected_7
    # Never the old flat per-section constant once there's more than one section.
    assert _section_token_budget(None, 7) != SETTINGS.gen_section_tokens


def test_section_budget_divides_whole_doc_across_sections():
    pages, n = 20, 8
    whole_doc = int(pages * 450 * 1.6)
    expected = max(1536, min(whole_doc // n, SETTINGS.gen_max_output_tokens))
    assert _section_token_budget(pages, n) == expected


def test_section_budget_no_blowup_vs_old_multiply():
    # Regression guard: total budget (per-section × sections) must stay close to
    # the whole-document budget, NOT N× it (the old bug).
    pages, n = 10, 7
    whole_doc = int(pages * 450 * 1.6)
    per = _section_token_budget(pages, n)
    total = per * n
    # The floor can lift a very fine split a little above whole_doc, but never
    # anywhere near the old N× (which for n=7 would have been ~7× whole_doc).
    assert total <= whole_doc * 3
    # The old code returned ~7200 tokens *per section* for 10 pages regardless of
    # the section count; the new value is far smaller once divided.
    assert per < int(pages * 450 * 1.6)


def test_section_budget_has_floor_and_ceiling():
    # Floor: a fine split never starves a section below 1536 tokens.
    assert _section_token_budget(10, 40) == 1536
    # Ceiling: a huge per-section ask never exceeds the model output ceiling.
    assert _section_token_budget(1000, 1) == SETTINGS.gen_max_output_tokens


# --------------------------------------------------------------------------- #
# build_outline honors the cap end-to-end (with the offline fake model)        #
# --------------------------------------------------------------------------- #
def test_build_outline_respects_max_sections(fake_gemini, tmp_corpus):
    from hawkama_copilot.rag import RagEngine

    rag = RagEngine("pages1")
    # The fake model returns 2 outline sections; a cap of 1 must truncate to 1.
    secs = build_outline("سياسة", "هدف", rag, max_sections=1)
    assert len(secs) == 1


def test_generate_document_with_target_pages_runs(fake_gemini, tmp_corpus):
    from hawkama_copilot.rag import RagEngine

    rag = RagEngine("pages2")
    doc = generate_document(
        "سياسة الإجازات", "صياغة كاملة", rag,
        target_pages=10, parallel_sections=False,
    )
    # Bounded section count (the fake yields 2) and a real, stitched document.
    assert 1 <= len(doc.sections) <= _outline_cap(10)
    assert doc.markdown.startswith("# سياسة الإجازات")
    assert doc.word_count > 0


def test_generate_document_without_target_pages_is_bounded(fake_gemini, tmp_corpus):
    # P1/D3 end-to-end: no target_pages at all must still cap the outline at the
    # bounded default, never SETTINGS.gen_max_sections (40).
    from hawkama_copilot.rag import RagEngine

    rag = RagEngine("pages3")
    doc = generate_document("سياسة الإجازات", "صياغة كاملة", rag, parallel_sections=False)
    assert 1 <= len(doc.sections) <= _DEFAULT_SECTIONS_CAP
    assert doc.markdown.startswith("# سياسة الإجازات")

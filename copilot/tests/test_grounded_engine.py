"""V9 (grounded per-axis engine) + V10 (chunked per-chunk critique) + BE-3
(org structure grounded in model.orgUnits).

Pure-logic tests need no model; the model-dependent paths use the offline
`fake_gemini` fixture (which now returns a structured AxisFinding for axis probes).
"""

from __future__ import annotations

import hawkama_copilot.generation as generation
from hawkama_copilot.generation import (
    AxisFinding,
    GroundingContext,
    _as_grounding,
    _chunk_indices,
    axis_findings_digest,
    build_org_chart_mermaid,
    detect_deliverable,
    draft_request,
    generate_deliverable,
    generate_document,
    generate_full_model,
    render_axis_findings_md,
    render_org_structure_md,
    run_axis_pipeline,
)
from hawkama_copilot.skill import (
    GOVERNANCE_AXES,
    GOVERNANCE_AXES_BY_KEY,
    axis_system_prompt,
    grounded_system_prompt,
    grounding_brief,
)


HR_TEXT = """# لائحة الموارد البشرية
## الباب الأول: التعيين
يتم التعيين وفق حاجة العمل والكفاءة وتخضع فترة التجربة لثلاثة أشهر.
## الباب الثاني: الإجازات
يستحق الموظف إجازة سنوية مدتها ثلاثون يومًا.
"""

ORG_UNITS = [
    {"id": "u_ceo", "name": "الرئيس التنفيذي", "mandate": "القيادة العليا"},
    {"id": "u_fin", "name": "الإدارة المالية", "parentId": "u_ceo", "mandate": "المالية والمحاسبة"},
    {"id": "u_hr", "name": "الموارد البشرية", "parentId": "u_ceo", "mandate": "شؤون الموظفين"},
]
ROLES = [{"id": "r1", "title": "المدير المالي", "unitId": "u_fin"}]


# --------------------------------------------------------------------------- #
# Chunking (V10) — pure                                                         #
# --------------------------------------------------------------------------- #
def test_chunk_indices_splits_contiguously():
    assert _chunk_indices(7, 3) == [[0, 1, 2], [3, 4, 5], [6]]
    assert _chunk_indices(4, 2) == [[0, 1], [2, 3]]
    assert _chunk_indices(0, 3) == []
    assert _chunk_indices(2, 5) == [[0, 1]]


def test_chunk_indices_size_floor():
    # A non-positive size never produces empty/overlapping chunks.
    assert _chunk_indices(3, 0) == [[0], [1], [2]]


# --------------------------------------------------------------------------- #
# Governance axes + prompts (V9) — pure                                         #
# --------------------------------------------------------------------------- #
def test_seventeen_axes_present_with_benchmarks():
    assert len(GOVERNANCE_AXES) == 17
    assert all(a.name_ar and a.probe and a.benchmark for a in GOVERNANCE_AXES)
    assert "org_structure" in GOVERNANCE_AXES_BY_KEY
    assert "risk_control" in GOVERNANCE_AXES_BY_KEY


def test_axis_system_prompt_carries_probe_and_benchmark():
    ax = GOVERNANCE_AXES_BY_KEY["risk_control"]
    sp = axis_system_prompt(ax, brief="المنظمة: شركة س.")
    assert ax.name_ar in sp
    assert ax.benchmark in sp
    # The probe-before-drafting discipline must be present.
    assert "منهجية الاستناد" in sp
    assert "شركة س" in sp


def test_grounding_brief_names_real_departments():
    brief = grounding_brief(company="شركة النور", departments=["المالية", "العمليات"], criteria=["ISO 37000"])
    assert "شركة النور" in brief
    assert "المالية" in brief and "العمليات" in brief
    assert "ISO 37000" in brief
    # Empty inputs → empty brief (ungrounded path unchanged).
    assert grounding_brief() == ""


def test_grounded_system_prompt_includes_probe_rule():
    sp = grounded_system_prompt("brief-x")
    assert "منهجية الاستناد" in sp
    assert "brief-x" in sp


# --------------------------------------------------------------------------- #
# GroundingContext — pure                                                       #
# --------------------------------------------------------------------------- #
def test_department_names_union_dedup_order():
    g = GroundingContext(
        departments=["المالية"],
        org_units=[{"id": "u1", "name": "المالية"}, {"id": "u2", "name": "العمليات"}],
    )
    # explicit first, org-unit names appended, duplicate "المالية" not repeated.
    assert g.department_names() == ["المالية", "العمليات"]


def test_as_grounding_from_dict_and_empty():
    assert _as_grounding(None) is None
    assert _as_grounding({}) is None  # empty dict → None (ungrounded)
    g = _as_grounding({"company": "ج", "orgUnits": ORG_UNITS})
    assert isinstance(g, GroundingContext)
    assert g.company == "ج" and len(g.org_units) == 3


def test_grounding_is_empty():
    assert GroundingContext().is_empty
    assert not GroundingContext(company="x").is_empty
    # P1/D1 — a plan's axes/notes alone are enough to make the context non-empty.
    assert not GroundingContext(axes=["الاستراتيجية"]).is_empty
    assert not GroundingContext(notes="ملاحظة المالك").is_empty


def test_grounding_brief_includes_plan_axes_and_notes():
    # P1/D1 — the confirmed wizard plan's axes + owner notes reach the SAME brief
    # block injected into the outline prompt and every section-drafting prompt.
    brief = GroundingContext(
        axes=["الحوكمة المؤسسية", "الاستراتيجية"],
        notes="التزم بإبراز دور مجلس الإدارة",
    ).brief()
    assert "الحوكمة المؤسسية" in brief and "الاستراتيجية" in brief
    assert "التزم بإبراز دور مجلس الإدارة" in brief
    # Empty axes/notes → no stray section (ungrounded/plan-less path unchanged).
    assert grounding_brief() == ""


# --------------------------------------------------------------------------- #
# Org structure deterministic render (BE-3) — pure                              #
# --------------------------------------------------------------------------- #
def test_org_chart_mermaid_matches_frontend_scheme():
    mer = build_org_chart_mermaid(ORG_UNITS, ROLES)
    expected = (
        "flowchart TD\n"
        '  u0["الرئيس التنفيذي"]\n'
        '  u1["الإدارة المالية"]\n'
        '  u2["الموارد البشرية"]\n'
        "  u0 --> u1\n"
        "  u0 --> u2\n"
        '  r0["المدير المالي"]\n'
        "  u1 -.-> r0"
    )
    assert mer == expected


def test_org_chart_is_deterministic():
    assert build_org_chart_mermaid(ORG_UNITS, ROLES) == build_org_chart_mermaid(ORG_UNITS, ROLES)


def test_org_chart_empty_units_fallback():
    assert build_org_chart_mermaid([], company="جهة ما").startswith("flowchart TD")
    assert 'org_root["جهة ما"]' in build_org_chart_mermaid([], company="جهة ما")


def test_org_chart_escapes_unsafe_label_chars():
    mer = build_org_chart_mermaid([{"id": "x", "name": 'إدارة [المشاريع] "أ"'}])
    assert "[المشاريع]" not in mer  # brackets/quotes stripped from the label
    assert '"إدارة المشاريع أ"' in mer


# --------------------------------------------------------------------------- #
# P1/D4 — org-chart root synthesis, mirroring the frontend's synthesizeRoot     #
# (src/__tests__/orgChartBuilder.test.ts) so backend and frontend charts match #
# --------------------------------------------------------------------------- #
def test_org_chart_synthesizes_root_for_multiple_top_level_units():
    units = [
        {"id": "d1", "name": "إدارة المشتريات"},
        {"id": "d2", "name": "الإدارة المالية"},
        {"id": "d3", "name": "الموارد البشرية"},
        {"id": "d1a", "name": "الشراء والتوريد", "parentId": "d1"},
    ]
    roles = [{"id": "r_ceo", "title": "الرئيس التنفيذي", "unitId": "d0"}]
    mer = build_org_chart_mermaid(units, roles, include_roles=False)
    assert mer.startswith("flowchart TD")
    assert mer.count('org_root[') == 1
    assert 'org_root["الرئيس التنفيذي"]' in mer
    assert "org_root --> u0" in mer
    assert "org_root --> u1" in mer
    assert "org_root --> u2" in mer
    # existing nesting preserved; the root is NOT linked to a sub-unit directly
    assert "u0 --> u3" in mer
    assert "org_root --> u3" not in mer


def test_org_chart_root_synthesis_never_picks_a_deputy():
    units = [{"id": "a", "name": "أ"}, {"id": "b", "name": "ب"}]
    roles = [
        {"id": "r_vp", "title": "نائب الرئيس للتطوير والاستراتيجية", "unitId": "a"},
        {"id": "r_ceo", "title": "الرئيس التنفيذي", "unitId": "b"},
    ]
    mer = build_org_chart_mermaid(units, roles, include_roles=False)
    assert 'org_root["الرئيس التنفيذي"]' in mer
    assert "نائب الرئيس" not in mer


def test_org_chart_root_synthesis_falls_back_to_company_then_literal_ceo():
    units = [{"id": "a", "name": "أ"}, {"id": "b", "name": "ب"}]
    mer = build_org_chart_mermaid(units, [], company="مجموعة كلمة", include_roles=False)
    assert 'org_root["مجموعة كلمة"]' in mer

    mer2 = build_org_chart_mermaid(units, [], company="", include_roles=False)
    assert 'org_root["الرئيس التنفيذي"]' in mer2


def test_org_chart_no_root_synthesis_for_single_existing_root():
    # ORG_UNITS already has exactly one top-level unit (u_ceo) → unchanged tree.
    mer = build_org_chart_mermaid(ORG_UNITS, ROLES, include_roles=False)
    assert "org_root" not in mer


def test_org_chart_root_synthesis_handles_zero_real_roots_cycle():
    cyclic = [
        {"id": "a", "name": "أ", "parentId": "b"},
        {"id": "b", "name": "ب", "parentId": "a"},
    ]
    mer = build_org_chart_mermaid(cyclic, [], include_roles=False)
    assert mer.count('org_root[') == 1


def test_org_chart_root_synthesis_is_deterministic():
    units = [{"id": "d1", "name": "أ"}, {"id": "d2", "name": "ب"}]
    assert build_org_chart_mermaid(units) == build_org_chart_mermaid(units)


def test_render_org_structure_md_has_chart_and_table():
    md = render_org_structure_md(ORG_UNITS, ROLES, company="شركة")
    assert "```mermaid" in md
    assert "flowchart TD" in md
    # Real unit + role names appear in the grounded tables.
    assert "الإدارة المالية" in md
    assert "المدير المالي" in md
    assert "المالية والمحاسبة" in md  # mandate column


# --------------------------------------------------------------------------- #
# Axis findings render/digest — pure                                            #
# --------------------------------------------------------------------------- #
def _sample_findings() -> list[AxisFinding]:
    return [
        AxisFinding("policies", "السياسات واللوائح", "لا توجد سياسات موثقة", 2,
                    ["غياب التوثيق"], "مخاطر تشغيلية", "ضعف الحوكمة",
                    ["توثيق السياسات"], ["مراجعة دورية"]),
        AxisFinding("risk_control", "إدارة المخاطر", "لا يوجد سجل مخاطر", 1,
                    ["غياب السجل"], "مخاطر غير مُدارة", "غياب المالك",
                    ["إنشاء سجل مخاطر"], []),
    ]


def test_render_axis_findings_has_sections_and_gap_matrix():
    md = render_axis_findings_md(_sample_findings())
    assert "### السياسات واللوائح" in md
    assert "مستوى النضج 2/5" in md
    assert "**الفجوات:**" in md
    assert "**التوصيات:**" in md
    assert "## مصفوفة الفجوات" in md
    assert "| البعد | الفجوة | الأثر | السبب الجذري |" in md
    assert "غياب التوثيق" in md


def test_axis_findings_digest_is_compact_and_grounded():
    digest = axis_findings_digest(_sample_findings(), max_chars=10000)
    assert "السياسات واللوائح" in digest
    assert "فجوة: غياب التوثيق" in digest
    assert "توصية: توثيق السياسات" in digest
    assert len(axis_findings_digest(_sample_findings(), max_chars=20)) <= 20


# --------------------------------------------------------------------------- #
# Routing — pure                                                                #
# --------------------------------------------------------------------------- #
def test_module_detect_deliverable_matches_agent():
    assert detect_deliverable("اكتب تقرير الواقع الراهن") == "current_state"
    assert detect_deliverable("صمم الهيكل التنظيمي") == "org_structure"
    assert detect_deliverable("سجل المخاطر") == "risk_register"
    assert detect_deliverable("") is None


# --------------------------------------------------------------------------- #
# Per-axis pipeline (V9) — with the offline fake model                         #
# --------------------------------------------------------------------------- #
def test_run_axis_pipeline_produces_grounded_findings(fake_gemini, tmp_corpus):
    from hawkama_copilot.rag import RagEngine

    rag = RagEngine("axis1")
    rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
    ground = GroundingContext(company="شركة", departments=["المالية"])
    findings = run_axis_pipeline(rag, ground, axes=GOVERNANCE_AXES[:3])
    assert len(findings) == 3
    assert all(f.recommendations for f in findings)
    assert all(f.gaps for f in findings)
    assert all(1 <= f.maturity <= 5 for f in findings)


def test_current_state_deliverable_pins_axis_matrix(fake_gemini, tmp_corpus, monkeypatch):
    from hawkama_copilot import config
    from hawkama_copilot.rag import RagEngine

    # Keep the test fast: probe only a few axes.
    object.__setattr__(config.SETTINGS, "gen_axis_max", 3)
    try:
        rag = RagEngine("axis2")
        rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
        doc = generate_deliverable("current_state", rag, ground={"company": "شركة"})
    finally:
        object.__setattr__(config.SETTINGS, "gen_axis_max", 17)
    # The deterministic per-axis findings + gaps matrix are present.
    assert "نتائج التقييم حسب الأبعاد" in doc.markdown
    assert "## مصفوفة الفجوات" in doc.markdown
    # The pinned findings section was not redrafted (stays deterministic).
    assert any(s.pinned for s in doc.sections)


# --------------------------------------------------------------------------- #
# Org-structure deliverable grounded in org units (BE-3) — with fake model      #
# --------------------------------------------------------------------------- #
def test_org_structure_deliverable_is_grounded(fake_gemini, tmp_corpus):
    from hawkama_copilot.rag import RagEngine

    rag = RagEngine("org1")
    rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
    doc = generate_deliverable(
        "org_structure", rag,
        ground={"company": "شركة", "orgUnits": ORG_UNITS, "roles": ROLES},
    )
    # Deterministic chart from the REAL units, not free prose.
    assert "flowchart TD" in doc.markdown
    assert 'u0["الرئيس التنفيذي"]' in doc.markdown
    assert "الإدارة المالية" in doc.markdown
    # A pinned (deterministic) org section exists.
    assert any(s.pinned and "الهيكل العام" in s.title for s in doc.sections)


# --------------------------------------------------------------------------- #
# Chunked generation + per-chunk critique (V10) — with fake model              #
# --------------------------------------------------------------------------- #
def test_generation_critiques_per_chunk(fake_gemini, tmp_corpus, monkeypatch):
    from hawkama_copilot.rag import RagEngine

    rag = RagEngine("chunk1")
    rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])

    seen: list[int] = []
    real_critique = generation._critique

    def spy(title, secs):
        seen.append(len(secs))
        return real_critique(title, secs)

    monkeypatch.setattr(generation, "_critique", spy)
    # 2 model sections + 5 prescribed = 7 sections → chunks of 3 → 3 chunks.
    doc = generate_document(
        "سياسة", "هدف", rag,
        prescribed=("بند أ", "بند ب", "بند ج", "بند د", "بند هـ"),
        parallel_sections=False,
    )
    assert len(doc.sections) == 7
    # Critique ran once per chunk (not a single global pass), each over its chunk.
    assert len(seen) == 3
    assert all(c <= 3 for c in seen)


def test_small_doc_skips_critique(fake_gemini, tmp_corpus, monkeypatch):
    from hawkama_copilot.rag import RagEngine

    rag = RagEngine("chunk2")
    rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
    calls = {"n": 0}
    real = generation._critique
    monkeypatch.setattr(generation, "_critique", lambda *a, **k: (calls.__setitem__("n", calls["n"] + 1) or real(*a, **k)))
    # The fake outline yields only 2 sections → 1 chunk, total<=2 → no critique.
    generate_document("سياسة", "هدف", rag, parallel_sections=False)
    assert calls["n"] == 0


# --------------------------------------------------------------------------- #
# Grounded routing + full build — with fake model                              #
# --------------------------------------------------------------------------- #
def test_draft_request_routes_and_grounds(fake_gemini, tmp_corpus):
    from hawkama_copilot.generation import GeneratedDoc
    from hawkama_copilot.rag import RagEngine

    rag = RagEngine("route1")
    rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
    doc = draft_request(
        rag, "صمم الهيكل التنظيمي",
        ground={"company": "شركة", "orgUnits": ORG_UNITS},
    )
    assert isinstance(doc, GeneratedDoc)
    assert "flowchart TD" in doc.markdown  # grounded org chart present


def test_generate_full_model_grounded(fake_gemini, tmp_corpus):
    from hawkama_copilot import config
    from hawkama_copilot.rag import RagEngine

    object.__setattr__(config.SETTINGS, "gen_axis_max", 2)
    try:
        rag = RagEngine("full1")
        rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
        docs, manual = generate_full_model(
            rag, company="شركة النور",
            department_list=["المالية"],
            ground={"orgUnits": ORG_UNITS, "roles": ROLES},
        )
    finally:
        object.__setattr__(config.SETTINGS, "gen_axis_max", 17)
    assert docs and manual
    titles = [d.title for d in docs]
    # Current-state + org-structure + a department pack are all built.
    assert any("الواقع الراهن" in t for t in titles)
    assert any("الهيكل" in t for t in titles)
    assert any("المالية" in t for t in titles)
    # The org-structure doc is grounded in the real units.
    org_doc = next(d for d in docs if "الهيكل" in d.title)
    assert "flowchart TD" in org_doc.markdown

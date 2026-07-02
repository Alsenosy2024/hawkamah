"""P1 — the confirmed wizard plan is honored end-to-end (D1), and grounding is
forwarded through the conversational agent path (D2).

Adversarial verification against production found the frontend build wizard's
CONFIRMED plan (title/pages/axes/departments/components/notes) getting silently
discarded: every wizard request contains «وثيقة حوكمة», which always matches the
«حوكمة» keyword, so `draft_request` routed to the canned `governance` deliverable
— its own title and outline — dropping everything the owner just confirmed except
the page count. Separately, `agent.py`'s conversational draft/build_full_model/
tool-call paths never forwarded a `GroundingContext`, so they always ran
ungrounded even when the HTTP layer had one. These tests pin both fixes.
"""

from __future__ import annotations

from hawkama_copilot.generation import GroundingContext, _plan_grounding, draft_request

HR_TEXT = """# لائحة الموارد البشرية
## الباب الأول: التعيين
يتم التعيين وفق حاجة العمل والكفاءة وتخضع فترة التجربة لثلاثة أشهر.
## الباب الثاني: الإجازات
يستحق الموظف إجازة سنوية مدتها ثلاثون يومًا.
"""

ORG_UNITS = [
    {"id": "u_ceo", "name": "الرئيس التنفيذي", "mandate": "القيادة العليا"},
    {"id": "u_fin", "name": "الإدارة المالية", "parentId": "u_ceo", "mandate": "المالية والمحاسبة"},
]
ROLES = [{"id": "r1", "title": "المدير المالي", "unitId": "u_fin"}]


# --------------------------------------------------------------------------- #
# _plan_grounding — pure                                                       #
# --------------------------------------------------------------------------- #
def test_plan_grounding_merges_departments_axes_notes():
    g = _plan_grounding(
        {"departments": ["المالية", "الموارد البشرية"], "axes": ["الاستراتيجية"], "notes": "ملاحظة"},
        None,
    )
    assert g.departments == ["المالية", "الموارد البشرية"]
    assert g.axes == ["الاستراتيجية"]
    assert g.notes == "ملاحظة"


def test_plan_grounding_extends_existing_ground_without_dropping_org_units():
    base = GroundingContext(company="شركة", org_units=ORG_UNITS, departments=["المالية"])
    g = _plan_grounding({"departments": ["الموارد البشرية"], "axes": [], "notes": ""}, base)
    assert g.company == "شركة"
    assert g.org_units == ORG_UNITS
    # explicit dept preserved, plan dept appended, no duplicates
    assert g.departments == ["المالية", "الموارد البشرية"]


# --------------------------------------------------------------------------- #
# D1 — plan bypasses keyword routing; title/pages/components honored           #
# --------------------------------------------------------------------------- #
def test_plan_bypasses_deliverable_keyword_routing(fake_gemini, tmp_corpus):
    from hawkama_copilot.rag import RagEngine

    rag = RagEngine("plan1")
    rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
    # This request text ALWAYS matches the "governance" keyword ("حوكمة"), which
    # would normally discard it for the canned "منظومة الحوكمة" deliverable.
    request = "اكتب وثيقة حوكمة كاملة بعنوان: «خطة اختبار المالك». الطول المستهدف: 6 صفحة."
    plan = {
        "title": "خطة اختبار المالك",
        "pages": 6,
        "axes": ["الحوكمة المؤسسية"],
        "departments": ["المالية"],
        "components": ["القسم الأول المخصص", "القسم الثاني المخصص"],
        "notes": "لا تُغفل الفريق المالي.",
    }
    doc = draft_request(rag, request, plan=plan)
    # The plan's title wins — never the canned deliverable title.
    assert doc.title == "خطة اختبار المالك"
    assert doc.title != "منظومة الحوكمة"
    # Every prescribed component made it into the document (TOC entry at least).
    assert "القسم الأول المخصص" in doc.markdown
    assert "القسم الثاني المخصص" in doc.markdown


def test_plan_absent_still_routes_by_keyword(fake_gemini, tmp_corpus):
    # Unchanged behavior: no plan → the old keyword routing still applies.
    from hawkama_copilot.rag import RagEngine

    rag = RagEngine("plan2")
    rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
    doc = draft_request(rag, "اكتب منظومة الحوكمة الكاملة")
    assert doc.title == "منظومة الحوكمة"


def test_keyword_deliverable_without_plan_keeps_owner_text_as_extra_goal(fake_gemini, tmp_corpus, monkeypatch):
    # D1's second fix: even WITHOUT a plan, a keyword-matched deliverable must not
    # silently drop the user's original text — it flows into the outline prompt's
    # goal as "طلب المالك: …".
    import hawkama_copilot.generation as generation
    from hawkama_copilot.rag import RagEngine

    prompts: list[str] = []
    real_generate_json = generation.genai_client.generate_json

    def spy(prompt, **kw):
        prompts.append(str(prompt))
        return real_generate_json(prompt, **kw)

    monkeypatch.setattr(generation.genai_client, "generate_json", spy)

    rag = RagEngine("plan3")
    rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
    request = "أريد مؤشرات أداء تركز على خدمة العملاء تحديداً"
    draft_request(rag, request)
    assert any("طلب المالك" in p and "خدمة العملاء" in p for p in prompts)


# --------------------------------------------------------------------------- #
# D1 — plan notes/axes reach the outline AND every section-drafting prompt     #
# --------------------------------------------------------------------------- #
def test_plan_notes_and_axes_reach_outline_and_section_prompts(fake_gemini, tmp_corpus, monkeypatch):
    import hawkama_copilot.generation as generation
    from hawkama_copilot.rag import RagEngine

    calls: list[tuple[str, str]] = []  # (kind, system)
    real_generate = generation.genai_client.generate
    real_generate_json = generation.genai_client.generate_json

    def spy_generate(prompt, **kw):
        calls.append(("generate", kw.get("system", "")))
        return real_generate(prompt, **kw)

    def spy_generate_json(prompt, **kw):
        calls.append(("generate_json", kw.get("system", "")))
        return real_generate_json(prompt, **kw)

    monkeypatch.setattr(generation.genai_client, "generate", spy_generate)
    monkeypatch.setattr(generation.genai_client, "generate_json", spy_generate_json)

    rag = RagEngine("plan4")
    rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
    plan = {
        "title": "خطة الأثر",
        "pages": 4,
        "axes": ["الحوكمة المؤسسية"],
        "departments": ["المالية"],
        "components": ["القسم الأول"],
        "notes": "التزم بإبراز دور مجلس الإدارة",
    }
    draft_request(rag, "اكتب وثيقة حوكمة", plan=plan)

    outline_systems = [s for kind, s in calls if kind == "generate_json"]
    section_systems = [s for kind, s in calls if kind == "generate"]
    assert any("التزم بإبراز دور مجلس الإدارة" in s for s in outline_systems)
    assert any("التزم بإبراز دور مجلس الإدارة" in s for s in section_systems)
    assert any("الحوكمة المؤسسية" in s for s in outline_systems)
    assert any("الحوكمة المؤسسية" in s for s in section_systems)


# --------------------------------------------------------------------------- #
# D2 — agent.py forwards ground through draft() / build_full_model() /         #
# run_agent()'s tool-call loop                                                 #
# --------------------------------------------------------------------------- #
def test_agent_draft_forwards_ground_to_org_structure(fake_gemini, tmp_corpus):
    from hawkama_copilot.agent import HawkamaAgent

    agent = HawkamaAgent("agent-ground-1")
    agent.rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
    ground = GroundingContext(company="شركة", org_units=ORG_UNITS, roles=ROLES)
    doc = agent.draft("صمم الهيكل التنظيمي", ground=ground)
    # The deterministic, grounded org chart is present — proof `ground` reached
    # generate_deliverable (previously agent.draft() had no ground parameter at all).
    assert "flowchart TD" in doc.markdown
    assert "الإدارة المالية" in doc.markdown


def test_agent_build_full_model_forwards_ground(fake_gemini, tmp_corpus, monkeypatch):
    from hawkama_copilot import config
    from hawkama_copilot.agent import HawkamaAgent

    object.__setattr__(config.SETTINGS, "gen_axis_max", 2)
    try:
        agent = HawkamaAgent("agent-ground-2")
        agent.rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
        ground = GroundingContext(company="شركة", org_units=ORG_UNITS, roles=ROLES)
        docs, manual = agent.build_full_model(department_list=["المالية"], ground=ground)
    finally:
        object.__setattr__(config.SETTINGS, "gen_axis_max", 17)
    assert docs and manual
    org_doc = next(d for d in docs if "الهيكل" in d.title)
    assert "flowchart TD" in org_doc.markdown
    assert "الإدارة المالية" in org_doc.markdown


def test_run_agent_forwards_ground_into_draft_document_tool(fake_gemini, tmp_corpus, monkeypatch):
    """run_agent's tool-call loop hands the model plain python callables as
    "tools"; the SDK's automatic-function-calling machinery invokes them when the
    model decides to. We stub the client to simulate the model calling
    draft_document directly, so this proves the wiring without a real network
    call / API key."""
    import hawkama_copilot.agent as agent_mod
    from hawkama_copilot.agent import HawkamaAgent

    agent = HawkamaAgent("agent-ground-3")
    agent.rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
    ground = GroundingContext(company="شركة", org_units=ORG_UNITS, roles=ROLES)

    captured: dict = {}
    real_draft = HawkamaAgent.draft

    def spy_draft(self, request, **kw):
        captured["ground"] = kw.get("ground")
        return real_draft(self, request, **kw)

    monkeypatch.setattr(HawkamaAgent, "draft", spy_draft)

    class _FakeResponse:
        text = "تم."

    class _FakeModels:
        def generate_content(self, *, model, contents, config):
            for tool in config.tools:
                if getattr(tool, "__name__", "") == "draft_document":
                    tool("صمم الهيكل التنظيمي")
            return _FakeResponse()

    class _FakeClient:
        models = _FakeModels()

    monkeypatch.setattr(agent_mod.genai_client, "get_client", lambda: _FakeClient())

    result = agent.run_agent("ابنِ الهيكل التنظيمي", ground=ground)
    assert captured["ground"] is ground
    assert result.documents
    assert "flowchart TD" in result.documents[0].markdown


# --------------------------------------------------------------------------- #
# api.py — the request-body plan extraction (pure)                             #
# --------------------------------------------------------------------------- #
def test_plan_from_body_pure():
    from hawkama_copilot.api import _plan_from_body

    assert _plan_from_body({}) is None
    assert _plan_from_body({"plan": {}}) is None  # empty dict → treated as absent
    assert _plan_from_body({"plan": "not-a-dict"}) is None
    plan = {"title": "خطة", "pages": 8}
    assert _plan_from_body({"plan": plan}) == plan

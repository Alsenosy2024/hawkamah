"""V5 + V16 — the backend ask-before-generating behavior.

A grounded ASK turn that is really a *build* request must steer the copilot to
converse first (ask which departments/scope, propose an editable plan) instead of
dumping a document — the front-end wizard's backend counterpart. A plain question
must be unaffected. These tests run offline (no network)."""

from __future__ import annotations

from hawkama_copilot.agent import HawkamaAgent, _WIZARD_HINT_AR


def test_is_build_request_matches_build_commands():
    assert HawkamaAgent._is_build_request("ابنِ الهيكل التنظيمي")
    assert HawkamaAgent._is_build_request("ابدأ البناء")
    assert HawkamaAgent._is_build_request("نبني دليل الحوكمة")
    assert HawkamaAgent._is_build_request("generate the org structure")
    assert HawkamaAgent._is_build_request("design a governance manual")


def test_is_build_request_ignores_plain_questions():
    assert not HawkamaAgent._is_build_request("ما هي سياسة تضارب المصالح؟")
    assert not HawkamaAgent._is_build_request("what does RACI mean?")
    assert not HawkamaAgent._is_build_request("")


def test_wizard_hint_asks_and_plans_without_writing_the_doc():
    # The hint must push toward a plan + clarifying questions, not the document.
    assert "خطة" in _WIZARD_HINT_AR
    assert "الإدارات" in _WIZARD_HINT_AR


def test_ask_prompt_injects_hint_only_for_build_requests(fake_gemini, tmp_corpus):
    agent = HawkamaAgent("test_wizard")
    build_prompt = agent._ask_prompt("ابنِ الهيكل التنظيمي", [])
    plain_prompt = agent._ask_prompt("ما هي سياسة الإجازات؟", [])
    assert _WIZARD_HINT_AR in build_prompt
    assert _WIZARD_HINT_AR not in plain_prompt

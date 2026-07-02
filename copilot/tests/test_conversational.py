"""P10 — the conversational copilot register.

Bug report: "even if I said hi it replies back with the full document; it asks
all questions up front — I want it conversational." Three fixes covered here:

  1. `_is_smalltalk` — a conservative, whole-message greeting/thanks detector.
  2. Smalltalk turns skip RAG retrieval and get a tiny reply, no evidence block.
  3. Normal asks get a proportionate-register system prompt (`ask_system_prompt`),
     scoped away from the document-GENERATION path's bare `system_prompt()`.
  4. `_WIZARD_HINT_AR` now asks one question per turn instead of a batch.

P11 adds two more, both covered below:

  5. `_is_smalltalk`'s bare-name allowance is tightened so a greeting attached to
     a real content word ("هلا الحوكمة") no longer skips RAG (section 2).
  6. `/ask`'s `ask()`/`ask_stream()` now accept the same `GroundingContext` /draft
     already honors, injecting `grounding_brief()` into both the system prompt and
     the user-turn context block (section 3b).

These tests run offline (no network) via the `fake_gemini` fixture."""

from __future__ import annotations

from hawkama_copilot.agent import HawkamaAgent, _WIZARD_HINT_AR, _is_smalltalk
from hawkama_copilot.generation import GroundingContext
from hawkama_copilot.skill import CONVERSATION_RULE, system_prompt


# --------------------------------------------------------------------------- #
# 1. _is_smalltalk truth table                                                #
# --------------------------------------------------------------------------- #
def test_is_smalltalk_true_for_arabic_greetings_and_thanks():
    for msg in (
        "هلا", "مرحبا", "أهلاً", "السلام عليكم", "صباح الخير", "مساء الخير",
        "هاي", "شكرا", "شكراً جزيلاً", "تسلم", "كيف حالك",
    ):
        assert _is_smalltalk(msg), msg


def test_is_smalltalk_true_for_english_greetings_and_thanks():
    for msg in ("hi", "hello", "hey", "good morning", "thanks", "thank you", "how are you"):
        assert _is_smalltalk(msg), msg


def test_is_smalltalk_false_for_governance_questions():
    for msg in (
        "ما هي الحوكمة؟",
        "اشرح سجل المخاطر",
        "اكتب سياسة",
        "مرحبا، عندي سؤال طويل جداً عن سياسة الإجازات وأريد تفاصيل كاملة عن الإجراء",
    ):
        assert not _is_smalltalk(msg), msg


def test_is_smalltalk_false_for_greeting_plus_content_word():
    # P11 — the bare-name allowance ("هلا محمد") used to also accept ANY single
    # extra token, so a greeting attached to a real governance noun (or a
    # question mark) was misread as pure smalltalk and skipped RAG entirely.
    for msg in (
        "هلا الحوكمة",
        "هلا سياسة",
        "صباح الخير حوكمة",
        "مرحبا تقرير",
        "hi, policy?",
        "hi policy",
        "hello report",
        "hi document",
    ):
        assert not _is_smalltalk(msg), msg


def test_is_smalltalk_true_for_greeting_plus_bare_name():
    # The actual allowance this tolerance exists for must still pass.
    for msg in ("هلا محمد", "hi John", "مرحبا سارة"):
        assert _is_smalltalk(msg), msg


def test_is_smalltalk_false_for_bare_acks():
    # Contextual answers to a prior elicitation question ("هل نضيف الإدارة
    # المالية؟" → "نعم") — must NOT be shortcut as smalltalk.
    for msg in ("نعم", "تمام", "ok", "اه"):
        assert not _is_smalltalk(msg), msg


def test_is_smalltalk_false_for_empty_and_none():
    assert not _is_smalltalk("")
    assert not _is_smalltalk(None)


# --------------------------------------------------------------------------- #
# 2. smalltalk ask_stream turn: no retrieval, empty sources, no evidence wrap  #
# --------------------------------------------------------------------------- #
def test_smalltalk_ask_stream_skips_retrieval_and_evidence_wrapper(fake_gemini, tmp_corpus, monkeypatch):
    agent = HawkamaAgent("test_conversational_smalltalk")

    called = {"retrieve": False}

    def _spy_retrieve(*a, **kw):
        called["retrieve"] = True
        return []

    monkeypatch.setattr(agent.rag, "retrieve", _spy_retrieve)

    captured_prompts = []
    orig_stream = fake_gemini.generate_stream

    def _spy_stream(contents, **kw):
        captured_prompts.append(contents)
        yield from orig_stream(contents, **kw)

    monkeypatch.setattr(fake_gemini, "generate_stream", _spy_stream)  # == agent_mod.genai_client

    events = list(agent.ask_stream("هلا"))

    assert called["retrieve"] is False                       # rag.retrieve NOT called
    assert events[0] == {"type": "sources", "sources": []}   # first event: empty sources
    assert events[-1]["type"] == "done"

    # The prompt sent to the model carries the raw greeting only — no evidence
    # block and no grounded-ask wrapper.
    sent_contents = captured_prompts[0]
    last_text = sent_contents[-1].parts[0].text
    assert "== الأدلة ==" not in last_text
    assert "السؤال:" not in last_text


def test_smalltalk_ask_returns_empty_sources(fake_gemini, tmp_corpus, monkeypatch):
    agent = HawkamaAgent("test_conversational_smalltalk_ask")

    called = {"retrieve": False}

    def _spy_retrieve(*a, **kw):
        called["retrieve"] = True
        return []

    monkeypatch.setattr(agent.rag, "retrieve", _spy_retrieve)

    result = agent.ask("thanks")
    assert called["retrieve"] is False
    assert result.sources == []


# --------------------------------------------------------------------------- #
# 3. normal ask turn: retrieval happens, register rule present in system      #
# --------------------------------------------------------------------------- #
def test_normal_ask_retrieves_and_uses_conversation_register(fake_gemini, tmp_corpus, monkeypatch):
    agent = HawkamaAgent("test_conversational_normal")

    called = {"retrieve": False}
    orig_retrieve = agent.rag.retrieve

    def _spy_retrieve(*a, **kw):
        called["retrieve"] = True
        return orig_retrieve(*a, **kw)

    monkeypatch.setattr(agent.rag, "retrieve", _spy_retrieve)

    captured_systems = []
    import hawkama_copilot.agent as agent_mod

    def _spy_generate(contents, **kw):
        captured_systems.append(kw.get("system", ""))
        return "جواب موجز [مصدر 1]."

    monkeypatch.setattr(agent_mod.genai_client, "generate", _spy_generate)

    agent.ask("ما هي سياسة التعيين؟")

    assert called["retrieve"] is True
    assert CONVERSATION_RULE in captured_systems[0]


# --------------------------------------------------------------------------- #
# 3b. /ask honors GroundingContext (P11) — same brief /draft already injects   #
# --------------------------------------------------------------------------- #
def test_ask_injects_grounding_brief_into_system_and_prompt(fake_gemini, tmp_corpus, monkeypatch):
    agent = HawkamaAgent("test_conversational_grounded_ask")

    captured = {}
    import hawkama_copilot.agent as agent_mod

    def _spy_generate(contents, **kw):
        captured["system"] = kw.get("system", "")
        captured["last_text"] = contents[-1].parts[0].text
        return "جواب [مصدر 1]."

    monkeypatch.setattr(agent_mod.genai_client, "generate", _spy_generate)

    ground = GroundingContext(company="شركة النور", departments=["المالية", "العمليات"])
    agent.ask("ما هي إداراتنا؟", ground=ground)

    # Same brief text /draft injects (GroundingContext.brief()) reaches BOTH the
    # system prompt and the user-turn context block, mirroring the draft path.
    assert "شركة النور" in captured["system"]
    assert "المالية" in captured["system"] and "العمليات" in captured["system"]
    assert "== سياق المنظمة ==" in captured["last_text"]
    assert "المالية" in captured["last_text"]


def test_ask_stream_injects_grounding_brief(fake_gemini, tmp_corpus, monkeypatch):
    agent = HawkamaAgent("test_conversational_grounded_ask_stream")

    captured = {}
    import hawkama_copilot.agent as agent_mod

    def _spy_stream(contents, **kw):
        captured["system"] = kw.get("system", "")
        yield "جواب"

    monkeypatch.setattr(agent_mod.genai_client, "generate_stream", _spy_stream)

    # A raw dict (as the HTTP layer's _grounding_from_body produces) must work too.
    ground = {"company": "شركة النور", "departments": ["الموارد البشرية"]}
    list(agent.ask_stream("من يدير الموارد البشرية؟", ground=ground))

    assert "شركة النور" in captured["system"]
    assert "الموارد البشرية" in captured["system"]


def test_ask_without_grounding_context_is_unchanged(fake_gemini, tmp_corpus, monkeypatch):
    # Absent ground → behavior identical to pre-P11 (no company-context block).
    agent = HawkamaAgent("test_conversational_ungrounded_ask")
    captured = {}
    import hawkama_copilot.agent as agent_mod

    def _spy_generate(contents, **kw):
        captured["last_text"] = contents[-1].parts[0].text
        return "جواب [مصدر 1]."

    monkeypatch.setattr(agent_mod.genai_client, "generate", _spy_generate)
    agent.ask("ما هي سياسة التعيين؟")
    assert "== سياق المنظمة ==" not in captured["last_text"]


def test_smalltalk_still_skips_grounding_brief(fake_gemini, tmp_corpus, monkeypatch):
    # A standalone greeting stays a tiny reply even when grounding is present —
    # P10's smalltalk shortcut takes priority over P11's grounding injection.
    agent = HawkamaAgent("test_conversational_smalltalk_with_ground")
    captured = {}
    import hawkama_copilot.agent as agent_mod

    def _spy_generate(contents, **kw):
        captured["system"] = kw.get("system", "")
        captured["last_text"] = contents[-1].parts[0].text
        return "أهلاً بك!"

    monkeypatch.setattr(agent_mod.genai_client, "generate", _spy_generate)
    ground = GroundingContext(company="شركة النور")
    agent.ask("هلا", ground=ground)
    assert "== سياق المنظمة ==" not in captured["last_text"]
    assert "شركة النور" not in captured["system"]


# --------------------------------------------------------------------------- #
# 4. system_prompt() bare stays byte-identical (protects the generation path) #
# --------------------------------------------------------------------------- #
def test_bare_system_prompt_unchanged_by_conversational_rule():
    bare = system_prompt()
    assert CONVERSATION_RULE not in bare


# --------------------------------------------------------------------------- #
# 5. build-intent hint: progressive, one question per turn                    #
# --------------------------------------------------------------------------- #
def test_wizard_hint_asks_one_question_at_a_time():
    assert "سؤالًا واحدًا فقط" in _WIZARD_HINT_AR or "سؤال واحد" in _WIZARD_HINT_AR
    # Accumulation across turns must be part of the protocol.
    assert "ما اتفقنا عليه حتى الآن" in _WIZARD_HINT_AR
    # The old batch phrasing ("ما الإدارات التي تريد تضمينها أو حذفها؟ ما
    # النطاق والتفضيلات؟" asked together) must be gone.
    assert "ما النطاق والتفضيلات؟" not in _WIZARD_HINT_AR
    # Still mentions plan + departments (kept for test_wizard.py compatibility).
    assert "خطة" in _WIZARD_HINT_AR
    assert "الإدارات" in _WIZARD_HINT_AR

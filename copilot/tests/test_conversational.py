"""P10 — the conversational copilot register.

Bug report: "even if I said hi it replies back with the full document; it asks
all questions up front — I want it conversational." Three fixes covered here:

  1. `_is_smalltalk` — a conservative, whole-message greeting/thanks detector.
  2. Smalltalk turns skip RAG retrieval and get a tiny reply, no evidence block.
  3. Normal asks get a proportionate-register system prompt (`ask_system_prompt`),
     scoped away from the document-GENERATION path's bare `system_prompt()`.
  4. `_WIZARD_HINT_AR` now asks one question per turn instead of a batch.

These tests run offline (no network) via the `fake_gemini` fixture."""

from __future__ import annotations

from hawkama_copilot.agent import HawkamaAgent, _WIZARD_HINT_AR, _is_smalltalk
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

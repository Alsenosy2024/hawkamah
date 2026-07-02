"""The Hawkama Copilot agent.

Three layers, smallest to largest:

  • ask()        — grounded RAG Q&A with [مصدر N] citations (the copilot's "اسأل").
  • draft()      — large multi-page document drafting (the "اطلب صياغة كاملة" path);
                   routes to a prescribed skill deliverable when the request maps
                   to one, else free-form outline→sections→stitch.
  • run_agent()  — a real Gemini function-calling loop: the model chooses tools
                   (retrieve / draft / list deliverables / build full manual) and
                   we execute them, capturing artifacts on the side.

build_full_model() runs the whole skill end-to-end (all deliverables → one RTL
HTML governance manual), honoring the quality-gate ordering.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Callable, Iterator

from google.genai import types

from . import genai_client
from .config import SETTINGS
from .exporters import Exported, ManualDoc, export, render_manual
from .generation import GeneratedDoc, GroundingContext, generate_deliverable, generate_document
from .rag import Evidence, RagEngine
from .skill import (
    DELIVERABLES,
    DELIVERABLES_BY_KEY,
    ask_system_prompt,
    smalltalk_system_prompt,
    system_prompt,
)


# Phrases that signal "draft a full document" rather than "answer a question"
# (mirrors the JS longForm heuristic).
_LONGFORM = re.compile(
    r"اكتب|صغ|صياغة|أنشئ|انشئ|جهّز|جهز|أعدّ|اعد|سياسة|لائحة|ميثاق|دليل|إجراء|اجراء|"
    r"حزمة|تقرير|استراتيج|كامل|مفصّل|مفصل|وثيقة|draft|write|generate|full|policy|charter|manual",
    re.IGNORECASE,
)

# V5 + V16 — build-intent phrases for the conversational wizard. When a grounded
# ASK turn looks like a *build* request, the copilot should converse first: ask
# which departments/scope/preferences the user wants and propose a short editable
# plan, instead of dumping a document with no give-and-take ("ومسألنيش أي سؤال
# ولا خد وعطا معايا أصلاً"). This complements the front-end wizard (which proposes
# the plan in-app) by making the backend ask-before-generating on the /ask path.
_BUILD_INTENT = re.compile(
    r"ابن|ابدأ\s*البناء|ابدا\s*البناء|الهيكل\s*التنظيمي|أنشئ|انشئ|صمّم|صمم|ولّد|ولد|نبني|"
    r"build|generate|create|design|start\s*building|org\s*structure",
    re.IGNORECASE,
)

# P10 — rewritten from a batch questionnaire ("ما الإدارات؟ ما النطاق والتفضيلات؟"
# asked all at once) to a PROGRESSIVE protocol: one question per turn, accumulating
# agreement across turns, and only proposing the plan once the essentials are known.
# This is what fixes "it asks all questions up front" from the bug report — the
# copilot converses like a person scoping the work, not a form.
_WIZARD_HINT_AR = (
    "ملاحظة مهمة: يبدو أن المستخدم يريد *بناء* مخرجات حوكمة. تحاور معه تدريجيًا "
    "ولا تكتب الوثيقة كاملة في هذا الرد ولا في أي رد ضمن /ask. أقرّ بهدفه أولاً "
    "بجملة قصيرة، ثم اسأل سؤالًا واحدًا فقط هو الأهم لإكمال الصورة (أو سؤالين كحد "
    "أقصى إن كانا مترابطين ولا يصح فصلهما) — لا تطرح قائمة أسئلة دفعة واحدة. إذا "
    "كانت هناك محادثة سابقة، لخّص بسطر واحد مضغوط ما اتفقتما عليه حتى الآن («ما "
    "اتفقنا عليه حتى الآن: …») قبل طرح السؤال التالي، حتى يرى المستخدم تقدّم "
    "الحوار. لا تقترح خطة (عنوان، صفحات، محاور، إدارات، أقسام) إلا بعد أن تتضح "
    "العناصر الأساسية الثلاثة: نوع المخرج المطلوب، والنطاق/الإدارات المعنية، "
    "والطول التقريبي؛ عندها فقط اعرض خطة موجزة قابلة للتعديل واطلب تأكيدها أو "
    "تعديلها قبل البناء.\n\n"
)

# --------------------------------------------------------------------------- #
# Smalltalk detection (P10)                                                   #
# --------------------------------------------------------------------------- #
# A conservative, WHOLE-MESSAGE check — never a substring test — so it can't fire
# on a real question that happens to open with a greeting ("مرحبا، ما هي سياسة
# الإجازات؟"). Diacritics/alef variants are normalized, multi-word greetings are
# merged into single vocabulary tokens, and every remaining token must be either a
# recognized greeting/thanks core token, a small politeness filler, or (at most
# one) a bare name ("هلا محمد"). Zero core tokens ⇒ never smalltalk — this is what
# keeps bare acks like «نعم»/«تمام»/"ok"/«اه» OUT: they carry no greeting/thanks
# token at all, so they fall through to the normal grounded path (they are answers
# to a prior elicitation question, not smalltalk).
_TASHKEEL_RE = re.compile(r"[ً-ْٰـ]")  # harakat + tatweel
_ALEF_NORMALIZE = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي", "ؤ": "و", "ئ": "ي"})
_NON_WORD_RE = re.compile(r"[^\w\s]", re.UNICODE)
_WS_RE = re.compile(r"\s+")

# Multi-word phrases merged into ONE underscore-joined token before splitting, so
# "السلام عليكم" is matched as a single greeting, not two unrelated words.
_SMALLTALK_PHRASES = (
    "اهلا وسهلا", "السلام عليكم", "وعليكم السلام", "صباح الخير", "صباح النور",
    "مساء الخير", "مساء النور", "كيف حالك", "كيف حالكم", "كيف الحال", "ايش اخبارك",
    "شكرا جزيلا", "الله يعطيك العافية", "يعطيك العافية",
    "good morning", "good evening", "good afternoon",
    "thank you", "thanks a lot", "how are you",
)

_SMALLTALK_CORE = {
    # Arabic greetings
    "هلا", "مرحبا", "مرحبتين", "اهلا", "اهلين", "اهلا_وسهلا",
    "السلام_عليكم", "وعليكم_السلام", "صباح_الخير", "صباح_النور",
    "مساء_الخير", "مساء_النور", "هاي", "هالو",
    "كيف_حالك", "كيف_حالكم", "كيف_الحال", "كيفك", "ازيك", "شلونك", "ايش_اخبارك",
    # Arabic thanks
    "شكرا", "شكرا_جزيلا", "مشكور", "مشكورة", "تسلم", "تسلمي",
    "يعطيك_العافية", "ممتن", "ممتنة",
    # English
    "hi", "hello", "hey", "hiya", "yo",
    "good_morning", "good_evening", "good_afternoon",
    "thanks", "thank_you", "thanks_a_lot", "how_are_you",
}

# Politeness/address fillers tolerated ALONGSIDE a core token (never counted as
# the "one extra token" name allowance, never sufficient on their own).
_SMALLTALK_FILLER = {
    "يا", "استاذ", "دكتور", "دكتورة", "مهندس", "بشمهندس", "الله",
    "جدا", "كتير", "اوي", "so", "much", "there", "a", "lot", "very",
}

_SMALLTALK_MAX_CHARS = 40
_SMALLTALK_MAX_TOKENS = 6


def _normalize_smalltalk(message: str) -> str:
    text = (message or "").strip().translate(_ALEF_NORMALIZE)
    text = _TASHKEEL_RE.sub("", text)
    text = text.lower()
    for phrase in _SMALLTALK_PHRASES:
        text = re.sub(re.escape(phrase), phrase.replace(" ", "_"), text)
    text = _NON_WORD_RE.sub(" ", text)
    return _WS_RE.sub(" ", text).strip()


def _is_smalltalk(message: str) -> bool:
    """True only when ``message`` is a standalone greeting/thanks (P10) — never
    for a message that merely contains one. See module comment above for the
    matching rule."""
    if not message or len(message.strip()) >= _SMALLTALK_MAX_CHARS:
        return False
    normalized = _normalize_smalltalk(message)
    if not normalized:
        return False
    tokens = normalized.split(" ")
    if len(tokens) > _SMALLTALK_MAX_TOKENS:
        return False
    core_hits = sum(1 for t in tokens if t in _SMALLTALK_CORE)
    if core_hits == 0:
        return False
    unknown = [t for t in tokens if t not in _SMALLTALK_CORE and t not in _SMALLTALK_FILLER]
    return len(unknown) <= 1


@dataclass
class AskResult:
    answer: str
    sources: list[Evidence] = field(default_factory=list)


@dataclass
class AgentResult:
    answer: str
    documents: list[GeneratedDoc] = field(default_factory=list)
    trace: list[str] = field(default_factory=list)


class HawkamaAgent:
    def __init__(self, corpus_id: str = "default"):
        self.corpus_id = corpus_id
        self.rag = RagEngine(corpus_id)

    # --------------------------------------------------------------- ingest
    def ingest_paths(self, paths, on_progress=None):
        return self.rag.ingest_paths(paths, on_progress)

    def ingest_bytes(self, files, on_progress=None):
        return self.rag.ingest_bytes(files, on_progress)

    def stats(self) -> dict:
        return self.rag.stats()

    # ------------------------------------------------------------------ ask
    def ask(self, question: str, history: list[dict] | None = None) -> AskResult:
        # P10: a standalone greeting/thanks skips retrieval entirely and gets a
        # tiny conversational reply — no evidence block, no [مصدر N], no document.
        if _is_smalltalk(question):
            contents = self._build_contents(question, [], history, prompt_text=question)
            answer = genai_client.generate(contents, system=smalltalk_system_prompt(), temperature=0.5)
            return AskResult(answer=answer, sources=[])
        evidence = self.rag.retrieve(question)
        contents = self._build_contents(question, evidence, history)
        answer = genai_client.generate(contents, system=ask_system_prompt(), temperature=0.3)
        return AskResult(answer=answer, sources=evidence)

    def ask_stream(self, question: str, history: list[dict] | None = None) -> Iterator[dict]:
        """Yield {'type': 'sources'|'delta'|'done', ...} events for SSE."""
        # P10: same smalltalk shortcut as ask() — SSE event shape is unchanged
        # (sources → delta* → done), sources is just an empty list.
        if _is_smalltalk(question):
            yield {"type": "sources", "sources": []}
            contents = self._build_contents(question, [], history, prompt_text=question)
            full = []
            for piece in genai_client.generate_stream(contents, system=smalltalk_system_prompt(), temperature=0.5):
                full.append(piece)
                yield {"type": "delta", "text": piece}
            yield {"type": "done", "text": "".join(full)}
            return
        evidence = self.rag.retrieve(question)
        yield {"type": "sources", "sources": [self._ev_dict(e) for e in evidence]}
        contents = self._build_contents(question, evidence, history)
        full = []
        for piece in genai_client.generate_stream(contents, system=ask_system_prompt(), temperature=0.3):
            full.append(piece)
            yield {"type": "delta", "text": piece}
        yield {"type": "done", "text": "".join(full)}

    def _build_contents(
        self,
        question: str,
        evidence: list[Evidence],
        history: list[dict] | None,
        *,
        prompt_text: str | None = None,
    ) -> list[types.Content]:
        """Prior turns as TYPED multi-turn Content + a final user turn carrying the
        instructions, question and freshly-retrieved evidence.

        Feeding genuine Content objects (not a flattened "user: …\\nassistant: …"
        transcript collapsed into one prompt) is what gives the model real
        multi-turn memory of its own earlier answers. Evidence is re-retrieved every
        turn and placed in the LAST user turn so it never lands "lost in the middle".
        We build the contents list ourselves and stream via generate_content_stream
        rather than the SDK Chat object, sidestepping its streaming-history bug.

        ``prompt_text`` (P10) overrides the final user turn with a raw, un-wrapped
        message — used by the smalltalk shortcut so the model sees the greeting
        as-is instead of the grounded ``_ask_prompt`` wrapper (evidence block,
        citation instructions, etc.)."""
        contents = [
            types.Content(role=role, parts=[types.Part.from_text(text=text)])
            for role, text in self._history_window(history)
        ]
        text = prompt_text if prompt_text is not None else self._ask_prompt(question, evidence)
        contents.append(types.Content(role="user", parts=[types.Part.from_text(text=text)]))
        return contents

    @staticmethod
    def _is_build_request(message: str) -> bool:
        """True when an ASK turn is really a 'build this' request (V5/V16)."""
        return bool(_BUILD_INTENT.search(message or ""))

    def _ask_prompt(self, question: str, evidence: list[Evidence]) -> str:
        ev_block = self.rag.format_evidence(evidence)
        # V5/V16: on a build-intent ASK, steer the copilot to converse + propose an
        # editable plan before generating, rather than dumping a document.
        wizard = _WIZARD_HINT_AR if self._is_build_request(question) else ""
        return (
            f"السؤال: {question}\n\n"
            "أجب بدقة واستنادًا إلى الأدلة أدناه فقط فيما يخص وقائع المنظمة، مع الاستشهاد "
            "بـ [مصدر N]. إن لم تكفِ الأدلة فاذكر ذلك واقترح ما يلزم من ملفات. استعن بسياق "
            "المحادثة السابق لفهم الإحالات (مثل «وسّع ذلك» أو «والإدارة الأخرى؟») دون تكراره.\n\n"
            f"{wizard}"
            f"== الأدلة ==\n{ev_block or 'لا توجد ملفات مفهرسة بعد.'}"
        )

    @staticmethod
    def _history_window(history: list[dict] | None) -> list[tuple[str, str]]:
        """Char-budgeted recent-turn window → [(role, text)].

        Roles are normalized to the SDK's only accepted values, 'user' / 'model'
        (never 'agent'/'assistant', which raise ValueError when wrapped in Content).
        Walks newest→oldest, drops empty turns, truncates any single oversized turn
        (e.g. a pasted full draft), then restores chronological order."""
        if not history:
            return []
        per_msg = SETTINGS.history_per_msg_chars
        budget = SETTINGS.history_max_chars
        considered = history[-SETTINGS.history_max_messages:]
        out: list[tuple[str, str]] = []
        used = 0
        for h in reversed(considered):
            text = (h.get("content") or h.get("text") or "").strip()
            if not text:
                continue
            if len(text) > per_msg:
                text = text[:per_msg].rstrip() + " …"
            raw_role = h.get("role") or h.get("sender")
            role = "user" if raw_role == "user" else "model"
            if used + len(text) > budget:
                break
            out.append((role, text))
            used += len(text)
        out.reverse()
        return out

    # ---------------------------------------------------------------- draft
    def detect_deliverable(self, request: str) -> str | None:
        """Map a free-text request to a prescribed skill deliverable, if any."""
        # Keys are matched as substrings, so include the ال-prefixed forms that
        # appear in natural requests ("تقرير الواقع الراهن", "الهيكل التنظيمي").
        keymap = {
            "current_state": ("واقع راهن", "الواقع الراهن", "الراهن", "تقييم", "current state", "assessment"),
            "org_structure": ("هيكل تنظيمي", "الهيكل التنظيمي", "هيكل", "org structure", "organization"),
            "strategy": ("استراتيج", "الرؤية", "رؤية", "رسالة", "strategy"),
            "governance": ("منظومة الحوكمة", "إطار الحوكمة", "governance framework", "حوكمة"),
            "committees": ("لجنة", "لجان", "ميثاق", "committee", "charter"),
            "department_pack": ("حزمة تشغيل", "حزمة الإدارة", "department pack", "إدارة "),
            "raci_doa": ("raci", "صلاحيات", "تفويض", "delegation"),
            "kpis": ("مؤشرات", "kpi", "أداء"),
            "risk_register": ("مخاطر", "risk", "سجل المخاطر"),
        }
        low = request.lower()
        for key, keys in keymap.items():
            if any(k in low for k in keys):
                return key
        return None

    def draft(
        self,
        request: str,
        *,
        language: str = "ar",
        target_pages: int | None = None,
        ground: "GroundingContext | dict | None" = None,
        on_progress: Callable[[str, int, int], None] | None = None,
    ) -> GeneratedDoc:
        key = self.detect_deliverable(request)
        if key:
            department = None
            if key == "department_pack":
                m = re.search(r"إدارة\s+([^\.،\n]+)", request)
                department = m.group(1).strip() if m else None
            return generate_deliverable(
                key, self.rag, department=department, language=language,
                target_pages=target_pages, ground=ground, on_progress=on_progress,
                extra_request=request,
            )
        # Free-form: derive a title/goal then generate.
        title = re.sub(r"^\s*(اكتب|صغ|أنشئ|انشئ|جهّز|أعدّ|write|generate|draft)\s*", "", request).strip()
        title = title[:120] or "وثيقة حوكمة"
        return generate_document(
            title, f"إنتاج وثيقة كاملة احترافية تلبي الطلب: {request}", self.rag,
            language=language, target_pages=target_pages, ground=ground, on_progress=on_progress,
        )

    def respond(self, message: str, history: list[dict] | None = None, **kw) -> AskResult | GeneratedDoc:
        """Copilot router: long-form request → draft(); else → ask()."""
        if _LONGFORM.search(message) and len(message) > 12:
            return self.draft(message, **kw)
        return self.ask(message, history)

    # ----------------------------------------------------- full skill model
    def build_full_model(
        self,
        *,
        company: str = "",
        department_list: list[str] | None = None,
        language: str = "ar",
        ground: "GroundingContext | dict | None" = None,
        on_progress: Callable[[str, int, int], None] | None = None,
    ) -> tuple[list[GeneratedDoc], str]:
        """Run every skill deliverable in gate order → one RTL HTML manual."""
        docs: list[GeneratedDoc] = []
        # Deliverables in their canonical (gate) order; department_pack expanded.
        order = [d for d in DELIVERABLES if d.key != "department_pack"]
        total = len(order) + len(department_list or [])
        done = 0
        for d in order:
            if on_progress:
                on_progress(f"deliverable:{d.key}", done, total)
            docs.append(generate_deliverable(d.key, self.rag, language=language, ground=ground))
            done += 1
        for dept in department_list or []:
            if on_progress:
                on_progress(f"department:{dept}", done, total)
            docs.append(generate_deliverable(
                "department_pack", self.rag, department=dept, language=language, ground=ground,
            ))
            done += 1

        manual = render_manual(
            [ManualDoc(doc_id=f"d{i}", title=doc.title, markdown=doc.markdown) for i, doc in enumerate(docs)],
            manual_title=f"دليل الحوكمة والنموذج التشغيلي{(' — ' + company) if company else ''}",
            subtitle=company,
        )
        if on_progress:
            on_progress("done", total, total)
        return docs, manual

    # ------------------------------------------------------------- export
    def export_doc(self, doc: GeneratedDoc, fmt: str, *, company: str = "") -> Exported:
        return export(doc.markdown, doc.title, fmt, company=company)

    # ----------------------------------------------- function-calling agent
    def run_agent(
        self, instruction: str, max_steps: int = 6, *,
        ground: "GroundingContext | dict | None" = None,
    ) -> AgentResult:
        """A real Gemini function-calling loop. The model selects tools; we run
        them and feed compact receipts back (large artifacts are kept aside).

        ``ground`` (P1/D2) is forwarded into the ``draft_document`` tool so the
        agent's own drafting — previously always ungrounded — can derive from the
        same company inputs the HTTP layer's /draft path already grounds with."""
        client = genai_client.get_client()
        artifacts: list[GeneratedDoc] = []
        trace: list[str] = []

        def retrieve_evidence(query: str) -> str:
            """Retrieve grounded evidence snippets from the organization's files."""
            ev = self.rag.retrieve(query)
            trace.append(f"retrieve_evidence({query!r}) → {len(ev)} hits")
            return self.rag.format_evidence(ev, max_chars=6000) or "لا توجد أدلة."

        def list_deliverables() -> str:
            """List the prescribed governance deliverables the agent can produce."""
            trace.append("list_deliverables()")
            return json.dumps({d.key: d.title_ar for d in DELIVERABLES}, ensure_ascii=False)

        def draft_document(request: str) -> str:
            """Draft a complete multi-page governance document for the request."""
            doc = self.draft(request, ground=ground)
            artifacts.append(doc)
            trace.append(f"draft_document({request!r}) → '{doc.title}' (~{doc.page_estimate}p)")
            return f"تم إنشاء «{doc.title}» (~{doc.page_estimate} صفحة، {len(doc.sections)} أقسام)."

        tools = [retrieve_evidence, list_deliverables, draft_document]
        cfg = types.GenerateContentConfig(
            system_instruction=system_prompt(
                "أنت في وضع الوكيل: استخدم الأدوات المتاحة عند الحاجة لإنجاز طلب المستخدم، "
                "ثم قدّم ملخصًا تنفيذيًا لما أنجزته."
            ),
            tools=tools,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(maximum_remote_calls=max_steps),
        )
        resp = client.models.generate_content(
            model=SETTINGS.models.text, contents=instruction, config=cfg
        )
        return AgentResult(answer=(resp.text or "").strip(), documents=artifacts, trace=trace)

    # ------------------------------------------------------------- helpers
    @staticmethod
    def _ev_dict(e: Evidence) -> dict:
        return {
            "label": e.label, "doc": e.doc_name, "heading": e.heading_path,
            "score": e.score, "text": e.text[:300],
        }

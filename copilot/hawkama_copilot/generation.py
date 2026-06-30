"""Large multi-page document generation, grounded in RAG.

The single hardest requirement: produce *many pages from one request* despite a
~64K output-token ceiling. We never ask for the whole document at once. Instead:

    outline → per-section retrieve + draft (each its own request) → critique →
    targeted revise → stitch (cover + TOC + sections + citations table).

Each section is retrieved and drafted independently, so total document length is
bounded by section_count × per_section_tokens, not by one model call. A shared
"coherence memo" (the full outline + canonical terminology) is injected into every
section so names stay consistent across pages. Every factual sentence carries a
[مصدر N] citation back to the evidence, satisfying the skill's grounding rule.
"""

from __future__ import annotations

import concurrent.futures
import re
from dataclasses import dataclass, field
from typing import Callable

from . import genai_client
from .config import SETTINGS
from .rag import Evidence, RagEngine
from .skill import DELIVERABLES_BY_KEY, Deliverable, system_prompt


ProgressCb = Callable[[str, int, int], None]


@dataclass
class Section:
    title: str
    goal: str
    body: str = ""
    sources: list[Evidence] = field(default_factory=list)


@dataclass
class GeneratedDoc:
    title: str
    markdown: str
    sections: list[Section]
    sources: list[Evidence]
    word_count: int

    @property
    def page_estimate(self) -> int:
        # ~450 words per A4 page of Arabic body text.
        return max(1, round(self.word_count / 450))


_OUTLINE_SCHEMA = {
    "type": "object",
    "properties": {
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "goal": {"type": "string"},
                },
                "required": ["title", "goal"],
            },
        }
    },
    "required": ["sections"],
}


def _outline_cap(target_pages: int | None) -> int | None:
    """Section-count ceiling derived from the requested page count.

    Without this the outline falls back to ``SETTINGS.gen_max_sections`` (40),
    which is the dominant cause of "asked 10 pages → got ~100": a high section
    count multiplied by a per-section token budget yields N× the intended length.
    A ~2-pages-per-section heuristic (plus a small constant for cover/TOC/sources)
    keeps the count proportional to the ask, clamped to the global ceiling.
    Returns ``None`` (use the default cap) when no page target was given.
    """
    if not target_pages:
        return None
    return min(SETTINGS.gen_max_sections, max(3, round(target_pages / 2) + 2))


def _section_token_budget(target_pages: int | None, num_sections: int = 1) -> int:
    """Per-section *output*-token ceiling.

    The whole-document budget (~720 output tokens per A4 page of Arabic body
    text, i.e. ~450 words × ~1.6 tokens/word) is computed ONCE and DIVIDED across
    the count-capped sections — never multiplied per section. This is the second
    half of the page-count fix: total output now scales with ``target_pages``
    instead of ``num_sections × full-doc budget``. Clamped to a sane window so a
    section is never starved (floor) nor allowed to exceed the model ceiling.
    """
    if not target_pages:
        return SETTINGS.gen_section_tokens
    whole_doc = int(target_pages * 450 * 1.6)  # words→tokens, whole document
    per = whole_doc // max(1, num_sections)
    return max(1536, min(per, SETTINGS.gen_max_output_tokens))


# --------------------------------------------------------------------------- #
# Outline                                                                      #
# --------------------------------------------------------------------------- #
def build_outline(
    title: str,
    goal: str,
    rag: RagEngine,
    *,
    prescribed: tuple[str, ...] | None = None,
    language: str = "ar",
    max_sections: int | None = None,
    target_pages: int | None = None,
) -> list[Section]:
    max_sections = max_sections or SETTINGS.gen_max_sections
    evidence = rag.retrieve(f"{title}\n{goal}", k=10)
    ev_block = rag.format_evidence(evidence, max_chars=12000)

    prescribed_block = ""
    if prescribed:
        prescribed_block = (
            "التزم بالأقسام المطلوبة التالية كهيكل أساسي (يمكنك تقسيم القسم الواحد إلى "
            "أقسام فرعية إذا كان كبيرًا، ولا تحذف أيًا منها):\n- "
            + "\n- ".join(prescribed)
        )

    # Make the requested document size explicit so the model sizes the outline to
    # the target instead of padding it toward the section ceiling.
    pages_block = (
        f"الحجم المستهدف للوثيقة: نحو {target_pages} صفحة A4؛ اجعل عدد الأقسام مناسبًا "
        f"لهذا الحجم (لا تتجاوز {max_sections} قسمًا) دون حشو.\n\n"
        if target_pages
        else ""
    )

    prompt = (
        f"المطلوب إعداد وثيقة بعنوان: «{title}».\n"
        f"الهدف: {goal}\n\n"
        f"{pages_block}"
        f"{prescribed_block}\n\n"
        "اعتمادًا على الأدلة التالية المستخرجة من ملفات المنظمة، ضع خطة أقسام تفصيلية "
        "للوثيقة. لكل قسم: عنوان دقيق و«goal» يصف ما يجب أن يغطيه القسم تحديدًا مستندًا "
        "إلى واقع المنظمة. اجعل الأقسام كافية لإنتاج وثيقة احترافية كاملة "
        f"(حتى {max_sections} قسمًا).\n\n"
        f"== الأدلة ==\n{ev_block or 'لا توجد أدلة كافية؛ صمّم الخطة وفق أفضل الممارسات واذكر مواضع نقص الدليل.'}"
    )
    data = genai_client.generate_json(
        prompt,
        system=system_prompt(),
        response_schema=_OUTLINE_SCHEMA,
        temperature=0.2,
        default={"sections": []},
    )
    secs = [
        Section(title=s.get("title", "").strip(), goal=s.get("goal", "").strip())
        for s in (data.get("sections") or [])
        if s.get("title")
    ][:max_sections]

    # Guarantee prescribed sections exist even if the model dropped some.
    if prescribed:
        have = {s.title for s in secs}
        for p in prescribed:
            label = p.split(" (")[0]
            if not any(label[:18] in s.title or s.title[:18] in label for s in secs):
                secs.append(Section(title=label, goal=p))
    return secs or [Section(title=title, goal=goal)]


# --------------------------------------------------------------------------- #
# Section drafting                                                             #
# --------------------------------------------------------------------------- #
def _draft_section(
    section: Section,
    doc_title: str,
    outline_titles: list[str],
    rag: RagEngine,
    *,
    section_tokens: int,
    language: str,
    target_words: int | None = None,
) -> Section:
    evidence = rag.retrieve(f"{section.title}\n{section.goal}", k=8)
    section.sources = evidence
    ev_block = rag.format_evidence(evidence, max_chars=18000)
    coherence = " | ".join(outline_titles)

    # The token budget is only a ceiling; an explicit length target is what makes
    # the model size the section to the requested document length.
    length_block = (
        f"اجعل طول هذا القسم نحو {target_words} كلمة (لا تقل كثيرًا ولا تتجاوزها كثيرًا) "
        "دون حشو أو تكرار.\n"
        if target_words
        else ""
    )

    prompt = (
        f"تكتب الآن قسمًا واحدًا من وثيقة «{doc_title}».\n"
        f"عنوان القسم: {section.title}\n"
        f"هدف القسم: {section.goal}\n\n"
        f"الخطة الكاملة للوثيقة (للاتساق فقط، لا تكتب الأقسام الأخرى): {coherence}\n\n"
        f"{length_block}"
        "اكتب محتوى القسم كاملًا ومفصّلًا واحترافيًا بصيغة Markdown:\n"
        "- ابدأ بعنوان القسم بمستوى ## ثم المحتوى.\n"
        "- استخدم جداول Markdown حيثما طلبت المهارة جداول (مصفوفات، KPIs، فجوات، RACI...).\n"
        "- استشهد بالأدلة هكذا [مصدر N] بعد كل واقعة مستمدة من الملفات.\n"
        "- لا تكرر مقدمات عامة؛ ادخل في المضمون التنفيذي مباشرة.\n"
        "- حافظ على تطابق المسميات (إدارات/أدوار/سياسات/مؤشرات) مع بقية الوثيقة.\n"
        "- عند نقص الدليل لقسم ما، اكتب توصية واضحة واذكر الدليل الناقص بدل اختلاق وقائع.\n\n"
        f"== الأدلة المتاحة لهذا القسم ==\n{ev_block or 'لا توجد أدلة مباشرة؛ استند لأفضل الممارسات واذكر نقص الدليل.'}"
    )
    body = genai_client.generate(
        prompt,
        system=system_prompt(),
        model=SETTINGS.models.generate,
        temperature=SETTINGS.gen_temperature,
        max_output_tokens=section_tokens,
    )
    section.body = (body or "").strip() or f"## {section.title}\n\n*(تعذّر توليد هذا القسم — يلزم إعادة المحاولة.)*"
    return section


def _critique(doc_title: str, sections: list[Section]) -> list[int]:
    """Return indices of sections that need revision (coherence/gaps/repetition)."""
    digest = "\n".join(
        f"[{i}] {s.title} — {len(s.body)} حرف" for i, s in enumerate(sections)
    )
    sample = "\n\n".join(f"[{i}] {s.title}\n{s.body[:600]}" for i, s in enumerate(sections))
    schema = {
        "type": "object",
        "properties": {"revise": {"type": "array", "items": {"type": "integer"}}},
        "required": ["revise"],
    }
    prompt = (
        f"راجع اتساق وجودة مسودة وثيقة «{doc_title}». "
        "حدّد أرقام الأقسام التي تعاني من: قِصر مخل، تكرار، تعارض في المسميات، أو غياب "
        "جداول/تفاصيل مطلوبة. أعد فقط قائمة الأرقام في الحقل revise (فارغة إن كانت الجودة كافية).\n\n"
        f"== فهرس الأقسام ==\n{digest}\n\n== عينات ==\n{sample[:16000]}"
    )
    data = genai_client.generate_json(prompt, response_schema=schema, temperature=0.0, default={"revise": []})
    out = [i for i in (data.get("revise") or []) if isinstance(i, int) and 0 <= i < len(sections)]
    return out[:8]  # cap revision work


# --------------------------------------------------------------------------- #
# Stitch                                                                       #
# --------------------------------------------------------------------------- #
def _stitch(title: str, sections: list[Section], all_sources: list[Evidence], language: str) -> str:
    lines: list[str] = [f"# {title}", ""]

    # Table of contents.
    lines.append("## الفهرس" if language == "ar" else "## Table of Contents")
    for i, s in enumerate(sections, 1):
        anchor = _anchor(s.title)
        lines.append(f"{i}. [{s.title}](#{anchor})")
    lines.append("")

    for s in sections:
        body = s.body.strip()
        # Ensure each section starts with a heading even if the model omitted one.
        if not re.match(r"^#{1,6}\s", body):
            body = f"## {s.title}\n\n{body}"
        lines.append(body)
        lines.append("")

    # Consolidated citations table (skill: standards/sources cited at the end).
    if all_sources:
        seen: dict[str, Evidence] = {}
        for ev in all_sources:
            seen.setdefault(ev.chunk_id, ev)
        lines.append("## قائمة المصادر والأدلة" if language == "ar" else "## Sources & Evidence")
        lines.append("")
        lines.append("| # | المستند | الموضع | المقتطف |")
        lines.append("|---|---|---|---|")
        for i, ev in enumerate(seen.values(), 1):
            snippet = ev.text.strip().replace("\n", " ")[:140]
            heading = ev.heading_path or "—"
            lines.append(f"| {i} | {ev.doc_name} | {heading} | {snippet}… |")
        lines.append("")

    return "\n".join(lines)


def _anchor(title: str) -> str:
    return re.sub(r"\s+", "-", re.sub(r"[^\w\s؀-ۿ-]", "", title.strip().lower()))


# --------------------------------------------------------------------------- #
# Public API                                                                   #
# --------------------------------------------------------------------------- #
def generate_document(
    title: str,
    goal: str,
    rag: RagEngine,
    *,
    prescribed: tuple[str, ...] | None = None,
    language: str = "ar",
    target_pages: int | None = None,
    critique: bool = True,
    parallel_sections: bool = True,
    on_progress: ProgressCb | None = None,
) -> GeneratedDoc:
    """Generate one large, RAG-grounded document end-to-end."""
    def progress(stage: str, done: int, total: int) -> None:
        if on_progress:
            on_progress(stage, done, total)

    progress("outline", 0, 1)
    sections = build_outline(
        title, goal, rag,
        prescribed=prescribed, language=language,
        max_sections=_outline_cap(target_pages), target_pages=target_pages,
    )
    progress("outline", 1, 1)

    outline_titles = [s.title for s in sections]
    # Per-section budget is derived AFTER the count-capped outline so the whole-doc
    # budget is divided across the real section count, not multiplied per section.
    section_tokens = _section_token_budget(target_pages, len(sections))
    # Per-section word target (~450 words/page) so the model aims for the requested
    # length rather than filling the (much larger) token ceiling.
    target_words = (
        max(250, round(target_pages * 450 / max(1, len(sections)))) if target_pages else None
    )
    total = len(sections)

    if parallel_sections and total > 1:
        # Bounded concurrency keeps us under the model RPM while cutting wall-clock.
        workers = min(4, total)
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {
                ex.submit(
                    _draft_section, s, title, outline_titles, rag,
                    section_tokens=section_tokens, language=language, target_words=target_words,
                ): idx
                for idx, s in enumerate(sections)
            }
            done = 0
            for fut in concurrent.futures.as_completed(futs):
                idx = futs[fut]
                sections[idx] = fut.result()
                done += 1
                progress("drafting", done, total)
    else:
        for i, s in enumerate(sections):
            sections[i] = _draft_section(
                s, title, outline_titles, rag, section_tokens=section_tokens,
                language=language, target_words=target_words,
            )
            progress("drafting", i + 1, total)

    if critique and total > 2:
        progress("critique", 0, 1)
        to_revise = _critique(title, sections)
        progress("critique", 1, 1)
        for j, idx in enumerate(to_revise):
            sections[idx] = _draft_section(
                sections[idx], title, outline_titles, rag,
                section_tokens=section_tokens, language=language, target_words=target_words,
            )
            progress("revising", j + 1, len(to_revise))

    all_sources: list[Evidence] = [ev for s in sections for ev in s.sources]
    markdown = _stitch(title, sections, all_sources, language)
    word_count = len(re.findall(r"\S+", markdown))
    progress("done", 1, 1)

    return GeneratedDoc(
        title=title,
        markdown=markdown,
        sections=sections,
        sources=all_sources,
        word_count=word_count,
    )


def generate_deliverable(
    deliverable_key: str,
    rag: RagEngine,
    *,
    department: str | None = None,
    language: str = "ar",
    target_pages: int | None = None,
    on_progress: ProgressCb | None = None,
) -> GeneratedDoc:
    """Generate one of the skill's prescribed deliverables (current_state,
    org_structure, strategy, governance, department_pack, ...)."""
    d: Deliverable | None = DELIVERABLES_BY_KEY.get(deliverable_key)
    if d is None:
        raise KeyError(f"Unknown deliverable: {deliverable_key}")
    title = d.title_ar
    goal = d.goal_ar
    if deliverable_key == "department_pack" and department:
        title = f"حزمة تشغيل إدارة: {department}"
        goal = f"{d.goal_ar} الإدارة المستهدفة: {department}."
    return generate_document(
        title, goal, rag,
        prescribed=d.sections,
        language=language,
        target_pages=target_pages,
        on_progress=on_progress,
    )

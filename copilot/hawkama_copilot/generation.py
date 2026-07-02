"""Large multi-page document generation, grounded in RAG.

The single hardest requirement: produce *many pages from one request* despite a
~64K output-token ceiling. We never ask for the whole document at once. Instead:

    outline → [per CHUNK of sections: retrieve + draft each → critique → revise]
    → stitch (cover + TOC + sections + citations table).

Each section is retrieved and drafted independently, so total document length is
bounded by section_count × per_section_tokens, not by one model call. A shared
"coherence memo" (the full outline + canonical terminology) is injected into every
section so names stay consistent across pages. Every factual sentence carries a
[مصدر N] citation back to the evidence, satisfying the skill's grounding rule.

Two pillars layered on top of that backbone:

* **V9 — grounded per-axis engine.** Generated policies/procedures used to be
  generic boilerplate. The engine now PROBES the real inputs + benchmark criteria
  + the current-state report for each governance axis (the 17 dimensions) and
  derives axis-specific current-state → gaps → recommendations → improvements. That
  diagnostic is then injected as grounding into every downstream section, so
  procedures are named per REAL department, not invented examples.

* **V10 — chunked generation with per-chunk critique.** Sending the whole plan in
  one shot degrades accuracy. The outline is split into small CHUNKS; each chunk's
  sections are drafted and then critiqued/revised *before* the next chunk, so the
  review context stays tight and the assembled document holds together.

* **BE-3 — org structure grounded in `model.orgUnits`.** The org-structure section
  is rendered DETERMINISTICALLY from the real org units (the same source of truth
  the frontend's deterministic chart uses), never free-form AI prose.
"""

from __future__ import annotations

import concurrent.futures
import re
from dataclasses import dataclass, field
from typing import Callable

from . import genai_client
from .config import SETTINGS
from .rag import Evidence, RagEngine
from .skill import (
    DELIVERABLES,
    DELIVERABLES_BY_KEY,
    GOVERNANCE_AXES,
    Deliverable,
    GovernanceAxis,
    axis_system_prompt,
    grounded_system_prompt,
    grounding_brief,
    system_prompt,
)


ProgressCb = Callable[[str, int, int], None]


@dataclass
class Section:
    title: str
    goal: str
    body: str = ""
    sources: list[Evidence] = field(default_factory=list)
    pinned: bool = False  # deterministic body (org chart / axis matrix) — never redrafted
    # P11 — True unless this section was drafted with ZERO retrieved evidence, in
    # which case its content is best-practice guidance rather than a claim about
    # the organization. Pinned sections are always grounded (built from the real
    # org units, not free-form prose).
    grounded: bool = True


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

    @property
    def ungrounded_sections(self) -> int:
        """Count of sections drafted with no retrieved evidence (P11) — the
        machine-readable signal that a thin/empty corpus produced best-practice
        boilerplate rather than facts about the organization."""
        return sum(1 for s in self.sections if not s.grounded)


# --------------------------------------------------------------------------- #
# Grounding context (V9 / BE-3)                                                #
# --------------------------------------------------------------------------- #
@dataclass
class GroundingContext:
    """The real-world inputs a grounded generation derives from.

    Carries the structured truth the RAG corpus can't express on its own: the
    company name, its actual org units / roles (BE-3), the department list and
    benchmark criteria to name explicitly, and the current-state diagnostic the
    per-axis pipeline produced. Passed (optionally) into every public entry point;
    when absent, generation behaves exactly as before.
    """

    company: str = ""
    org_units: list[dict] = field(default_factory=list)  # raw model.orgUnits dicts
    roles: list[dict] = field(default_factory=list)      # raw model.roles dicts
    departments: list[str] = field(default_factory=list)  # explicit department names
    criteria: list[str] = field(default_factory=list)     # benchmark criteria/standards
    current_state_md: str = ""                            # grounded diagnostic digest
    # P1/D1 — the confirmed wizard plan's axes + free-text owner notes, folded in
    # by _plan_grounding() so they reach the outline prompt AND every per-section
    # drafting prompt (both go through brief(), below).
    axes: list[str] = field(default_factory=list)
    notes: str = ""

    @property
    def is_empty(self) -> bool:
        return not (
            self.company
            or self.org_units
            or self.roles
            or self.departments
            or self.criteria
            or self.current_state_md
            or self.axes
            or self.notes
        )

    def department_names(self) -> list[str]:
        """Real department names: explicit list ∪ org-unit names, de-duplicated and
        order-preserving. This is what the engine injects so procedures are named
        per real department rather than with generic placeholders."""
        names: list[str] = [d.strip() for d in self.departments if (d or "").strip()]
        seen = {n for n in names}
        for u in self.org_units:
            n = (u.get("name") or "").strip()
            if n and n not in seen:
                names.append(n)
                seen.add(n)
        return names

    def brief(self) -> str:
        """The compact company-specific briefing injected into grounded prompts."""
        return grounding_brief(
            company=self.company,
            departments=tuple(self.department_names()),
            criteria=tuple(c for c in self.criteria if c),
            has_current_state=bool(self.current_state_md),
            axes=tuple(a for a in self.axes if a),
            notes=self.notes,
        )


def _as_grounding(ground: "GroundingContext | dict | None") -> GroundingContext | None:
    """Accept either a GroundingContext or a raw dict (as the HTTP layer receives)."""
    if ground is None:
        return None
    if isinstance(ground, GroundingContext):
        return ground
    if isinstance(ground, dict):
        g = GroundingContext(
            company=ground.get("company", "") or "",
            org_units=list(ground.get("org_units") or ground.get("orgUnits") or []),
            roles=list(ground.get("roles") or []),
            departments=list(ground.get("departments") or []),
            criteria=list(ground.get("criteria") or []),
            current_state_md=ground.get("current_state_md") or ground.get("current_state") or "",
            axes=list(ground.get("axes") or []),
            notes=ground.get("notes") or "",
        )
        return None if g.is_empty else g
    return None


# P11 — fallback text injected in place of the evidence block when retrieval
# comes back empty (fresh/thin tenant corpus). Previously this just told the
# model to "design per best practices" with no instruction to LABEL that content
# as general guidance rather than a fact about the organization — so a thin
# corpus silently produced prose that read exactly like a grounded finding. Both
# now explicitly require a visible disclaimer instead of a silent fallback.
_NO_EVIDENCE_OUTLINE_NOTE = (
    "لا توجد أدلة كافية من ملفات المنظمة. صمّم الخطة وفق أفضل الممارسات العامة، "
    "واذكر بوضوح أن الأقسام التي تفتقر إلى دليل ستُبنى على إرشادات عامة لا على "
    "وقائع مؤكدة عن المنظمة إلى أن تتوفر الأدلة."
)
_NO_EVIDENCE_SECTION_NOTE = (
    "لا توجد أدلة مباشرة من ملفات المنظمة لهذا القسم. لا تختلق وقائع كأنها عن "
    "المنظمة. اكتب المحتوى بصفته إرشادًا عامًا وفق أفضل الممارسات فقط، وابدأ "
    "القسم بسطر تنبيه صريح مشابه لِـ: «⚠️ لا تتوفر أدلة من ملفات المنظمة لهذا "
    "القسم — المحتوى أدناه إرشادات عامة وفق أفضل الممارسات وتحتاج مراجعة وتكييف "
    "على واقع المنظمة الفعلي.» ثم أكمل المحتوى دون عرضه كواقع مؤكد أو خاص بالمنظمة."
)


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


# P1/D3 — moderate defaults for the "no target_pages at all" path. Previously an
# absent target_pages fell all the way back to SETTINGS.gen_max_sections (40)
# sections × a FLAT SETTINGS.gen_section_tokens (8192) per section — i.e. an
# effectively unbounded ~40×8192 token document, the confirmed "asked small, got
# 105 pages" defect. A caller that forgets target_pages now gets the SAME divide
# math as the target_pages-given path, just anchored to a modest assumed length
# (mirrors the wizard's own default: services/governanceChat.ts fallbackBuildPlan
# defaults targetPages to ~12 when the request doesn't state one).
_DEFAULT_TARGET_PAGES = 12
_DEFAULT_SECTIONS_CAP = 14


def _outline_cap(target_pages: int | None) -> int:
    """Section-count ceiling derived from the requested page count.

    A ~2-pages-per-section heuristic (plus a small constant for cover/TOC/sources)
    keeps the count proportional to the ask, clamped to the global ceiling. When no
    page target was given, falls back to the bounded ``_DEFAULT_SECTIONS_CAP``
    (never the old unbounded ``SETTINGS.gen_max_sections``).
    """
    if not target_pages:
        return _DEFAULT_SECTIONS_CAP
    return min(SETTINGS.gen_max_sections, max(3, round(target_pages / 2) + 2))


def _section_token_budget(target_pages: int | None, num_sections: int = 1) -> int:
    """Per-section *output*-token ceiling.

    The whole-document budget (~720 output tokens per A4 page of Arabic body
    text, i.e. ~450 words × ~1.6 tokens/word) is computed ONCE and DIVIDED across
    the count-capped sections — never multiplied per section. This is the second
    half of the page-count fix: total output now scales with the (real or
    assumed) target page count instead of ``num_sections × full-doc budget``.
    Clamped to a sane window so a section is never starved (floor) nor allowed to
    exceed the model ceiling. When no page target was given, the whole-document
    budget is derived from ``_DEFAULT_TARGET_PAGES`` instead of the old flat
    ``SETTINGS.gen_section_tokens`` fallback.
    """
    pages = target_pages or _DEFAULT_TARGET_PAGES
    whole_doc = int(pages * 450 * 1.6)  # words→tokens, whole document
    per = whole_doc // max(1, num_sections)
    return max(1536, min(per, SETTINGS.gen_max_output_tokens))


def _chunk_indices(n: int, chunk_size: int) -> list[list[int]]:
    """Split ``range(n)`` into contiguous chunks of at most ``chunk_size`` indices.

    V10: sections are drafted and critiqued chunk-by-chunk rather than in one
    mega-pass, so this is the unit the per-chunk review loop iterates over.
    """
    size = max(1, chunk_size)
    return [list(range(i, min(i + size, n))) for i in range(0, n, size)]


# --------------------------------------------------------------------------- #
# Org structure — deterministic, grounded in model.orgUnits (BE-3)            #
# --------------------------------------------------------------------------- #
def _mermaid_label(s: str) -> str:
    """Mirror the frontend `buildOrgChartMermaid` label escaping so the backend
    chart is byte-compatible: drop <br>, strip []{}|" and collapse whitespace."""
    s = re.sub(r"<br\s*/?>", " ", s or "", flags=re.IGNORECASE)
    s = re.sub(r'[\[\]{}|"]', " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def build_org_chart_mermaid(org_units: list[dict], roles: list[dict] | None = None,
                            company: str = "", include_roles: bool = True) -> str:
    """Deterministic org-chart Mermaid built PURELY from the org units (+ roles),
    mirroring the frontend `buildOrgChartMermaid` exactly: node ids by array order
    (``u0, u1, …``), ``parentId`` → tree edges, roles attached by ``unitId`` with a
    dotted edge. Identical input → identical output, invents nothing (BE-3).

    P1/D4 — also mirrors the frontend's ROOT SYNTHESIS (services/diagramService.ts
    `synthesizeRoot`): real org models often have MANY parentless top-level units,
    which would otherwise render as disconnected mini-trees with no single head.
    When the model isn't already single-rooted (zero or 2+ real roots), a
    deterministic ``org_root`` node is synthesized and every former root hangs
    under it, so the backend chart matches the frontend's byte-for-byte."""
    units = [u for u in (org_units or []) if isinstance(u, dict)]
    if not units:
        name = _mermaid_label(company) or "الجهة"
        return f'flowchart TD\n  org_root["{name}"]'

    u_id: dict[str, str] = {}
    for i, u in enumerate(units):
        uid = u.get("id")
        if uid is not None and uid not in u_id:
            u_id[uid] = f"u{i}"

    def present(uid) -> bool:
        return bool(uid) and uid in u_id

    roles_list = [r for r in (roles or []) if isinstance(r, dict)]

    # Root units = no real parent inside THIS model (parentId absent, dangling, or
    # self-referential — `present()` is false for the first two, and the third is
    # excluded explicitly). Exactly one root → already single-rooted, left as-is;
    # zero or 2+ roots → synthesize one head so the chart stays one connected tree.
    root_units = [u for u in units if not present(u.get("parentId")) or u.get("parentId") == u.get("id")]
    synthesize_root = len(root_units) != 1
    ROOT_ID = "org_root"

    def root_label() -> str:
        # Deterministic priority (array order, never a deputy): (1) a STRONG
        # chief-exec title, (2) a loose "الرئيس" match — both excluding
        # نائب/deputy/vice so a VP listed before the CEO can never win — (3) the
        # first unit-less role, (4) the company name, (5) the literal CEO label.
        deputy_re = re.compile(r"نائب|deputy|vice", re.IGNORECASE)
        strong_re = re.compile(r"الرئيس\s+التنفيذي|المدير العام|\bCEO\b|chief executive", re.IGNORECASE)
        loose_re = re.compile(r"الرئيس")

        def not_deputy(t) -> bool:
            return bool(t) and not deputy_re.search(t)

        ceo = next((r for r in roles_list if not_deputy(r.get("title")) and strong_re.search(r.get("title") or "")), None)
        if ceo is None:
            ceo = next((r for r in roles_list if not_deputy(r.get("title")) and loose_re.search(r.get("title") or "")), None)
        if ceo is None:
            ceo = next((r for r in roles_list if not r.get("unitId")), None)
        title = ceo.get("title") if ceo else None
        return _mermaid_label(title or company or "الرئيس التنفيذي") or "الرئيس التنفيذي"

    lines = ["flowchart TD"]
    for i, u in enumerate(units):
        label = _mermaid_label(u.get("name") or u.get("id") or "")
        lines.append(f'  {u_id.get(u.get("id"), f"u{i}")}["{label}"]')
    if synthesize_root:
        lines.append(f'  {ROOT_ID}["{root_label()}"]')
    for u in units:
        pid = u.get("parentId")
        if present(pid) and pid != u.get("id"):
            lines.append(f"  {u_id[pid]} --> {u_id[u.get('id')]}")
    if synthesize_root:
        for u in root_units:
            lines.append(f"  {ROOT_ID} --> {u_id[u.get('id')]}")
    if include_roles:
        for ri, r in enumerate(roles_list):
            if present(r.get("unitId")):
                rid = f"r{ri}"
                label = _mermaid_label(r.get("title") or r.get("id") or "")
                lines.append(f'  {rid}["{label}"]')
                lines.append(f"  {u_id[r.get('unitId')]} -.-> {rid}")
    return "\n".join(lines)


def render_org_structure_md(org_units: list[dict], roles: list[dict] | None = None,
                            company: str = "", language: str = "ar") -> str:
    """The org-structure section, GROUNDED deterministically in the real units:
    a Mermaid chart (identical to the frontend's) + a units table (name, parent,
    mandate) + a roles table. No model call — so it can never drift or invent units
    relative to the canonical chart (BE-3)."""
    units = [u for u in (org_units or []) if isinstance(u, dict)]
    by_id = {u.get("id"): u for u in units}
    heading = "## الهيكل العام (مبني من الوحدات الفعلية)" if language == "ar" else "## Organization Structure (from actual units)"
    out = [heading, ""]
    note = (
        "هذا الهيكل مبنيٌّ آلياً من الوحدات التنظيمية الفعلية للمنظمة (مصدر الحقيقة "
        "نفسه الذي يرسم منه المخطط)، فلا يخترع وحدات ولا يتعارض مع بقية الوثيقة."
    )
    out.append(note if language == "ar" else "Built automatically from the organization's real units.")
    out.append("")
    out.append("```mermaid")
    out.append(build_org_chart_mermaid(units, roles, company=company))
    out.append("```")
    out.append("")
    if units:
        out.append("| الوحدة | تتبع لـ | التكليف/الغرض |" if language == "ar" else "| Unit | Reports to | Mandate |")
        out.append("|---|---|---|")
        for u in units:
            parent = by_id.get(u.get("parentId"))
            pname = (parent.get("name") if parent else "") or "—"
            mandate = (u.get("mandate") or u.get("objective") or "—").replace("\n", " ").strip() or "—"
            out.append(f"| {(u.get('name') or u.get('id') or '—')} | {pname} | {mandate} |")
        out.append("")
    role_rows = [r for r in (roles or []) if isinstance(r, dict) and r.get("title")]
    if role_rows:
        out.append("| الدور/المسمى | الوحدة |" if language == "ar" else "| Role | Unit |")
        out.append("|---|---|")
        for r in role_rows:
            unit = by_id.get(r.get("unitId"))
            uname = (unit.get("name") if unit else "") or "—"
            out.append(f"| {r.get('title')} | {uname} |")
        out.append("")
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# Per-axis pipeline (V9)                                                       #
# --------------------------------------------------------------------------- #
@dataclass
class AxisFinding:
    axis_key: str
    axis_name: str
    current_state: str
    maturity: int
    gaps: list[str]
    impact: str
    root_cause: str
    recommendations: list[str]
    improvements: list[str]
    sources: list[Evidence] = field(default_factory=list)


_AXIS_SCHEMA = {
    "type": "object",
    "properties": {
        "current_state": {"type": "string"},
        "maturity": {"type": "integer"},
        "gaps": {"type": "array", "items": {"type": "string"}},
        "impact": {"type": "string"},
        "root_cause": {"type": "string"},
        "recommendations": {"type": "array", "items": {"type": "string"}},
        "improvements": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["current_state", "gaps", "recommendations"],
}


def _axis_queries(axis: GovernanceAxis, ground: GroundingContext | None) -> list[str]:
    """Multi-angle probe for one axis: the axis itself, what to look for in the
    inputs, and the company's real departments — so retrieval surfaces the actual
    evidence for THIS axis rather than one generic embedding hit."""
    qs = [f"{axis.name_ar} {axis.probe}", axis.name_ar]
    if ground:
        depts = ground.department_names()
        if depts:
            qs.append(f"{axis.name_ar} " + " ".join(depts[:6]))
    return qs


def probe_axis(axis: GovernanceAxis, rag: RagEngine, ground: GroundingContext | None) -> AxisFinding:
    """Probe inputs + criteria + current-state for ONE axis and return its
    structured current-state → gaps → recommendations → improvements (V9)."""
    evidence = rag.retrieve_multi(_axis_queries(axis, ground), k=6)
    ev_block = rag.format_evidence(evidence, max_chars=9000)
    brief = ground.brief() if ground else ""
    cs = (ground.current_state_md if ground else "") or ""
    cs_block = (
        f"\n\n== مقتطف من تقرير الواقع الراهن ==\n{cs[:4000]}" if cs else ""
    )
    prompt = (
        f"قيّم محور «{axis.name_ar}» للمنظمة بدقة واستناداً إلى الأدلة فقط.\n"
        f"اسبر في المدخلات تحديداً: {axis.probe}.\n"
        f"قارن الوضع الراهن بالمعيار المرجعي: {axis.benchmark}.\n\n"
        "أعد النتائج في JSON بالحقول: current_state (وصف الوضع الراهن مستنداً للأدلة)، "
        "maturity (مستوى نضج 1–5)، gaps (قائمة فجوات محددة)، impact (أثر الفجوات)، "
        "root_cause (السبب الجذري)، recommendations (توصيات قابلة للتنفيذ ومرتبطة "
        "بإدارات المنظمة الفعلية)، improvements (تحسينات مقترحة). "
        "سمِّ الإدارات والأنظمة بأسمائها الحقيقية من المدخلات، ولا تعمّم.\n\n"
        f"== الأدلة ==\n{ev_block or 'لا توجد أدلة مباشرة لهذا المحور؛ اذكر النقص واطلب المُدخل اللازم بدل الاختلاق.'}"
        f"{cs_block}"
    )
    data = genai_client.generate_json(
        prompt,
        system=axis_system_prompt(axis, brief),
        response_schema=_AXIS_SCHEMA,
        temperature=0.2,
        max_output_tokens=SETTINGS.gen_axis_tokens,
        default={"current_state": "", "gaps": [], "recommendations": []},
    )

    def _strlist(v) -> list[str]:
        if isinstance(v, list):
            return [str(x).strip() for x in v if str(x).strip()]
        return [str(v).strip()] if str(v).strip() else []

    maturity = data.get("maturity")
    try:
        maturity = max(1, min(5, int(maturity)))
    except (TypeError, ValueError):
        maturity = 0
    return AxisFinding(
        axis_key=axis.key,
        axis_name=axis.name_ar,
        current_state=str(data.get("current_state") or "").strip(),
        maturity=maturity,
        gaps=_strlist(data.get("gaps")),
        impact=str(data.get("impact") or "").strip(),
        root_cause=str(data.get("root_cause") or "").strip(),
        recommendations=_strlist(data.get("recommendations")),
        improvements=_strlist(data.get("improvements")),
        sources=evidence,
    )


def run_axis_pipeline(
    rag: RagEngine,
    ground: GroundingContext | None = None,
    *,
    axes: tuple[GovernanceAxis, ...] | None = None,
    on_progress: ProgressCb | None = None,
) -> list[AxisFinding]:
    """Probe every governance axis (bounded concurrency) → per-axis findings.

    This is the heart of V9: each axis independently detects its current-state,
    gaps, recommendations and improvements from the real inputs + its benchmark +
    the current-state report, so the resulting diagnostic is grounded per axis
    rather than a single generic pass."""
    axes = axes or GOVERNANCE_AXES[: SETTINGS.gen_axis_max]
    findings: list[AxisFinding | None] = [None] * len(axes)
    total = len(axes)
    workers = min(SETTINGS.gen_axis_concurrency, max(1, total))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(probe_axis, ax, rag, ground): i for i, ax in enumerate(axes)}
        done = 0
        for fut in concurrent.futures.as_completed(futs):
            findings[futs[fut]] = fut.result()
            done += 1
            if on_progress:
                on_progress("axis", done, total)
    return [f for f in findings if f is not None]


def render_axis_findings_md(findings: list[AxisFinding], language: str = "ar") -> str:
    """Deterministic markdown for the axis findings: a per-axis block (current-state
    → maturity → gaps → root cause → recommendations → improvements) plus the
    consolidated gaps matrix. Built from the structured findings, so it never drifts
    from what each axis actually detected."""
    out = ["## نتائج التقييم حسب الأبعاد (تحليل لكل محور)", ""]
    for f in findings:
        out.append(f"### {f.axis_name}" + (f" — مستوى النضج {f.maturity}/5" if f.maturity else ""))
        if f.current_state:
            out.append(f"**الوضع الراهن:** {f.current_state}")
        if f.gaps:
            out.append("**الفجوات:**")
            out.extend(f"- {g}" for g in f.gaps)
        if f.root_cause:
            out.append(f"**السبب الجذري:** {f.root_cause}")
        if f.impact:
            out.append(f"**الأثر:** {f.impact}")
        if f.recommendations:
            out.append("**التوصيات:**")
            out.extend(f"- {r}" for r in f.recommendations)
        if f.improvements:
            out.append("**التحسينات:**")
            out.extend(f"- {im}" for im in f.improvements)
        out.append("")
    # Consolidated gaps matrix (skill §8.4 §5).
    rows = [(f.axis_name, g, f.impact or "—", f.root_cause or "—") for f in findings for g in f.gaps]
    if rows:
        out.append("## مصفوفة الفجوات")
        out.append("")
        out.append("| البعد | الفجوة | الأثر | السبب الجذري |")
        out.append("|---|---|---|---|")
        for axis_name, gap, impact, root in rows:
            out.append(f"| {axis_name} | {gap} | {impact} | {root} |")
        out.append("")
    return "\n".join(out)


def axis_findings_digest(findings: list[AxisFinding], max_chars: int = 6000) -> str:
    """A compact, plain-text digest of the diagnostic for injection as grounding
    into downstream deliverables (so policies/procedures derive from the real
    gaps). One line per axis: current-state + the top gap + the top recommendation."""
    lines: list[str] = []
    for f in findings:
        bits = [f"• {f.axis_name}:"]
        if f.current_state:
            bits.append(f.current_state)
        if f.gaps:
            bits.append(f"— فجوة: {f.gaps[0]}")
        if f.recommendations:
            bits.append(f"— توصية: {f.recommendations[0]}")
        lines.append(" ".join(bits))
    text = "\n".join(lines)
    return text[:max_chars]


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
    ground: "GroundingContext | dict | None" = None,
) -> list[Section]:
    max_sections = max_sections or SETTINGS.gen_max_sections
    ground = _as_grounding(ground)
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
    brief = ground.brief() if ground else ""
    brief_block = f"== سياق المنظمة ==\n{brief}\n\n" if brief else ""

    prompt = (
        f"المطلوب إعداد وثيقة بعنوان: «{title}».\n"
        f"الهدف: {goal}\n\n"
        f"{pages_block}"
        f"{brief_block}"
        f"{prescribed_block}\n\n"
        "اعتمادًا على الأدلة التالية المستخرجة من ملفات المنظمة، ضع خطة أقسام تفصيلية "
        "للوثيقة. لكل قسم: عنوان دقيق و«goal» يصف ما يجب أن يغطيه القسم تحديدًا مستندًا "
        "إلى واقع المنظمة. اجعل الأقسام كافية لإنتاج وثيقة احترافية كاملة "
        f"(حتى {max_sections} قسمًا).\n\n"
        f"== الأدلة ==\n{ev_block or _NO_EVIDENCE_OUTLINE_NOTE}"
    )
    data = genai_client.generate_json(
        prompt,
        system=grounded_system_prompt(brief) if ground else system_prompt(),
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
    ground: GroundingContext | None = None,
    brief: str = "",
) -> Section:
    if section.pinned:  # deterministic body (org chart / axis matrix) — keep as-is
        return section
    evidence = rag.retrieve(f"{section.title}\n{section.goal}", k=8)
    section.sources = evidence
    # P11 — zero retrieved evidence ⇒ this section's content is best-practice
    # guidance, not a fact about the organization; surfaced to callers via
    # GeneratedDoc.ungrounded_sections (see api._doc_payload).
    section.grounded = bool(evidence)
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

    # V9 grounding: name the real departments and lean on the current-state
    # diagnostic so the section is derived from inputs, not a generic template.
    ground_block = ""
    dept_rule = ""
    if ground:
        depts = ground.department_names()
        if depts:
            dept_rule = (
                "- عند ذكر الإدارات أو الإجراءات، استخدم أسماء الإدارات الفعلية التالية "
                "حصراً ووزّع الإجراءات عليها بالاسم: " + "، ".join(depts) + ".\n"
            )
        if ground.current_state_md:
            ground_block = (
                "\n\n== الواقع الراهن والفجوات المرصودة (استند إليها) ==\n"
                f"{ground.current_state_md[:5000]}"
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
        f"{dept_rule}"
        "- عند نقص الدليل لقسم ما، اكتب توصية واضحة واذكر الدليل الناقص بدل اختلاق وقائع.\n\n"
        f"== الأدلة المتاحة لهذا القسم ==\n{ev_block or _NO_EVIDENCE_SECTION_NOTE}"
        f"{ground_block}"
    )
    body = genai_client.generate(
        prompt,
        system=grounded_system_prompt(brief) if ground else system_prompt(),
        model=SETTINGS.models.generate,
        temperature=SETTINGS.gen_temperature,
        max_output_tokens=section_tokens,
    )
    section.body = (body or "").strip() or f"## {section.title}\n\n*(تعذّر توليد هذا القسم — يلزم إعادة المحاولة.)*"
    return section


def _critique(doc_title: str, sections: list[Section]) -> list[int]:
    """Return indices (into the passed list) of sections that need revision.

    Operates on whatever slice it is handed, so the chunked loop can critique one
    chunk at a time (V10) with a tight context, not the whole document at once.
    Pinned (deterministic) sections are never flagged."""
    candidates = [(i, s) for i, s in enumerate(sections) if not s.pinned]
    if not candidates:
        return []
    digest = "\n".join(f"[{i}] {s.title} — {len(s.body)} حرف" for i, s in candidates)
    sample = "\n\n".join(f"[{i}] {s.title}\n{s.body[:600]}" for i, s in candidates)
    schema = {
        "type": "object",
        "properties": {"revise": {"type": "array", "items": {"type": "integer"}}},
        "required": ["revise"],
    }
    prompt = (
        f"راجع اتساق وجودة هذا الجزء من مسودة وثيقة «{doc_title}». "
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
    ground: "GroundingContext | dict | None" = None,
    pinned_front: list[Section] | None = None,
    on_progress: ProgressCb | None = None,
) -> GeneratedDoc:
    """Generate one large, RAG-grounded document end-to-end.

    Drafting is CHUNKED (V10): the outline is split into chunks of
    ``SETTINGS.gen_chunk_sections`` sections, each chunk is drafted then critiqued
    and revised before the next chunk begins. ``ground`` (V9/BE-3) injects the real
    company inputs so sections derive from them; ``pinned_front`` are deterministic
    sections (e.g. the org chart) inserted at the front and never redrafted."""
    ground = _as_grounding(ground)
    brief = ground.brief() if ground else ""

    def progress(stage: str, done: int, total: int) -> None:
        if on_progress:
            on_progress(stage, done, total)

    progress("outline", 0, 1)
    sections = build_outline(
        title, goal, rag,
        prescribed=prescribed, language=language,
        max_sections=_outline_cap(target_pages), target_pages=target_pages,
        ground=ground,
    )
    if pinned_front:
        sections = list(pinned_front) + sections
    progress("outline", 1, 1)

    outline_titles = [s.title for s in sections]
    # Per-section budget is derived AFTER the count-capped outline so the whole-doc
    # budget is divided across the real section count, not multiplied per section.
    section_tokens = _section_token_budget(target_pages, max(1, len(sections)))
    # Per-section word target (~450 words/page) so the model aims for the requested
    # length rather than filling the (much larger) token ceiling.
    target_words = (
        max(250, round(target_pages * 450 / max(1, len(sections)))) if target_pages else None
    )
    total = len(sections)

    def draft_one(s: Section) -> Section:
        return _draft_section(
            s, title, outline_titles, rag,
            section_tokens=section_tokens, language=language,
            target_words=target_words, ground=ground, brief=brief,
        )

    # ---- chunked drafting + per-chunk critique (V10) ---------------------- #
    chunks = _chunk_indices(total, SETTINGS.gen_chunk_sections)
    drafted = 0
    for ci, idxs in enumerate(chunks):
        live = [i for i in idxs if not sections[i].pinned]
        if parallel_sections and len(live) > 1:
            workers = min(4, len(live))
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
                futs = {ex.submit(draft_one, sections[i]): i for i in live}
                for fut in concurrent.futures.as_completed(futs):
                    sections[futs[fut]] = fut.result()
        else:
            for i in live:
                sections[i] = draft_one(sections[i])
        drafted += len(idxs)
        progress("drafting", drafted, total)

        # Per-chunk review: critique only this chunk, revise what it flags, before
        # moving on — keeps the review context tight so accuracy holds (V10).
        if critique and len(live) >= 1 and total > 2:
            chunk_secs = [sections[i] for i in idxs]
            local_revise = _critique(title, chunk_secs)
            for local in local_revise:
                gi = idxs[local]
                if not sections[gi].pinned:
                    sections[gi] = draft_one(sections[gi])
            progress("critique", ci + 1, len(chunks))

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


def _with_current_state(ground: GroundingContext | None, digest: str) -> GroundingContext:
    """Return a grounding context carrying ``digest`` as the current-state diagnostic
    (keeping the rest), creating one if needed. Used so downstream deliverables
    derive from the diagnostic the per-axis pipeline produced."""
    if ground is None:
        return GroundingContext(current_state_md=digest)
    return GroundingContext(
        company=ground.company, org_units=ground.org_units, roles=ground.roles,
        departments=ground.departments, criteria=ground.criteria,
        current_state_md=ground.current_state_md or digest,
    )


def generate_deliverable(
    deliverable_key: str,
    rag: RagEngine,
    *,
    department: str | None = None,
    language: str = "ar",
    target_pages: int | None = None,
    ground: "GroundingContext | dict | None" = None,
    axis_findings: "list[AxisFinding] | None" = None,
    extra_request: str | None = None,
    on_progress: ProgressCb | None = None,
) -> GeneratedDoc:
    """Generate one of the skill's prescribed deliverables (current_state,
    org_structure, strategy, governance, department_pack, ...).

    Grounded (V9/BE-3) when ``ground`` is supplied:
    * ``current_state`` runs the per-axis pipeline and pins its findings + gaps
      matrix as deterministic sections, and folds the diagnostic into the doc's
      grounding so the rest of the report derives from it.
    * ``org_structure`` pins the deterministic org chart/units (never free prose).

    ``extra_request`` (P1/D1) is the user's original free-text ask when it was
    routed here by KEYWORD detection (``detect_deliverable``) rather than by an
    explicit structured plan — it used to be silently discarded once a keyword
    matched a canned deliverable; it is now folded into the goal so the model
    still sees what the owner actually asked for.
    """
    d: Deliverable | None = DELIVERABLES_BY_KEY.get(deliverable_key)
    if d is None:
        raise KeyError(f"Unknown deliverable: {deliverable_key}")
    ground = _as_grounding(ground)
    title = d.title_ar
    goal = d.goal_ar
    if deliverable_key == "department_pack" and department:
        title = f"حزمة تشغيل إدارة: {department}"
        goal = f"{d.goal_ar} الإدارة المستهدفة: {department}."
    if extra_request and extra_request.strip():
        goal = f"{goal}\n\nطلب المالك: {extra_request.strip()}"

    pinned: list[Section] = []

    # V9 — current-state assessment: probe every axis, render the grounded findings
    # deterministically, and inject the diagnostic so downstream sections use it.
    if deliverable_key == "current_state":
        findings = axis_findings if axis_findings is not None else run_axis_pipeline(
            rag, ground, on_progress=on_progress
        )
        if findings:
            pinned.append(
                Section(
                    title="نتائج التقييم حسب الأبعاد (تحليل لكل محور)",
                    goal="تحليل كل محور حوكمة: الوضع الراهن والفجوات والتوصيات والتحسينات.",
                    body=render_axis_findings_md(findings, language),
                    pinned=True,
                )
            )
            ground = _with_current_state(ground, axis_findings_digest(findings))

    # BE-3 — org structure grounded deterministically in the real org units.
    if deliverable_key == "org_structure" and ground and ground.org_units:
        pinned.append(
            Section(
                title="الهيكل العام (مبني من الوحدات الفعلية)",
                goal="هيكل المنظمة مبنيٌّ آلياً من الوحدات الفعلية (مصدر الحقيقة).",
                body=render_org_structure_md(ground.org_units, ground.roles, ground.company, language),
                pinned=True,
            )
        )

    return generate_document(
        title, goal, rag,
        prescribed=d.sections,
        language=language,
        target_pages=target_pages,
        ground=ground,
        pinned_front=pinned or None,
        on_progress=on_progress,
    )


# --------------------------------------------------------------------------- #
# Request routing (shared with the HTTP layer)                                #
# --------------------------------------------------------------------------- #
# Free-text request → prescribed deliverable. Mirrors HawkamaAgent.detect_deliverable
# at module level so the grounded HTTP path can route without importing the agent
# (agent.py imports this module). The agent's copy can later delegate here.
_DELIVERABLE_KEYMAP: dict[str, tuple[str, ...]] = {
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


def detect_deliverable(request: str) -> str | None:
    low = (request or "").lower()
    for key, keys in _DELIVERABLE_KEYMAP.items():
        if any(k in low for k in keys):
            return key
    return None


def _plan_prescribed_sections(plan: dict) -> tuple[str, ...] | None:
    comps = plan.get("components") if isinstance(plan, dict) else None
    if not comps:
        return None
    out = [str(c).strip() for c in comps if str(c or "").strip()]
    return tuple(out) or None


def _plan_grounding(plan: dict, ground: GroundingContext | None) -> GroundingContext:
    """Fold a confirmed build plan's departments/axes/notes into the grounding
    context (P1/D1): ``plan.departments`` extend the real org departments (so
    the wizard's edits reach ``GroundingContext.department_names()``, and in
    turn the org-chart/dept-naming rules); ``plan.axes``/``plan.notes`` reach
    ``GroundingContext.brief()`` — which is injected into the outline prompt AND
    every per-section drafting prompt (see ``build_outline``/``_draft_section``)."""
    departments = list(ground.departments) if ground else []
    for d in plan.get("departments") or []:
        d = str(d or "").strip()
        if d and d not in departments:
            departments.append(d)
    axes = [str(a or "").strip() for a in (plan.get("axes") or []) if str(a or "").strip()]
    notes = str(plan.get("notes") or "").strip()
    if ground is None:
        return GroundingContext(departments=departments, axes=axes, notes=notes)
    return GroundingContext(
        company=ground.company, org_units=ground.org_units, roles=ground.roles,
        departments=departments, criteria=ground.criteria,
        current_state_md=ground.current_state_md,
        axes=axes or ground.axes, notes=notes or ground.notes,
    )


def _draft_from_plan(
    rag: RagEngine,
    request: str,
    plan: dict,
    *,
    language: str,
    target_pages: int | None,
    ground: GroundingContext | None,
    on_progress: ProgressCb | None,
) -> GeneratedDoc:
    """P1/D1 — honor the wizard's CONFIRMED structured plan end-to-end, bypassing
    the keyword-based deliverable routing entirely.

    Before this fix, ``draft_request`` matched a deliverable keyword against the
    serialized plan text (every wizard build contains «وثيقة حوكمة», which always
    matches the «حوكمة» key) and generated the CANNED catalog deliverable — its
    own title and outline — discarding every confirmed field except page count.
    A plan already carries an explicit title/sections/length, so it drives
    ``generate_document`` directly instead of being re-guessed from prose."""
    title = str(plan.get("title") or "").strip() or (request[:120].strip() or "وثيقة حوكمة")
    pages = plan.get("pages")
    try:
        pages = int(pages) if pages else None
    except (TypeError, ValueError):
        pages = None
    pages = pages or target_pages
    if pages:
        pages = max(1, min(200, pages))
    prescribed = _plan_prescribed_sections(plan)
    ground = _plan_grounding(plan, ground)
    goal = f"إنتاج وثيقة حوكمة كاملة احترافية بعنوان «{title}» تلبي طلب المالك المؤكَّد."
    return generate_document(
        title, goal, rag,
        prescribed=prescribed,
        language=language, target_pages=pages,
        ground=ground, on_progress=on_progress,
    )


def draft_request(
    rag: RagEngine,
    request: str,
    *,
    language: str = "ar",
    target_pages: int | None = None,
    ground: "GroundingContext | dict | None" = None,
    plan: dict | None = None,
    on_progress: ProgressCb | None = None,
) -> GeneratedDoc:
    """Route a free-text request to a grounded deliverable or a free-form document.

    The grounded sibling of ``HawkamaAgent.draft``: same routing, but threads the
    ``ground`` context through so the HTTP layer can ground generation without
    touching the agent.

    ``plan`` (P1/D1) is the wizard's optional CONFIRMED structured plan
    (``{title, pages, axes, departments, components, notes}``). When present it
    takes over completely — no keyword routing — since it already states the
    title/sections/length explicitly; see ``_draft_from_plan``."""
    ground = _as_grounding(ground)
    if plan:
        return _draft_from_plan(
            rag, request, plan, language=language, target_pages=target_pages,
            ground=ground, on_progress=on_progress,
        )
    key = detect_deliverable(request)
    if key:
        department = None
        if key == "department_pack":
            m = re.search(r"إدارة\s+([^\.،\n]+)", request)
            department = m.group(1).strip() if m else None
        return generate_deliverable(
            key, rag, department=department, language=language,
            target_pages=target_pages, ground=ground, on_progress=on_progress,
            extra_request=request,
        )
    title = re.sub(r"^\s*(اكتب|صغ|أنشئ|انشئ|جهّز|أعدّ|write|generate|draft)\s*", "", request).strip()
    title = title[:120] or "وثيقة حوكمة"
    return generate_document(
        title, f"إنتاج وثيقة كاملة احترافية تلبي الطلب: {request}", rag,
        language=language, target_pages=target_pages, ground=ground, on_progress=on_progress,
    )


# --------------------------------------------------------------------------- #
# Full skill model (grounded) — V9 diagnostic shared across deliverables       #
# --------------------------------------------------------------------------- #
def generate_full_model(
    rag: RagEngine,
    *,
    company: str = "",
    department_list: list[str] | None = None,
    language: str = "ar",
    ground: "GroundingContext | dict | None" = None,
    on_progress: ProgressCb | None = None,
) -> tuple[list[GeneratedDoc], str]:
    """Run every skill deliverable in gate order → one RTL HTML manual, GROUNDED.

    The per-axis pipeline runs ONCE up front (V9); its diagnostic digest is then
    threaded into EVERY deliverable so policies/procedures/department packs derive
    from the same current-state, and the org-structure deliverable is grounded in
    the real org units (BE-3). Grounded sibling of ``HawkamaAgent.build_full_model``;
    when ``ground`` is empty it still upgrades the current-state to the per-axis
    engine (a richer, more grounded diagnostic than the old single pass)."""
    from .exporters import ManualDoc, render_manual

    ground = _as_grounding(ground)
    # Fold the explicit company into the grounding so its name is asserted.
    if company and (ground is None or not ground.company):
        ground = GroundingContext(
            company=company,
            org_units=ground.org_units if ground else [],
            roles=ground.roles if ground else [],
            departments=ground.departments if ground else [],
            criteria=ground.criteria if ground else [],
            current_state_md=ground.current_state_md if ground else "",
        )

    order = [d for d in DELIVERABLES if d.key != "department_pack"]
    total = len(order) + len(department_list or [])
    done = 0

    def step(label: str) -> None:
        if on_progress:
            on_progress(label, done, total)

    # V9 — probe the axes once; share the diagnostic with every deliverable.
    step("axes")
    findings = run_axis_pipeline(rag, ground)
    ground = _with_current_state(ground, axis_findings_digest(findings)) if findings else ground

    docs: list[GeneratedDoc] = []
    for d in order:
        step(f"deliverable:{d.key}")
        docs.append(generate_deliverable(
            d.key, rag, language=language, ground=ground,
            axis_findings=findings if d.key == "current_state" else None,
        ))
        done += 1
    for dept in department_list or []:
        step(f"department:{dept}")
        docs.append(generate_deliverable("department_pack", rag, department=dept, language=language, ground=ground))
        done += 1

    manual = render_manual(
        [ManualDoc(doc_id=f"d{i}", title=doc.title, markdown=doc.markdown) for i, doc in enumerate(docs)],
        manual_title=f"دليل الحوكمة والنموذج التشغيلي{(' — ' + company) if company else ''}",
        subtitle=company,
    )
    if on_progress:
        on_progress("done", total, total)
    return docs, manual

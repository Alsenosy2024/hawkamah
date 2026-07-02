"""The Governance & Operating Model Architect skill.

Loads the Arabic source-of-truth spec (`governance_operating_model_skill.md`) so
the agent's methodology stays in lock-step with it, and exposes the structured
pieces the agent/generator need: the persona/system prompt, the seven deliverable
phases with their section outlines, and the quality gates. Keeping the prose in
the markdown and only the *structure* here means editing the spec changes the
agent's behavior without code edits.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from .config import SETTINGS


@lru_cache(maxsize=1)
def skill_markdown() -> str:
    p = SETTINGS.skill_path
    if p.is_file():
        return p.read_text(encoding="utf-8")
    return ""


PERSONA = (
    "أنت Governance & Operating Model Architect: مستشار حوكمة مؤسسية ونموذج تشغيلي "
    "ومُصمّم هياكل وسياسات ومحلل فجوات ومخاطر. تتعامل مع المدخلات كأدلة Evidence يجب "
    "تحويلها إلى استنتاجات وفجوات وأسباب جذرية وتوصيات وخطط عمل قابلة للاعتماد، لا "
    "كمعلومات وصفية. تسترشد بـ ISO 37000 وG20/OECD 2023 وCOSO وThree Lines Model "
    "وCOBIT كأطر مقارنة، ثم تصمّم نموذجًا مناسبًا للمنظمة محل الدراسة. "
    "تلتزم بالقواعد: لا معلومة بلا مصدر، ميّز بين Evidence/Inference/Recommendation، "
    "كل فجوة لها أثر، كل توصية لها مالك ومدة ومخرج قابل للتحقق، ولا تخلط المشكلة بالعَرَض. "
    "تكتب بالعربية الفصحى بمصطلحات أعمال إنجليزية عند اللزوم، بلغة تنفيذية مباشرة، "
    "وتحافظ على التسلسل من الأعلى للأسفل: مجلس → لجان → إدارة تنفيذية → إدارات → "
    "عمليات → إجراءات → مؤشرات."
)

GROUNDING_RULE = (
    "اعتمد حصريًا على الأدلة المرفقة (المقاطع المعنونة [مصدر N]) عند تقرير وقائع عن "
    "المنظمة. استشهد بالمصدر هكذا [مصدر N] بعد كل واقعة مستمدة من الملفات. عند نقص "
    "الدليل، اذكر النقص صراحةً واقترح كيفية الحصول عليه، ولا تخترع سياسات أو أرقامًا. "
    "ميّز بوضوح ما هو ثابت بالدليل عمّا هو استنتاج أو توصية."
)

# Output formatting: diagrams MUST be valid Mermaid code blocks (rendered as real
# diagrams by the app), never ASCII art; tabular data as Markdown tables.
# IMPORTANT: the model used to invent unsupported types (e.g. `radar-chart`),
# which Mermaid can't render — so we now enumerate the supported types and
# explicitly forbid invented ones.
FORMATTING_RULE = (
    "التنسيق: عند الحاجة إلى رسمٍ بياني أو هيكل تنظيمي أو مخطط تدفّق أو خريطة علاقات، "
    "أخرِجه حصراً ككتلة ```mermaid``` بصياغة Mermaid صحيحة. "
    "استخدم فقط الأنواع المدعومة: graph/flowchart، sequenceDiagram، classDiagram، "
    "stateDiagram-v2، erDiagram، gantt، pie، mindmap، timeline، journey، gitGraph، quadrantChart. "
    "لا تخترع أنواعاً غير مدعومة (مثل radar-chart أو أي صيغة غير قياسية) فهي لا تُرسَم؛ "
    "لإظهار تقييمٍ متعدّد المحاور استخدم graph/flowchart أو جدول Markdown. "
    "لا ترسم المخططات بالحروف أو ASCII أبداً. قدّم البيانات الجدولية كجداول Markdown. "
    "إلزامي: حين يلزم مخطط، أخرِج كتلة ```mermaid``` نظيفة فقط تبدأ مباشرةً بنوع المخطط "
    "(graph TD أو flowchart أو غيرها) دون أي نصٍّ تفسيري أو تأمّلي قبل السياج أو بعده "
    "(ممنوع مثل «سأرسم الآن…» أو «في الواقع، graph TD يوضّح…» أو «هذا المخطط يبيّن…»)، "
    "ولا تصف أداة الرسم ولا تسرد تفكيرك؛ الكتلة وحدها هي المخرج المطلوب."
)

# V9 — the dedicated "probe inputs + criteria + current-state before drafting"
# rule. Generated procedures/policies used to be generic boilerplate because the
# model drafted straight from a thin prompt. This directive forces the per-axis
# discipline the spec describes: read the real inputs, the benchmark criteria, and
# the current-state diagnostic FIRST, then derive axis-specific findings — never a
# generic template. It is injected into every grounded section + axis draft.
AXIS_PROBE_RULE = (
    "منهجية الاستناد (إلزامية قبل الصياغة): لا تبدأ الكتابة قبل أن تَسبُر ثلاثة مصادر "
    "بالترتيب — (١) المدخلات الفعلية للمنظمة (الملفات/الأدلة [مصدر N])، (٢) المعايير "
    "المرجعية للمحور (الإطار/الـbest practice المقارَن به)، (٣) تقرير الواقع الراهن "
    "وما رصده من فجوات. اربط كل عبارة بواقع المنظمة الفعلي: سمِّ الإدارات والأدوار "
    "والأنظمة بأسمائها الحقيقية كما وردت في المدخلات، ولا تستخدم أمثلة عامة أو أسماء "
    "افتراضية. لكل محور حوكمة استخرِج بوضوح: الوضع الراهن → الفجوات → التوصيات → "
    "التحسينات، كلٌّ مستند إلى دليل. إذا غاب الدليل لجزء، فاذكر النقص صراحةً واطلب "
    "المُدخل اللازم بدل اختراع إجراء أو سياسة."
)


@dataclass(frozen=True)
class GovernanceAxis:
    """One governance assessment axis (skill §8.2 — the 17 dimensions).

    ``probe`` tells the engine which inputs to retrieve for this axis; ``benchmark``
    is the framework/standard the axis is compared against so the current-state is
    judged against best practice rather than described in a vacuum.
    """

    key: str
    name_ar: str
    probe: str
    benchmark: str


# The 17 assessment dimensions (skill §8.2), each with what to PROBE in the inputs
# and the BENCHMARK to compare the current-state against. The per-axis pipeline
# walks these so each axis yields its own current-state → gaps → recommendations →
# improvements, grounded in the company's real inputs.
GOVERNANCE_AXES: tuple[GovernanceAxis, ...] = (
    GovernanceAxis("corporate_governance", "الحوكمة المؤسسية",
                   "إطار الحوكمة، الميثاق، الفصل بين الملكية والإدارة، الإفصاح",
                   "ISO 37000 / OECD-G20 2023"),
    GovernanceAxis("board_committees", "مجلس الإدارة واللجان",
                   "تشكيل المجلس، اللجان القائمة، المواثيق، استقلالية الأعضاء",
                   "OECD / مبادئ حوكمة المجالس"),
    GovernanceAxis("strategy", "الاستراتيجية والتوجهات",
                   "الرؤية والرسالة والأهداف، خطط العمل، مؤشرات التوجه",
                   "Balanced Scorecard / التخطيط الاستراتيجي"),
    GovernanceAxis("org_structure", "الهيكل التنظيمي",
                   "الوحدات التنظيمية، خطوط التقرير، الإدارات وأغراضها",
                   "Operating Model Design / تصميم منظمات"),
    GovernanceAxis("decision_rights", "الصلاحيات وحقوق القرار",
                   "مصفوفة الصلاحيات، حدود الاعتماد، تفويض السلطة",
                   "Delegation of Authority / RACI"),
    GovernanceAxis("policies", "السياسات واللوائح",
                   "السياسات المعتمدة، اللوائح، دورية المراجعة، مالكو السياسات",
                   "إطار السياسات Policy Framework"),
    GovernanceAxis("processes", "العمليات والإجراءات",
                   "العمليات الرئيسية، الإجراءات SOPs، نقاط القرار والضوابط",
                   "BPM / إدارة العمليات"),
    GovernanceAxis("technology", "الأنظمة التقنية والأدوات",
                   "الأنظمة المستخدمة، درجة الأتمتة، التكامل، الفجوات التقنية",
                   "COBIT / حوكمة تقنية المعلومات"),
    GovernanceAxis("data_reporting", "البيانات والتقارير",
                   "مصادر البيانات، التقارير الدورية، جودة البيانات وحوكمتها",
                   "DAMA-DMBOK / حوكمة البيانات"),
    GovernanceAxis("people_capabilities", "الأفراد والقدرات",
                   "الكفاءات، الوصف الوظيفي، فجوات المهارات، التدريب",
                   "Competency Framework / إدارة المواهب"),
    GovernanceAxis("culture", "الثقافة والسلوك المؤسسي",
                   "القيم المعلنة، السلوك الفعلي، التواصل، الحوافز",
                   "أطر الثقافة المؤسسية"),
    GovernanceAxis("risk_control", "إدارة المخاطر والرقابة الداخلية",
                   "سجل المخاطر، الضوابط، خطوط الدفاع، الرقابة الداخلية",
                   "COSO ERM / Three Lines Model"),
    GovernanceAxis("compliance", "الامتثال والالتزام",
                   "المتطلبات النظامية، آليات الالتزام، المتابعة والإبلاغ",
                   "إطار الامتثال Compliance"),
    GovernanceAxis("performance", "الأداء ومؤشرات القياس",
                   "مؤشرات الأداء، المستهدفات، دورية القياس والمراجعة",
                   "KPI / Balanced Scorecard"),
    GovernanceAxis("customer", "تجربة العملاء أو المستفيدين",
                   "رحلة العميل، قنوات الخدمة، قياس الرضا، معالجة الشكاوى",
                   "Customer Experience"),
    GovernanceAxis("projects", "إدارة المشاريع والبرامج",
                   "منهجية المشاريع، مكتب إدارة المشاريع، المتابعة والحوكمة",
                   "PMI / P3O"),
    GovernanceAxis("change", "إدارة التغيير والتحول",
                   "مبادرات التحول، إدارة التغيير، الاستعداد المؤسسي",
                   "Change Management / Kotter"),
)

GOVERNANCE_AXES_BY_KEY: dict[str, GovernanceAxis] = {a.key: a for a in GOVERNANCE_AXES}


@dataclass(frozen=True)
class Deliverable:
    key: str
    filename: str
    title_ar: str
    goal_ar: str
    sections: tuple[str, ...]
    gate: str


# The seven deliverables + supporting artifacts (skill §7, §8–13, §19).
DELIVERABLES: tuple[Deliverable, ...] = (
    Deliverable(
        key="current_state",
        filename="01_Current_State_Assessment.md",
        title_ar="تقرير الواقع الراهن للمنظمة",
        goal_ar="تقييم الوضع الحالي عبر 17 بُعدًا مقابل أفضل الممارسات، مع الفجوات والأسباب الجذرية والتوصيات.",
        sections=(
            "الملخص التنفيذي (أهم 7–10 نتائج، أخطر الفجوات، مستوى النضج العام، أولويات التدخل)",
            "نطاق ومنهجية التقييم (النطاق، مصادر البيانات، الأدوات، المعايير المرجعية، حدود التحليل)",
            "نبذة عن المنظمة (النشاط، الحجم، الإدارات، المنتجات/الخدمات، الوضع التشغيلي)",
            "نتائج التقييم حسب الأبعاد السبعة عشر (لكل بُعد: الوضع الحالي، الأدلة، مستوى النضج 1–5، الفجوات، الأثر، السبب الجذري، التوصية)",
            "مصفوفة الفجوات (البعد، الفجوة، الخطورة، الأثر، السبب الجذري، الأولوية، التوصية)",
            "خطة التحسين (المبادرة، الهدف، المالك، المدة، الاعتمادية، المخرج، مؤشر النجاح)",
            "خارطة الطريق (30/60/90 يوم، 6 أشهر، 12 شهر)",
            "الملاحق (الاستبيانات، المقابلات، قائمة الأدلة، النتائج التفصيلية)",
        ),
        gate="Gate 2",
    ),
    Deliverable(
        key="org_structure",
        filename="03_Organization_Structure.md",
        title_ar="الهيكل التنظيمي المقترح",
        goal_ar="تصميم هيكل عملي يترجم الاستراتيجية والحوكمة إلى أدوار ومسارات تقرير وصلاحيات.",
        sections=(
            "مبادئ التصميم (ابدأ بالوظائف والقدرات لا المسميات؛ فصل الأدوار؛ تجنّب تضارب المصالح)",
            "الهيكل العام Corporate Structure",
            "مجلس الإدارة واللجان",
            "الإدارة التنفيذية",
            "الإدارات الرئيسية (الإدارة، الغرض، الوظائف، التقارير، مؤشرات الأداء العليا)",
            "مصفوفة الصلاحيات Delegation of Authority (القرار، التوصية، المراجعة، الاعتماد، الحدود)",
            "مصفوفة RACI للوظائف الحرجة",
            "فجوات الهيكل (الفجوة، الأثر، التوصية، الأولوية)",
        ),
        gate="Gate 3",
    ),
    Deliverable(
        key="strategy",
        filename="04_Initial_Strategy.md",
        title_ar="الاستراتيجية الأولية",
        goal_ar="استراتيجية أولية قابلة للنقاش والاعتماد مبنية على نتائج الواقع الراهن وطبيعة النشاط.",
        sections=(
            "فرضيات التصميم الاستراتيجي",
            "الرؤية Vision",
            "الرسالة Mission",
            "القيم Values",
            "المحاور الاستراتيجية (المحور، الوصف، الهدف المرتبط، مؤشر النجاح)",
            "الأهداف الاستراتيجية (الهدف، المؤشر، خط الأساس، المستهدف، المالك)",
            "المبادرات الاستراتيجية (المبادرة، الوصف، المالك، المدة، المخرجات، الاعتمادية)",
            "المخاطر الاستراتيجية (الخطر، الاحتمالية، الأثر، الاستجابة، المالك)",
        ),
        gate="Gate 4",
    ),
    Deliverable(
        key="governance",
        filename="05_Governance_Framework.md",
        title_ar="منظومة الحوكمة",
        goal_ar="بناء الحوكمة من المساهمين إلى المجلس واللجان والإدارة التنفيذية والإدارات والعمليات.",
        sections=(
            "التسلسل الحاكم (مساهمون → مجلس → لجان → رئيس تنفيذي → لجان تنفيذية → إدارات → عمليات/سياسات/مؤشرات/ضوابط)",
            "حوكمة مجلس الإدارة (ميثاق المجلس، المسؤوليات، التشكيل، دور الرئيس، العلاقة مع الرئيس التنفيذي، تقويم الأداء، الإفصاح)",
            "سياسة تعارض المصالح وآليات الشفافية",
            "اللجان المقترحة ومواثيقها (المراجعة، المخاطر، الترشيحات والمكافآت، الاستثمار، الحوكمة، التقنية)",
            "الحوكمة التنفيذية (ميثاق اللجنة التنفيذية، إيقاع الاجتماعات، حقوق القرار، مصفوفة التصعيد، مراجعة الأداء)",
            "حزمة تقارير المجلس Board Reporting Pack وجدول الاجتماعات",
        ),
        gate="Gate 5",
    ),
    Deliverable(
        key="committees",
        filename="06_Board_and_Committees_Charters.md",
        title_ar="مواثيق المجلس واللجان",
        goal_ar="ميثاق مفصّل لكل لجنة: الغرض، النطاق، التشكيل، المسؤوليات، الصلاحيات، الدورية، النصاب، المدخلات/المخرجات، التقارير، مؤشرات الفعالية.",
        sections=(
            "ميثاق مجلس الإدارة",
            "ميثاق لجنة المراجعة Audit Committee",
            "ميثاق لجنة المخاطر Risk Committee",
            "ميثاق لجنة الترشيحات والمكافآت Nomination & Remuneration",
            "ميثاق لجنة الحوكمة Governance Committee",
            "ميثاق لجنة التقنية والتحول الرقمي",
        ),
        gate="Gate 5",
    ),
    Deliverable(
        key="department_pack",
        filename="07_Department_Operating_Pack.md",
        title_ar="حزمة تشغيل الإدارة",
        goal_ar="حزمة تشغيلية كاملة لإدارة محددة وفق الهيكل الموحد للمهارة (§12).",
        sections=(
            "هدف الإدارة والقيمة المقدّمة",
            "نطاق العمل (ما يدخل وما لا يدخل)",
            "الهيكل التنظيمي للإدارة (الوحدات، خطوط التقرير، الأدوار)",
            "الوظائف والمسؤوليات الرئيسية (الوظيفة، المسؤوليات، المخرجات، العلاقات)",
            "السياسات الحاكمة (السياسة، الغرض، المالك، النطاق، دورية المراجعة)",
            "العمليات الرئيسية (العملية، الهدف، المدخلات، المخرجات، المالك، الأنظمة)",
            "الإجراءات SOPs (لكل إجراء: الغرض، النطاق، المدخلات، الخطوات، نقاط القرار، المخرجات، المسؤوليات، النماذج، الضوابط)",
            "مؤشرات الأداء KPIs (المؤشر، التعريف، طريقة القياس، المستهدف، الدورية، المالك)",
            "المسميات والوصف الوظيفي (المسمى، الهدف، المسؤوليات، الصلاحيات، المؤهلات، الخبرات، الكفاءات الفنية والسلوكية، مؤشرات الأداء)",
            "مصفوفة الكفاءات (الدور، الكفاءة، المطلوب، الحالي، الفجوة، الإجراء)",
            "الأنظمة والتقنيات (النظام، الاستخدام، المستخدمون، الفجوات، التحسينات)",
            "المخاطر والضوابط (الخطر، السبب، الأثر، الضابط الحالي، الضابط المقترح، المالك)",
            "التقارير والاجتماعات (التقرير/الاجتماع، الغرض، الدورية، الجمهور، المالك)",
            "خطة التحسين الخاصة بالإدارة",
        ),
        gate="Gate 6",
    ),
    Deliverable(
        key="raci_doa",
        filename="08_RACI_and_DoA_Matrices.md",
        title_ar="مصفوفات RACI وتفويض الصلاحيات",
        goal_ar="مصفوفات RACI للأنشطة الحرجة ومصفوفة تفويض الصلاحيات الكاملة عبر المنظمة.",
        sections=(
            "مصفوفة RACI للأنشطة عبر الإدارات",
            "مصفوفة تفويض الصلاحيات Delegation of Authority",
            "مصفوفة التصعيد Escalation Matrix",
        ),
        gate="Gate 5",
    ),
    Deliverable(
        key="kpis",
        filename="09_KPIs_and_Performance_Framework.md",
        title_ar="منظومة مؤشرات الأداء",
        goal_ar="إطار قياس أداء مترابط من المؤشرات الاستراتيجية إلى مؤشرات الإدارات.",
        sections=(
            "مبادئ منظومة الأداء",
            "المؤشرات الاستراتيجية",
            "مؤشرات الإدارات",
            "دورية القياس والمراجعة والحوكمة",
        ),
        gate="Gate 6",
    ),
    Deliverable(
        key="risk_register",
        filename="10_Risk_and_Control_Register.md",
        title_ar="سجل المخاطر والضوابط",
        goal_ar="سجل مخاطر مؤسسي بالضوابط الحالية والمقترحة وفق COSO ERM.",
        sections=(
            "منهجية تقييم المخاطر",
            "سجل المخاطر المؤسسية (الخطر، السبب، الأثر، الاحتمالية، الضابط الحالي، الضابط المقترح، المالك)",
            "خريطة المخاطر الحرارية Heat Map (وصفًا)",
            "خطة الاستجابة والمتابعة",
        ),
        gate="Gate 6",
    ),
)

DELIVERABLES_BY_KEY: dict[str, Deliverable] = {d.key: d for d in DELIVERABLES}


@dataclass(frozen=True)
class QualityGate:
    gate: str
    phase: str
    criteria: str


QUALITY_GATES: tuple[QualityGate, ...] = (
    QualityGate("Gate 0", "بدء المشروع", "نطاق واضح، قائمة مدخلات، جدول مقابلات، تعريف المعايير المرجعية"),
    QualityGate("Gate 1", "تنظيم الأدلة", "كل مصدر له Evidence ID وتصنيف ودرجة موثوقية"),
    QualityGate("Gate 2", "الواقع الراهن", "كل فجوة مرتبطة بدليل، وكل توصية مرتبطة بأثر واضح"),
    QualityGate("Gate 3", "الهيكل", "الهيكل مرتبط بالاستراتيجية والقدرات وليس مجرد مسميات"),
    QualityGate("Gate 4", "الاستراتيجية", "الأهداف قابلة للقياس ومتصلة بالفجوات والفرص"),
    QualityGate("Gate 5", "الحوكمة", "المجلس واللجان والصلاحيات ومسارات التصعيد واضحة"),
    QualityGate("Gate 6", "الإدارات", "كل إدارة لها هدف وسياسات وعمليات ومؤشرات ووصف وظيفي"),
    QualityGate("Gate 7", "HTML", "المحتوى كامل، منظم، RTL، قابل للتصفح، ولا يحتوي على ادعاءات بلا دليل"),
)


def system_prompt(extra: str = "") -> str:
    """Full agent system prompt: persona + grounding rule + optional context."""
    parts = [PERSONA, GROUNDING_RULE, FORMATTING_RULE]
    if extra:
        parts.append(extra)
    return "\n\n".join(parts)


def grounding_brief(
    *,
    company: str = "",
    departments: tuple[str, ...] | list[str] | None = None,
    criteria: tuple[str, ...] | list[str] | None = None,
    has_current_state: bool = False,
    axes: tuple[str, ...] | list[str] | None = None,
    notes: str = "",
) -> str:
    """A compact, real-input briefing injected into grounded prompts.

    Naming the company's ACTUAL departments/criteria in the system prompt is what
    stops the model from inventing generic ones — it must use these exact names.
    Returns "" when there is nothing concrete to assert (so ungrounded calls are
    unchanged).

    ``axes``/``notes`` (P1/D1) carry the confirmed build-wizard plan's governance
    axes and free-text owner instructions into this SAME briefing block, so they
    reach every grounded prompt (outline + each section) without a separate
    injection point."""
    lines: list[str] = []
    if company:
        lines.append(f"المنظمة محل العمل: {company}.")
    depts = [d for d in (departments or []) if d]
    if depts:
        lines.append(
            "إداراتها/وحداتها الفعلية (استخدم هذه الأسماء حصراً عند ذكر الإدارات، "
            "ولا تخترع غيرها): " + "، ".join(depts) + "."
        )
    crit = [c for c in (criteria or []) if c]
    if crit:
        lines.append("معايير القياس المعتمدة: " + "، ".join(crit) + ".")
    if has_current_state:
        lines.append(
            "تقرير الواقع الراهن للمنظمة متاحٌ ضمن السياق؛ استند إليه في رصد الفجوات "
            "والتوصيات بدل التعميم."
        )
    ax = [a for a in (axes or []) if a]
    if ax:
        lines.append("المحاور الحوكمية المطلوب تغطيتها (طلب المالك): " + "، ".join(ax) + ".")
    if notes and notes.strip():
        lines.append("طلب المالك/توجيهات إلزامية (التزم بها في كل قسم): " + notes.strip())
    return "\n".join(lines)


def grounded_system_prompt(brief: str = "") -> str:
    """System prompt for grounded drafting: persona + grounding + the probe rule
    + the company-specific briefing. Used by per-section drafting so every section
    is derived from the real inputs/criteria/current-state, not a template."""
    parts = [PERSONA, GROUNDING_RULE, FORMATTING_RULE, AXIS_PROBE_RULE]
    if brief:
        parts.append(brief)
    return "\n\n".join(parts)


def axis_system_prompt(axis: GovernanceAxis, brief: str = "") -> str:
    """System prompt for one axis of the per-axis pipeline: the probe discipline +
    the axis's benchmark, so the current-state is judged against best practice."""
    axis_ctx = (
        f"المحور قيد التقييم الآن: «{axis.name_ar}». "
        f"اسبر في المدخلات: {axis.probe}. "
        f"قارن الوضع الراهن بالمعيار المرجعي: {axis.benchmark}."
    )
    parts = [PERSONA, GROUNDING_RULE, AXIS_PROBE_RULE, axis_ctx]
    if brief:
        parts.append(brief)
    return "\n\n".join(parts)

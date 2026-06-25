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
FORMATTING_RULE = (
    "التنسيق: عند الحاجة إلى رسمٍ بياني أو هيكل تنظيمي أو مخطط تدفّق أو خريطة علاقات، "
    "أخرِجه حصراً ككتلة ```mermaid``` بصياغة Mermaid صحيحة (مثل graph TD أو flowchart LR). "
    "لا ترسم المخططات بالحروف أو ASCII أبداً. قدّم البيانات الجدولية كجداول Markdown."
)


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

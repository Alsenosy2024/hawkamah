from hawkama_copilot.chunking import classify_doc_kind, hierarchical_chunk

SAMPLE = """# لائحة الموارد البشرية

## الباب الأول: التعيين
المادة 1: يتم التعيين وفق حاجة العمل والكفاءة.
المادة 2: تخضع فترة التجربة لثلاثة أشهر قابلة للتمديد.

## الباب الثاني: الإجازات
المادة 3: يستحق الموظف إجازة سنوية مدتها 30 يومًا.
""" + ("نص إضافي مطوّل. " * 200)


def test_headings_become_breadcrumbs():
    chunks = hierarchical_chunk(SAMPLE, doc_id="hr", doc_name="HR.md")
    assert chunks, "should produce chunks"
    assert any("الباب الأول" in c.heading_path for c in chunks)
    assert all(c.doc_name == "HR.md" for c in chunks)
    # ordinals are unique and sequential
    ordinals = [c.ordinal for c in chunks]
    assert ordinals == list(range(len(chunks)))


def test_long_section_is_split():
    chunks = hierarchical_chunk(SAMPLE)
    # The padded long section must be split into multiple sized chunks.
    assert len(chunks) >= 3
    assert all(len(c.text) <= 1400 + 200 for c in chunks)


def test_classify_doc_kind():
    assert classify_doc_kind("لائحة.md", "نظام داخلي") == "regulation"
    assert classify_doc_kind("policy.txt", "سياسة الشركة") in {"policy", "regulation"}
    assert classify_doc_kind("random.txt", "بدون كلمات دالة") == "other"

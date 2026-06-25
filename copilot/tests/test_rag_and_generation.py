from hawkama_copilot.agent import HawkamaAgent
from hawkama_copilot.generation import generate_document
from hawkama_copilot.rag import RagEngine


HR_TEXT = """# لائحة الموارد البشرية
## الباب الأول: التعيين
يتم التعيين وفق حاجة العمل والكفاءة وتخضع فترة التجربة لثلاثة أشهر.
## الباب الثاني: الإجازات
يستحق الموظف إجازة سنوية مدتها ثلاثون يومًا.
"""


def test_ingest_and_retrieve(fake_gemini, tmp_corpus):
    rag = RagEngine("c1")
    reports = rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
    assert sum(r.chunks for r in reports) >= 2
    assert rag.stats()["embedded"] >= 1

    hits = rag.retrieve("ما مدة الإجازة السنوية؟")
    assert hits, "should retrieve evidence"
    assert all(h.label.startswith("مصدر") for h in hits)


def test_generate_document_pipeline(fake_gemini, tmp_corpus):
    rag = RagEngine("c2")
    rag.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])
    doc = generate_document("سياسة تعارض المصالح", "صياغة سياسة كاملة", rag, parallel_sections=False)
    assert doc.markdown.startswith("# سياسة تعارض المصالح")
    assert "## الفهرس" in doc.markdown
    assert "قائمة المصادر" in doc.markdown
    assert len(doc.sections) >= 1
    assert doc.word_count > 0


def test_agent_ask_and_draft(fake_gemini, tmp_corpus):
    agent = HawkamaAgent("c3")
    agent.ingest_bytes([("HR.md", HR_TEXT.encode("utf-8"))])

    ans = agent.ask("ما سياسة التعيين؟")
    assert ans.answer
    assert ans.sources

    # Router: a "write a full policy" message must route to draft().
    out = agent.respond("اكتب سياسة تعارض المصالح كاملة")
    from hawkama_copilot.generation import GeneratedDoc
    assert isinstance(out, GeneratedDoc)


def test_image_ingest_multimodal(fake_gemini, tmp_corpus):
    rag = RagEngine("img1")
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 256          # stand-in image bytes
    reports = rag.ingest_bytes([("logo.png", png), ("HR.md", HR_TEXT.encode("utf-8"))])

    img_rep = next(r for r in reports if r.file == "logo.png")
    assert img_rep.chunks == 1 and img_rep.method == "image-embed"

    img_chunks = [c for c in rag.store.chunks if c.kind == "image"]
    assert len(img_chunks) == 1
    assert img_chunks[0].embedding, "image chunk must carry a multimodal embedding"
    assert "وصف الصورة" in img_chunks[0].text   # caption used as readable evidence
    # text + image share one store/space
    assert rag.stats()["chunks"] >= 3


def test_video_ingest_multimodal(fake_gemini, tmp_corpus):
    rag = RagEngine("vid1")
    mp4 = b"\x00\x00\x00\x18ftypmp42" + b"0" * 512        # stand-in video bytes
    reports = rag.ingest_bytes([("clip.mp4", mp4)])
    rep = next(r for r in reports if r.file == "clip.mp4")
    assert rep.method == "video-embed" and rep.chunks == 2   # two segment chunks
    vid_chunks = [c for c in rag.store.chunks if c.kind == "video"]
    assert len(vid_chunks) == 2
    assert all(c.embedding for c in vid_chunks)
    assert "وصف الفيديو" in vid_chunks[0].text


def test_oversized_video_rejected(fake_gemini, tmp_corpus):
    from hawkama_copilot.rag import _VIDEO_INLINE_LIMIT
    rag = RagEngine("vid2")
    big = b"0" * (_VIDEO_INLINE_LIMIT + 1)
    reports = rag.ingest_bytes([("big.mp4", big)])
    rep = next(r for r in reports if r.file == "big.mp4")
    assert rep.chunks == 0 and rep.error and "too large" in rep.error


def test_primary_embed_is_multimodal():
    from hawkama_copilot.config import MODELS
    assert MODELS.embed == "gemini-embedding-2"


def test_detect_deliverable():
    agent = HawkamaAgent("c4")
    assert agent.detect_deliverable("اكتب تقرير الواقع الراهن") == "current_state"
    assert agent.detect_deliverable("صمم الهيكل التنظيمي") == "org_structure"
    assert agent.detect_deliverable("سجل المخاطر") == "risk_register"

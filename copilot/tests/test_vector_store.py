from hawkama_copilot.chunking import Chunk
from hawkama_copilot.vector_store import VectorStore


def _chunk(text, vec):
    c = Chunk(text=text, heading_path="", char_start=0, ordinal=0, doc_name="d")
    c.embedding = vec
    return c


def test_cosine_topk_orders_by_similarity(tmp_path):
    vs = VectorStore("t", data_dir=tmp_path)
    vs.add([
        _chunk("a", [1.0, 0.0, 0.0]),
        _chunk("b", [0.0, 1.0, 0.0]),
        _chunk("c", [0.9, 0.1, 0.0]),
    ])
    hits = vs.cosine_topk([1.0, 0.0, 0.0], k=2)
    assert [c.text for c, _ in hits] == ["a", "c"]
    assert hits[0][1] > hits[1][1]


def test_persistence_roundtrip(tmp_path):
    vs = VectorStore("persist", data_dir=tmp_path)
    vs.add([_chunk("x", [0.1, 0.2, 0.3])])
    vs.save()
    reopened = VectorStore("persist", data_dir=tmp_path)
    assert reopened.stats()["chunks"] == 1
    assert reopened.chunks[0].text == "x"


def test_empty_store_returns_no_hits(tmp_path):
    vs = VectorStore("empty", data_dir=tmp_path)
    assert vs.cosine_topk([1.0, 0.0], k=5) == []

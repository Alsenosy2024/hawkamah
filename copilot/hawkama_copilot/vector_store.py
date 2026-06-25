"""Persistent vector store for chunk embeddings.

Design choice (mirrors the JS note in `embeddingService.ts`): keep it simple and
self-contained. Vectors live alongside chunk metadata in a per-corpus JSON file;
similarity is computed with a single vectorized numpy matmul, which handles tens
of thousands of chunks in milliseconds — far past what the in-browser cosine loop
could do. The on-disk vectors are 1536-dim and L2-normalized, so they drop into
Firestore's `find_nearest` KNN index unchanged if/when a tenant outgrows this.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

import numpy as np

from .chunking import Chunk
from .config import SETTINGS


class VectorStore:
    """One store == one corpus (tenant/project). Append-only ingest + top-k search."""

    def __init__(self, corpus_id: str, data_dir: Path | None = None):
        self.corpus_id = corpus_id
        self.data_dir = data_dir or SETTINGS.data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / f"corpus_{_safe(corpus_id)}.json"
        self._lock = threading.Lock()
        self.chunks: list[Chunk] = []
        self._matrix: np.ndarray | None = None  # (N, dim) normalized; rows align to self.chunks
        self._load()

    # ----------------------------------------------------------------- io --
    def _load(self) -> None:
        if not self.path.is_file():
            return
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.chunks = [Chunk.from_dict(c) for c in data.get("chunks", [])]
        self._rebuild_matrix()

    def save(self) -> None:
        with self._lock:
            payload = {
                "corpus_id": self.corpus_id,
                "dim": SETTINGS.embed_dim,
                "count": len(self.chunks),
                "chunks": [c.to_dict() for c in self.chunks],
            }
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self.path)

    def _rebuild_matrix(self) -> None:
        vecs = [c.embedding for c in self.chunks]
        if vecs and all(len(v) == len(vecs[0]) and v for v in vecs):
            self._matrix = np.asarray(vecs, dtype=np.float32)
        else:
            # Mixed/empty embeddings → no matrix; search degrades to lexical.
            self._matrix = None

    # ------------------------------------------------------------- mutate --
    def add(self, chunks: list[Chunk]) -> int:
        with self._lock:
            self.chunks.extend(chunks)
            self._rebuild_matrix()
        return len(chunks)

    def clear(self) -> None:
        with self._lock:
            self.chunks = []
            self._matrix = None
        if self.path.is_file():
            self.path.unlink()

    @property
    def doc_names(self) -> list[str]:
        seen: dict[str, None] = {}
        for c in self.chunks:
            if c.doc_name:
                seen.setdefault(c.doc_name, None)
        return list(seen)

    def stats(self) -> dict:
        docs = {c.doc_id or c.doc_name for c in self.chunks}
        embedded = sum(1 for c in self.chunks if c.embedding)
        return {
            "corpus_id": self.corpus_id,
            "documents": len([d for d in docs if d]),
            "chunks": len(self.chunks),
            "embedded": embedded,
        }

    # ------------------------------------------------------------- search --
    def cosine_topk(self, query_vec: list[float], k: int) -> list[tuple[Chunk, float]]:
        """Vectorized cosine top-k. Vectors are pre-normalized so cosine == dot."""
        if self._matrix is None or not query_vec or len(query_vec) != self._matrix.shape[1]:
            return []
        q = np.asarray(query_vec, dtype=np.float32)
        qn = np.linalg.norm(q)
        if qn == 0:
            return []
        q = q / qn
        scores = self._matrix @ q  # rows already unit-norm
        if k >= len(scores):
            idx = np.argsort(-scores)
        else:
            part = np.argpartition(-scores, k)[:k]
            idx = part[np.argsort(-scores[part])]
        return [(self.chunks[i], float(scores[i])) for i in idx]


def _safe(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name)[:80] or "default"

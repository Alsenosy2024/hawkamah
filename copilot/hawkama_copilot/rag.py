"""RAG engine: ingest a large corpus, retrieve grounded evidence with citations.

Ingest: extract → chunk → embed (RETRIEVAL_DOCUMENT) → persist. Designed for a
large file volume — embedding runs in batched, bounded-concurrency requests and
the store is append-only so re-ingesting more files never re-embeds old ones.

Retrieve: hybrid vector + lexical + heading rerank (same blend weights as the JS
engine), an adaptive k, and a relative-score cutoff so a thin query returns few
high-quality hits rather than padding with noise. Every hit keeps a stable
``[مصدر N]`` citation label that maps back to the source document + heading path,
so generated governance documents cite their evidence.
"""

from __future__ import annotations

import concurrent.futures
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import mimetypes

from . import genai_client
from .chunking import Chunk, classify_doc_kind, hierarchical_chunk
from .config import SETTINGS
from .extraction import (
    ExtractResult,
    caption_image,
    caption_video,
    extract_bytes,
    extract_file,
    is_image,
    is_video,
)

# Inline-embed ceiling for video (the Files API path needs extra provisioning);
# longer/larger clips should be trimmed before upload.
_VIDEO_INLINE_LIMIT = 18 * 1024 * 1024
from .vector_store import VectorStore


@dataclass
class IngestReport:
    file: str
    method: str
    chunks: int
    error: str | None = None


@dataclass
class Evidence:
    label: str          # "مصدر 1"
    doc_name: str
    heading_path: str
    text: str
    score: float
    chunk_id: str
    kind: str = "text"  # "text" | "image"


class RagEngine:
    def __init__(self, corpus_id: str, data_dir: Path | None = None):
        self.store = VectorStore(corpus_id, data_dir)

    # ------------------------------------------------------------ ingest --
    def ingest_paths(
        self, paths: Iterable[str | Path], on_progress: Callable[[str, int, int], None] | None = None
    ) -> list[IngestReport]:
        items = []
        for p in paths:
            p = Path(p)
            items.append((p.name, extract_file(p)))
        return self._ingest_extracted(items, on_progress)

    def ingest_bytes(
        self,
        files: list[tuple[str, bytes]],
        on_progress: Callable[[str, int, int], None] | None = None,
    ) -> list[IngestReport]:
        # Images take the MULTIMODAL path (embed the image itself into the shared
        # vector space, with a caption as readable evidence); everything else is
        # extracted to text and chunked.
        media_chunks: list[Chunk] = []
        media_reports: list[IngestReport] = []
        text_items: list[tuple[str, ExtractResult]] = []
        for name, data in files:
            if is_image(name):
                ch = self._image_chunk(name, data)
                if ch:
                    media_chunks.append(ch)
                    media_reports.append(IngestReport(name, "image-embed", 1))
                else:
                    media_reports.append(IngestReport(name, "image", 0, error="image embed failed"))
            elif is_video(name):
                if len(data) > _VIDEO_INLINE_LIMIT:
                    media_reports.append(IngestReport(name, "video", 0, error="video too large (trim to a shorter clip)"))
                    continue
                chs = self._video_chunks(name, data)
                if chs:
                    media_chunks.extend(chs)
                    media_reports.append(IngestReport(name, "video-embed", len(chs)))
                else:
                    media_reports.append(IngestReport(name, "video", 0, error="video embed failed"))
            else:
                text_items.append((name, extract_bytes(data, filename=name)))

        reports = self._ingest_extracted(text_items, on_progress, extra_chunks=media_chunks)
        return media_reports + reports

    def _image_chunk(self, name: str, data: bytes) -> Chunk | None:
        """Build one image chunk: multimodal embedding of the image + a caption."""
        vec = genai_client.embed_image(
            data, mime_type=mimetypes.guess_type(name)[0] or "image/png"
        )
        if not vec:
            return None
        caption = caption_image(data, name) or f"صورة: {name}"
        ch = Chunk(
            text=caption,
            heading_path=name,
            char_start=0,
            ordinal=0,
            doc_id=name,
            doc_name=name,
            doc_kind="image",
            kind="image",
            media_mime=mimetypes.guess_type(name)[0] or "image/png",
        )
        ch.embedding = vec
        return ch

    def _video_chunks(self, name: str, data: bytes) -> list[Chunk]:
        """Build one chunk per video segment: multimodal embedding + a caption."""
        mime = mimetypes.guess_type(name)[0] or "video/mp4"
        vecs = genai_client.embed_video(data, mime_type=mime)
        if not vecs:
            return []
        caption = caption_video(data, name) or f"فيديو: {name}"
        out: list[Chunk] = []
        for i, v in enumerate(vecs):
            seg = f" — مقطع {i + 1}" if len(vecs) > 1 else ""
            ch = Chunk(
                text=caption + seg,
                heading_path=name,
                char_start=0,
                ordinal=i,
                doc_id=name,
                doc_name=name,
                doc_kind="video",
                kind="video",
                media_mime=mime,
            )
            ch.embedding = v
            out.append(ch)
        return out

    def _ingest_extracted(
        self,
        items: list[tuple[str, ExtractResult]],
        on_progress: Callable[[str, int, int], None] | None,
        extra_chunks: list[Chunk] | None = None,
    ) -> list[IngestReport]:
        reports: list[IngestReport] = []
        text_chunks: list[Chunk] = []
        for name, res in items:
            if not res.ok:
                reports.append(IngestReport(name, res.method, 0, error=res.error or "no text"))
                continue
            kind = classify_doc_kind(name, res.text)
            doc_id = f"{name}"
            chunks = hierarchical_chunk(res.text, doc_id=doc_id, doc_name=name, doc_kind=kind)
            text_chunks.extend(chunks)
            reports.append(IngestReport(name, res.method, len(chunks)))

        if text_chunks:
            self._embed_chunks(text_chunks, on_progress)   # text → text embeddings
        combined = text_chunks + list(extra_chunks or [])  # image chunks pre-embedded
        if combined:
            self.store.add(combined)
            self.store.save()
        return reports

    def _embed_chunks(
        self, chunks: list[Chunk], on_progress: Callable[[str, int, int], None] | None
    ) -> None:
        # Embed text combined with its heading path — the breadcrumb meaningfully
        # disambiguates near-identical clauses across documents.
        texts = [f"{c.heading_path}\n{c.text}" if c.heading_path else c.text for c in chunks]
        batch = SETTINGS.embed_batch
        batches = [(i, texts[i : i + batch]) for i in range(0, len(texts), batch)]
        done = 0
        total = len(chunks)

        def run(start_texts: tuple[int, list[str]]) -> tuple[int, list[list[float]]]:
            start, group = start_texts
            return start, genai_client.embed(group, task_type=SETTINGS.embed_doc_task)

        with concurrent.futures.ThreadPoolExecutor(max_workers=SETTINGS.embed_concurrency) as ex:
            for start, vecs in ex.map(run, batches):
                for j, v in enumerate(vecs):
                    chunks[start + j].embedding = v
                done += len(vecs)
                if on_progress:
                    on_progress("embedding", min(done, total), total)

    # ---------------------------------------------------------- retrieve --
    def retrieve(self, query: str, k: int | None = None) -> list[Evidence]:
        k = k or self._adaptive_k(query)
        # Over-fetch from the vector index, then rerank with lexical + heading.
        qvec = genai_client.embed_one(query, task_type=SETTINGS.embed_query_task)
        vec_hits = self.store.cosine_topk(qvec, k * 3) if qvec else []

        cand: dict[str, tuple[Chunk, float]] = {c.id: (c, s) for c, s in vec_hits}
        # Always blend in lexical so keyword-y queries (a policy name, an Arabic
        # term) surface chunks the vector pass may rank low.
        for c in self.store.chunks:
            cand.setdefault(c.id, (c, 0.0))

        scored: list[tuple[Chunk, float]] = []
        vec_lookup = {c.id: s for c, s in vec_hits}
        for cid, (c, _) in cand.items():
            vs = vec_lookup.get(cid, 0.0)
            ls = _lexical_score(query, c.text)
            hs = _heading_hit(query, c.heading_path)
            blended = (
                SETTINGS.rerank_vector_weight * vs
                + SETTINGS.rerank_lexical_weight * ls
                + SETTINGS.rerank_heading_weight * hs
            )
            if blended > 0:
                scored.append((c, blended))

        scored.sort(key=lambda t: t[1], reverse=True)
        if not scored:
            return []
        best = scored[0][1]
        cutoff = best * SETTINGS.retrieve_rel_cutoff
        kept = [(c, s) for c, s in scored if s >= cutoff][:k]

        return [
            Evidence(
                label=f"مصدر {i + 1}",
                doc_name=c.doc_name,
                heading_path=c.heading_path,
                text=c.text,
                score=round(s, 4),
                chunk_id=c.id,
                kind=getattr(c, "kind", "text"),
            )
            for i, (c, s) in enumerate(kept)
        ]

    def _adaptive_k(self, query: str) -> int:
        words = len([w for w in re.split(r"\s+", query.strip()) if len(w) > 2])
        corpus = len(self.store.chunks)
        k = SETTINGS.retrieve_k + (2 if words > 12 else 0) + (2 if corpus > 400 else 0)
        return max(4, min(k, SETTINGS.retrieve_k_max))

    # ----------------------------------------------------------- helpers --
    @staticmethod
    def format_evidence(items: list[Evidence], max_chars: int = 24000) -> str:
        """Render retrieved evidence as a citable context block for the model."""
        out: list[str] = []
        used = 0
        for ev in items:
            tag = {"image": " (صورة)", "video": " (فيديو)"}.get(ev.kind, "")
            head = f"[{ev.label}]{tag} {ev.doc_name}" + (f" › {ev.heading_path}" if ev.heading_path else "")
            body = ev.text.strip()
            block = f"{head}\n{body}"
            if used + len(block) > max_chars:
                break
            out.append(block)
            used += len(block)
        return "\n\n---\n\n".join(out)

    def stats(self) -> dict:
        return self.store.stats()


# --------------------------------------------------------------------------- #
# Lexical helpers (Arabic-aware tokenization)                                  #
# --------------------------------------------------------------------------- #
# `\w` already matches Arabic letters under Unicode; we must NOT widen it to the
# whole Arabic block or punctuation like ؟ ، ؛ gets glued onto words ("التعيين؟"
# != "التعيين") and lexical overlap silently drops to zero.
_WORD_RE = re.compile(r"\w+", re.UNICODE)


def _tokens(s: str) -> list[str]:
    return [w.lower() for w in _WORD_RE.findall(s) if len(w) > 2]


def _lexical_score(query: str, text: str) -> float:
    q = set(_tokens(query))
    if not q:
        return 0.0
    t = _tokens(text)
    if not t:
        return 0.0
    hit = sum(1 for w in t if w in q)
    return hit / len(t)


def _heading_hit(query: str, heading_path: str) -> float:
    if not heading_path:
        return 0.0
    q = set(_tokens(query))
    h = set(_tokens(heading_path))
    if not q or not h:
        return 0.0
    return len(q & h) / len(h)

"""Heading-aware hierarchical chunking for Arabic & English governance docs.

Ported from `ingestionService.ts`. Splits on markdown headings AND Arabic
structural markers (الباب / الفصل / المادة / البند / القسم / مبحث / أولاً..عاشراً),
keeping a breadcrumb `heading_path` so retrieved evidence can be cited as
"اللائحة › الباب الثاني › المادة 5". Long sections are soft-split on paragraph /
sentence boundaries to stay under the embedding token ceiling.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field, asdict
from typing import Iterable

from .config import SETTINGS

# Markdown ATX heading.
_MD_HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")

# Arabic structural markers commonly used in regulations / bylaws, with a nesting
# level each. NOTE: المادة/البند are deliberately NOT headings — they are the atomic
# clauses we want to retrieve as *bodies* under their الباب/الفصل heading, so a
# clause never clobbers its section breadcrumb.
_AR_MARKER_LEVELS: tuple[tuple[re.Pattern[str], int], ...] = (
    (re.compile(r"^\s*(الباب|الجزء)\b"), 2),
    (re.compile(r"^\s*(الفصل|القسم)\b"), 3),
    (re.compile(
        r"^\s*(المبحث|مبحث|أولاً|ثانياً|ثالثاً|رابعاً|خامساً|سادساً|سابعاً|ثامناً|تاسعاً|عاشراً)\b"
    ), 4),
)


@dataclass
class Chunk:
    text: str
    heading_path: str
    char_start: int
    ordinal: int
    doc_id: str = ""
    doc_name: str = ""
    doc_kind: str = "other"
    kind: str = "text"          # "text" | "image" — image chunks carry a visual embedding
    media_mime: str = ""        # mime type for image/media chunks
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    embedding: list[float] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Chunk":
        known = {k: d[k] for k in cls.__dataclass_fields__ if k in d}  # type: ignore[attr-defined]
        return cls(**known)


def _heading_level(line: str) -> tuple[int, str] | None:
    m = _MD_HEADING.match(line)
    if m:
        return len(m.group(1)), m.group(2).strip()
    stripped = line.strip()
    if len(stripped) <= 120:
        for pat, level in _AR_MARKER_LEVELS:
            if pat.match(stripped):
                return level, stripped
    return None


def _soft_split(text: str, max_chars: int) -> list[str]:
    """Split an over-long block on paragraph then sentence boundaries."""
    if len(text) <= max_chars:
        return [text]
    out: list[str] = []
    buf = ""
    # Prefer paragraph boundaries, then Arabic/Latin sentence enders.
    pieces = re.split(r"(\n\s*\n)", text)
    for piece in pieces:
        if len(buf) + len(piece) <= max_chars:
            buf += piece
            continue
        if buf.strip():
            out.append(buf.strip())
        if len(piece) <= max_chars:
            buf = piece
        else:
            for sent in re.split(r"(?<=[\.\!\?؟。])\s+", piece):
                if len(buf) + len(sent) + 1 <= max_chars:
                    buf += (" " if buf else "") + sent
                else:
                    if buf.strip():
                        out.append(buf.strip())
                    buf = sent
    if buf.strip():
        out.append(buf.strip())
    return out or [text[:max_chars]]


def hierarchical_chunk(
    text: str,
    *,
    doc_id: str = "",
    doc_name: str = "",
    doc_kind: str = "other",
    max_chars: int | None = None,
    min_chars: int | None = None,
) -> list[Chunk]:
    """Chunk a document into heading-scoped, size-bounded pieces."""
    max_chars = max_chars or SETTINGS.chunk_max_chars
    min_chars = min_chars or SETTINGS.chunk_min_chars
    lines = text.splitlines()

    heading_stack: list[tuple[int, str]] = []   # (level, title)
    buf_lines: list[str] = []
    buf_start = 0
    char_cursor = 0
    raw: list[tuple[str, str, int]] = []        # (heading_path, text, char_start)

    def path() -> str:
        return " › ".join(t for _, t in heading_stack)

    def flush(start: int) -> None:
        body = "\n".join(buf_lines).strip()
        if body:
            raw.append((path(), body, start))
        buf_lines.clear()

    for line in lines:
        hl = _heading_level(line)
        if hl is not None:
            flush(buf_start)
            level, title = hl
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            heading_stack.append((level, title))
            buf_start = char_cursor + len(line) + 1
        else:
            if not buf_lines:
                buf_start = char_cursor
            buf_lines.append(line)
        char_cursor += len(line) + 1
    flush(buf_start)

    # Size-normalize: split over-long sections, merge tiny adjacent ones.
    chunks: list[Chunk] = []
    ordinal = 0
    carry_path: str | None = None
    carry_text = ""
    carry_start = 0

    def emit(hp: str, body: str, start: int) -> None:
        nonlocal ordinal
        chunks.append(
            Chunk(
                text=body,
                heading_path=hp,
                char_start=start,
                ordinal=ordinal,
                doc_id=doc_id,
                doc_name=doc_name,
                doc_kind=doc_kind,
            )
        )
        ordinal += 1

    for hp, body, start in raw:
        for piece in _soft_split(body, max_chars):
            if len(piece) < min_chars:
                # accumulate tiny fragments under the same heading
                if carry_path == hp:
                    carry_text = (carry_text + "\n" + piece).strip()
                else:
                    if carry_text:
                        emit(carry_path or "", carry_text, carry_start)
                    carry_path, carry_text, carry_start = hp, piece, start
                if len(carry_text) >= min_chars:
                    emit(carry_path or "", carry_text, carry_start)
                    carry_path, carry_text = None, ""
            else:
                if carry_text:
                    emit(carry_path or "", carry_text, carry_start)
                    carry_path, carry_text = None, ""
                emit(hp, piece, start)
    if carry_text:
        emit(carry_path or "", carry_text, carry_start)

    return chunks


def classify_doc_kind(name: str, content: str) -> str:
    """Heuristic doc-kind tag used to weight retrieval / evidence."""
    n = name.lower()
    c = content[:2000]
    pairs = [
        ("regulation", ("لائحة", "نظام", "regulation", "bylaw")),
        ("policy", ("سياسة", "policy")),
        ("procedure", ("إجراء", "اجراء", "sop", "procedure")),
        ("org_chart", ("هيكل", "تنظيمي", "org chart", "organization structure")),
        ("profile", ("نبذة", "تعريف", "profile", "about us", "السجل التجاري")),
        ("financial", ("مالي", "ميزانية", "financial", "budget", "income")),
        ("survey", ("استبيان", "survey", "questionnaire")),
        ("interview", ("مقابلة", "interview")),
    ]
    for kind, keys in pairs:
        if any(k in n or k in c for k in keys):
            return kind
    return "other"

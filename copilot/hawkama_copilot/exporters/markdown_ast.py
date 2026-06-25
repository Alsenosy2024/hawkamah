"""Minimal Markdown → block AST shared by every exporter.

Mirrors the JS `markdownAst.ts`: one parser feeds the DOCX/PDF/XLSX/PPTX/HTML
writers so all formats render the same structure. We only support the block kinds
the generator actually emits (headings, paragraphs, bullets, ordered items,
quotes, code, tables, rules) — deliberately not a full CommonMark engine.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class Block:
    type: str                       # heading|paragraph|bullet|ordered|quote|code|table|rule
    text: str = ""
    level: int = 0                  # heading level / bullet indent
    headers: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)


_HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
_BULLET = re.compile(r"^(\s*)[-*•]\s+(.*)$")
_ORDERED = re.compile(r"^(\s*)\d+[\.\)]\s+(.*)$")
_QUOTE = re.compile(r"^>\s?(.*)$")
_RULE = re.compile(r"^\s*([-*_])\1{2,}\s*$")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}.*$")


def parse_markdown(md: str) -> list[Block]:
    lines = md.replace("\r\n", "\n").split("\n")
    blocks: list[Block] = []
    i = 0
    n = len(lines)
    para: list[str] = []

    def flush_para() -> None:
        if para:
            text = _inline(" ".join(s.strip() for s in para).strip())
            if text:
                blocks.append(Block("paragraph", text=text))
            para.clear()

    while i < n:
        line = lines[i]

        # fenced code
        if line.strip().startswith("```"):
            flush_para()
            i += 1
            buf: list[str] = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            blocks.append(Block("code", text="\n".join(buf)))
            continue

        if not line.strip():
            flush_para()
            i += 1
            continue

        if _RULE.match(line):
            flush_para()
            blocks.append(Block("rule"))
            i += 1
            continue

        m = _HEADING.match(line)
        if m:
            flush_para()
            blocks.append(Block("heading", text=_inline(m.group(2)), level=len(m.group(1))))
            i += 1
            continue

        # table: a pipe row followed by a separator row
        if "|" in line and i + 1 < n and _TABLE_SEP.match(lines[i + 1]):
            flush_para()
            headers = _split_row(line)
            i += 2
            rows: list[list[str]] = []
            while i < n and "|" in lines[i] and lines[i].strip():
                rows.append(_split_row(lines[i]))
                i += 1
            blocks.append(Block("table", headers=headers, rows=rows))
            continue

        m = _BULLET.match(line)
        if m:
            flush_para()
            blocks.append(Block("bullet", text=_inline(m.group(2)), level=len(m.group(1)) // 2))
            i += 1
            continue

        m = _ORDERED.match(line)
        if m:
            flush_para()
            blocks.append(Block("ordered", text=_inline(m.group(2)), level=len(m.group(1)) // 2))
            i += 1
            continue

        m = _QUOTE.match(line)
        if m:
            flush_para()
            blocks.append(Block("quote", text=_inline(m.group(1))))
            i += 1
            continue

        para.append(line)
        i += 1

    flush_para()
    return blocks


def _split_row(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [_inline(c.strip()) for c in s.split("|")]


def _inline(text: str) -> str:
    """Strip inline emphasis/code/links to plain text (writers style separately).
    Models often put `<br>` inside table cells; normalize those to newlines so the
    writers (which escape text) render line breaks instead of literal tags."""
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"__(.+?)__", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"`(.+?)`", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    return text.strip()


def strip_markdown(md: str) -> str:
    return "\n".join(
        b.text if b.type != "table" else " ".join(b.headers)
        for b in parse_markdown(md)
        if b.type != "rule"
    )

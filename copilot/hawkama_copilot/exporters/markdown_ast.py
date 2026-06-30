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
    type: str                       # heading|paragraph|bullet|ordered|quote|code|mermaid|table|rule
    text: str = ""
    level: int = 0                  # heading level / bullet indent
    headers: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)
    lang: str = ""                  # fenced-code language tag (code/mermaid blocks)


# --------------------------------------------------------------------------- #
# Mermaid detection — ported from the frontend `services/mermaidDetect.ts` so the #
# export pipeline recognises a diagram exactly like the in-app canvas does. The   #
# model often emits a diagram with the wrong fence (```graph, ```flow) or no lang #
# at all; without this every such fence fell through to a raw <pre><code> block.  #
# --------------------------------------------------------------------------- #
# First non-empty line of a Mermaid diagram starts with one of these keywords
# (optionally preceded by an %%{init}%% directive). Covers every Mermaid v11 type.
_MERMAID_HEAD = re.compile(
    r"^(?:%%\{[^}]*\}%%\s*)?"
    r"(?:flowchart|graph|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|"
    r"erDiagram|gantt|pie\b|journey|mindmap|timeline|quadrantChart|gitGraph|"
    r"requirementDiagram|C4(?:Context|Container|Component|Dynamic|Deployment)|"
    r"sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|"
    r"architecture(?:-beta)?|kanban|radar|zenuml|treemap)\b",
    re.IGNORECASE,
)

# Languages that are explicitly Mermaid (aliases the model might use).
_MERMAID_LANGS = {"mermaid", "mmd", "mermaidjs"}

# Real programming/markup languages — never sniff their content as a diagram, even
# if it coincidentally starts with "graph" etc.
_PROG_LANGS = re.compile(
    r"^(js|javascript|ts|typescript|jsx|tsx|py|python|java|kotlin|c|cpp|c\+\+|cs|"
    r"csharp|go|golang|rust|rs|rb|ruby|php|sh|bash|zsh|shell|console|sql|json|jsonc|"
    r"yaml|yml|xml|html|htm|css|scss|sass|less|md|markdown|mdx|diff|patch|toml|ini|"
    r"dockerfile|docker|swift|scala|r|matlab|perl|lua|dart|graphql|gql|proto|"
    r"makefile|cmake|nginx|apache|vim|powershell|ps1|bat|tex|text|txt|plaintext|none)$",
    re.IGNORECASE,
)


def looks_like_mermaid(code: str) -> bool:
    """True when the code body itself reads like a Mermaid diagram."""
    return bool(_MERMAID_HEAD.match((code or "").strip()))


def is_mermaid_block(lang: str | None, code: str) -> bool:
    """Whether a fenced code block should render as a Mermaid diagram.

    Mirrors `isMermaidBlock` in `services/mermaidDetect.ts`:
    - explicit mermaid language → yes
    - a real programming language → no (don't sniff)
    - empty/unknown/diagram-ish language → sniff the content

    Superset of the frontend in one respect: the fence info itself is also sniffed,
    so a bare ```graph TD / ```flowchart LR fence (diagram keyword on the fence line
    rather than in the body) is recognised too.
    """
    l = (lang or "").strip().lower()
    if l in _MERMAID_LANGS:
        return True
    if l and _PROG_LANGS.match(l):
        return False
    return looks_like_mermaid(l) or looks_like_mermaid(code)


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

        # fenced code — capture the language tag from the opening fence and detect
        # Mermaid (explicit lang OR sniffed content) so it renders as a real diagram
        # downstream instead of a raw code block (mirrors the in-app canvas).
        if line.strip().startswith("```"):
            flush_para()
            lang = line.strip()[3:].strip()  # full fence info string (mirrors the JS)
            i += 1
            buf: list[str] = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            code = "\n".join(buf)
            btype = "mermaid" if is_mermaid_block(lang, code) else "code"
            blocks.append(Block(btype, text=code, lang=lang))
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

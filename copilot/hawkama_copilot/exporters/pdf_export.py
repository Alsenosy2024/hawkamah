"""PDF export (ReportLab) with Arabic shaping + bidi.

ReportLab has no native Arabic shaping, so each text fragment is run through
arabic-reshaper (contextual letter forms) then python-bidi `get_display` (the
Unicode bidi algorithm) before it is drawn, and paragraphs are right-aligned.
Body font is Almarai (the project's Word/PDF font); we fall back to the system
Noto Naskh Arabic if the bundled TTF is missing.
"""

from __future__ import annotations

import os
from io import BytesIO
from pathlib import Path

import arabic_reshaper
from bidi.algorithm import get_display
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT, TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from .markdown_ast import Block, parse_markdown

# Fonts vendored inside the package (so the container/image is self-contained),
# with the repo's public/fonts as a dev fallback.
_PKG_FONTS = Path(__file__).resolve().parents[1] / "fonts"
_REPO_FONTS = Path(__file__).resolve().parents[3] / "public" / "fonts"
NAVY = colors.HexColor("#1A3557")
GOLD = colors.HexColor("#C8912A")
_REGISTERED = False
_FONT = "Body"
_FONT_BOLD = "BodyBold"


def _register_fonts() -> None:
    global _REGISTERED
    if _REGISTERED:
        return
    candidates_regular = [
        _PKG_FONTS / "Almarai-Regular.ttf",
        _REPO_FONTS / "Almarai-Regular.ttf",
        Path("/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf"),
        Path("/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf"),
    ]
    candidates_bold = [
        _PKG_FONTS / "Almarai-Bold.ttf",
        _REPO_FONTS / "Almarai-Bold.ttf",
        Path("/usr/share/fonts/truetype/noto/NotoNaskhArabic-Bold.ttf"),
        Path("/usr/share/fonts/truetype/noto/NotoSansArabic-Bold.ttf"),
    ]
    reg = next((p for p in candidates_regular if p.is_file()), None)
    bold = next((p for p in candidates_bold if p.is_file()), reg)
    if reg is None:
        raise RuntimeError("No Arabic-capable TTF found for PDF export (need Almarai or Noto).")
    pdfmetrics.registerFont(TTFont(_FONT, str(reg)))
    pdfmetrics.registerFont(TTFont(_FONT_BOLD, str(bold)))
    _REGISTERED = True


def _ar(text: str) -> str:
    """Shape + bidi-reorder a fragment for correct visual order in the PDF."""
    if not text:
        return ""
    try:
        return get_display(arabic_reshaper.reshape(text))
    except Exception:  # noqa: BLE001 — never let shaping crash export
        return text


def _rl(text: str):
    """Paragraph-safe RTL markup: shape each line, XML-escape it (so stray
    <, >, & or model-emitted <br> can't break ReportLab's mini-HTML parser),
    then join lines with <br/>. ReportLab Paragraph parses its input as markup,
    so escaping is mandatory."""
    import html as _html

    if not text:
        return ""
    lines = text.split("\n")
    return "<br/>".join(_html.escape(_ar(line), quote=False) for line in lines)


def export_pdf(markdown: str, title: str, *, company: str = "") -> bytes:
    _register_fonts()
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        rightMargin=18 * mm, leftMargin=18 * mm, topMargin=20 * mm, bottomMargin=20 * mm,
        title=title,
    )
    styles = _styles()
    flow = []

    # Cover
    flow.append(Spacer(1, 60 * mm))
    flow.append(Paragraph(_rl(title), styles["CoverTitle"]))
    if company:
        flow.append(Spacer(1, 6 * mm))
        flow.append(Paragraph(_rl(company), styles["CoverSub"]))
    flow.append(PageBreak())

    for b in parse_markdown(markdown):
        flow.extend(_emit(b, styles))

    doc.build(flow)
    return buf.getvalue()


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    common = dict(fontName=_FONT, alignment=TA_RIGHT, wordWrap="RTL", leading=18)
    s = {
        "CoverTitle": ParagraphStyle("CoverTitle", parent=base["Title"], fontName=_FONT_BOLD,
                                     alignment=TA_CENTER, fontSize=28, textColor=NAVY, leading=34),
        "CoverSub": ParagraphStyle("CoverSub", parent=base["Normal"], fontName=_FONT,
                                   alignment=TA_CENTER, fontSize=15, textColor=GOLD),
        "Body": ParagraphStyle("Body", parent=base["Normal"], fontSize=10.5, **common),
        "Bullet": ParagraphStyle("Bullet", parent=base["Normal"], fontSize=10.5,
                                 bulletIndent=0, rightIndent=10, **common),
        "Quote": ParagraphStyle("Quote", parent=base["Normal"], fontSize=10.5,
                                textColor=colors.HexColor("#0E5A6B"), backColor=colors.HexColor("#F0FBFD"),
                                borderPadding=6, **common),
        "Cell": ParagraphStyle("Cell", parent=base["Normal"], fontName=_FONT, fontSize=9,
                               alignment=TA_RIGHT, wordWrap="RTL", leading=12),
        "CellHead": ParagraphStyle("CellHead", parent=base["Normal"], fontName=_FONT_BOLD, fontSize=9,
                                   alignment=TA_RIGHT, wordWrap="RTL", leading=12,
                                   textColor=colors.white),
    }
    for lvl, size in ((1, 18), (2, 15), (3, 13), (4, 11.5)):
        s[f"H{lvl}"] = ParagraphStyle(f"H{lvl}", parent=base["Normal"], fontName=_FONT_BOLD,
                                      fontSize=size, textColor=NAVY, alignment=TA_RIGHT,
                                      wordWrap="RTL", spaceBefore=10, spaceAfter=6, leading=size + 6)
    return s


def _emit(b: Block, styles: dict) -> list:
    if b.type == "heading":
        return [Paragraph(_rl(b.text), styles[f"H{min(max(b.level,1),4)}"])]
    if b.type == "paragraph":
        return [Paragraph(_rl(b.text), styles["Body"])]
    if b.type in ("bullet", "ordered"):
        marker = "•" if b.type == "bullet" else "—"
        return [Paragraph(_rl(f"{b.text} {marker}"), styles["Bullet"])]
    if b.type == "quote":
        return [Paragraph(_rl(b.text), styles["Quote"])]
    if b.type == "code":
        return [Paragraph(_rl(b.text), styles["Body"])]
    if b.type == "rule":
        return [Spacer(1, 6 * mm)]
    if b.type == "table":
        return [_emit_table(b, styles), Spacer(1, 4 * mm)]
    return []


def _emit_table(b: Block, styles: dict):
    cols = max(len(b.headers), max((len(r) for r in b.rows), default=0)) or 1
    # RTL tables: reverse column order so the first logical column sits on the right.
    def row_cells(cells: list[str], head: bool) -> list:
        padded = cells + [""] * (cols - len(cells))
        style = styles["CellHead"] if head else styles["Cell"]
        rendered = [Paragraph(_rl(c) or "&nbsp;", style) for c in padded]
        return list(reversed(rendered))

    data = [row_cells(b.headers, True)] + [row_cells(r, False) for r in b.rows]
    table = Table(data, repeatRows=1, hAlign="RIGHT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D8DEE9")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAFBFF")]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table

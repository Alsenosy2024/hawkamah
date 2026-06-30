"""DOCX export with full Arabic RTL support (python-docx).

python-docx has no high-level RTL switch, so we set the low-level OOXML bits
directly: document-default bidi, per-paragraph `w:bidi`, right alignment, and the
`w:rtl` run property. Default body font is Almarai (the project mandate for Word
exports — do NOT swap to Thmanyah here). Tables get a navy header + zebra rows.
"""

from __future__ import annotations

from io import BytesIO

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor
from docx.oxml import OxmlElement

from .markdown_ast import Block, parse_markdown

NAVY = RGBColor(0x1A, 0x35, 0x57)
GOLD = RGBColor(0xC8, 0x91, 0x2A)
DEFAULT_FONT = "Almarai"


def export_docx(markdown: str, title: str, *, font: str = DEFAULT_FONT, company: str = "") -> bytes:
    doc = Document()
    _set_rtl_defaults(doc, font)
    _cover(doc, title, company, font)

    for b in parse_markdown(markdown):
        _emit_block(doc, b, font)

    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


# --------------------------------------------------------------------------- #
def _set_rtl_defaults(doc: Document, font: str) -> None:
    # Default font.
    style = doc.styles["Normal"]
    style.font.name = font
    style.font.size = Pt(11)
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:cs"), font)   # complex-script font = Arabic
    rfonts.set(qn("w:ascii"), font)
    rfonts.set(qn("w:hAnsi"), font)
    # Document default bidi.
    _bidi_ppr(style.element.get_or_add_pPr())

    # Section direction: make every section RTL.
    for section in doc.sections:
        sectPr = section._sectPr
        bidi = sectPr.find(qn("w:bidi"))
        if bidi is None:
            bidi = OxmlElement("w:bidi")
            sectPr.append(bidi)


def _bidi_ppr(ppr) -> None:
    if ppr.find(qn("w:bidi")) is None:
        ppr.append(OxmlElement("w:bidi"))


def _rtl_para(p) -> None:
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    _bidi_ppr(p._p.get_or_add_pPr())
    for run in p.runs:
        rpr = run._element.get_or_add_rPr()
        if rpr.find(qn("w:rtl")) is None:
            rpr.append(OxmlElement("w:rtl"))


def _cover(doc: Document, title: str, company: str, font: str) -> None:
    h = doc.add_paragraph()
    run = h.add_run(title)
    run.font.size = Pt(26)
    run.font.bold = True
    run.font.color.rgb = NAVY
    run.font.name = font
    _rtl_para(h)
    if company:
        c = doc.add_paragraph()
        cr = c.add_run(company)
        cr.font.size = Pt(14)
        cr.font.color.rgb = GOLD
        cr.font.name = font
        _rtl_para(c)
    doc.add_page_break()


def _emit_block(doc: Document, b: Block, font: str) -> None:
    if b.type == "heading":
        p = doc.add_heading(level=min(max(b.level, 1), 4))
        p.clear()
        run = p.add_run(b.text)
        run.font.name = font
        run.font.color.rgb = NAVY
        _rtl_para(p)
    elif b.type == "paragraph":
        p = doc.add_paragraph(b.text)
        _style_runs(p, font)
        _rtl_para(p)
    elif b.type == "bullet":
        p = doc.add_paragraph(b.text, style="List Bullet")
        _style_runs(p, font)
        _rtl_para(p)
    elif b.type == "ordered":
        p = doc.add_paragraph(b.text, style="List Number")
        _style_runs(p, font)
        _rtl_para(p)
    elif b.type == "quote":
        p = doc.add_paragraph(b.text, style="Intense Quote")
        _style_runs(p, font)
        _rtl_para(p)
    elif b.type in ("code", "mermaid"):
        # Word has no Mermaid renderer; keep the diagram source as monospace text so
        # it is preserved rather than dropped (rich rendering lives in the HTML export).
        p = doc.add_paragraph(b.text)
        for run in p.runs:
            run.font.name = "Consolas"
    elif b.type == "rule":
        doc.add_paragraph("―" * 20)
    elif b.type == "table":
        _emit_table(doc, b, font)


def _style_runs(p, font: str) -> None:
    for run in p.runs:
        run.font.name = font


def _emit_table(doc: Document, b: Block, font: str) -> None:
    cols = max(len(b.headers), max((len(r) for r in b.rows), default=0))
    if cols == 0:
        return
    table = doc.add_table(rows=1, cols=cols)
    table.style = "Light Grid Accent 1"
    table.alignment = WD_TABLE_ALIGNMENT.RIGHT
    _table_rtl(table)

    hdr = table.rows[0].cells
    for i in range(cols):
        text = b.headers[i] if i < len(b.headers) else ""
        cell = hdr[i]
        cell.text = ""
        run = cell.paragraphs[0].add_run(text)
        run.font.bold = True
        run.font.name = font
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        _shade(cell, "1A3557")
        _rtl_para(cell.paragraphs[0])

    for r in b.rows:
        cells = table.add_row().cells
        for i in range(cols):
            text = r[i] if i < len(r) else ""
            cells[i].text = ""
            run = cells[i].paragraphs[0].add_run(text)
            run.font.name = font
            _rtl_para(cells[i].paragraphs[0])


def _table_rtl(table) -> None:
    tblPr = table._tbl.tblPr
    if tblPr.find(qn("w:bidiVisual")) is None:
        tblPr.append(OxmlElement("w:bidiVisual"))


def _shade(cell, hex_color: str) -> None:
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), hex_color)
    tcPr.append(shd)

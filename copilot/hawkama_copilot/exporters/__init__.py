"""Unified multi-format export facade.

One entry point, `export(markdown, title, fmt, ...) -> (bytes, mime, ext)`, so the
agent and API can offer "export as <anything>" without knowing per-format details.
Supported: md, html, docx, pdf, xlsx, pptx, json, txt.
"""

from __future__ import annotations

import json as _json
from dataclasses import dataclass

from .docx_export import export_docx
from .html_export import render_document, render_manual, ManualDoc
from .markdown_ast import parse_markdown, strip_markdown
from .pdf_export import export_pdf
from .pptx_export import export_pptx
from .xlsx_export import export_xlsx

FORMATS = ("md", "txt", "html", "docx", "pdf", "xlsx", "pptx", "json")

_MIME = {
    "md": ("text/markdown", "md"),
    "txt": ("text/plain", "txt"),
    "html": ("text/html", "html"),
    "json": ("application/json", "json"),
    "docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
    "pdf": ("application/pdf", "pdf"),
    "xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
    "pptx": ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"),
}


@dataclass
class Exported:
    data: bytes
    mime: str
    ext: str


def export(markdown: str, title: str, fmt: str, *, company: str = "", subtitle: str = "") -> Exported:
    fmt = fmt.lower().lstrip(".")
    if fmt not in _MIME:
        raise ValueError(f"Unsupported format: {fmt}. Supported: {', '.join(FORMATS)}")
    mime, ext = _MIME[fmt]

    if fmt == "md":
        data = markdown.encode("utf-8")
    elif fmt == "txt":
        data = strip_markdown(markdown).encode("utf-8")
    elif fmt == "html":
        data = render_document(title, markdown, subtitle=subtitle).encode("utf-8")
    elif fmt == "json":
        blocks = [b.__dict__ for b in parse_markdown(markdown)]
        data = _json.dumps({"title": title, "blocks": blocks}, ensure_ascii=False, indent=2).encode("utf-8")
    elif fmt == "docx":
        data = export_docx(markdown, title, company=company)
    elif fmt == "pdf":
        data = export_pdf(markdown, title, company=company)
    elif fmt == "xlsx":
        data = export_xlsx(markdown, title)
    elif fmt == "pptx":
        data = export_pptx(markdown, title, company=company)
    else:  # pragma: no cover
        raise ValueError(fmt)

    return Exported(data=data, mime=mime, ext=ext)


__all__ = [
    "FORMATS",
    "Exported",
    "export",
    "render_manual",
    "render_document",
    "ManualDoc",
    "parse_markdown",
    "strip_markdown",
    "export_docx",
    "export_pdf",
    "export_xlsx",
    "export_pptx",
]

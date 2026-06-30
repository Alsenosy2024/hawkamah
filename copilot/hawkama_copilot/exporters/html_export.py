"""RTL HTML governance manual — the skill's headline deliverable (§13).

Renders one or many generated documents into a single self-contained, browsable
Arabic RTL HTML file: cover, sticky side navigation, styled tables, and gap /
recommendation callout cards. No external assets (offline-friendly). HTML handles
Arabic shaping & bidi natively via `dir="rtl"`, so no reshaping is needed here.
"""

from __future__ import annotations

import html
from dataclasses import dataclass

from .markdown_ast import Block, parse_markdown

NAVY = "#0f172a"
GOLD = "#c8912a"
CYAN = "#0e9ebb"

# Mermaid runtime injected ONCE into <head> (only when the document actually has a
# diagram). Loaded from the jsDelivr CDN and themed to the app's teal brand so the
# exported diagrams match the in-app canvas. CAVEAT: this needs network access when
# the HTML is opened — offline viewers will see the raw <pre class="mermaid"> source
# rather than a rendered diagram (acceptable: the diagram text is still legible).
_MERMAID_RUNTIME = (
    "<script type=\"module\">"
    "import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'; "
    "mermaid.initialize({startOnLoad:true, theme:'base', themeVariables:{ "
    "primaryColor:'#def2f6', primaryBorderColor:'#11a8bc', lineColor:'#0b8090', "
    "fontFamily:'Thmanyah Sans, Tajawal, sans-serif' }});"
    "</script>"
)


@dataclass
class ManualDoc:
    doc_id: str
    title: str
    markdown: str


_CSS = f"""
:root {{ --navy:{NAVY}; --gold:{GOLD}; --cyan:{CYAN}; }}
* {{ box-sizing: border-box; }}
body {{ font-family: 'Thmanyah','Segoe UI',Tahoma,Arial,sans-serif; line-height:1.9;
  margin:0; background:#f7f8fa; color:#1f2937; }}
header.cover {{ background:linear-gradient(135deg,var(--navy),#1e293b); color:#fff;
  padding:64px 32px; }}
header.cover h1 {{ font-size:2.2rem; margin:0 0 8px; }}
header.cover p {{ opacity:.85; margin:0; }}
.layout {{ display:flex; align-items:flex-start; gap:24px; max-width:1280px;
  margin:0 auto; padding:24px; }}
nav.side {{ position:sticky; top:24px; flex:0 0 260px; background:#fff;
  border:1px solid #e5e7eb; border-radius:12px; padding:16px; max-height:90vh;
  overflow:auto; }}
nav.side a {{ display:block; color:var(--navy); text-decoration:none; padding:6px 8px;
  border-radius:8px; font-size:.92rem; }}
nav.side a:hover {{ background:#eef2ff; }}
nav.side a.lvl2 {{ padding-right:20px; color:#475569; font-size:.86rem; }}
main {{ flex:1; min-width:0; }}
section.doc {{ background:#fff; border-radius:12px; padding:28px 32px; margin-bottom:24px;
  border:1px solid #e9ecf2; }}
h1,h2,h3,h4 {{ color:var(--navy); }}
h2 {{ border-bottom:2px solid var(--gold); padding-bottom:6px; }}
table {{ width:100%; border-collapse:collapse; margin:16px 0; font-size:.92rem; }}
th,td {{ border:1px solid #e5e7eb; padding:9px 11px; vertical-align:top; text-align:right; }}
th {{ background:#eef2ff; color:var(--navy); }}
tr:nth-child(even) td {{ background:#fafbff; }}
blockquote {{ border-right:4px solid var(--cyan); background:#f0fbfd; margin:12px 0;
  padding:10px 14px; border-radius:6px; }}
code,pre {{ background:#0f172a0d; border-radius:6px; padding:2px 6px; font-family:monospace; }}
pre {{ padding:12px; overflow:auto; }}
pre.mermaid {{ background:transparent; border:0; padding:16px 0; text-align:center;
  font-family:inherit; overflow:visible; }}
.gap {{ background:#fff7ed; border-right:5px solid #f97316; padding:12px 14px;
  margin:10px 0; border-radius:6px; }}
.rec {{ background:#ecfdf5; border-right:5px solid #10b981; padding:12px 14px;
  margin:10px 0; border-radius:6px; }}
.src {{ color:#64748b; font-size:.82rem; }}
ul,ol {{ padding-right:22px; }}
@media print {{ nav.side{{display:none}} .layout{{display:block}} section.doc{{break-inside:avoid}} }}
"""


def render_manual(docs: list[ManualDoc], *, manual_title: str, subtitle: str = "") -> str:
    nav_items: list[str] = []
    bodies: list[str] = []
    has_mermaid = False

    for d in docs:
        blocks = parse_markdown(d.markdown)
        if any(b.type == "mermaid" for b in blocks):
            has_mermaid = True
        nav_items.append(f'<a href="#{d.doc_id}"><b>{html.escape(d.title)}</b></a>')
        for b in blocks:
            if b.type == "heading" and b.level == 2:
                aid = f"{d.doc_id}--{_slug(b.text)}"
                nav_items.append(f'<a class="lvl2" href="#{aid}">{html.escape(b.text)}</a>')
        bodies.append(_render_doc(d, blocks))

    sub = f"<p>{html.escape(subtitle)}</p>" if subtitle else ""
    # Only pull the Mermaid runtime when a diagram is actually present, so plain
    # documents stay fully offline/self-contained.
    mermaid_head = f"\n{_MERMAID_RUNTIME}" if has_mermaid else ""
    return f"""<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>{html.escape(manual_title)}</title>
<style>{_CSS}</style>{mermaid_head}
</head>
<body>
<header class="cover">
  <h1>{html.escape(manual_title)}</h1>
  {sub}
  <p>Current State Assessment · Governance Framework · Operating Model · Department Packs</p>
</header>
<div class="layout">
  <nav class="side">{''.join(nav_items)}</nav>
  <main>{''.join(bodies)}</main>
</div>
</body>
</html>"""


def render_document(title: str, markdown: str, *, subtitle: str = "") -> str:
    """Convenience: render a single generated document as a standalone manual."""
    return render_manual([ManualDoc("doc", title, markdown)], manual_title=title, subtitle=subtitle)


def _render_doc(d: ManualDoc, blocks: list[Block]) -> str:
    out: list[str] = [f'<section class="doc" id="{d.doc_id}">']
    for b in blocks:
        out.append(_render_block(d.doc_id, b))
    out.append("</section>")
    return "".join(out)


def _esc(text: str) -> str:
    """Escape for HTML and turn normalized newlines into visible line breaks."""
    return html.escape(text).replace("\n", "<br>")


def _render_block(doc_id: str, b: Block) -> str:
    if b.type == "heading":
        lvl = min(max(b.level, 1), 4)
        aid = f' id="{doc_id}--{_slug(b.text)}"' if lvl == 2 else ""
        return f"<h{lvl}{aid}>{html.escape(b.text)}</h{lvl}>"
    if b.type == "paragraph":
        return f"<p>{_classify(b.text)}</p>"
    if b.type == "bullet":
        return f"<ul><li>{_esc(b.text)}</li></ul>"
    if b.type == "ordered":
        return f"<ol><li>{_esc(b.text)}</li></ol>"
    if b.type == "quote":
        return f"<blockquote>{_esc(b.text)}</blockquote>"
    if b.type == "mermaid":
        # Mermaid reads the element's textContent, so HTML-escaping is both safe and
        # correct: the browser decodes the entities back to the original diagram
        # source before Mermaid parses it, while keeping the surrounding HTML valid.
        return f'<pre class="mermaid">{html.escape(b.text)}</pre>'
    if b.type == "code":
        return f"<pre><code>{html.escape(b.text)}</code></pre>"
    if b.type == "rule":
        return "<hr/>"
    if b.type == "table":
        return _render_table(b)
    return ""


def _render_table(b: Block) -> str:
    head = "".join(f"<th>{_esc(h)}</th>" for h in b.headers)
    rows = "".join(
        "<tr>" + "".join(f"<td>{_link_sources(_esc(c))}</td>" for c in r) + "</tr>"
        for r in b.rows
    )
    return f"<table><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table>"


def _classify(text: str) -> str:
    esc = _link_sources(_esc(text))
    low = text.strip()
    if low.startswith(("الفجوة", "فجوة", "Gap")):
        return f'<span class="gap">{esc}</span>'
    if low.startswith(("التوصية", "توصية", "Recommendation")):
        return f'<span class="rec">{esc}</span>'
    return esc


def _link_sources(text: str) -> str:
    # Make [مصدر N] visually distinct.
    import re

    return re.sub(r"(\[مصدر\s*\d+\])", r'<span class="src">\1</span>', text)


def _slug(text: str) -> str:
    import re

    return re.sub(r"\s+", "-", re.sub(r"[^\w\s؀-ۿ]", "", text.strip().lower()))[:60] or "s"

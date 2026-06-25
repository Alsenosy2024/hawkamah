"""FastAPI surface for the Hawkama Copilot, consumed by the React GovCopilot UI.

Endpoints:
  GET  /health                          → liveness + model config
  POST /ingest         (multipart)      → upload & index files into a corpus
  GET  /stats?corpus=                   → corpus stats (documents / chunks)
  POST /ask            (json, SSE)      → grounded Q&A stream (the "اسأل" tab)
  POST /draft          (json)           → draft one large document → markdown + html
  POST /build_full     (json)           → run the whole skill → docs + HTML manual
  POST /export         (json)           → render markdown to any format (download)

CORS is locked to the same origins the Firebase functions allow. Corpus IDs map
1:1 to the front-end tenantId so the same uploaded files back both stacks.
"""

from __future__ import annotations

import io
import json
from typing import Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from . import __version__
from .agent import HawkamaAgent
from .config import MODELS, SETTINGS
from .exporters import FORMATS, export
from .generation import GeneratedDoc

# The API lives on `api`; the ASGI entrypoint `app` mounts it under /copilot so it
# can be served through a Firebase Hosting rewrite (same-origin as hawkamah.web.app
# → no CORS, and no public Cloud Run exposure: Hosting's own service agent invokes
# it, which is permitted even when an org policy blocks allUsers).
api = FastAPI(title="Hawkama Copilot API", version=__version__)

ALLOWED_ORIGINS = [
    "https://hawkamah.web.app",
    "https://gen-lang-client-0579241284.firebaseapp.com",
    "http://localhost:3000",
    "http://localhost:3100",
    "http://localhost:5173",
]
api.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# The service is publicly invokable (Firebase Hosting → Cloud Run requires
# allUsers), and it's backed by a paid Gemini key, so the expensive/mutating
# endpoints are gated by an Origin/Referer allowlist — the same defense the
# project's Cloud Functions use. It stops casual/non-browser abuse; pair with
# Firebase App Check for stronger guarantees.
def require_allowed_origin(request: Request) -> None:
    o = (request.headers.get("origin") or request.headers.get("referer") or "").rstrip("/")
    if not any(o == a or o.startswith(a + "/") for a in ALLOWED_ORIGINS):
        raise HTTPException(status_code=403, detail="origin not allowed")


# Cheap agent cache keyed by corpus so we don't reload vectors every request.
_agents: dict[str, HawkamaAgent] = {}


def get_agent(corpus: str) -> HawkamaAgent:
    corpus = corpus or "default"
    if corpus not in _agents:
        _agents[corpus] = HawkamaAgent(corpus)
    return _agents[corpus]


@api.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "version": __version__,
        "models": {"text": MODELS.text, "embed": MODELS.embed},
        "embed_dim": SETTINGS.embed_dim,
        "api_key_present": bool(SETTINGS.api_key),
        "durable": bool(SETTINGS.gcs_bucket),
        "formats": list(FORMATS),
    }


@api.post("/ingest", dependencies=[Depends(require_allowed_origin)])
async def ingest(corpus: str = Form("default"), files: list[UploadFile] = File(...)) -> dict[str, Any]:
    agent = get_agent(corpus)
    payload = [(f.filename or "file", await f.read()) for f in files]
    reports = agent.ingest_bytes(payload)
    return {
        "corpus": corpus,
        "reports": [r.__dict__ for r in reports],
        "stats": agent.stats(),
    }


@api.get("/stats")
def stats(corpus: str = "default") -> dict[str, Any]:
    return get_agent(corpus).stats()


@api.post("/ask", dependencies=[Depends(require_allowed_origin)])
async def ask(body: dict[str, Any]) -> StreamingResponse:
    corpus = body.get("corpus", "default")
    question = (body.get("message") or body.get("question") or "").strip()
    history = body.get("history") or []
    if not question:
        raise HTTPException(400, "message is required")
    agent = get_agent(corpus)

    def event_stream():
        for ev in agent.ask_stream(question, history):
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@api.post("/draft", dependencies=[Depends(require_allowed_origin)])
def draft(body: dict[str, Any]) -> dict[str, Any]:
    corpus = body.get("corpus", "default")
    request = (body.get("request") or body.get("message") or "").strip()
    if not request:
        raise HTTPException(400, "request is required")
    agent = get_agent(corpus)
    doc = agent.draft(
        request,
        language=body.get("language", "ar"),
        target_pages=body.get("target_pages"),
    )
    return _doc_payload(doc)


@api.post("/build_full", dependencies=[Depends(require_allowed_origin)])
def build_full(body: dict[str, Any]) -> dict[str, Any]:
    corpus = body.get("corpus", "default")
    agent = get_agent(corpus)
    docs, manual = agent.build_full_model(
        company=body.get("company", ""),
        department_list=body.get("departments") or [],
        language=body.get("language", "ar"),
    )
    return {
        "documents": [_doc_payload(d, with_html=False) for d in docs],
        "manual_html": manual,
        "stats": agent.stats(),
    }


@api.post("/export", dependencies=[Depends(require_allowed_origin)])
def export_endpoint(body: dict[str, Any]) -> StreamingResponse:
    markdown = body.get("markdown") or ""
    title = body.get("title") or "document"
    fmt = (body.get("format") or "docx").lower()
    if not markdown:
        raise HTTPException(400, "markdown is required")
    try:
        out = export(markdown, title, fmt, company=body.get("company", ""))
    except ValueError as e:
        raise HTTPException(400, str(e))
    # HTTP headers are latin-1; an Arabic filename must go via RFC 5987
    # (filename*=UTF-8''…) with an ASCII fallback for older clients.
    from urllib.parse import quote

    base = _safe_name(title)
    ascii_name = "".join(c if c.isascii() and (c.isalnum() or c in " -_") else "_" for c in base).strip() or "document"
    utf8_name = quote(f"{base}.{out.ext}")
    disposition = f"attachment; filename=\"{ascii_name}.{out.ext}\"; filename*=UTF-8''{utf8_name}"
    return StreamingResponse(
        io.BytesIO(out.data),
        media_type=out.mime,
        headers={"Content-Disposition": disposition},
    )


def _doc_payload(doc: GeneratedDoc, with_html: bool = True) -> dict[str, Any]:
    from .exporters import render_document

    payload = {
        "title": doc.title,
        "markdown": doc.markdown,
        "word_count": doc.word_count,
        "pages": doc.page_estimate,
        "sections": [{"title": s.title, "goal": s.goal} for s in doc.sections],
        "sources": [
            {"label": e.label, "doc": e.doc_name, "heading": e.heading_path}
            for s in doc.sections for e in s.sources
        ],
    }
    if with_html:
        payload["html"] = render_document(doc.title, doc.markdown)
    return payload


def _safe_name(name: str) -> str:
    return "".join(c if c.isalnum() or c in " -_" else "_" for c in name).strip()[:80] or "document"


# ASGI entrypoint. The whole API is mounted under /copilot so a Firebase Hosting
# rewrite (source "/copilot/**") forwards the prefixed path straight through to
# the matching routes. A bare root health check is kept for Cloud Run probes.
app = FastAPI()
app.mount("/copilot", api)


@app.get("/")
@app.get("/healthz")
def root_health() -> dict[str, Any]:
    return {"ok": True, "service": "hawkama-copilot", "mounted_at": "/copilot"}

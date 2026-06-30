"""FastAPI surface for the Hawkama Copilot, consumed by the React GovCopilot UI.

Endpoints:
  GET  /health                          → liveness + model config
  POST /ingest         (multipart)      → upload & index files into a corpus
  GET  /stats?corpus=                   → corpus stats (documents / chunks)
  POST /ask            (json, SSE)      → grounded Q&A stream (the "اسأل" tab)
  POST /draft          (json)           → draft one large document → markdown + html
  POST /build_full     (json)           → run the whole skill → docs + HTML manual
  POST /export         (json)           → render markdown to any format (download)
  GET  /conversations?corpus=           → list saved chat threads (summaries)
  GET  /conversation?corpus=&id=        → one full chat thread (history)
  POST /conversations/save  (json)      → upsert a chat thread (durable)
  POST /conversations/delete (json)     → delete a chat thread

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
from .conversations import ConversationStore
from .exporters import FORMATS, export
from .generation import GeneratedDoc, GroundingContext, draft_request, generate_full_model

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
_conversations: dict[str, ConversationStore] = {}


def get_agent(corpus: str) -> HawkamaAgent:
    corpus = corpus or "default"
    if corpus not in _agents:
        _agents[corpus] = HawkamaAgent(corpus)
    return _agents[corpus]


def get_conversations(corpus: str) -> ConversationStore:
    corpus = corpus or "default"
    if corpus not in _conversations:
        _conversations[corpus] = ConversationStore(corpus)
    return _conversations[corpus]


def _grounding_from_body(body: dict[str, Any]) -> GroundingContext | None:
    """Build the V9/BE-3 grounding context from the request body.

    The front-end may send the company's real `org_units` / `roles` (BE-3), an
    explicit `departments` / `criteria` list, and a `current_state` diagnostic so
    generation derives from them instead of generic boilerplate. Absent → None, so
    the ungrounded path is byte-for-byte unchanged."""
    model = body.get("model") if isinstance(body.get("model"), dict) else {}
    g = GroundingContext(
        company=body.get("company") or model.get("companyName") or "",
        org_units=list(body.get("org_units") or body.get("orgUnits") or model.get("orgUnits") or []),
        roles=list(body.get("roles") or model.get("roles") or []),
        departments=list(body.get("departments") or []),
        criteria=list(body.get("criteria") or []),
        current_state_md=body.get("current_state") or body.get("current_state_md") or "",
    )
    return None if g.is_empty else g


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
    # Grounded path (V9/BE-3): when the body carries the company's real inputs we
    # route through generation.draft_request with a GroundingContext; otherwise the
    # routing is identical to agent.draft (same deliverable detection + free-form).
    doc = draft_request(
        agent.rag,
        request,
        language=body.get("language", "ar"),
        target_pages=body.get("target_pages"),
        ground=_grounding_from_body(body),
    )
    return _doc_payload(doc)


@api.post("/draft/stream", dependencies=[Depends(require_allowed_origin)])
async def draft_stream(body: dict[str, Any]) -> StreamingResponse:
    """SSE variant of /draft (HWK-A1). Emits
        {"type":"progress","stage":...,"done":N,"total":N}
    events while drafting, then a terminal
        {"type":"done","doc":{...}}   (or {"type":"error","detail":...}).
    The blocking /draft endpoint is unchanged; clients fall back to it when this
    route is absent (older deployment). agent.draft() already accepts an
    on_progress(stage, done, total) callback (used by the CLI), so this simply
    relays those callbacks from a worker thread onto an asyncio queue.
    """
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    corpus = body.get("corpus", "default")
    request = (body.get("request") or body.get("message") or "").strip()
    if not request:
        raise HTTPException(400, "request is required")
    agent = get_agent(corpus)
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict] = asyncio.Queue()
    doc_holder: list[dict] = []

    def on_progress(stage: str, done: int, total: int) -> None:
        loop.call_soon_threadsafe(
            queue.put_nowait,
            {"type": "progress", "stage": stage, "done": done, "total": total},
        )

    ground = _grounding_from_body(body)

    def worker() -> None:
        try:
            doc = draft_request(
                agent.rag,
                request,
                language=body.get("language", "ar"),
                target_pages=body.get("target_pages"),
                ground=ground,
                on_progress=on_progress,
            )
            doc_holder.append(_doc_payload(doc))
            loop.call_soon_threadsafe(queue.put_nowait, {"type": "__done__"})
        except Exception as exc:  # surface the failure to the client as an SSE error
            loop.call_soon_threadsafe(
                queue.put_nowait, {"type": "error", "detail": str(exc)}
            )

    async def event_generator():
        executor = ThreadPoolExecutor(max_workers=1)
        fut = loop.run_in_executor(executor, worker)
        try:
            while True:
                ev = await queue.get()
                if ev["type"] == "__done__":
                    payload = {"type": "done", "doc": doc_holder[0] if doc_holder else {}}
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                    break
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                if ev["type"] == "error":
                    break
        finally:
            await fut
            executor.shutdown(wait=False)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@api.post("/build_full", dependencies=[Depends(require_allowed_origin)])
def build_full(body: dict[str, Any]) -> dict[str, Any]:
    corpus = body.get("corpus", "default")
    agent = get_agent(corpus)
    # Grounded full build (V9/BE-3): per-axis pipeline once, diagnostic shared
    # across deliverables, org structure grounded in the real org units.
    docs, manual = generate_full_model(
        agent.rag,
        company=body.get("company", ""),
        department_list=body.get("departments") or [],
        language=body.get("language", "ar"),
        ground=_grounding_from_body(body),
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
    except Exception as e:  # noqa: BLE001 — a render crash must be a clear 500,
        # never a silent/empty 200 that the browser saves as a dead "File not found".
        raise HTTPException(500, f"export failed for format '{fmt}': {e}")
    # Defense-in-depth: a 0-byte download is exactly what opens as Google-Drive
    # "File not found". Refuse to stream an empty body as a successful response.
    if not out.data:
        raise HTTPException(500, f"export produced an empty file for format '{fmt}'")
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


# --------------------------------------------------------------------------- #
# Chat history (durable conversation threads)                                  #
# --------------------------------------------------------------------------- #
@api.get("/conversations", dependencies=[Depends(require_allowed_origin)])
def list_conversations(corpus: str = "default") -> dict[str, Any]:
    return {"corpus": corpus, "conversations": get_conversations(corpus).list()}


@api.get("/conversation", dependencies=[Depends(require_allowed_origin)])
def get_conversation(corpus: str = "default", id: str = "") -> dict[str, Any]:
    if not id:
        raise HTTPException(400, "id is required")
    conv = get_conversations(corpus).get(id)
    if conv is None:
        raise HTTPException(404, "conversation not found")
    return conv


@api.post("/conversations/save", dependencies=[Depends(require_allowed_origin)])
def save_conversation(body: dict[str, Any]) -> dict[str, Any]:
    corpus = body.get("corpus", "default")
    conv = body.get("conversation") or body
    if not isinstance(conv.get("messages"), list):
        raise HTTPException(400, "conversation.messages (list) is required")
    return {"summary": get_conversations(corpus).save(conv)}


@api.post("/conversations/delete", dependencies=[Depends(require_allowed_origin)])
def delete_conversation(body: dict[str, Any]) -> dict[str, Any]:
    corpus = body.get("corpus", "default")
    conv_id = body.get("id") or ""
    if not conv_id:
        raise HTTPException(400, "id is required")
    get_conversations(corpus).delete(conv_id)
    return {"ok": True, "id": conv_id}


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

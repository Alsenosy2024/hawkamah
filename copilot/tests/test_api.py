"""P11 — the /ask FastAPI handler.

Two fixes at the HTTP layer, both exercised offline (no model, no network) by
stubbing the cached agent so we can assert on exactly what api.ask() passes it:

  1. /ask now parses the same grounding payload /draft, /draft/stream and
     /build_full already honor (via the shared `_grounding_from_body` helper)
     and threads it into `agent.ask_stream`.
  2. /ask's SSE generator is now wrapped so a mid-stream exception yields a
     clean `{"type": "error", "message": ...}` frame instead of killing the raw
     chunked response outright.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from hawkama_copilot import api as api_mod

# api.require_allowed_origin only accepts these Origin/Referer values.
ORIGIN = {"Origin": "http://localhost:5173"}


def _sse_events(body: str) -> list[dict]:
    events = []
    for frame in body.split("\n\n"):
        frame = frame.strip()
        if not frame:
            continue
        payload = frame[len("data:"):].strip() if frame.startswith("data:") else frame
        if payload:
            events.append(json.loads(payload))
    return events


def test_ask_threads_grounding_context_into_agent(monkeypatch):
    captured: dict = {}

    class _StubAgent:
        def ask_stream(self, question, history, ground=None):
            captured["question"] = question
            captured["ground"] = ground
            yield {"type": "sources", "sources": []}
            yield {"type": "done", "text": "ok"}

    monkeypatch.setattr(api_mod, "get_agent", lambda corpus: _StubAgent())

    client = TestClient(api_mod.api)
    resp = client.post(
        "/ask",
        json={
            "corpus": "t1",
            "message": "ما هي الإدارات؟",
            "company": "شركة النور",
            "departments": ["المالية", "العمليات"],
        },
        headers=ORIGIN,
    )
    assert resp.status_code == 200
    ground = captured["ground"]
    assert ground is not None
    assert ground.company == "شركة النور"
    assert "المالية" in ground.departments and "العمليات" in ground.departments


def test_ask_without_grounding_fields_passes_none(monkeypatch):
    captured: dict = {}

    class _StubAgent:
        def ask_stream(self, question, history, ground=None):
            captured["ground"] = ground
            yield {"type": "done", "text": "ok"}

    monkeypatch.setattr(api_mod, "get_agent", lambda corpus: _StubAgent())

    client = TestClient(api_mod.api)
    resp = client.post("/ask", json={"corpus": "t1", "message": "سؤال عام"}, headers=ORIGIN)
    assert resp.status_code == 200
    assert captured["ground"] is None


def test_ask_stream_emits_clean_error_event_on_mid_stream_failure(monkeypatch):
    class _StubAgent:
        def ask_stream(self, question, history, ground=None):
            yield {"type": "sources", "sources": []}
            raise RuntimeError("boom")

    monkeypatch.setattr(api_mod, "get_agent", lambda corpus: _StubAgent())

    client = TestClient(api_mod.api)
    resp = client.post("/ask", json={"corpus": "t1", "message": "سؤال"}, headers=ORIGIN)
    assert resp.status_code == 200
    events = _sse_events(resp.text)
    assert events[0]["type"] == "sources"
    assert events[-1]["type"] == "error"
    assert "boom" in events[-1]["message"]


def test_ask_stream_clean_run_has_no_error_event(monkeypatch):
    class _StubAgent:
        def ask_stream(self, question, history, ground=None):
            yield {"type": "sources", "sources": []}
            yield {"type": "delta", "text": "جزء"}
            yield {"type": "done", "text": "جزء"}

    monkeypatch.setattr(api_mod, "get_agent", lambda corpus: _StubAgent())

    client = TestClient(api_mod.api)
    resp = client.post("/ask", json={"corpus": "t1", "message": "سؤال"}, headers=ORIGIN)
    events = _sse_events(resp.text)
    assert [e["type"] for e in events] == ["sources", "delta", "done"]


def test_doc_payload_carries_grounded_flags():
    from hawkama_copilot.generation import GeneratedDoc, Section

    # with_html=False so exporters.render_document is never reached.
    doc = GeneratedDoc(
        title="وثيقة",
        markdown="# وثيقة",
        sections=[
            Section(title="أ", goal="أ", grounded=True),
            Section(title="ب", goal="ب", grounded=False),
        ],
        sources=[],
        word_count=5,
    )
    payload = api_mod._doc_payload(doc, with_html=False)
    assert payload["ungrounded_sections"] == 1
    assert [s["grounded"] for s in payload["sections"]] == [True, False]

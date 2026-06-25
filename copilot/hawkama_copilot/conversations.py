"""Durable multi-turn chat history (conversation threads).

Each conversation is one JSON document persisted in the SAME GCS bucket as the
corpus/originals, so chat threads survive Cloud Run cold starts and follow the
user across devices. Reads prefer GCS, then a local cache in the data dir;
writes go to both (mirroring ``vector_store``). When GCS is disabled (local dev /
tests) everything still works against the local data dir, and when neither is
writable the layer degrades silently — chat keeps working, it just isn't saved.

A small ``_index.json`` per corpus holds thread *summaries* so listing the
history sidebar is a single read instead of one-GET-per-thread; it is rebuilt
from the individual thread files if it is ever missing or corrupt.

Canonical conversation document:
    {
      "id": str, "corpus": str, "title": str,
      "created_at": float, "updated_at": float,
      "messages": [ {opaque front-end message}, ... ]
    }
The ``messages`` are stored verbatim (the front-end's own shape) so every turn —
grounded Q&A, full drafts, web-researched docs, export receipts — is captured
uniformly; the agent only needs each message's role + text, derived on demand.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from . import storage as gcs
from .config import SETTINGS

_TITLE_MAX = 80
_PREVIEW_MAX = 140
# Hard ceiling so a runaway client can't grow one thread without bound. Far above
# any real governance chat; older turns beyond this are dropped oldest-first.
_MAX_MESSAGES = 400


def _safe(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in (name or ""))[:80] or "default"


def _text_of(msg: dict) -> str:
    return str(msg.get("text") or msg.get("content") or "").strip()


def _role_of(msg: dict) -> str:
    r = msg.get("sender") or msg.get("role") or ""
    return "user" if r == "user" else "agent"


class ConversationStore:
    """All chat threads for one corpus (== tenant). Thread-safe, durable."""

    def __init__(self, corpus_id: str, data_dir: Path | None = None):
        self.corpus_id = corpus_id
        self._safe_corpus = _safe(corpus_id)
        base = (data_dir or SETTINGS.data_dir) / "conversations" / self._safe_corpus
        base.mkdir(parents=True, exist_ok=True)
        self._dir = base
        self._lock = threading.Lock()

    # ------------------------------------------------------------- paths --
    def _gcs_path(self, conv_id: str) -> str:
        return f"conversations/{self.corpus_id}/{_safe(conv_id)}.json"

    def _gcs_index(self) -> str:
        return f"conversations/{self.corpus_id}/_index.json"

    def _local_path(self, conv_id: str) -> Path:
        return self._dir / f"{_safe(conv_id)}.json"

    def _local_index(self) -> Path:
        return self._dir / "_index.json"

    # ----------------------------------------------------------- low-level --
    def _read(self, gcs_path: str, local_path: Path) -> Any | None:
        raw = gcs.get_blob(gcs_path)
        if raw is None and local_path.is_file():
            raw = local_path.read_bytes()
        if not raw:
            return None
        try:
            return json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            return None

    def _write(self, gcs_path: str, local_path: Path, obj: Any) -> None:
        blob = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            tmp = local_path.with_suffix(".tmp")
            tmp.write_bytes(blob)
            tmp.replace(local_path)
        except OSError:
            pass  # read-only fs → rely on GCS
        gcs.put_blob(gcs_path, blob)

    # --------------------------------------------------------------- public --
    def get(self, conv_id: str) -> dict | None:
        return self._read(self._gcs_path(conv_id), self._local_path(conv_id))

    def save(self, conv: dict) -> dict:
        """Upsert a conversation; stamps timestamps + title, updates the index.

        Returns the thread summary (the shape the history sidebar lists)."""
        raw_id = str(conv.get("id") or "").strip()
        conv_id = _safe(raw_id) if raw_id else _new_id()
        with self._lock:
            existing = self.get(conv_id)
            now = time.time()
            created = (existing or {}).get("created_at") or conv.get("created_at") or now
            messages = list(conv.get("messages") or [])
            if len(messages) > _MAX_MESSAGES:
                messages = messages[-_MAX_MESSAGES:]
            title = (conv.get("title") or (existing or {}).get("title") or _derive_title(messages)).strip()[:_TITLE_MAX]
            doc = {
                "id": conv_id,
                "corpus": self.corpus_id,
                "title": title or "محادثة",
                "created_at": created,
                "updated_at": now,
                "messages": messages,
            }
            self._write(self._gcs_path(conv_id), self._local_path(conv_id), doc)
            summary = _summary(doc)
            self._upsert_index(summary)
            return summary

    def delete(self, conv_id: str) -> bool:
        conv_id = _safe(conv_id)
        with self._lock:
            gcs.delete_blob(self._gcs_path(conv_id))
            try:
                self._local_path(conv_id).unlink(missing_ok=True)
            except OSError:
                pass
            idx = self._load_index()
            kept = [s for s in idx if s.get("id") != conv_id]
            if len(kept) != len(idx):
                self._write(self._gcs_index(), self._local_index(), {"conversations": kept})
            return True

    def list(self) -> list[dict]:
        """Thread summaries, newest first. Rebuilds the index if missing."""
        idx = self._load_index()
        if idx is None:
            idx = self._rebuild_index()
        return sorted(idx, key=lambda s: s.get("updated_at", 0), reverse=True)

    # ----------------------------------------------------------- index io --
    def _load_index(self) -> list[dict] | None:
        data = self._read(self._gcs_index(), self._local_index())
        if not isinstance(data, dict):
            return None
        convs = data.get("conversations")
        return convs if isinstance(convs, list) else None

    def _upsert_index(self, summary: dict) -> None:
        idx = self._load_index() or []
        idx = [s for s in idx if s.get("id") != summary["id"]]
        idx.append(summary)
        self._write(self._gcs_index(), self._local_index(), {"conversations": idx})

    def _rebuild_index(self) -> list[dict]:
        """Reconstruct the index by scanning every thread file (GCS then local)."""
        ids: set[str] = set()
        prefix = f"conversations/{self.corpus_id}/"
        for name in gcs.list_blob_names(prefix):
            tail = name[len(prefix):]
            if tail.endswith(".json") and tail != "_index.json":
                ids.add(tail[:-5])
        for p in self._dir.glob("*.json"):
            if p.name != "_index.json":
                ids.add(p.stem)
        summaries: list[dict] = []
        for cid in ids:
            doc = self.get(cid)
            if doc:
                summaries.append(_summary(doc))
        self._write(self._gcs_index(), self._local_index(), {"conversations": summaries})
        return summaries


# --------------------------------------------------------------------------- #
# Helpers                                                                       #
# --------------------------------------------------------------------------- #
def _new_id() -> str:
    import uuid

    return uuid.uuid4().hex


def _derive_title(messages: list[dict]) -> str:
    for m in messages:
        if _role_of(m) == "user":
            txt = _text_of(m)
            if txt:
                return txt[:_TITLE_MAX]
    return ""


def _summary(doc: dict) -> dict:
    messages = doc.get("messages") or []
    last_text = ""
    for m in reversed(messages):
        t = _text_of(m)
        if t:
            last_text = t
            break
    return {
        "id": doc["id"],
        "title": doc.get("title") or "محادثة",
        "created_at": doc.get("created_at", 0),
        "updated_at": doc.get("updated_at", 0),
        "message_count": len(messages),
        "preview": last_text[:_PREVIEW_MAX],
    }

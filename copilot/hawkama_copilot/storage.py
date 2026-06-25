"""Durable GCS-backed persistence for the corpus + original files.

When HAWKAMA_GCS_BUCKET is set, the vector store and every ingested original file
are mirrored to a Google Cloud Storage bucket. A Cloud Run cold start (whose /tmp
is ephemeral) then reloads the full corpus — including media embeddings — with no
re-embedding, and the original images/videos/docs stay available for re-embedding
or serving. Degrades silently to local-only when the bucket is unset or the GCS
client / credentials are unavailable (e.g. local dev without ADC), so nothing
here can break ingestion.

Layout in the bucket:
    corpora/<corpus_id>.json               # the persisted vector store
    originals/<corpus_id>/<filename>       # original uploaded bytes
    conversations/<corpus_id>/<id>.json    # one chat thread (history)
    conversations/<corpus_id>/_index.json  # thread summaries for fast listing
"""

from __future__ import annotations

from functools import lru_cache

from .config import SETTINGS


@lru_cache(maxsize=1)
def _bucket():
    name = SETTINGS.gcs_bucket
    if not name:
        return None
    try:
        from google.cloud import storage  # lazy: optional dependency / creds

        client = storage.Client()
        return client.bucket(name)
    except Exception:  # noqa: BLE001 — no creds / not installed → local-only
        return None


def enabled() -> bool:
    return _bucket() is not None


def save_corpus(corpus_id: str, data: bytes) -> bool:
    b = _bucket()
    if b is None:
        return False
    try:
        b.blob(f"corpora/{corpus_id}.json").upload_from_string(data, content_type="application/json")
        return True
    except Exception:  # noqa: BLE001
        return False


def load_corpus(corpus_id: str) -> bytes | None:
    b = _bucket()
    if b is None:
        return None
    try:
        blob = b.blob(f"corpora/{corpus_id}.json")
        if blob.exists():
            return blob.download_as_bytes()
    except Exception:  # noqa: BLE001
        pass
    return None


def put_original(corpus_id: str, name: str, data: bytes, content_type: str | None = None) -> str:
    """Store an original file's bytes; returns the bucket path ('' on failure/disabled)."""
    b = _bucket()
    if b is None:
        return ""
    try:
        path = f"originals/{corpus_id}/{name}"
        b.blob(path).upload_from_string(data, content_type=content_type or "application/octet-stream")
        return path
    except Exception:  # noqa: BLE001
        return ""


def list_originals(corpus_id: str) -> list[str]:
    b = _bucket()
    if b is None:
        return []
    try:
        prefix = f"originals/{corpus_id}/"
        return [bl.name[len(prefix):] for bl in b.list_blobs(prefix=prefix) if bl.name != prefix]
    except Exception:  # noqa: BLE001
        return []


def get_original(corpus_id: str, name: str) -> bytes | None:
    b = _bucket()
    if b is None:
        return None
    try:
        blob = b.blob(f"originals/{corpus_id}/{name}")
        if blob.exists():
            return blob.download_as_bytes()
    except Exception:  # noqa: BLE001
        pass
    return None


# --------------------------------------------------------------------------- #
# Generic blob I/O (used by the conversation store for chat history)           #
# --------------------------------------------------------------------------- #
def put_blob(path: str, data: bytes, content_type: str = "application/json") -> bool:
    b = _bucket()
    if b is None:
        return False
    try:
        b.blob(path).upload_from_string(data, content_type=content_type)
        return True
    except Exception:  # noqa: BLE001
        return False


def get_blob(path: str) -> bytes | None:
    b = _bucket()
    if b is None:
        return None
    try:
        blob = b.blob(path)
        if blob.exists():
            return blob.download_as_bytes()
    except Exception:  # noqa: BLE001
        pass
    return None


def delete_blob(path: str) -> bool:
    b = _bucket()
    if b is None:
        return False
    try:
        blob = b.blob(path)
        if blob.exists():
            blob.delete()
        return True
    except Exception:  # noqa: BLE001
        return False


def list_blob_names(prefix: str) -> list[str]:
    """Return blob names (full paths) under a prefix; [] when GCS is disabled."""
    b = _bucket()
    if b is None:
        return []
    try:
        return [bl.name for bl in b.list_blobs(prefix=prefix)]
    except Exception:  # noqa: BLE001
        return []

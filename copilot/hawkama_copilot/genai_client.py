"""Thin, resilient wrapper around the google-genai Python SDK.

Centralizes: client construction, retry/backoff with model fallback (mirrors the
JS `embeddingService` policy — retry 429/5xx, give up on terminal 4xx), JSON
generation, token-by-token streaming, and embeddings. Every other module talks
to Gemini through here so the retry/fallback policy lives in exactly one place.
"""

from __future__ import annotations

import json
import random
import re
import time
from typing import Any, Callable, Iterable, Iterator, Sequence

from google import genai
from google.genai import types

from .config import SETTINGS, MODELS


# --------------------------------------------------------------------------- #
# Client singleton                                                            #
# --------------------------------------------------------------------------- #
_client: genai.Client | None = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(api_key=SETTINGS.require_api_key())
    return _client


# --------------------------------------------------------------------------- #
# Error classification (status-aware retry)                                    #
# --------------------------------------------------------------------------- #
def _err_status(e: Exception) -> int:
    for attr in ("status_code", "code", "status"):
        v = getattr(e, attr, None)
        if isinstance(v, int):
            return v
    m = re.search(r"\b(4\d\d|5\d\d)\b", str(e))
    return int(m.group(1)) if m else 0


def _retryable(e: Exception) -> bool:
    s = _err_status(e)
    return s == 429 or 500 <= s < 600 or s == 0  # 0 == network/unknown → retry


def _backoff(attempt: int) -> float:
    # 0.7s, 1.4s, 2.8s ... + jitter, capped.
    return min(0.7 * (2 ** attempt) + random.uniform(0, 0.25), 15.0)


# --------------------------------------------------------------------------- #
# Text generation                                                             #
# --------------------------------------------------------------------------- #
def _build_config(
    *,
    system: str | None,
    temperature: float | None,
    max_output_tokens: int | None,
    json_mode: bool,
    response_schema: Any | None,
    thinking_budget: int | None,
    tools: Sequence[Callable[..., Any]] | None,
) -> types.GenerateContentConfig:
    kwargs: dict[str, Any] = {}
    if system:
        kwargs["system_instruction"] = system
    if temperature is not None:
        kwargs["temperature"] = temperature
    if max_output_tokens is not None:
        kwargs["max_output_tokens"] = max_output_tokens
    if json_mode:
        kwargs["response_mime_type"] = "application/json"
        if response_schema is not None:
            kwargs["response_schema"] = response_schema
    if thinking_budget is not None:
        kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=thinking_budget)
    if tools:
        kwargs["tools"] = list(tools)
    return types.GenerateContentConfig(**kwargs)


def generate(
    prompt: str | Sequence[Any],
    *,
    system: str | None = None,
    model: str | None = None,
    temperature: float | None = None,
    max_output_tokens: int | None = None,
    json_mode: bool = False,
    response_schema: Any | None = None,
    thinking_budget: int | None = None,
    tools: Sequence[Callable[..., Any]] | None = None,
    attempts: int = 4,
) -> str:
    """Generate text, retrying transient failures and falling back to a second
    model if the primary keeps failing. Returns the response text (possibly a
    JSON string when ``json_mode`` is set)."""
    client = get_client()
    primary = model or MODELS.text
    fallback = MODELS.text_fallback if primary != MODELS.text_fallback else None
    models = [m for m in (primary, fallback) if m]
    contents: Any = prompt

    last_err: Exception | None = None
    for mdl in models:
        cfg = _build_config(
            system=system,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
            json_mode=json_mode,
            response_schema=response_schema,
            thinking_budget=thinking_budget,
            tools=tools,
        )
        for attempt in range(attempts):
            try:
                resp = client.models.generate_content(model=mdl, contents=contents, config=cfg)
                text = (resp.text or "").strip()
                if text:
                    return text
                break  # empty but no error → try next model
            except Exception as e:  # noqa: BLE001 — classify below
                last_err = e
                if _retryable(e) and attempt < attempts - 1:
                    time.sleep(_backoff(attempt))
                    continue
                break  # terminal (4xx) or exhausted → next model
    if last_err:
        raise last_err
    return ""


def generate_json(
    prompt: str | Sequence[Any],
    *,
    system: str | None = None,
    model: str | None = None,
    temperature: float | None = 0.1,
    max_output_tokens: int | None = None,
    response_schema: Any | None = None,
    default: Any = None,
) -> Any:
    """Generate and parse a JSON value. Tolerates code-fenced JSON. Returns
    ``default`` (or raises if default is None) on unparseable output."""
    raw = generate(
        prompt,
        system=system,
        model=model,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
        json_mode=True,
        response_schema=response_schema,
    )
    parsed = _parse_json_loose(raw)
    if parsed is None:
        if default is not None:
            return default
        raise ValueError(f"Model did not return valid JSON. Got: {raw[:300]!r}")
    return parsed


def _parse_json_loose(raw: str) -> Any | None:
    if not raw:
        return None
    s = raw.strip()
    # Strip ```json ... ``` fences if present.
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", s, re.DOTALL)
    if fence:
        s = fence.group(1).strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    # Salvage the outermost {...} or [...] block.
    for opener, closer in (("{", "}"), ("[", "]")):
        i, j = s.find(opener), s.rfind(closer)
        if 0 <= i < j:
            try:
                return json.loads(s[i : j + 1])
            except json.JSONDecodeError:
                continue
    return None


def generate_stream(
    prompt: str | Sequence[Any],
    *,
    system: str | None = None,
    model: str | None = None,
    temperature: float | None = None,
    max_output_tokens: int | None = None,
    thinking_budget: int | None = None,
) -> Iterator[str]:
    """Yield text deltas as they arrive. Falls back to a one-shot generate on a
    streaming failure so callers always get *something*."""
    client = get_client()
    mdl = model or MODELS.text
    cfg = _build_config(
        system=system,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
        json_mode=False,
        response_schema=None,
        thinking_budget=thinking_budget,
        tools=None,
    )
    try:
        for chunk in client.models.generate_content_stream(model=mdl, contents=prompt, config=cfg):
            piece = getattr(chunk, "text", None)
            if piece:
                yield piece
    except Exception:  # noqa: BLE001 — degrade to non-streaming
        text = generate(
            prompt,
            system=system,
            model=mdl,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
        if text:
            yield text


# --------------------------------------------------------------------------- #
# Embeddings                                                                   #
# --------------------------------------------------------------------------- #
def embed(
    texts: Sequence[str],
    *,
    task_type: str,
    dim: int | None = None,
    attempts: int = 4,
) -> list[list[float]]:
    """Embed a batch of texts with gemini-embedding-001.

    Returns one vector per input (same order). Failed inputs yield ``[]`` so the
    caller can degrade that chunk to lexical-only retrieval rather than poisoning
    the store with a zero vector. Vectors below 3072 dims are L2-normalized as
    required by the embedding API.
    """
    if not texts:
        return []
    client = get_client()
    out_dim = dim or SETTINGS.embed_dim
    cfg = types.EmbedContentConfig(task_type=task_type, output_dimensionality=out_dim)
    models = [MODELS.embed, MODELS.embed_fallback]

    cleaned = [(t or "").strip()[: SETTINGS.embed_max_chars] for t in texts]

    for mdl in models:
        for attempt in range(attempts):
            try:
                resp = client.models.embed_content(model=mdl, contents=list(cleaned), config=cfg)
                vecs = [list(e.values) for e in (resp.embeddings or [])]
                if len(vecs) == len(cleaned):
                    return [_normalize(v, out_dim) for v in vecs]
                break  # shape mismatch → next model
            except Exception as e:  # noqa: BLE001
                if _retryable(e) and attempt < attempts - 1:
                    time.sleep(_backoff(attempt))
                    continue
                break
    # Total failure for this batch → empty vectors (caller degrades to lexical).
    return [[] for _ in cleaned]


def embed_one(text: str, *, task_type: str, dim: int | None = None) -> list[float]:
    res = embed([text], task_type=task_type, dim=dim)
    return res[0] if res else []


def _normalize(vec: list[float], expected_dim: int) -> list[float]:
    # gemini-embedding-001 returns unit-norm vectors only at 3072; truncated MRL
    # vectors must be re-normalized for cosine/dot-product to behave.
    if not vec:
        return vec
    if len(vec) == 3072:
        return vec
    norm = sum(x * x for x in vec) ** 0.5
    if norm == 0:
        return vec
    return [x / norm for x in vec]

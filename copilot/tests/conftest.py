"""Shared fixtures: a fake Gemini layer so the suite runs offline & deterministic."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

# Make the package importable without installation.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _fake_vec(text: str, dim: int = 1536) -> list[float]:
    """Deterministic pseudo-embedding: a hashed bag-of-words vector. Texts that
    share words get a positive cosine (like a real RETRIEVAL embedding), texts
    that don't sit near orthogonal — enough to exercise the vector path."""
    import re

    import numpy as np

    v = np.zeros(dim, dtype="float32")
    for tok in re.findall(r"\w+", text.lower()):
        if len(tok) <= 2:
            continue
        h = int.from_bytes(hashlib.sha256(tok.encode("utf-8")).digest()[:4], "little")
        v[h % dim] += 1.0
    n = float(np.linalg.norm(v))
    return (v / n).tolist() if n else v.tolist()


@pytest.fixture
def fake_gemini(monkeypatch):
    """Patch genai_client so no network calls happen."""
    from hawkama_copilot import genai_client

    def fake_embed(texts, *, task_type, dim=None, attempts=4):
        return [_fake_vec(t, dim or 1536) for t in texts]

    def fake_embed_one(text, *, task_type, dim=None):
        return _fake_vec(text, dim or 1536)

    def fake_generate(prompt, **kw):
        # Echo a small markdown section so generation pipeline produces structure.
        title = "قسم"
        return f"## {title}\nمحتوى تجريبي [مصدر 1].\n\n| العمود | القيمة |\n|---|---|\n| أ | ب |"

    def fake_generate_json(prompt, **kw):
        # Used by build_outline and _critique.
        if "revise" in str(kw.get("response_schema", "")) or "راجع" in str(prompt):
            return {"revise": []}
        # Titles/goals reference corpus terms so retrieval hits and the
        # citations path is exercised end-to-end.
        return {"sections": [
            {"title": "التعيين والتوظيف", "goal": "سياسة التعيين والكفاءة وفترة التجربة"},
            {"title": "الإجازات", "goal": "الإجازة السنوية للموظف ومدتها"},
        ]}

    def fake_stream(prompt, **kw):
        yield "إجابة "
        yield "تجريبية [مصدر 1]."

    monkeypatch.setattr(genai_client, "embed", fake_embed)
    monkeypatch.setattr(genai_client, "embed_one", fake_embed_one)
    monkeypatch.setattr(genai_client, "generate", fake_generate)
    monkeypatch.setattr(genai_client, "generate_json", fake_generate_json)
    monkeypatch.setattr(genai_client, "generate_stream", fake_stream)
    # Re-export into modules that imported the functions by reference.
    import hawkama_copilot.rag as rag_mod
    import hawkama_copilot.generation as gen_mod
    import hawkama_copilot.agent as agent_mod
    for mod in (rag_mod, gen_mod, agent_mod):
        monkeypatch.setattr(mod, "genai_client", genai_client)
    return genai_client


@pytest.fixture
def tmp_corpus(tmp_path):
    # SETTINGS is a frozen dataclass shared by reference across modules; redirect
    # its data_dir to a temp dir via object.__setattr__ and restore after.
    from hawkama_copilot import config

    original = config.SETTINGS.data_dir
    object.__setattr__(config.SETTINGS, "data_dir", tmp_path)
    yield tmp_path
    object.__setattr__(config.SETTINGS, "data_dir", original)

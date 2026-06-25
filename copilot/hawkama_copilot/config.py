"""Central configuration for the Hawkama Copilot Python agent.

Single source of truth for model names, embedding geometry, retrieval knobs and
API-key loading. Mirrors the front-end `constants/models.ts` so the Python agent
and the React app speak about the same Gemini models.

Everything here is overridable via environment variables (or a `.env` file) so a
model upgrade or a dimensionality change is a one-line/config change, never a
scattered find-replace.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


# --------------------------------------------------------------------------- #
# .env loading (tiny, dependency-free)                                         #
# --------------------------------------------------------------------------- #
# We deliberately avoid python-dotenv to keep the dependency surface small. We
# look for a .env first in the copilot/ dir, then in the repo root (where the
# React app keeps its key as GEMINI_API_KEY / API_KEY).
_REPO_ROOT = Path(__file__).resolve().parents[2]          # .../repo
_COPILOT_ROOT = Path(__file__).resolve().parents[1]       # .../repo/copilot


def _load_env_files() -> None:
    for env_path in (_COPILOT_ROOT / ".env", _REPO_ROOT / ".env"):
        if not env_path.is_file():
            continue
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            # Do not clobber a value already present in the real environment.
            os.environ.setdefault(key, val)


_load_env_files()


def _get(name: str, default: str) -> str:
    return os.environ.get(name, default)


def resolve_api_key() -> str:
    """Resolve the Gemini Developer API key from the environment.

    Accepts any of the names the project already uses so we never duplicate the
    secret: HAWKAMA_GEMINI_API_KEY > GEMINI_API_KEY > API_KEY.
    """
    for name in ("HAWKAMA_GEMINI_API_KEY", "GEMINI_API_KEY", "API_KEY"):
        v = os.environ.get(name)
        if v:
            return v
    return ""


@dataclass(frozen=True)
class Models:
    # Text generation / reasoning / extraction. Matches constants/models.ts.
    text: str = _get("HAWKAMA_TEXT_MODEL", "gemini-3.5-flash")
    text_fallback: str = _get("HAWKAMA_TEXT_FALLBACK", "gemini-2.5-flash")
    # Heavy long-form drafting. Defaults to the same flash model (proven on the
    # project's key) but can be pointed at a Pro model via env when available.
    generate: str = _get("HAWKAMA_GEN_MODEL", _get("HAWKAMA_TEXT_MODEL", "gemini-3.5-flash"))
    # Embeddings. Primary is gemini-embedding-2 — MULTIMODAL (text + image + video
    # in one shared vector space; inline image bytes work on the Developer API,
    # verified). gemini-embedding-001 (text-only) is the fallback for text.
    embed: str = _get("HAWKAMA_EMBED_MODEL", "gemini-embedding-2")
    embed_fallback: str = _get("HAWKAMA_EMBED_FALLBACK", "gemini-embedding-001")


@dataclass(frozen=True)
class Settings:
    api_key: str = field(default_factory=resolve_api_key)
    models: Models = field(default_factory=Models)

    # --- Embedding geometry --------------------------------------------------
    # gemini-embedding-001 defaults to 3072 dims (Matryoshka). We truncate to
    # 1536 and L2-normalize: half the storage, negligible quality loss, AND it
    # fits Firestore's KNN vector-index ceiling of 2048 dims so the same vectors
    # work both for in-process cosine and Firestore find_nearest.
    embed_dim: int = int(_get("HAWKAMA_EMBED_DIM", "1536"))
    embed_doc_task: str = "RETRIEVAL_DOCUMENT"
    embed_query_task: str = "RETRIEVAL_QUERY"
    # gemini-embedding-001 truncates silently above 2048 tokens; we cap chunk
    # text well under that (~1 token ≈ 4 chars for mixed Arabic/English).
    embed_max_chars: int = 7000
    embed_batch: int = int(_get("HAWKAMA_EMBED_BATCH", "32"))      # texts/request
    embed_concurrency: int = int(_get("HAWKAMA_EMBED_CONCURRENCY", "6"))

    # --- Chunking ------------------------------------------------------------
    chunk_max_chars: int = 1400        # ~512 tokens, matches the JS ingestion
    chunk_min_chars: int = 200

    # --- Retrieval -----------------------------------------------------------
    retrieve_k: int = int(_get("HAWKAMA_RETRIEVE_K", "8"))
    retrieve_k_max: int = 16
    rerank_vector_weight: float = 0.70
    rerank_lexical_weight: float = 0.22
    rerank_heading_weight: float = 0.08
    retrieve_rel_cutoff: float = 0.45  # keep cands >= cutoff * best score

    # --- Generation ----------------------------------------------------------
    # Gemini flash/pro cap output at 65,536 tokens. We size per-section ceilings
    # under that and stitch sections to exceed it across a whole document.
    gen_max_output_tokens: int = int(_get("HAWKAMA_GEN_MAX_TOKENS", "32768"))
    gen_section_tokens: int = int(_get("HAWKAMA_GEN_SECTION_TOKENS", "8192"))
    gen_temperature: float = float(_get("HAWKAMA_GEN_TEMP", "0.35"))
    gen_max_sections: int = int(_get("HAWKAMA_GEN_MAX_SECTIONS", "40"))

    # --- Storage -------------------------------------------------------------
    data_dir: Path = field(default_factory=lambda: Path(_get("HAWKAMA_DATA_DIR", str(_COPILOT_ROOT / "data"))))

    # --- Skill ---------------------------------------------------------------
    # The governance operating-model skill spec (Arabic). Read at runtime so the
    # agent's methodology stays in lock-step with the source-of-truth markdown.
    # Prefer the copy vendored inside the package (present in the container image),
    # then the repo-parent original, both overridable via HAWKAMA_SKILL_PATH.
    skill_path: Path = field(default_factory=lambda: Path(_get(
        "HAWKAMA_SKILL_PATH",
        str(next(
            (p for p in (
                Path(__file__).resolve().parent / "governance_operating_model_skill.md",
                _REPO_ROOT.parent / "governance_operating_model_skill.md",
            ) if p.is_file()),
            Path(__file__).resolve().parent / "governance_operating_model_skill.md",
        )),
    )))

    def require_api_key(self) -> str:
        if not self.api_key:
            raise RuntimeError(
                "No Gemini API key found. Set HAWKAMA_GEMINI_API_KEY (or "
                "GEMINI_API_KEY / API_KEY) in the environment or a .env file."
            )
        return self.api_key


# Module-level singleton; cheap and immutable.
SETTINGS = Settings()
MODELS = SETTINGS.models

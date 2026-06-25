"""Hawkama Copilot — a Python AI agent for governance & operating-model work.

Built on the google-genai SDK with RAG over gemini-embedding-001, large multi-page
document generation, and multi-format export (MD/HTML/DOCX/PDF/XLSX/PPTX). Drives
the "كوبايلوت الحوكمة" surface: ingest a large corpus, ask grounded questions,
and draft exportable governance documents.
"""

from __future__ import annotations

from .agent import AgentResult, AskResult, HawkamaAgent
from .config import MODELS, SETTINGS
from .generation import GeneratedDoc
from .rag import Evidence, RagEngine

__version__ = "0.1.0"

__all__ = [
    "HawkamaAgent",
    "AskResult",
    "AgentResult",
    "RagEngine",
    "Evidence",
    "GeneratedDoc",
    "SETTINGS",
    "MODELS",
    "__version__",
]

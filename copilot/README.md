# Hawkama Copilot — Python AI Agent (كوبايلوت الحوكمة)

A Python AI agent built on the **google-genai SDK** that powers the Governance
Copilot surface of Hawkamah. It ingests a **large corpus** of an organization's
files, answers grounded questions over them, and drafts **large multi-page
governance documents** that it can export to **any file format** (Markdown, RTL
HTML, DOCX, PDF, XLSX, PPTX, JSON).

It implements the methodology in
[`../../governance_operating_model_skill.md`](../../governance_operating_model_skill.md)
— the Governance & Operating Model Architect skill: current-state assessment,
org structure, initial strategy, governance framework, board/committee charters,
department operating packs, RACI/DoA matrices, KPIs, and a risk register, all the
way to a single browsable RTL HTML governance manual.

---

## Why it exists / what's novel

| Requirement | How it's met |
|---|---|
| **AI agent on Google GenAI SDK** | `genai.Client` + `client.models.generate_content` / `embed_content`; a real **function-calling** agent loop (`agent.run_agent`). Models mirror the app's `constants/models.ts` (`gemini-3.5-flash`, `gemini-embedding-001`). |
| **RAG with the latest embeddings** | `gemini-embedding-001` at **1536 dims, L2-normalized** (`RETRIEVAL_DOCUMENT` for chunks, `RETRIEVAL_QUERY` for queries). Hybrid retrieval = vector + lexical + heading rerank with a relative-score cutoff and `[مصدر N]` citations. |
| **Process large file volumes** | Streaming extraction (PDF/DOCX/XLSX/PPTX/HTML/text + Gemini OCR fallback), Arabic-aware hierarchical chunking, **batched bounded-concurrency embedding**, append-only persistent vector store (numpy cosine; vectors fit Firestore's 2048-dim KNN ceiling). |
| **Many pages per document** | `generation.py` never asks for the whole doc at once: **outline → per-section RAG draft → critique → targeted revise → stitch**. Document length is bounded by `sections × per-section-tokens`, not one model call's 64K output cap. |
| **Generate all file types** | Unified `exporters.export(markdown, title, fmt)` → MD/TXT/HTML/DOCX/PDF/XLSX/PPTX/JSON, all with correct **Arabic shaping & RTL** (`arabic-reshaper` + `python-bidi` for PDF; native RTL props for the rest). |

---

## Layout

```
copilot/
  hawkama_copilot/
    config.py          # models, embedding geometry, retrieval/gen knobs, .env loading
    genai_client.py    # google-genai wrapper: retry/backoff + fallback, JSON, stream, embed
    extraction.py      # PDF/DOCX/XLSX/PPTX/HTML/text + Gemini OCR fallback
    chunking.py        # heading + Arabic-marker aware hierarchical chunking
    embeddings…        # (in genai_client.embed) gemini-embedding-001, normalized
    vector_store.py    # persistent, numpy-vectorized cosine top-k
    rag.py             # ingest() + retrieve() (hybrid rerank + citations)
    skill.py           # the governance skill: persona, deliverables, quality gates
    generation.py      # large multi-page doc generation (outline→sections→critique→stitch)
    agent.py           # ask / draft / build_full_model / run_agent (function calling)
    exporters/         # markdown_ast + docx/pdf/xlsx/pptx/html writers
    api.py             # FastAPI: /health /ingest /ask(SSE) /draft /build_full /export
    cli.py             # `hawkama` CLI
  tests/               # 22 offline tests (Gemini mocked) — no network needed
```

## Setup

```bash
cd copilot
uv venv .venv && source .venv/bin/activate     # or: python -m venv .venv
uv pip install -r requirements.txt             # or: pip install -r requirements.txt
cp .env.example .env                           # add HAWKAMA_GEMINI_API_KEY (or reuse repo-root .env)
```

The key is read from `HAWKAMA_GEMINI_API_KEY`, `GEMINI_API_KEY`, or `API_KEY`
(it auto-loads `copilot/.env` then the repo-root `.env`).

## CLI

```bash
hawkama ingest acme  /path/to/company_docs/*          # extract → chunk → embed → store
hawkama stats  acme
hawkama ask    acme  "هل توجد سياسة لتعارض المصالح؟ وما الفجوة؟"
hawkama draft  acme  "اكتب سياسة تعارض المصالح كاملة" --pages 10 --format md,docx,pdf --out ./out
hawkama build  acme  --company "شركة أكمي" --dept "المالية" --dept "الموارد البشرية" \
                     --format html,docx --out ./out          # whole skill → HTML manual
hawkama serve  --port 8000
```

## HTTP API

```
GET  /health                               liveness + model config
POST /ingest        (multipart: corpus, files[])      → index files
GET  /stats?corpus=…
POST /ask           {corpus,message,history}          → SSE: {sources|delta|done}
POST /draft         {corpus,request,target_pages}     → {title,markdown,html,pages,sources}
POST /build_full    {corpus,company,departments[]}    → {documents[],manual_html}
POST /export        {markdown,title,format,company}    → file download
```

## Tests

```bash
pytest -q          # 22 passing, fully offline (genai mocked)
```

## Frontend integration

The React `components/GovCopilot.tsx` already calls this backend behind a flag.
Set the backend URL at build time and the copilot routes Ask → `/ask`, full-draft
requests → `/draft`, and Export buttons → `/export`:

```bash
# repo root
echo 'VITE_COPILOT_API=http://localhost:8000' >> .env.local
npm run dev
```

When `VITE_COPILOT_API` is unset, the app uses its in-app TS path unchanged, so
this is safe to ship dark and flip on per environment. The copilot `corpus` id is
the front-end `tenantId`, so both stacks share the same uploaded files.

## Key design decisions

- **1536-dim embeddings**: `gemini-embedding-001` defaults to 3072; we truncate
  to 1536 and re-normalize (the API requires manual normalization below 3072).
  Half the storage, negligible quality loss, and it fits Firestore's KNN index
  ceiling (2048) so the same vectors back both in-process search and Firestore
  `find_nearest` if a tenant outgrows the local store.
- **Thinking-model awareness**: `gemini-3.5-flash` counts thinking + output
  against `max_output_tokens`; section budgets are sized generously (≥8K) so
  thinking never starves the body.
- **Grounding first**: every factual sentence cites `[مصدر N]`; missing evidence
  is flagged, never fabricated — per the skill's mandatory rules.
```

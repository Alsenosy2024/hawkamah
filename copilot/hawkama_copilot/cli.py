"""Command-line interface for the Hawkama Copilot.

    hawkama ingest <corpus> <path...>          # extract, chunk, embed, store
    hawkama stats <corpus>
    hawkama ask <corpus> "سؤال"                 # grounded answer + citations
    hawkama draft <corpus> "اكتب سياسة..." [--pages N] [--format docx,pdf,...] [--out DIR]
    hawkama build <corpus> [--company NAME] [--dept "المالية" --dept "الموارد البشرية"]
                            [--format html,docx] [--out DIR]
    hawkama serve [--host H --port P]          # run the FastAPI server
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .agent import HawkamaAgent
from .config import SETTINGS
from .exporters import export


def _progress(stage: str, done: int, total: int) -> None:
    print(f"  · {stage}: {done}/{total}", file=sys.stderr)


def _write_outputs(markdown: str, title: str, formats: list[str], out_dir: Path, company: str = "") -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in " -_" else "_" for c in title).strip()[:80] or "document"
    for fmt in formats:
        res = export(markdown, title, fmt, company=company)
        path = out_dir / f"{safe}.{res.ext}"
        path.write_bytes(res.data)
        print(f"  → {path}")


def cmd_ingest(args) -> int:
    agent = HawkamaAgent(args.corpus)
    reports = agent.ingest_paths(args.paths, on_progress=_progress)
    ok = sum(r.chunks for r in reports)
    for r in reports:
        status = f"{r.chunks} chunks ({r.method})" if r.chunks else f"SKIPPED — {r.error}"
        print(f"  {r.file}: {status}")
    print(f"Indexed {ok} chunks across {len(reports)} files. {agent.stats()}")
    return 0


def cmd_stats(args) -> int:
    print(HawkamaAgent(args.corpus).stats())
    return 0


def cmd_ask(args) -> int:
    agent = HawkamaAgent(args.corpus)
    res = agent.ask(args.question)
    print(res.answer)
    if res.sources:
        print("\n— المصادر —")
        for e in res.sources:
            print(f"  [{e.label}] {e.doc_name} › {e.heading_path}  ({e.score})")
    return 0


def cmd_draft(args) -> int:
    agent = HawkamaAgent(args.corpus)
    doc = agent.draft(args.request, target_pages=args.pages, on_progress=_progress)
    print(f"Generated «{doc.title}» — ~{doc.page_estimate} pages, {len(doc.sections)} sections, {doc.word_count} words")
    _write_outputs(doc.markdown, doc.title, args.format.split(","), Path(args.out), company=args.company)
    return 0


def cmd_build(args) -> int:
    agent = HawkamaAgent(args.corpus)
    docs, manual = agent.build_full_model(
        company=args.company, department_list=args.dept or [], on_progress=_progress
    )
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "Governance_Manual.html").write_text(manual, encoding="utf-8")
    print(f"  → {out / 'Governance_Manual.html'}")
    for d in docs:
        _write_outputs(d.markdown, d.title, args.format.split(","), out, company=args.company)
    print(f"Built {len(docs)} deliverables for {args.company or args.corpus}.")
    return 0


def cmd_serve(args) -> int:
    import uvicorn

    uvicorn.run("hawkama_copilot.api:app", host=args.host, port=args.port, reload=False)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="hawkama", description="Hawkama Copilot — governance AI agent")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("ingest"); sp.add_argument("corpus"); sp.add_argument("paths", nargs="+"); sp.set_defaults(fn=cmd_ingest)
    sp = sub.add_parser("stats"); sp.add_argument("corpus"); sp.set_defaults(fn=cmd_stats)
    sp = sub.add_parser("ask"); sp.add_argument("corpus"); sp.add_argument("question"); sp.set_defaults(fn=cmd_ask)

    sp = sub.add_parser("draft")
    sp.add_argument("corpus"); sp.add_argument("request")
    sp.add_argument("--pages", type=int, default=None)
    sp.add_argument("--format", default="md,docx")
    sp.add_argument("--out", default="./out")
    sp.add_argument("--company", default="")
    sp.set_defaults(fn=cmd_draft)

    sp = sub.add_parser("build")
    sp.add_argument("corpus")
    sp.add_argument("--company", default="")
    sp.add_argument("--dept", action="append")
    sp.add_argument("--format", default="md,html")
    sp.add_argument("--out", default="./out")
    sp.set_defaults(fn=cmd_build)

    sp = sub.add_parser("serve")
    sp.add_argument("--host", default="127.0.0.1"); sp.add_argument("--port", type=int, default=8000)
    sp.set_defaults(fn=cmd_serve)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())

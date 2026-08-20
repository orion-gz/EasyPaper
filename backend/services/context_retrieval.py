"""Grounded page/paragraph retrieval for document chat.

SQLite FTS5 supplies lexical recall; deterministic page proximity, explicit page
references and section adjacency provide the re-ranking layer. No document text
is sent to telemetry or external embedding services.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

_TOKEN_RE = re.compile(r"[A-Za-z0-9가-힣_]{2,}")
_PAGE_RE = re.compile(r"(?:page|pages|p\.?|페이지)\s*(\d+)(?:\s*[-–~]\s*(\d+))?", re.I)
_CITATION_RE = re.compile(r"\[(p|pp)\.(\d+)(?:\s*[-–]\s*(\d+))?\]", re.I)
_STOP = {"the", "and", "for", "that", "with", "this", "from", "what", "which", "문서", "페이지", "내용", "대한"}


@dataclass(frozen=True)
class ContextResult:
    text: str
    evidence_pages: frozenset[int]
    retrieval_count: int
    strategy: str


def _tokens(text: str) -> list[str]:
    return [t.casefold() for t in _TOKEN_RE.findall(text or "") if t.casefold() not in _STOP]


def _section_name(text: str, fallback: str) -> str:
    for line in (text or "").splitlines()[:8]:
        clean = line.strip().strip("#")
        if 3 <= len(clean) <= 120 and (line.lstrip().startswith("#") or re.match(r"^(?:\d+(?:\.\d+)*|chapter|section|장|절)\b", clean, re.I)):
            return clean
    return fallback


def chunk_pages(pages: Iterable[dict], max_chars: int = 1800) -> list[dict]:
    chunks = []
    current_section = ""
    for page in pages:
        page_num = int(page.get("page_num") or 0)
        text = (page.get("text") or "").strip()
        if not text or page_num < 1:
            continue
        current_section = _section_name(text, current_section or f"Page {page_num}")
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        if not paragraphs:
            paragraphs = [text]
        bucket = ""
        ordinal = 0
        for paragraph in paragraphs:
            parts = [paragraph[i:i + max_chars] for i in range(0, len(paragraph), max_chars)]
            for part in parts:
                if bucket and len(bucket) + len(part) + 2 > max_chars:
                    chunks.append({"page_num": page_num, "ordinal": ordinal, "section": current_section, "content": bucket})
                    ordinal += 1
                    bucket = ""
                bucket = f"{bucket}\n\n{part}".strip()
        if bucket:
            chunks.append({"page_num": page_num, "ordinal": ordinal, "section": current_section, "content": bucket})
    return chunks


def index_document_chunks(doc_id: str, pages: list[dict]) -> int:
    from services.db import get_db
    chunks = chunk_pages(pages)
    with get_db() as conn:
        try:
            conn.execute("DELETE FROM document_chunks_fts WHERE doc_id = ?", (doc_id,))
            conn.executemany(
                "INSERT INTO document_chunks_fts(doc_id,page_num,ordinal,section,content) VALUES(?,?,?,?,?)",
                [(doc_id, c["page_num"], c["ordinal"], c["section"], c["content"]) for c in chunks],
            )
            conn.commit()
        except Exception:
            return 0
    return len(chunks)


def _requested_pages(question: str, total_pages: int) -> set[int]:
    result = set()
    for start, end in _PAGE_RE.findall(question or ""):
        a, b = int(start), int(end or start)
        if a > b:
            a, b = b, a
        result.update(range(max(1, a), min(total_pages, b) + 1))
    return result


def _fts_rows(doc_id: str, query: str) -> list[dict]:
    terms = list(dict.fromkeys(_tokens(query)))[:12]
    if not terms:
        return []
    expression = " OR ".join(f'"{term.replace(chr(34), "")}"' for term in terms)
    from services.db import get_db
    try:
        with get_db() as conn:
            rows = conn.execute(
                """SELECT page_num, ordinal, section, content, bm25(document_chunks_fts) AS rank
                   FROM document_chunks_fts WHERE document_chunks_fts MATCH ? AND doc_id = ?
                   ORDER BY rank LIMIT 30""",
                (expression, doc_id),
            ).fetchall()
        return [dict(row) for row in rows]
    except Exception:
        return []


def retrieve_context(doc_id: str, pages: list[dict], question: str, current_page: int | None = None,
                     selected_text: str | None = None, budget: int = 40000, max_chunks: int = 14) -> ContextResult:
    all_chunks = chunk_pages(pages)
    total_pages = max((int(p.get("page_num") or 0) for p in pages), default=0)
    from services.document_policy import feature_enabled
    fts_enabled = feature_enabled("document_fts")
    rows = _fts_rows(doc_id, question) if fts_enabled else []
    if fts_enabled and not rows and all_chunks:
        index_document_chunks(doc_id, pages)
        rows = _fts_rows(doc_id, question)
    if not rows:
        query_terms = set(_tokens(question))
        rows = []
        for chunk in all_chunks:
            overlap = len(query_terms.intersection(_tokens(chunk["content"])))
            if overlap:
                rows.append({**chunk, "rank": -float(overlap)})

    requested = _requested_pages(question, total_pages)
    page_priority = set(requested)
    if current_page and 1 <= current_page <= total_pages:
        page_priority.add(current_page)

    def score(row: dict) -> tuple[float, int, int]:
        page = int(row["page_num"])
        lexical = -float(row.get("rank") or 0.0)
        explicit = 100.0 if page in requested else 0.0
        proximity = 0.0 if not current_page else max(0.0, 24.0 - abs(page - current_page) * 6.0)
        return (lexical + explicit + proximity, -page, -int(row.get("ordinal") or 0))

    ranked = sorted(rows, key=score, reverse=True)
    by_key = {(int(c["page_num"]), int(c["ordinal"])): c for c in all_chunks}
    selected = []
    seen = set()

    # Always retain explicit/current page evidence, even when query terms are sparse.
    for c in all_chunks:
        if int(c["page_num"]) in page_priority:
            key = (int(c["page_num"]), int(c["ordinal"]))
            if key not in seen:
                selected.append(c); seen.add(key)
    for row in ranked:
        key = (int(row["page_num"]), int(row.get("ordinal") or 0))
        if key not in seen:
            selected.append(row); seen.add(key)
        # Extend within the same section by one adjacent paragraph.
        neighbor = by_key.get((key[0], key[1] + 1))
        if neighbor and neighbor.get("section") == row.get("section"):
            nkey = (key[0], key[1] + 1)
            if nkey not in seen:
                selected.append(neighbor); seen.add(nkey)
        if len(selected) >= max_chunks:
            break
    if not selected:
        selected = all_chunks[:min(4, max_chunks)]

    blocks = []
    evidence = set()
    if selected_text:
        page = current_page if current_page and current_page > 0 else 0
        blocks.append(f"--- Selected text, Page {page or '?'} ---\n{selected_text.strip()}")
        if page:
            evidence.add(page)
    for row in selected:
        page = int(row["page_num"])
        block = f"--- Page {page} · {row.get('section') or 'Document'} ---\n{row['content'].strip()}"
        if sum(len(b) + 2 for b in blocks) + len(block) > budget:
            continue
        blocks.append(block)
        evidence.add(page)
    strategy = "fts5+page-proximity+section" if fts_enabled else "lexical+page-proximity+section"
    return ContextResult("\n\n".join(blocks), frozenset(evidence), len(selected), strategy)


def validate_page_citations(answer: str, evidence_pages: set[int] | frozenset[int]) -> tuple[str, list[str]]:
    invalid = []
    def replace(match: re.Match) -> str:
        start, end = int(match.group(2)), int(match.group(3) or match.group(2))
        cited = set(range(min(start, end), max(start, end) + 1))
        if cited and cited.issubset(evidence_pages):
            return match.group(0)
        invalid.append(match.group(0))
        return "[제공된 근거에서 확인되지 않은 페이지 인용 제거]"
    return _CITATION_RE.sub(replace, answer or ""), invalid

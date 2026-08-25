"""Grounded page/paragraph retrieval for document chat.

SQLite FTS5 supplies lexical recall; deterministic page proximity, explicit page
references and section adjacency provide the re-ranking layer. No document text
is sent to telemetry or external embedding services.
"""
from __future__ import annotations

import hashlib
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
    evidence: tuple[dict, ...] = ()


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


def _chunk_evidence(doc_id: str, revision: int, chunk: dict, page: dict) -> dict:
    content = str(chunk.get("content") or "").strip()
    page_text = str(page.get("text") or "")
    char_start = page_text.find(content)
    if char_start < 0:
        probe = content[:120]
        char_start = page_text.find(probe) if probe else -1
    char_end = char_start + len(content) if char_start >= 0 else None
    occurrence = 1
    if char_start >= 0 and content:
        occurrence = page_text[:char_start].count(content) + 1
    bbox = None
    for block in page.get("blocks") or []:
        block_text = str(block.get("text") or "") if isinstance(block, dict) else ""
        if content[:80] and content[:80] in block_text:
            bbox = block.get("bbox")
            break
    chunk_page_num = chunk.get("page_num")
    chunk_ordinal = chunk.get("ordinal")
    identity = f"{doc_id}:{revision}:{chunk_page_num}:{chunk_ordinal}:{char_start}:{content}"
    evidence_id = "ev_" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
    return {
        "evidence_id": evidence_id,
        "content_revision": int(revision),
        "page_num": int(chunk.get("page_num") or 0),
        "section": str(chunk.get("section") or ""),
        "quote": content,
        "char_start": char_start if char_start >= 0 else None,
        "char_end": char_end,
        "occurrence": occurrence,
        "bbox": bbox,
    }


def resolve_page_selected_text(
    pages: list[dict], page_num: int, selected_text: str | None,
) -> str | None:
    """Return the canonical source substring only when it exists on the page."""
    selection = (selected_text or "").strip()
    if not selection:
        return None
    page = next(
        (item for item in pages if int(item.get("page_num") or 0) == int(page_num)),
        None,
    )
    if page is None:
        return None
    source = str(page.get("text") or "")
    exact_start = source.find(selection)
    if exact_start >= 0:
        return source[exact_start:exact_start + len(selection)]

    # Browser text selection and PDF extraction commonly disagree only on line
    # breaks or repeated spaces. Match those boundaries flexibly, but return the
    # original server-side substring rather than any client-provided characters.
    parts = re.split(r"\s+", selection)
    if not parts:
        return None
    match = re.search(r"\s+".join(re.escape(part) for part in parts), source)
    return match.group(0) if match else None


def retrieve_context(doc_id: str, pages: list[dict], question: str, current_page: int | None = None,
                     selected_text: str | None = None, budget: int = 40000, max_chunks: int = 14,
                     content_revision: int = 1) -> ContextResult:
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
            selected.append(by_key.get(key, row)); seen.add(key)
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
    evidence_items = []
    pages_by_num = {int(page.get("page_num") or 0): page for page in pages}
    if selected_text:
        page_num = current_page if current_page and current_page > 0 else 0
        selected_chunk = {
            "page_num": page_num, "ordinal": -1,
            "section": "Selected text", "content": selected_text.strip(),
        }
        selected_evidence = _chunk_evidence(
            doc_id, content_revision, selected_chunk, pages_by_num.get(page_num, {}),
        )
        evidence_items.append(selected_evidence)
        selected_id = selected_evidence["evidence_id"]
        page_label = page_num or "?"
        blocks.append(
            f"[E:{selected_id}] Page {page_label} · Selected text\n"
            f"{selected_text.strip()}"
        )
    for row in selected:
        page_num = int(row["page_num"])
        evidence_item = _chunk_evidence(
            doc_id, content_revision, row, pages_by_num.get(page_num, {}),
        )
        evidence_id = evidence_item["evidence_id"]
        section = row.get("section") or "Document"
        content = row["content"].strip()
        block_text = (
            f"[E:{evidence_id}] Page {page_num} · {section}\n{content}"
        )
        if sum(len(item) + 2 for item in blocks) + len(block_text) > budget:
            continue
        blocks.append(block_text)
        evidence_items.append(evidence_item)
    strategy = "fts5+page-proximity+section" if fts_enabled else "lexical+page-proximity+section"
    evidence_pages = frozenset(item["page_num"] for item in evidence_items if item["page_num"] > 0)
    return ContextResult(
        "\n\n".join(blocks), evidence_pages, len(selected), strategy, tuple(evidence_items),
    )


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


_EVIDENCE_CITATION_RE = re.compile(r"\[E:([A-Za-z0-9_-]+)\]")
_NUMBER_RE = re.compile(r"(?<![A-Za-z])\d+(?:[.,]\d+)?%?")


def validate_evidence_citations(answer: str, evidence: tuple[dict, ...] | list[dict]) -> tuple[str, list[dict], dict]:
    """Allow only supplied evidence IDs and expose page citations to the UI."""
    by_id = {item["evidence_id"]: item for item in evidence}
    cited_ids = []
    invalid_ids = []

    def replace(match: re.Match) -> str:
        evidence_id = match.group(1)
        item = by_id.get(evidence_id)
        if item is None:
            invalid_ids.append(evidence_id)
            return "[제공되지 않은 근거 ID 제거]"
        cited_ids.append(evidence_id)
        page_num = item["page_num"]
        return f"[p.{page_num}]"

    displayed = _EVIDENCE_CITATION_RE.sub(replace, answer or "")
    cited = [by_id[evidence_id] for evidence_id in dict.fromkeys(cited_ids)]
    sentences = [part.strip() for part in re.split(r"(?<=[.!?。！？])\s+|\n+", answer or "") if part.strip()]
    numeric_without_citation = [
        sentence[:240] for sentence in sentences
        if _NUMBER_RE.search(sentence) and not _EVIDENCE_CITATION_RE.search(sentence)
    ]
    claim_count = sum(1 for sentence in sentences if len(sentence) >= 24)
    insufficient = claim_count >= 3 and len(set(cited_ids)) * 2 < claim_count
    risks = []
    if invalid_ids:
        risks.append("invalid_evidence_id")
    if numeric_without_citation:
        risks.append("uncited_numeric_claim")
    if insufficient:
        risks.append("insufficient_citation_coverage")
    verification = {
        "status": "risk" if risks else "verified_structure",
        "risks": risks,
        "invalid_evidence_ids": list(dict.fromkeys(invalid_ids)),
        "uncited_numeric_claims": numeric_without_citation,
        "claim_count": claim_count,
        "citation_count": len(set(cited_ids)),
    }
    return displayed, cited, verification

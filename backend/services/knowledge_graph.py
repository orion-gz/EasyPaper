"""
개인 지식 그래프(Knowledge Graph) 오케스트레이션.

논문(Paper) 노드, LLM이 추출한 개념(Concept) 노드, 그리고 두 종류의 엣지
(인용 citation / 카테고리 category)로 구성된 그래프를 만든다.

- 개념 노드: 번역 완료 시(translation_job.py) 한 번 LLM으로 추출해
  concepts/paper_concepts 테이블에 영구 저장한다(sync_document_for_graph).
- 인용 엣지: 참고문헌 파싱 + 라이브러리 내 텍스트 매칭(primer.py의
  _match_library_references 재사용)으로 계산해 paper_edges에 영구 저장한다.
  라이브러리 전체를 스캔하는 매칭이라 요청마다 다시 돌리기엔 비용이 있고,
  결과가 자주 바뀌지 않아 캐싱 가치가 크다.
- 카테고리 엣지: metadata.categories가 겹치는 문서끼리 매 요청마다 메모리에서
  즉석으로 계산한다(get_graph_data) - DB에 저장하지 않는다. LLM 호출 없이
  카테고리 리스트만 비교하면 되는 저렴한 연산인 반면, 저장해두면 논문이
  나중에 재분류될 때마다 이전 엣지를 무효화하는 로직이 추가로 필요해진다.
  "비용 대비 정합성 유지 부담"을 저울질했을 때 인용 엣지와는 반대 선택.
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import List

logger = logging.getLogger(__name__)

# 그래프 조회 시점에 아직 개념/인용 동기화가 안 된(graph_synced_at 없는) 문서를
# 백그라운드로 백필한다. 같은 문서에 대해 중복으로 백필 태스크가 여러 개
# 뜨는 것을 막기 위한 in-flight 집합.
_syncing: set = set()


async def sync_document_for_graph(doc_id: str, pages: list, doc_title: str) -> None:
    """번역 완료 직후 호출되어, 해당 문서의 개념을 추출하고 라이브러리 내
    다른 논문과의 인용 관계를 매칭해 DB에 저장한다. 실패해도 번역 파이프라인
    자체는 영향받지 않도록 호출부(translation_job.py)에서 try/except로 감싼다."""
    from services.library import get_document, update_document_metadata
    doc = get_document(doc_id)
    if not doc:
        return
    username = doc["username"]

    from services.llm_client import extract_paper_concepts
    from services.db import db_upsert_concept, db_link_paper_concept
    concepts = await extract_paper_concepts(
        doc_title, "\n".join(p.get("text", "") for p in pages[:2]), session_id=doc_id
    )
    for c in concepts:
        name = (c.get("concept") or "").strip()
        if not name:
            continue
        concept_id = db_upsert_concept(name, name.lower(), c.get("kind"))
        db_link_paper_concept(doc_id, concept_id)

    try:
        from services.reference_parser import extract_reference_list
        from services.primer import _match_library_references
        from services.db import db_upsert_paper_edge
        reference_map = extract_reference_list(pages)
        matches = _match_library_references(reference_map, doc_id, username)
        for m in matches:
            db_upsert_paper_edge(doc_id, m["doc_id"], "citation", {"ref_num": m["ref_num"]})
    except Exception:
        pass  # 참고문헌 파싱/매칭 실패는 조용히 무시한다 (primer.py와 동일한 철학)

    meta = doc.get("metadata", {})
    meta["graph_synced_at"] = datetime.now(timezone.utc).isoformat()
    update_document_metadata(doc_id, meta)


async def _backfill_one(doc_id: str) -> None:
    """graph_synced_at이 없는 구 문서를 그래프 조회 시점에 뒤늦게 동기화한다.
    /library/{doc_id}/references 라우트(routers/library.py)가 페이지 텍스트를
    얻는 방식과 동일한 패턴(캐시 우선, 없으면 추출 후 캐싱)을 그대로 따른다."""
    try:
        from services.library import get_document, get_pdf_path
        doc = get_document(doc_id)
        if not doc:
            return

        pdf_path = get_pdf_path(doc_id)
        if not pdf_path:
            return  # PDF가 없으면 이번엔 스킵 - 다음 조회 때 다시 시도된다

        from services.cache import get_cached_pages, save_pages_cache
        from services.pdf_parser import extract_pages
        pages = get_cached_pages(doc_id, pdf_path)
        if pages is None:
            pages = await asyncio.to_thread(extract_pages, pdf_path)
            save_pages_cache(doc_id, pdf_path, pages)

        doc_title = doc.get("metadata", {}).get("title") or doc.get("filename")
        await sync_document_for_graph(doc_id, pages, doc_title)
    except Exception as e:
        logger.warning(f"지식 그래프 백필 실패 (doc_id={doc_id}): {e}")
    finally:
        _syncing.discard(doc_id)


async def get_graph_data(username: str) -> dict:
    """현재 로그인한 사용자가 소유한 문서만으로 그래프를 구성한다.
    list_documents(username=username)로 소유 문서만 가져오는 것 자체가
    보안 경계다(routers/library.py의 _require_owned_document 패턴과 동일한
    "존재 자체를 노출하지 않는다" 원칙 - 여기서는 다른 사용자 문서는 애초에
    쿼리 결과에 들어오지도 않는다)."""
    from services.library import list_documents
    docs = list_documents(username=username)
    doc_ids = [d["id"] for d in docs]

    nodes = []
    for doc in docs:
        meta = doc.get("metadata", {}) or {}
        nodes.append({
            "id": f"paper:{doc['id']}",
            "type": "paper",
            "label": meta.get("title") or doc["filename"],
            "doc_id": doc["id"],
            "categories": meta.get("categories", []),
        })

    edges = []

    # 카테고리 엣지: DB에 저장하지 않고 매 요청마다 메모리에서 계산한다
    # (모듈 docstring의 설계 근거 참고).
    seen_category_pairs = set()
    for i in range(len(docs)):
        cats_i = set((docs[i].get("metadata", {}) or {}).get("categories", []) or [])
        if not cats_i:
            continue
        for j in range(i + 1, len(docs)):
            cats_j = set((docs[j].get("metadata", {}) or {}).get("categories", []) or [])
            shared = cats_i & cats_j
            for cat in shared:
                pair_key = (docs[i]["id"], docs[j]["id"], cat)
                if pair_key in seen_category_pairs:
                    continue
                seen_category_pairs.add(pair_key)
                edges.append({
                    "source": f"paper:{docs[i]['id']}",
                    "target": f"paper:{docs[j]['id']}",
                    "type": "category",
                    "category": cat,
                })

    # 인용 엣지: sync_document_for_graph가 미리 계산해 저장해둔 것을 그대로 읽는다.
    from services.db import db_get_paper_edges_for_docs
    paper_edges = db_get_paper_edges_for_docs(doc_ids)
    for e in paper_edges:
        edges.append({
            "source": f"paper:{e['doc_id_a']}",
            "target": f"paper:{e['doc_id_b']}",
            "type": "citation",
        })

    # 개념 노드/엣지
    from services.db import db_get_concepts_for_docs
    concept_links = db_get_concepts_for_docs(doc_ids)
    seen_concept_ids = set()
    for link in concept_links:
        cid = link["concept_id"]
        if cid not in seen_concept_ids:
            seen_concept_ids.add(cid)
            nodes.append({
                "id": f"concept:{cid}",
                "type": "concept",
                "label": link["name"],
                "kind": link.get("kind"),
            })
        edges.append({
            "source": f"paper:{link['doc_id']}",
            "target": f"concept:{cid}",
            "type": "has_concept",
        })

    # 아직 개념/인용 동기화가 안 된 문서는 pending으로 표시하고, 백그라운드로
    # 백필을 걸어둔다(fire-and-forget - 이번 응답에는 반영되지 않고, 클라이언트가
    # 잠시 뒤 다시 조회하면 반영된다).
    pending_docs = []
    for doc in docs:
        if (doc.get("metadata", {}) or {}).get("graph_synced_at"):
            continue
        pending_docs.append(doc["id"])
        if doc["id"] in _syncing:
            continue
        _syncing.add(doc["id"])
        asyncio.create_task(_backfill_one(doc["id"]))

    return {
        "nodes": nodes,
        "edges": edges,
        "pending_docs": pending_docs,
    }

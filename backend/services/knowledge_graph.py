"""
개인 지식 그래프(Knowledge Graph) 오케스트레이션.

논문(Paper)/개념(Concept)/메모(Note) 노드와, 인용(citation)/카테고리(category)/
개념 보유(has_concept)/유사 개념(similar_to)/메모 소속(notes_on) 엣지로
구성된 그래프를 만든다. 질문(Question)은 그래프 캔버스에는 그리지 않는다 -
채팅이 많은 사용자는 수백 개가 쌓일 수 있어 노드로 표시하면 그래프가
지저분해지므로, Concept/Paper 노드 클릭 시 상세 패널에 "관련 질문" 목록으로만
노출한다(get_related_questions).

- 개념 노드: 번역 완료 시(translation_job.py) 한 번 LLM으로 추출해
  concepts/paper_concepts 테이블에 영구 저장한다(sync_document_for_graph).
  새로 만들어진 개념은 그 자리에서 기존 개념 전체와 LLM으로 비교해, 의미가
  사실상 같은 것이 있으면 concept_edges에 비파괴적으로 연결한다(AI Graph
  Linking - 병합이 아니라 엣지 추가라 오판이 나도 데이터 손실이 없다).
- 인용 엣지: 참고문헌 파싱 + 라이브러리 내 텍스트 매칭(primer.py의
  _match_library_references 재사용)으로 계산해 paper_edges에 영구 저장한다.
  라이브러리 전체를 스캔하는 매칭이라 요청마다 다시 돌리기엔 비용이 있고,
  결과가 자주 바뀌지 않아 캐싱 가치가 크다.
- 카테고리 엣지: metadata.categories가 겹치는 문서끼리 매 요청마다 메모리에서
  즉석으로 계산한다(get_graph_data) - DB에 저장하지 않는다. LLM 호출 없이
  카테고리 리스트만 비교하면 되는 저렴한 연산인 반면, 저장해두면 논문이
  나중에 재분류될 때마다 이전 엣지를 무효화하는 로직이 추가로 필요해진다.
  "비용 대비 정합성 유지 부담"을 저울질했을 때 인용 엣지와는 반대 선택.
- 질문-개념 연결: 채팅 응답이 저장된 직후(chat.py) 해당 질문이 그 논문(들)의
  기존 개념 중 무엇과 관련 있는지 폐쇄형으로 분류한다(새 개념을 만들지 않음).
- Note 노드: 이미 서버 DB에 미러링된 memos 테이블을 그대로 노출한다(LLM
  호출 불필요 - 순수 데이터 노출).
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import List, Optional

logger = logging.getLogger(__name__)

# 그래프 조회 시점에 아직 개념/인용 동기화가 안 된(graph_synced_at 없는) 문서를
# 백그라운드로 백필한다. 같은 문서에 대해 중복으로 백필 태스크가 여러 개
# 뜨는 것을 막기 위한 in-flight 집합.
_syncing: set = set()

# 질문(chats.role='user') 배치 백필용 in-flight 집합(chat_id 단위).
_syncing_questions: set = set()

# 그래프 조회 시점에 한 번에 처리할 미동기화 질문 상한 - 오래된 질문이 아주
# 많이 쌓여도 그래프 조회 한 번에 LLM 호출이 무한정 늘어나지 않도록 방지.
_QUESTION_BACKFILL_BATCH_SIZE = 20


async def sync_document_for_graph(doc_id: str, pages: list, doc_title: str) -> None:
    """번역 완료 직후 호출되어, 해당 문서의 개념을 추출하고 라이브러리 내
    다른 논문과의 인용 관계를 매칭해 DB에 저장한다. 실패해도 번역 파이프라인
    자체는 영향받지 않도록 호출부(translation_job.py)에서 try/except로 감싼다."""
    from services.library import get_document, update_document_metadata
    doc = get_document(doc_id)
    if not doc:
        return
    username = doc["username"]

    from services.llm_client import extract_paper_concepts, find_similar_concepts
    from services.db import db_upsert_concept, db_link_paper_concept, db_get_all_concepts, db_upsert_concept_edge
    concepts = await extract_paper_concepts(
        doc_title, "\n".join(p.get("text", "") for p in pages[:2]), session_id=doc_id
    )

    # AI Graph Linking: 새로 만들어진 개념만, 그 시점까지의 전체 개념 이름과
    # 비교해 유사한 것이 있으면 연결한다. 개념 하나당 LLM 호출 1회로 비용을
    # 제한한다(쌍마다 호출하지 않음). 같은 배치 안에서 먼저 처리된 개념도
    # existing_by_normalized에 누적되므로, 한 논문에서 유사/중복 개념이 여러 개
    # 추출된 경우도 자연히 연결된다.
    existing_by_normalized = {c["normalized_name"]: c for c in db_get_all_concepts()}

    for c in concepts:
        name = (c.get("concept") or "").strip()
        if not name:
            continue
        normalized = name.lower()
        is_new = normalized not in existing_by_normalized
        concept_id = db_upsert_concept(name, normalized, c.get("kind"))
        db_link_paper_concept(doc_id, concept_id)

        if is_new and existing_by_normalized:
            try:
                candidate_names = [c2["name"] for c2 in existing_by_normalized.values()]
                matches = await find_similar_concepts(name, candidate_names, session_id=doc_id)
                for m in matches:
                    matched_name = (m.get("concept") or "").strip()
                    matched = existing_by_normalized.get(matched_name.lower())
                    if matched:
                        db_upsert_concept_edge(concept_id, matched["id"])
            except Exception:
                pass  # 유사 개념 탐색 실패는 조용히 무시한다 - 부가 정보일 뿐

        existing_by_normalized[normalized] = {"id": concept_id, "name": name, "normalized_name": normalized}

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


async def sync_question_for_graph(chat_id: int, doc_id_or_compare_id: str, question_text: str) -> None:
    """채팅 응답 저장 직후 호출되어, 이 질문이 어떤 논문(들)에 대한 것인지
    연결하고(question_papers), 그 논문(들)에 이미 추출된 개념 중 무엇과
    관련 있는지 폐쇄형으로 분류해 연결한다(question_concepts). 새 개념을
    만들지 않는다 - 개념 추출은 sync_document_for_graph의 몫이다.
    실패해도 채팅 응답 자체에는 영향 없도록 호출부(routers/chat.py)에서
    fire-and-forget(asyncio.create_task)으로 호출하고 예외를 삼킨다."""
    from services.db import (
        db_get_compare_doc_ids, db_link_question_paper, db_get_concepts_for_docs,
        db_link_question_concept, db_mark_question_synced,
    )

    if doc_id_or_compare_id.startswith("cmp_"):
        doc_ids = db_get_compare_doc_ids(doc_id_or_compare_id)
    else:
        doc_ids = [doc_id_or_compare_id]

    if not doc_ids:
        db_mark_question_synced(chat_id)
        return

    for doc_id in doc_ids:
        db_link_question_paper(chat_id, doc_id)

    concept_links = db_get_concepts_for_docs(doc_ids)
    if concept_links:
        from services.llm_client import match_question_to_concepts
        seen_concept_ids = set()
        concept_by_name = {}
        for link in concept_links:
            if link["concept_id"] not in seen_concept_ids:
                seen_concept_ids.add(link["concept_id"])
                concept_by_name[link["name"].lower()] = link["concept_id"]

        try:
            matches = await match_question_to_concepts(
                question_text, list({link["name"] for link in concept_links}), session_id=chat_id
            )
            for m in matches:
                matched_name = (m.get("concept") or "").strip().lower()
                concept_id = concept_by_name.get(matched_name)
                if concept_id:
                    db_link_question_concept(chat_id, concept_id)
        except Exception:
            pass  # 질문-개념 매칭 실패는 조용히 무시한다 - 부가 정보일 뿐

    db_mark_question_synced(chat_id)


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


async def _backfill_question(chat_id: int, doc_id: str, content: str) -> None:
    try:
        await sync_question_for_graph(chat_id, doc_id, content)
    except Exception as e:
        logger.warning(f"질문 지식 그래프 백필 실패 (chat_id={chat_id}): {e}")
    finally:
        _syncing_questions.discard(chat_id)


def _queue_note_nodes(doc_ids: List[str], nodes: list, edges: list) -> None:
    """이 사용자 소유 문서들의 메모(memos)를 Note 노드로 노출한다. LLM 호출이
    필요 없는 순수 데이터 노출이라 백필/pending 개념이 없다 - annotations/memos
    서버 미러(1차)가 이미 최신 상태를 best-effort로 유지하고 있으므로 그걸
    그대로 읽기만 한다."""
    from services.db import db_get_memos
    for doc_id in doc_ids:
        mirrored = db_get_memos(doc_id)
        if not mirrored or not mirrored.get("data"):
            continue
        for items in mirrored["data"].values():
            for item in items or []:
                if not isinstance(item, dict) or not item.get("id"):
                    continue
                note_id = f"note:{doc_id}:{item['id']}"
                nodes.append({
                    "id": note_id,
                    "type": "note",
                    "label": (item.get("text") or "")[:80],
                    "doc_id": doc_id,
                })
                edges.append({
                    "source": note_id,
                    "target": f"paper:{doc_id}",
                    "type": "notes_on",
                })


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

    # 개념 노드/엣지 (+ 질문 연결 수)
    from services.db import db_get_concepts_for_docs, db_get_question_count_for_concepts, db_get_concept_edges_for_concepts
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

    concept_id_list = list(seen_concept_ids)
    question_counts = db_get_question_count_for_concepts(concept_id_list)
    for node in nodes:
        if node["type"] == "concept":
            node["question_count"] = question_counts.get(int(node["id"].split(":", 1)[1]), 0)

    # AI Graph Linking: 유사 개념 엣지(비파괴적, 병합 아님)
    for e in db_get_concept_edges_for_concepts(concept_id_list):
        edges.append({
            "source": f"concept:{e['concept_id_a']}",
            "target": f"concept:{e['concept_id_b']}",
            "type": "similar_to",
        })

    # Note 노드: LLM 호출 불필요, memos 서버 미러를 그대로 노출.
    _queue_note_nodes(doc_ids, nodes, edges)

    # 아직 개념/인용 동기화가 안 된(graph_synced_at 없는) 문서는 pending으로
    # 표시하고, 백그라운드로 백필을 걸어둔다(fire-and-forget - 이번 응답에는
    # 반영되지 않고, 클라이언트가 잠시 뒤 다시 조회하면 반영된다).
    pending_docs = []
    for doc in docs:
        if (doc.get("metadata", {}) or {}).get("graph_synced_at"):
            continue
        pending_docs.append(doc["id"])
        if doc["id"] in _syncing:
            continue
        _syncing.add(doc["id"])
        asyncio.create_task(_backfill_one(doc["id"]))

    # 아직 개념 매칭이 안 된 질문 배치 백필(오래된 것부터, 상한 있음).
    from services.db import db_get_unsynced_questions
    for q in db_get_unsynced_questions(doc_ids, limit=_QUESTION_BACKFILL_BATCH_SIZE):
        if q["id"] in _syncing_questions:
            continue
        _syncing_questions.add(q["id"])
        asyncio.create_task(_backfill_question(q["id"], q["doc_id"], q["content"]))

    return {
        "nodes": nodes,
        "edges": edges,
        "pending_docs": pending_docs,
    }


async def get_related_questions(username: str, node_id: str) -> List[dict]:
    """상세 패널에서 Concept/Paper 노드를 클릭했을 때 보여줄 관련 질문 목록을
    반환한다. node_id는 "concept:{id}" 또는 "paper:{doc_id}" 형태. 다른
    사용자 데이터가 섞이지 않도록, concept 조회는 이 사용자가 소유한 문서
    범위로 한 번 더 필터링한다."""
    from services.library import list_documents
    owned_doc_ids = {d["id"] for d in list_documents(username=username)}

    if node_id.startswith("paper:"):
        doc_id = node_id.split(":", 1)[1]
        if doc_id not in owned_doc_ids:
            return []
        from services.db import db_get_related_questions_for_doc
        return db_get_related_questions_for_doc(doc_id)

    if node_id.startswith("concept:"):
        concept_id = int(node_id.split(":", 1)[1])
        from services.db import db_get_related_questions_for_concept
        questions = db_get_related_questions_for_concept(concept_id)
        return [q for q in questions if q.get("doc_id") in owned_doc_ids]

    return []


async def search_graph_nodes(username: str, query: str) -> dict:
    """이 사용자가 소유한 범위 안에서 논문/개념/메모/질문을 검색해 매칭된
    그래프 노드 id를 반환한다."""
    from services.library import list_documents
    from services.db import db_search_graph_nodes
    doc_ids = [d["id"] for d in list_documents(username=username)]
    return db_search_graph_nodes(doc_ids, query)

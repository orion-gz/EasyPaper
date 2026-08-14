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
- 연구 태그: 역할별 태그를 Tag 노드로 노출하고, 논문 간 직접 엣지는 같은
  primary topic을 공유할 때만 요청 시 계산한다. broad domain만 겹치는 논문은
  Tag 노드를 통해 간접적으로만 보이므로 직접 관련성이 있다고 과장하지 않는다.
- 질문-개념 연결: 채팅 응답이 저장된 직후(chat.py) 해당 질문이 그 논문(들)의
  기존 개념 중 무엇과 관련 있는지 폐쇄형으로 분류한다(새 개념을 만들지 않음).
- Note 노드: 이미 서버 DB에 미러링된 memos 테이블을 그대로 노출한다(LLM
  호출 불필요 - 순수 데이터 노출).
"""
import asyncio
import hashlib
import json
import logging
import math
import os
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# 추천 논문 목록 캐시 TTL - LLM+OpenAlex 검증이 여러 번 들어가는 무거운 작업이라
# 매번 다시 계산하지 않고, 일주일에 한 번만 새로 생성해 app_meta에 저장해둔다.
READING_RECOMMENDATIONS_CACHE_DAYS = 7

# AI 인사이트 캐시 TTL - 대시보드를 열 때마다 LLM을 호출하지 않으면서도 하루에
# 한 번은 그날의 최신 활동(질문/메모/읽은 논문)을 반영해 새로 생성되게 한다.
AI_INSIGHTS_CACHE_HOURS = 24

# OpenAlex에 짧은 시간 동안 과도한 요청을 보내지 않으면서 직렬 네트워크
# 왕복은 피하기 위한 추천 논문 검증 동시성 상한.
OPENALEX_RECOMMENDATION_CONCURRENCY = 4

# 그래프 조회 시점에 아직 개념/인용 동기화가 안 된(graph_synced_at 없는) 문서를
# 백그라운드로 백필한다. 같은 문서에 대해 중복으로 백필 태스크가 여러 개
# 뜨는 것을 막기 위한 in-flight 집합.
_syncing: set = set()

# 질문(chats.role='user') 배치 백필용 in-flight 집합(chat_id 단위).
_syncing_questions: set = set()

# 구버전 태그 재분류용 in-flight 집합.
_syncing_tags: set = set()

# 그래프 조회 시점에 한 번에 처리할 미동기화 질문 상한 - 오래된 질문이 아주
# 많이 쌓여도 그래프 조회 한 번에 LLM 호출이 무한정 늘어나지 않도록 방지.
_QUESTION_BACKFILL_BATCH_SIZE = 20
_TAG_BACKFILL_CONCURRENCY = 3


def _build_category_edges(docs: list) -> list:
    """Connect papers only when a versioned primary topic overlaps."""
    from services.paper_tags import iter_tag_records
    docs_by_topic = {}
    for doc in docs:
        names = {
            item["name"] for item in iter_tag_records(doc.get("metadata") or {})
            if item["role"] == "primary_topic" and item["name"] != "Other"
        }
        for name in names:
            docs_by_topic.setdefault(name, []).append(doc["id"])
    edges = []
    total_docs = max(1, len(docs))
    for topic, doc_ids in docs_by_topic.items():
        weight = math.log((total_docs + 1) / (len(doc_ids) + 1)) + 1.0
        for index, source_id in enumerate(doc_ids):
            for target_id in doc_ids[index + 1:]:
                edges.append({
                    "source": f"paper:{source_id}", "target": f"paper:{target_id}",
                    "type": "category", "category": topic,
                    "relation": "shared_primary_topic", "weight": round(weight, 4),
                })
    return edges


def _queue_tag_nodes(docs: list, nodes: list, edges: list) -> None:
    """Expose every tag role as a node without making domain-only paper edges."""
    from services.paper_tags import iter_tag_records
    seen = set()
    for doc in docs:
        for item in iter_tag_records(doc.get("metadata") or {}):
            role, name = item["role"], item["name"]
            tag_id = "tag:" + hashlib.sha1(f"{role}:{name}".encode()).hexdigest()[:16]
            if tag_id not in seen:
                seen.add(tag_id)
                nodes.append({"id": tag_id, "type": "tag", "label": name, "role": role})
            edges.append({
                "source": f"paper:{doc['id']}", "target": tag_id,
                "type": "tagged_with", "role": role,
                "confidence": item.get("confidence", 0.0),
            })


async def sync_document_for_graph(doc_id: str, pages: list, doc_title: str) -> None:
    """번역 완료 직후 호출되어, 해당 문서의 개념을 추출하고 라이브러리 내
    다른 논문과의 인용 관계를 매칭해 DB에 저장한다. 실패해도 번역 파이프라인
    자체는 영향받지 않도록 호출부(translation_job.py)에서 try/except로 감싼다."""
    from services.library import get_document, patch_document_metadata
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

    patch_document_metadata(doc_id, {"graph_synced_at": datetime.now(timezone.utc).isoformat()})


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


async def _backfill_paper_tags(doc_id: str) -> None:
    try:
        from services.library import get_document, get_pdf_path
        from services.cache import get_cached_pages, save_pages_cache
        from services.pdf_parser import extract_pages
        from services.paper_tags import classify_and_store_paper_tags
        doc = get_document(doc_id)
        pdf_path = get_pdf_path(doc_id)
        if not doc or not pdf_path:
            return
        pages = get_cached_pages(doc_id, pdf_path)
        if pages is None:
            pages = await asyncio.to_thread(extract_pages, pdf_path)
            save_pages_cache(doc_id, pdf_path, pages)
        title = (doc.get("metadata") or {}).get("title") or doc.get("filename") or ""
        await classify_and_store_paper_tags(doc_id, pages, title, force=False)
    except Exception as e:
        logger.warning(f"논문 태그 백필 실패 (doc_id={doc_id}): {e}")
    finally:
        _syncing_tags.discard(doc_id)


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


def _queue_figure_nodes(doc_ids: List[str], nodes: list, edges: list) -> None:
    """이미 캐시된 Figure/Table 데이터(extract_pdf_images, 뷰어에서 문서를
    한 번이라도 열면 생성됨)를 그래프에 노출한다. 캐시가 없는 문서를 위해
    PDF 파싱(비용 큼)을 여기서 강제로 트리거하지 않는다 - Note 노드와 동일한
    "이미 있는 데이터만 노출" 철학. extract_pdf_images 응답에는 안정적인 id가
    없어 캐시가 살아있는 동안의 리스트 인덱스를 합성 id로 쓴다(캐시가
    재생성되면 바뀔 수 있음 - 인용 매칭처럼 완벽하지 않아도 되는 수준으로
    받아들인다). 라벨이 없는(캡션 매칭 실패) 사각형은 사용자에게 의미가
    없으므로 노드로 만들지 않는다."""
    from services.library import get_pdf_path
    from services.cache import get_cached_images
    for doc_id in doc_ids:
        pdf_path = get_pdf_path(doc_id)
        if not pdf_path:
            continue
        images = get_cached_images(doc_id, pdf_path)
        if not images:
            continue
        for idx, img in enumerate(images):
            if not img.get("label"):
                continue
            figure_id = f"figure:{doc_id}:{idx}"
            nodes.append({
                "id": figure_id,
                "type": "figure",
                "label": img["label"],
                "doc_id": doc_id,
                "index": idx,
                "page": img.get("page"),
                "caption": img.get("caption"),
            })
            edges.append({
                "source": figure_id,
                "target": f"paper:{doc_id}",
                "type": "shows_figure",
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
            "paper_tags": meta.get("paper_tags"),
        })

    edges = []

    # 직접 논문 엣지는 공유 primary topic에만 생성한다. 모든 역할의 태그는
    # 별도 노드로 노출해 넓은 domain 공유를 직접 관련성으로 오해하지 않게 한다.
    edges.extend(_build_category_edges(docs))
    _queue_tag_nodes(docs, nodes, edges)

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

    # Figure 노드: LLM 호출 불필요, 이미 캐시된 것만 노출(강제 파싱 트리거 안 함).
    _queue_figure_nodes(doc_ids, nodes, edges)

    # 구버전 자동 태그는 요청을 막지 않고 백그라운드 재분류한다.
    from services.paper_tags import needs_ai_reclassification
    pending_tag_docs = []
    available_tag_slots = max(0, _TAG_BACKFILL_CONCURRENCY - len(_syncing_tags))
    for doc in docs:
        if not needs_ai_reclassification(doc.get("metadata") or {}):
            continue
        pending_tag_docs.append(doc["id"])
        if doc["id"] not in _syncing_tags and available_tag_slots > 0:
            _syncing_tags.add(doc["id"])
            available_tag_slots -= 1
            asyncio.create_task(_backfill_paper_tags(doc["id"]))

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
        "pending_tag_docs": pending_tag_docs,
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


async def get_activity_timeline(username: str) -> List[dict]:
    """업로드/읽음/질문/메모를 시간순(최신순)으로 병합한 활동 타임라인을
    반환한다. 삭제된 논문의 활동도 타임라인에 유지되며 holds is_deleted=True."""
    from services.library import list_documents
    from services.db import (
        db_get_memos, db_get_reading_sessions_for_user, db_get_user_reading_profile,
        db_get_related_questions_for_doc, get_db,
    )

    docs = list_documents(username=username, include_deleted=True)
    titles_by_doc = {d["id"]: (d.get("metadata") or {}).get("title") or d["filename"] for d in docs}
    deleted_by_doc = {d["id"]: bool(d.get("is_deleted")) for d in docs}
    manually_read_by_doc = {d["id"]: bool((d.get("metadata") or {}).get("read")) for d in docs}

    doc_ids_seen = set(titles_by_doc.keys())
    events = []

    from services.reading_analytics import (
        PageSession, analyze_page_sessions, classify_reading_activity,
        is_meaningful_page_session,
    )

    analytics_rows = db_get_reading_sessions_for_user(username)
    user_ema = db_get_user_reading_profile(username).get("ema_seconds_per_page", 600.0)
    analytics_doc_ids = {row["paper_id"] for row in analytics_rows}
    latest_session_by_doc = {}
    for row in analytics_rows:
        latest_session_by_doc.setdefault(row["paper_id"], row["id"])
    for row in analytics_rows:
        try:
            page_sessions = json.loads(row.get("page_sessions_json") or "[]")
        except (TypeError, json.JSONDecodeError):
            page_sessions = []
        page_models = []
        for page in page_sessions:
            if not isinstance(page, dict):
                continue
            try:
                page_models.append(PageSession(**page))
            except (TypeError, ValueError):
                continue
        pages = sorted({
            page.page for page in page_models if is_meaningful_page_session(page)
        })
        active_time = max(0, row.get("active_reading_time") or 0)
        verified_pages = max(0, row.get("verified_pages_count") or 0)
        verified_page_numbers = None
        if row.get("verified_pages_json") is not None:
            try:
                stored_verified_pages = json.loads(row["verified_pages_json"])
                if isinstance(stored_verified_pages, list):
                    verified_page_numbers = sorted({
                        int(page) for page in stored_verified_pages
                        if isinstance(page, int) and page > 0
                    })
            except (TypeError, ValueError, json.JSONDecodeError):
                pass
        if verified_page_numbers is None:
            # verified_pages_json 도입 전 세션은 당시 검증 개수를 유지하면서
            # 저장된 페이지별 근거 점수가 높은 순서로 정확한 페이지 번호를 복원한다.
            page_scores, _, _ = analyze_page_sessions(
                page_models, user_ema, max(0, row.get("total_pages") or 0),
            )
            ranked_pages = sorted(page_scores, key=lambda page: (-page_scores[page], page))
            verified_page_numbers = sorted(ranked_pages[:verified_pages])
        stored_activity = row.get("reading_activity")
        if stored_activity in {"read", "browsed"}:
            activity_type = stored_activity
            minimum_evidence_time = max(
                0.0, row.get("minimum_evidence_time") or 0.0,
            )
        else:
            activity_type, minimum_evidence_time = classify_reading_activity(
                active_time,
                verified_pages,
                max(0.0, row.get("reading_confidence") or 0.0),
                user_ema,
                page_models,
            )
        doc_id = row["paper_id"]
        if manually_read_by_doc.get(doc_id) and latest_session_by_doc.get(doc_id) == row["id"]:
            activity_type = "read"
        if activity_type == "ignored":
            continue
        start_ts = row.get("started_at") or row.get("updated_at")
        end_ts = row.get("ended_at")
        if end_ts == start_ts:
            end_ts = None
        events.append({
            "type": activity_type,
            "reading_activity": activity_type,
            "minimum_evidence_time": minimum_evidence_time,
            "doc_id": doc_id,
            "doc_title": titles_by_doc.get(doc_id) or row.get("doc_title") or "삭제된 논문",
            "timestamp": start_ts,
            "end_timestamp": end_ts,
            "duration_seconds": active_time,
            "start_page": min(pages) if pages else None,
            "end_page": max(pages) if pages else None,
            "verified_pages": verified_pages,
            "verified_page_numbers": verified_page_numbers,
            "reading_score": row.get("reading_score") or 0.0,
            "reading_confidence": row.get("reading_confidence") or 0.0,
            "reading_depth": row.get("reading_depth") or "Opened",
            "reading_session_id": row["id"],
            "is_deleted": doc_id not in doc_ids_seen or deleted_by_doc.get(doc_id, False),
        })
    for doc in docs:
        doc_id = doc["id"]
        title = titles_by_doc[doc_id]
        is_deleted = deleted_by_doc[doc_id]

        events.append({
            "type": "uploaded", "doc_id": doc_id, "doc_title": title,
            "timestamp": doc["created_at"],
            "is_deleted": is_deleted,
        })

        meta = doc.get("metadata") or {}
        read_sessions = meta.get("read_sessions") or []
        if read_sessions and doc_id not in analytics_doc_ids:
            for s in read_sessions:
                ts = s.get("timestamp") or s.get("read_at") or meta.get("last_read_at") or doc["created_at"]
                end_ts = s.get("end_timestamp")
                duration = s.get("duration_seconds")
                if not end_ts and ts and duration:
                    try:
                        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        end_ts = (dt + timedelta(seconds=duration)).isoformat()
                    except Exception:
                        pass
                if end_ts and ts and end_ts == ts:
                    end_ts = None
                events.append({
                    "type": "read",
                    "doc_id": doc_id,
                    "doc_title": title,
                    "timestamp": ts,
                    "end_timestamp": end_ts,
                    "duration_seconds": duration,
                    "start_page": s.get("start_page", 1),
                    "end_page": s.get("end_page", 1),
                    "verified_pages": s.get("verified_pages", 1),
                    "is_deleted": is_deleted,
                })
        elif doc_id not in analytics_doc_ids and meta.get("read") and meta.get("read_at"):
            events.append({
                "type": "read", "doc_id": doc_id, "doc_title": title,
                "timestamp": meta["read_at"],
                "start_page": 1,
                "end_page": meta.get("last_page") or 1,
                "verified_pages": meta.get("last_page") or 1,
                "is_deleted": is_deleted,
            })
        elif doc_id not in analytics_doc_ids and meta.get("last_read_at"):
            events.append({
                "type": "read", "doc_id": doc_id, "doc_title": title,
                "timestamp": meta["last_read_at"],
                "start_page": 1,
                "end_page": meta.get("last_page") or 1,
                "verified_pages": meta.get("last_page") or 1,
                "is_deleted": is_deleted,
            })

        mirrored = db_get_memos(doc_id)
        for items in (mirrored or {}).get("data", {}).values():
            for item in items or []:
                item_id = (item or {}).get("id", "") if isinstance(item, dict) else ""
                if not item_id.startswith("memo_"):
                    continue
                try:
                    ts_ms = int(item_id[len("memo_"):])
                except ValueError:
                    continue
                events.append({
                    "type": "note", "doc_id": doc_id, "doc_title": title,
                    "timestamp": datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isoformat(),
                    "summary": (item.get("content") or "")[:80],
                    "is_deleted": is_deleted,
                })

        for q in db_get_related_questions_for_doc(doc_id, limit=200):
            events.append({
                "type": "question", "doc_id": doc_id, "doc_title": title,
                "timestamp": q["created_at"], "summary": (q["content"] or "")[:80],
                "is_deleted": is_deleted,
            })

    # also handle reading_time entries for permanently deleted documents
    try:
        with get_db() as conn:
            cursor = conn.cursor()
            # doc_title 스냅샷이 있으면 함께 조회 (doc별 최신 제목)
            cursor.execute(
                """
                SELECT doc_id, day, SUM(seconds) as total_sec,
                       MAX(updated_at) as last_ts,
                       MAX(doc_title) as stored_title
                FROM reading_time WHERE username = ?
                GROUP BY doc_id, day
                """,
                (username,)
            )
            rows = cursor.fetchall()
            for r in rows:
                r_dict = dict(r)
                d_id = r_dict["doc_id"]
                if d_id not in doc_ids_seen and d_id not in analytics_doc_ids:
                    # reading_time에 저장된 제목을 우선 사용, 없으면 "삭제된 논문"
                    stored_title = r_dict.get("stored_title") or "삭제된 논문"
                    events.append({
                        "type": "read",
                        "doc_id": d_id,
                        "doc_title": stored_title,
                        "timestamp": r_dict["last_ts"] or f"{r_dict['day']}T00:00:00Z",
                        "duration_seconds": r_dict["total_sec"],
                        "start_page": 1,
                        "end_page": 1,
                        "verified_pages": 1,
                        "is_deleted": True,
                    })
    except Exception as err:
        pass

    events.sort(key=lambda e: e["timestamp"], reverse=True)
    return events


def _reading_recommendations_cache_key(username: str) -> str:
    return f"reading_recommendations:{username}"


def _read_reading_recommendations_cache(username: str) -> Optional[List[dict]]:
    """캐시에 유효한(READING_RECOMMENDATIONS_CACHE_DAYS 이내) 추천 결과가 있으면
    그대로 반환하고, 없거나 만료/손상됐으면 None을 반환한다 - 새로 생성하지는
    않는다(get_reading_recommendations와 get_cached_reading_recommendations가
    공유하는 순수 조회 로직)."""
    from services.db import db_get_meta

    cached_raw = db_get_meta(_reading_recommendations_cache_key(username))
    if not cached_raw:
        return None
    try:
        cached = json.loads(cached_raw)
        generated_at = datetime.fromisoformat(cached["generated_at"])
        age = datetime.now(timezone.utc) - generated_at
        if age < timedelta(days=READING_RECOMMENDATIONS_CACHE_DAYS):
            return cached["recommendations"]
    except Exception:
        pass  # 캐시가 손상됐으면 무시하고 새로 생성
    return None


async def get_cached_reading_recommendations(username: str) -> Optional[List[dict]]:
    """대시보드 진입 시 호출하는 가벼운 버전 - 유효한 캐시가 있으면 그대로
    반환하고, 없으면 LLM+OpenAlex를 호출해 새로 생성하지 않고 None을 반환한다
    (무거운 재계산 없이 캐시 유무만 확인). 이전에는 캐시가 있어도 사용자가
    "추천 받기" 버튼을 다시 눌러야만 보였는데, 대시보드 로드 시 이 함수로
    미리 조회해 캐시가 있으면 버튼 없이 바로 보여주기 위한 용도다."""
    return _read_reading_recommendations_cache(username)


async def get_reading_recommendations(username: str, force: bool = False) -> List[dict]:
    """읽은 논문들을 근거로 다음에 읽으면 좋을 논문을 추천한다. Primer 기능의
    기존 OpenAlex 검증 로직(_is_plausible_match, resolve_reference)을 그대로
    재사용해 LLM 환각(존재하지 않는 논문을 추천)을 걸러낸다 - 1차의
    _match_library_references 재사용과 동일한 패턴. LLM+OpenAlex 호출이
    여러 번 들어가는 무거운 작업이라 그래프 조회 시 자동 실행하지 않고,
    프론트에서 사용자가 명시적으로 요청했을 때만 호출한다.

    결과는 app_meta에 사용자별로 캐싱해 READING_RECOMMENDATIONS_CACHE_DAYS(7일)
    동안 재사용하고, 그 기간이 지나면 다음 조회 시 자동으로 새로 생성한다 -
    호출할 때마다 같은 무거운 계산을 반복하지 않으면서도, 추천 목록이 매주
    한 번씩은 새로 갱신되게 한다. force=True면 유효한 캐시가 있어도 무시하고
    새로 생성한다(대시보드의 "다시 받기" 버튼이 사용하는 경로).
    """
    if not force:
        cached = _read_reading_recommendations_cache(username)
        if cached is not None:
            return cached

    from services.db import db_set_meta
    from services.library import list_documents
    docs = list_documents(username=username)
    if len(docs) < 2:
        return []  # 근거가 너무 적으면 추천하지 않는다

    titles = [(d.get("metadata") or {}).get("title") or d["filename"] for d in docs]
    categories = sorted({c for d in docs for c in (d.get("metadata") or {}).get("categories", []) or []})

    from services.llm_client import generate_reading_recommendations
    from services.primer import _normalize_words, _is_plausible_match
    from services.reference_linker import resolve_reference

    raw = await generate_reading_recommendations(titles, categories, session_id=username)
    exclude_word_sets = [w for w in (_normalize_words(t) for t in titles) if w]

    semaphore = asyncio.Semaphore(OPENALEX_RECOMMENDATION_CONCURRENCY)

    async def resolve_recommendation(r: dict) -> Optional[dict]:
        title = (r.get("title") or "").strip()
        if not title:
            return None
        async with semaphore:
            resolved = await resolve_reference(title)
        if not resolved or not _is_plausible_match(title, resolved):
            return None
        result_words = _normalize_words(resolved.get("title", ""))
        if not result_words:
            return None
        if any(len(result_words & seen) / len(result_words) >= 0.6 for seen in exclude_word_sets):
            return None  # 이미 읽은 논문과 같은 논문이면 제외
        return {**resolved, "reason": r.get("reason", "")}

    resolved_results = await asyncio.gather(*(resolve_recommendation(r) for r in raw))
    results = [result for result in resolved_results if result is not None]

    db_set_meta(_reading_recommendations_cache_key(username), json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "recommendations": results,
    }, ensure_ascii=False))
    return results


async def get_concept_heatmap(username: str) -> List[dict]:
    """개념별로 몇 편의 논문에 등장했고 몇 개의 질문과 연결됐는지 집계해
    활동량(paper_count + question_count) 순으로 정렬한다. 1차의
    db_get_concepts_for_docs와 2차의 db_get_question_count_for_concepts를
    그대로 조합할 뿐 새 SQL이 필요 없다."""
    from services.library import list_documents
    from services.db import db_get_concepts_for_docs, db_get_question_count_for_concepts
    doc_ids = [d["id"] for d in list_documents(username=username)]
    concept_links = db_get_concepts_for_docs(doc_ids)

    by_concept = {}
    for link in concept_links:
        cid = link["concept_id"]
        entry = by_concept.setdefault(
            cid, {"concept_id": cid, "name": link["name"], "kind": link.get("kind"), "doc_ids": set()}
        )
        entry["doc_ids"].add(link["doc_id"])

    question_counts = db_get_question_count_for_concepts(list(by_concept.keys()))
    result = []
    for cid, entry in by_concept.items():
        paper_count = len(entry["doc_ids"])
        question_count = question_counts.get(cid, 0)
        result.append({
            "concept_id": cid,
            "name": entry["name"],
            "kind": entry["kind"],
            "paper_count": paper_count,
            "question_count": question_count,
            "score": paper_count + question_count,
        })
    result.sort(key=lambda r: r["score"], reverse=True)
    return result


# 히트맵 매트릭스 캐시 TTL - 논문마다 LLM 채점 호출이 들어가는 무거운 작업이라
# AI 인사이트와 동일하게 하루 단위로만 다시 계산한다.
HEATMAP_MATRIX_CACHE_HOURS = 24


def _heatmap_matrix_cache_key(username: str) -> str:
    return f"heatmap_matrix:{username}"


async def _get_paper_text_for_scoring(doc_id: str) -> str:
    """히트맵 LLM 채점용 논문 서두 텍스트. sync_document_for_graph(개념 추출)와
    동일하게 첫 2페이지만 써서 비용을 억제하고 근거 범위를 일관되게 유지한다.
    PDF가 없거나 추출에 실패하면 빈 문자열을 반환한다 - 호출부가 제목만으로도
    채점을 시도하거나 등장 여부 기반 값으로 대체할 수 있어 파이프라인을
    막지 않는다."""
    try:
        from services.library import get_pdf_path
        from services.cache import get_cached_pages, save_pages_cache
        from services.pdf_parser import extract_pages
        pdf_path = get_pdf_path(doc_id)
        if not pdf_path:
            return ""
        pages = get_cached_pages(doc_id, pdf_path)
        if pages is None:
            pages = await asyncio.to_thread(extract_pages, pdf_path)
            save_pages_cache(doc_id, pdf_path, pages)
        return "\n".join(p.get("text", "") for p in pages[:2])
    except Exception:
        return ""


async def _score_one_paper(doc_id: str, title: str, concept_names: List[str]) -> Dict[str, float]:
    """한 논문에 대해 concept_names 전체를 LLM 호출 1회로 채점한다(개념별로 나눠
    호출하면 비용이 개념 수 x 논문 수로 늘어나므로, 논문당 1회로 제한). 텍스트
    추출 실패, LLM 오류, 응답 파싱 실패 등 어떤 이유로든 실패하면 조용히 빈
    dict를 반환해 호출부가 등장 여부 기반 값으로 대체하게 한다 - 이 함수 하나가
    실패해도 나머지 논문의 채점이나 매트릭스 자체가 막히면 안 된다."""
    from services.llm_client import score_paper_concept_relevance
    text = await _get_paper_text_for_scoring(doc_id)
    try:
        raw = await score_paper_concept_relevance(title, text, concept_names, session_id=doc_id)
    except Exception:
        return {}
    scores: Dict[str, float] = {}
    for item in raw:
        name = (item.get("concept") or "").strip()
        if not name:
            continue
        try:
            score = float(item.get("score", 0))
        except (TypeError, ValueError):
            continue
        scores[name.lower()] = max(0.0, min(1.0, score))
    return scores


async def get_concept_paper_matrix(username: str, concept_limit: int = 12, paper_limit: int = 10, force: bool = False) -> dict:
    """개념 히트맵을 논문(행) x 개념(열) 매트릭스로 구성한다(seaborn류 2D 히트맵 UI용).

    열/행 선정은 기존 3개 테이블(paper_concepts, question_papers, question_concepts)만
    재사용하는 규칙 기반 집계다 - get_concept_heatmap과 동일한 활동량 순위로 상위
    concept_limit개 개념을, 그 개념들과 실제로 연결된 논문 중 활동량 상위 paper_limit개
    논문만 골라 표가 스크린 안에 들어오게 한다(항목이 너무 많으면 비직관적이라는
    피드백에서 시작된 제약).

    셀 값(score)은 선정된 논문마다 제목+서두 텍스트를 근거로 LLM이 각 개념을
    0.0~1.0으로 직접 채점한 값이다. 이전 버전은 "등장 여부 + 질문 수"로 근사했지만,
    개념 중복 제거가 완벽하지 않아(concepts.normalized_name이 소문자+trim만 함) 논문이
    실제로 다루는 개념인데도 다른 concept_id로 잡혀 0으로 뜨는 문제가 있었다 - 텍스트를
    직접 읽고 판단하므로 그 문제에서 자유롭다. 논문당 LLM 호출 1회로 비용을 제한하고
    (그 논문에 대해 concept_limit개 전부를 한 번에 채점), 논문들은 asyncio.gather로
    병렬 호출해 전체 지연 시간을 줄인다. 결과는 HEATMAP_MATRIX_CACHE_HOURS 동안
    app_meta에 캐싱해 히트맵을 열 때마다 다시 채점하지 않는다(get_reading_recommendations와
    동일한 캐싱 패턴). force=True면 캐시를 무시하고 새로 채점한다("다시 계산" 버튼)."""
    from services.db import db_get_meta, db_set_meta

    cache_key = _heatmap_matrix_cache_key(username)
    if not force:
        cached_raw = db_get_meta(cache_key)
        if cached_raw:
            try:
                cached = json.loads(cached_raw)
                generated_at = datetime.fromisoformat(cached["generated_at"])
                if datetime.now(timezone.utc) - generated_at < timedelta(hours=HEATMAP_MATRIX_CACHE_HOURS):
                    return cached["matrix"]
            except Exception:
                pass  # 캐시가 손상됐으면 무시하고 새로 계산

    from services.library import list_documents
    from services.db import db_get_concepts_for_docs, db_get_question_count_for_concepts, db_get_question_doc_concept_counts

    docs = {d["id"]: d for d in list_documents(username=username)}
    doc_ids = list(docs.keys())
    concept_links = db_get_concepts_for_docs(doc_ids)

    by_concept = {}
    for link in concept_links:
        cid = link["concept_id"]
        entry = by_concept.setdefault(
            cid, {"concept_id": cid, "name": link["name"], "kind": link.get("kind"), "doc_ids": set()}
        )
        entry["doc_ids"].add(link["doc_id"])

    question_counts = db_get_question_count_for_concepts(list(by_concept.keys()))
    ranked_concepts = sorted(
        by_concept.values(),
        key=lambda e: len(e["doc_ids"]) + question_counts.get(e["concept_id"], 0),
        reverse=True,
    )[:concept_limit]
    concept_ids = {c["concept_id"] for c in ranked_concepts}
    concept_names = [c["name"] for c in ranked_concepts]

    pair_question_counts = db_get_question_doc_concept_counts(doc_ids)

    # 이 개념들과 실제로 연결된 논문만, 연결된 개념 수 + 관련 질문 수 순으로 상위 paper_limit개.
    doc_scores: Dict[str, int] = {}
    for link in concept_links:
        if link["concept_id"] in concept_ids:
            doc_scores[link["doc_id"]] = doc_scores.get(link["doc_id"], 0) + 1
    for (doc_id, cid), cnt in pair_question_counts.items():
        if cid in concept_ids:
            doc_scores[doc_id] = doc_scores.get(doc_id, 0) + cnt
    ranked_doc_ids = sorted(doc_scores.keys(), key=lambda d: doc_scores[d], reverse=True)[:paper_limit]

    doc_concept_present = {(link["doc_id"], link["concept_id"]) for link in concept_links}

    papers = []
    for doc_id in ranked_doc_ids:
        doc = docs.get(doc_id)
        if not doc:
            continue
        meta = doc.get("metadata") or {}
        papers.append({
            "doc_id": doc_id,
            "title": meta.get("title") or doc.get("filename") or "제목 없음",
            "category": (meta.get("categories") or [None])[0],
        })

    if not ranked_concepts or not papers:
        # 아직 채점할 데이터가 없는 상태를 24시간짜리 빈 캐시로 굳히지 않는다 -
        # 다음 조회 때 데이터가 쌓여 있으면 바로 반영되게 캐싱을 건너뛴다.
        return {"concepts": [], "papers": [], "cells": []}

    score_results = await asyncio.gather(
        *[_score_one_paper(p["doc_id"], p["title"], concept_names) for p in papers],
        return_exceptions=True,
    )
    scores_by_doc: Dict[str, Dict[str, float]] = {
        p["doc_id"]: (result if isinstance(result, dict) else {})
        for p, result in zip(papers, score_results)
    }

    cells = []
    for doc_id in ranked_doc_ids:
        doc_scores_by_name = scores_by_doc.get(doc_id, {})
        for c in ranked_concepts:
            cid = c["concept_id"]
            present = (doc_id, cid) in doc_concept_present
            qcount = pair_question_counts.get((doc_id, cid), 0)
            llm_score = doc_scores_by_name.get(c["name"].strip().lower())
            score = llm_score if llm_score is not None else (1.0 if present else 0.0)
            cells.append({
                "doc_id": doc_id,
                "concept_id": cid,
                "present": present,
                "question_count": qcount,
                "score": round(score, 3),
            })

    matrix = {
        "concepts": [{"concept_id": c["concept_id"], "name": c["name"], "kind": c["kind"]} for c in ranked_concepts],
        "papers": papers,
        "cells": cells,
    }
    db_set_meta(cache_key, json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "matrix": matrix,
    }, ensure_ascii=False))
    return matrix


async def get_knowledge_gaps(username: str) -> List[dict]:
    """두 종류의 격차를 순수 규칙 기반(LLM 불필요)으로 감지한다:
    1. 논문 여러 편에 등장하는 개념인데 관련 질문이 하나도 없음
    2. 읽음 표시된 논문인데 메모가 하나도 없음
    각각 상위 5개까지만 반환해 너무 많은 항목으로 압도하지 않는다."""
    from services.library import list_documents
    from services.db import db_get_memo_counts_for_docs

    docs = list_documents(username=username)
    doc_ids = [d["id"] for d in docs]

    heatmap = await get_concept_heatmap(username)
    concept_gaps = [
        {
            "type": "low_question_concept",
            "concept_id": c["concept_id"],
            "message": f"'{c['name']}' 관련 질문이 거의 없습니다.",
        }
        for c in heatmap if c["paper_count"] >= 2 and c["question_count"] == 0
    ][:5]

    memo_counts = db_get_memo_counts_for_docs(doc_ids)
    paper_gaps = []
    for doc in docs:
        meta = doc.get("metadata") or {}
        if not meta.get("read"):
            continue
        if memo_counts.get(doc["id"], 0) == 0:
            title = meta.get("title") or doc["filename"]
            paper_gaps.append({
                "type": "no_notes_paper",
                "doc_id": doc["id"],
                "message": f"'{title}' 논문을 읽었지만 메모가 없습니다.",
            })
    return concept_gaps + paper_gaps[:5]


def _ai_insights_cache_key(username: str) -> str:
    return f"ai_insights:{username}"


def _resolve_ai_insight_title(doc: dict) -> str:
    """AI 인사이트에 전달할 논문 제목을 반환한다.

    과거 데이터에는 metadata.title이 비어 있거나 업로드 파일명 자체로 저장된
    경우가 있다. 이 값을 그대로 LLM에 넘기면 인사이트에도 파일명이 논문
    제목처럼 노출되므로, 그런 경우 PDF 본문에서 제목을 다시 추출해 저장한다.
    """
    metadata = doc.get("metadata") or {}
    title = (metadata.get("title") or "").strip()
    if title and metadata.get("title_source") == "manual":
        return title

    filename = (doc.get("filename") or "").strip()
    filename_stem = os.path.splitext(filename)[0]
    title_is_filename = bool(title and filename) and title.casefold() in {
        filename.casefold(),
        filename_stem.casefold(),
    }

    if title and not title_is_filename:
        return title

    pdf_path = doc.get("pdf_path") or ""
    if pdf_path and os.path.isfile(pdf_path):
        try:
            from services.pdf_parser import get_pdf_metadata
            extracted_title = (get_pdf_metadata(pdf_path).get("title") or "").strip()
        except Exception:
            extracted_title = ""
        if extracted_title and extracted_title.casefold() not in {
            filename.casefold(),
            filename_stem.casefold(),
        }:
            from services.library import patch_document_metadata
            updated_metadata = dict(metadata)
            updated_metadata["title"] = extracted_title
            patch_document_metadata(doc["id"], {"title": extracted_title})
            doc["metadata"] = updated_metadata
            return extracted_title

    return title or filename or "제목 없음"


async def get_ai_insights(username: str) -> List[dict]:
    """대시보드 "AI 인사이트" 카드의 내용을 생성한다. 예전에는 get_knowledge_gaps의
    규칙 기반 격차 문구를 그대로 노출했지만, 그건 매번 같은 두 패턴("질문이
    없습니다"/"메모가 없습니다")만 반복해 내용이 다양하지 않았다. 여기서는 실제
    질문/메모 내용을 LLM(지도교수 관점의 멘토 페르소나 - llm_client.
    generate_dashboard_insights 참고)에 근거로 전달해, 질문에서 드러나는 이해
    부족/개념 공백 진단, 교수자 관점의 조언, 스스로를 돌아보게 하는 관점 제시,
    근거 있는 격려처럼 실질적으로 도움이 되는 인사이트를 생성한다.

    결과는 app_meta에 하루(AI_INSIGHTS_CACHE_HOURS) 동안 캐싱해 대시보드를 열 때마다
    LLM을 호출하지 않으면서도 매일 새 활동을 반영해 갱신되게 한다(추천 논문 캐싱과
    동일한 패턴). LLM 호출이 실패하거나 빈 배열을 반환하면(프로바이더 장애, 아직
    분석할 활동이 전혀 없음 등) 기존 규칙 기반 지식 격차 감지로 조용히 대체해
    카드가 비지 않게 한다."""
    from services.db import db_get_meta, db_set_meta

    from services.library import list_documents
    docs = list_documents(username=username)
    titles_by_doc = {d["id"]: _resolve_ai_insight_title(d) for d in docs}
    title_signature = [[doc_id, title] for doc_id, title in sorted(titles_by_doc.items())]

    cache_key = _ai_insights_cache_key(username)
    cached_raw = db_get_meta(cache_key)
    if cached_raw:
        try:
            cached = json.loads(cached_raw)
            generated_at = datetime.fromisoformat(cached["generated_at"])
            age = datetime.now(timezone.utc) - generated_at
            if (
                age < timedelta(hours=AI_INSIGHTS_CACHE_HOURS)
                and cached.get("title_signature") == title_signature
            ):
                return cached["insights"]
        except Exception:
            pass  # 캐시가 손상됐으면 무시하고 새로 생성

    rule_based_gaps = await get_knowledge_gaps(username)
    if not docs:
        return rule_based_gaps

    # get_activity_timeline의 summary는 UI 카드용으로 80자로 잘려있어, 질문에서
    # 이해 부족/개념 공백을 실제로 진단하기엔 근거가 너무 짧다. 여기서는 같은
    # 원본(memos/questions)을 직접 조회해 더 긴 내용(최대 200자)을 LLM에 넘긴다.
    from services.db import db_get_memos, db_get_related_questions_for_doc
    note_entries = []
    question_entries = []
    for doc in docs:
        doc_id = doc["id"]
        title = titles_by_doc[doc_id]
        mirrored = db_get_memos(doc_id)
        for items in (mirrored or {}).get("data", {}).values():
            for item in items or []:
                item_id = (item or {}).get("id", "") if isinstance(item, dict) else ""
                if not item_id.startswith("memo_"):
                    continue
                try:
                    ts_ms = int(item_id[len("memo_"):])
                except ValueError:
                    continue
                content = (item.get("content") or "").strip()
                if content:
                    note_entries.append((ts_ms, title, content))
        for q in db_get_related_questions_for_doc(doc_id, limit=50):
            content = (q["content"] or "").strip()
            if content:
                question_entries.append((q["created_at"], title, content))

    note_entries.sort(key=lambda e: e[0], reverse=True)
    question_entries.sort(key=lambda e: e[0], reverse=True)
    notes = [f"[{title}] {content[:200]}" for _, title, content in note_entries[:8]]
    questions = [f"[{title}] {content[:200]}" for _, title, content in question_entries[:8]]

    heatmap = await get_concept_heatmap(username)
    concepts = [h["name"] for h in heatmap[:8]]
    categories = sorted({c for d in docs for c in (d.get("metadata") or {}).get("categories", []) or []})

    stats = {
        "total_papers": len(docs),
        "read_papers": sum(1 for d in docs if (d.get("metadata") or {}).get("read")),
        "total_notes": len(note_entries),
        "total_questions": len(question_entries),
    }

    from services.llm_client import generate_dashboard_insights
    insights = await generate_dashboard_insights({
        "stats": stats,
        "notes": notes,
        "questions": questions,
        "concepts": concepts,
        "categories": categories,
        "gap_hints": [g["message"] for g in rule_based_gaps],
    }, session_id=username)

    if not insights:
        insights = rule_based_gaps  # LLM 실패/빈 응답 시 규칙 기반으로 폴백

    db_set_meta(cache_key, json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "title_signature": title_signature,
        "insights": insights,
    }, ensure_ascii=False))
    return insights


async def get_dashboard_summary(username: str) -> dict:
    """지식 그래프 탭의 "대시보드" 뷰에 필요한 데이터를 한 번에 모은다.
    새 집계 로직 없이 get_concept_heatmap/get_ai_insights/
    get_activity_timeline을 조합할 뿐이다."""
    from services.library import list_documents
    docs = list_documents(username=username)  # 이미 created_at DESC 정렬됨

    heatmap = await get_concept_heatmap(username)
    insights = await get_ai_insights(username)
    timeline = await get_activity_timeline(username)

    recent_questions = [e for e in timeline if e["type"] == "question"][:10]
    recent_notes = [e for e in timeline if e["type"] == "note"][:10]
    recent_papers = [
        {"doc_id": d["id"], "title": (d.get("metadata") or {}).get("title") or d["filename"], "created_at": d["created_at"]}
        for d in docs[:10]
    ]

    from services.library import read_page_count
    stats = {
        "total_papers": len(docs),
        "total_pages": sum(d.get("total_pages") or 0 for d in docs),
        # 완독 표시된 문서는 참고문헌을 제외한 본문 페이지 수 전체를, 읽던
        # 중인 문서는 그 진행률(참고문헌 페이지 제외 상한)을 더한다 - 대시보드
        # 상단 통계 카드가 "전체 라이브러리 페이지 수"가 아니라 실제로 읽은
        # 페이지 수를 보여주도록 함(read_page_count는 프론트의 readPageCount와
        # 동일한 공식을 공유).
        "read_pages": sum(read_page_count(d) for d in docs),
        "read_papers": sum(1 for d in docs if (d.get("metadata") or {}).get("read")),
        "total_concepts": len(heatmap),
        "total_questions": len([e for e in timeline if e["type"] == "question"]),
        "total_notes": len([e for e in timeline if e["type"] == "note"]),
    }

    return {
        "stats": stats,
        "heatmap": heatmap[:10],
        "insights": insights,
        "recent_questions": recent_questions,
        "recent_notes": recent_notes,
        "recent_papers": recent_papers,
    }

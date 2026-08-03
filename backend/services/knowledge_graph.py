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
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Optional

logger = logging.getLogger(__name__)

# 추천 논문 목록 캐시 TTL - LLM+OpenAlex 검증이 여러 번 들어가는 무거운 작업이라
# 매번 다시 계산하지 않고, 일주일에 한 번만 새로 생성해 app_meta에 저장해둔다.
READING_RECOMMENDATIONS_CACHE_DAYS = 7

# AI 인사이트 캐시 TTL - 대시보드를 열 때마다 LLM을 호출하지 않으면서도 하루에
# 한 번은 그날의 최신 활동(질문/메모/읽은 논문)을 반영해 새로 생성되게 한다.
AI_INSIGHTS_CACHE_HOURS = 24

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

    # Figure 노드: LLM 호출 불필요, 이미 캐시된 것만 노출(강제 파싱 트리거 안 함).
    _queue_figure_nodes(doc_ids, nodes, edges)

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


async def get_activity_timeline(username: str) -> List[dict]:
    """업로드/읽음/질문/메모를 시간순(최신순)으로 병합한 활동 타임라인을
    반환한다. 전부 이미 존재하는 타임스탬프를 재구성한 것이라 신규 저장소가
    필요 없다 - 메모는 id가 "memo_{ms}" 형식(frontend의 createFloatingMemoForSentence)
    이라는 점을 이용해 별도 스키마 변경 없이 생성 시각을 그대로 복원한다."""
    from services.library import list_documents
    from services.db import db_get_memos, db_get_related_questions_for_doc

    docs = list_documents(username=username)
    titles_by_doc = {d["id"]: (d.get("metadata") or {}).get("title") or d["filename"] for d in docs}

    events = []
    for doc in docs:
        doc_id = doc["id"]
        title = titles_by_doc[doc_id]
        events.append({
            "type": "uploaded", "doc_id": doc_id, "doc_title": title,
            "timestamp": doc["created_at"],
        })

        meta = doc.get("metadata") or {}
        if meta.get("read") and meta.get("read_at"):
            events.append({
                "type": "read", "doc_id": doc_id, "doc_title": title,
                "timestamp": meta["read_at"],
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
                })

        for q in db_get_related_questions_for_doc(doc_id, limit=200):
            events.append({
                "type": "question", "doc_id": doc_id, "doc_title": title,
                "timestamp": q["created_at"], "summary": (q["content"] or "")[:80],
            })

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


async def get_reading_recommendations(username: str) -> List[dict]:
    """읽은 논문들을 근거로 다음에 읽으면 좋을 논문을 추천한다. Primer 기능의
    기존 OpenAlex 검증 로직(_is_plausible_match, resolve_reference)을 그대로
    재사용해 LLM 환각(존재하지 않는 논문을 추천)을 걸러낸다 - 1차의
    _match_library_references 재사용과 동일한 패턴. LLM+OpenAlex 호출이
    여러 번 들어가는 무거운 작업이라 그래프 조회 시 자동 실행하지 않고,
    프론트에서 사용자가 명시적으로 요청했을 때만 호출한다.

    결과는 app_meta에 사용자별로 캐싱해 READING_RECOMMENDATIONS_CACHE_DAYS(7일)
    동안 재사용하고, 그 기간이 지나면 다음 조회 시 자동으로 새로 생성한다 -
    호출할 때마다 같은 무거운 계산을 반복하지 않으면서도, 추천 목록이 매주
    한 번씩은 새로 갱신되게 한다.
    """
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

    results = []
    for r in raw:
        title = (r.get("title") or "").strip()
        if not title:
            continue
        resolved = await resolve_reference(title)
        if not resolved or not _is_plausible_match(title, resolved):
            continue
        result_words = _normalize_words(resolved.get("title", ""))
        if not result_words:
            continue
        if any(len(result_words & seen) / len(result_words) >= 0.6 for seen in exclude_word_sets):
            continue  # 이미 읽은 논문과 같은 논문이면 제외
        results.append({**resolved, "reason": r.get("reason", "")})

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


async def get_ai_insights(username: str) -> List[dict]:
    """대시보드 "AI 인사이트" 카드의 내용을 생성한다. 예전에는 get_knowledge_gaps의
    규칙 기반 격차 문구를 그대로 노출했지만, 그건 매번 같은 두 패턴("질문이
    없습니다"/"메모가 없습니다")만 반복해 내용이 다양하지 않았다. 여기서는 실제
    질문/메모 내용과 읽은 논문 목록을 LLM에 근거로 전달해, 조언/요약/추천/격려처럼
    더 다양하고 구체적인 인사이트를 생성한다.

    결과는 app_meta에 하루(AI_INSIGHTS_CACHE_HOURS) 동안 캐싱해 대시보드를 열 때마다
    LLM을 호출하지 않으면서도 매일 새 활동을 반영해 갱신되게 한다(추천 논문 캐싱과
    동일한 패턴). LLM 호출이 실패하거나 빈 배열을 반환하면(프로바이더 장애, 아직
    분석할 활동이 전혀 없음 등) 기존 규칙 기반 지식 격차 감지로 조용히 대체해
    카드가 비지 않게 한다."""
    from services.db import db_get_meta, db_set_meta

    cache_key = _ai_insights_cache_key(username)
    cached_raw = db_get_meta(cache_key)
    if cached_raw:
        try:
            cached = json.loads(cached_raw)
            generated_at = datetime.fromisoformat(cached["generated_at"])
            age = datetime.now(timezone.utc) - generated_at
            if age < timedelta(hours=AI_INSIGHTS_CACHE_HOURS):
                return cached["insights"]
        except Exception:
            pass  # 캐시가 손상됐으면 무시하고 새로 생성

    from services.library import list_documents
    docs = list_documents(username=username)
    rule_based_gaps = await get_knowledge_gaps(username)
    if not docs:
        return rule_based_gaps

    timeline = await get_activity_timeline(username)
    notes = [f"[{e['doc_title']}] {e['summary']}" for e in timeline if e["type"] == "note" and e.get("summary")][:8]
    questions = [f"[{e['doc_title']}] {e['summary']}" for e in timeline if e["type"] == "question" and e.get("summary")][:8]

    heatmap = await get_concept_heatmap(username)
    concepts = [h["name"] for h in heatmap[:8]]
    categories = sorted({c for d in docs for c in (d.get("metadata") or {}).get("categories", []) or []})

    stats = {
        "total_papers": len(docs),
        "read_papers": sum(1 for d in docs if (d.get("metadata") or {}).get("read")),
        "total_notes": len([e for e in timeline if e["type"] == "note"]),
        "total_questions": len([e for e in timeline if e["type"] == "question"]),
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

    stats = {
        "total_papers": len(docs),
        "total_pages": sum(d.get("total_pages") or 0 for d in docs),
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

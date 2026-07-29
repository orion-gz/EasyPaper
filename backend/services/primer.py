"""
"읽기 전 브리핑(Reading Primer)" 생성 오케스트레이션.

업로드 직후 백그라운드로 실행되어 아래를 조합한 결과를 page_insights 테이블
(doc_id, page_num=0, kind="primer_v2")에 캐싱한다:
  1. 훅 문장 / 연구 계보(LINEAGE) / 파인만 설명(FEYNMAN) / 예측 질문 3개 /
     체크리스트 3개 / 가설-실험-결과 흐름 최대 3세트 / 논문 고유 용어집 최대 5개
     (LLM, llm_client.generate_reading_primer)
  2. 대표 Figure 크롭 이미지 (pdf_parser.extract_pdf_images + render_image_crop)
  3. 내 라이브러리 안에서 이 논문의 참고문헌과 겹치는 논문 매칭 (외부 API 없이 텍스트 매칭)
  4. LLM이 직접 추천한 관련 논문(최대 5개)을 OpenAlex로 실존 여부 검증 후 채택

1번은 예전에는 인트로 2페이지(3000자)만 LLM에 넘겼으나, 계보/실험 흐름 서사를
뽑아내려면 서론만으로는 근거가 부족하다. section_parser.detect_sections로 논문
전체를 스캔해 서론/관련 연구·방법론/실험 결과·결론 세 버킷으로 압축하고,
term_extractor.extract_candidate_terms로 논문 고유 용어 후보를 정규식으로 뽑아
LLM 합성 프롬프트에 근거로 제공한다(원문 전체를 그대로 프롬프트에 욱여넣지 않음 -
Ollama 컨텍스트/타임아웃 제약 때문).

캐시 kind를 기존 "primer"에서 "primer_v2"로 바꾼 것은 프롬프트/응답 스키마가
바뀌어 기존 캐시에 새 필드가 없기 때문이다 - 기존 로우는 별도 마이그레이션 없이
그냥 고아로 남는다.

4번은 원래 이 논문의 참고문헌 목록을 그대로 외부 검색해 매칭하는 방식이었으나,
인용 형식이 지저분하거나 따옴표로 감싼 제목이 없는 스타일이면 매칭 개수가 너무
적고("참고문헌으로 한정" - 진짜 "관련성"과는 다름), 결과 품질도 들쭉날쭉했다.
LLM이 primer 생성 시점에 자기 지식으로 직접 관련 논문을 추천하게 하고, 그 제목을
OpenAlex로 재검색해 실제로 존재하고 제목이 충분히 일치하는 것만 채택하는 방식으로
바꿔 개수와 관련성을 모두 개선했다.
"""
import asyncio
import json
import re
from typing import Optional

from services.library import (
    save_page_insight,
    get_page_insight,
    delete_page_insight,
    get_pdf_path,
    save_primer_figure,
    list_documents,
)
from services.reference_parser import extract_reference_list
from services.section_parser import detect_sections
from services.term_extractor import extract_candidate_terms
from services.llm_client import generate_reading_primer

_PRIMER_CACHE_KIND = "primer_v2"
_RECOMMENDATION_LIMIT = 5
_LIBRARY_MATCH_THRESHOLD = 0.7
_DUPLICATE_TITLE_THRESHOLD = 0.6
_STOPWORDS = {
    "the", "a", "an", "of", "for", "and", "or", "on", "in", "to", "with",
    "using", "via", "based", "towards", "toward", "from", "into", "at", "by",
}


def _normalize_words(text: str) -> set:
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return {w for w in words if len(w) > 2 and w not in _STOPWORDS}


def _match_library_references(reference_map: dict, doc_id: str, username: str) -> list:
    """참고문헌 원문 목록을 내 라이브러리의 다른 논문 제목과 텍스트 매칭한다.
    외부 API를 쓰지 않아 업로드마다 항상 실행해도 부담이 없다."""
    candidates = []
    for doc in list_documents(username=username):
        if doc["id"] == doc_id:
            continue
        title = (doc.get("metadata") or {}).get("title") or doc.get("filename", "")
        words = _normalize_words(title)
        if len(words) < 2:
            continue
        candidates.append((doc["id"], title, words))

    matches = []
    matched_doc_ids = set()
    for ref_num, ref_text in reference_map.items():
        ref_words = _normalize_words(ref_text)
        if not ref_words:
            continue
        for cand_doc_id, title, words in candidates:
            if cand_doc_id in matched_doc_ids:
                continue
            if len(words & ref_words) / len(words) >= _LIBRARY_MATCH_THRESHOLD:
                matches.append({"ref_num": ref_num, "doc_id": cand_doc_id, "title": title})
                matched_doc_ids.add(cand_doc_id)
                break
    return matches


def _is_plausible_match(query_text: str, resolved: dict) -> bool:
    """resolve_reference() 검색 결과가 실제로 찾으려던 논문이 맞는지 검증한다.
    참고문헌 검색은 지저분한 인용 문자열 때문에, LLM 추천 검증은 환각(존재하지 않는
    논문 제목을 지어내거나 부정확하게 기억)때문에 엉뚱한 논문이 최상위로 반환될 수
    있어(실제로 EEG 논문 테스트에서 무관한 논문이 매칭된 사례를 확인함), 연도가 원문에
    그대로 등장하거나 제목 단어가 원문과 충분히 겹칠 때만 신뢰할 만한 매칭으로 받아들인다."""
    year = resolved.get("year")
    if year and str(year) in (query_text or ""):
        return True
    title_words = _normalize_words(resolved.get("title", ""))
    if not title_words:
        return False
    query_words = _normalize_words(query_text)
    return len(title_words & query_words) / len(title_words) >= 0.5


async def _resolve_recommended_titles(titles: list, exclude_title_words: list) -> list:
    """LLM이 추천한 논문 제목들을 OpenAlex로 검증해 실제로 존재하는 논문만 채택한다.
    LLM은 환각으로 없는 논문을 만들어내거나 제목을 부정확하게 기억할 수 있으므로,
    검색 결과 제목이 추천받은 제목과 충분히 일치할 때만(_is_plausible_match) 신뢰한다.
    이미 내 라이브러리 매칭으로 뜬 논문과 같은 논문을 추천했다면 중복 표시하지 않는다."""
    from services.reference_linker import resolve_reference
    results = []
    seen_word_sets = list(exclude_title_words)
    for title in titles[:_RECOMMENDATION_LIMIT]:
        title = (title or "").strip()
        if not title:
            continue
        resolved = await resolve_reference(title)
        if not resolved or not _is_plausible_match(title, resolved):
            continue
        result_words = _normalize_words(resolved.get("title", ""))
        if not result_words:
            continue
        if any(len(result_words & seen) / len(result_words) >= _DUPLICATE_TITLE_THRESHOLD for seen in seen_word_sets):
            continue
        seen_word_sets.append(result_words)
        results.append(resolved)
    return results


def _pick_primary_figure(pdf_path: str) -> Optional[dict]:
    from services.pdf_parser import extract_pdf_images
    try:
        images = extract_pdf_images(pdf_path)
    except Exception as e:
        print(f"[primer] Figure 추출 실패: {e}")
        return None

    best = None
    best_num = None
    for img in images:
        label = img.get("label") or ""
        m = re.match(r"^fig(?:ure)?\.?\s*(\d+)", label, re.IGNORECASE)
        if not m:
            continue
        num = int(m.group(1))
        if best_num is None or num < best_num:
            best_num = num
            best = img
    return best


async def generate_primer(
    doc_id: str,
    pages: list,
    metadata: dict,
    username: str,
    pdf_path: str,
    target_lang: str = "한국어",
    session_id: str = None,
) -> dict:
    """primer 콘텐츠를 생성하고 캐시에 저장한 뒤 결과 dict를 반환한다.

    LLM 생성이 실패(타임아웃 등)하면 예외를 그대로 전파한다 - 예전에는 여기서
    빈 값(hook="", lineage="" 등)으로 대체해 반환했는데, 그 빈 결과가 "정상
    완료된 브리핑"으로 캐시에 영구 저장되어 이후 재생성을 눌러도 계속 개요
    탭만 있는 빈 브리핑이 반복되는 문제가 있었다. 호출부(routers/primer.py의
    백그라운드 태스크)가 예외를 캐치해 캐시 저장을 건너뛰므로, 다음 조회/재생성
    시 처음부터 다시 시도하게 된다.
    """
    title = metadata.get("title") or ""
    sections = detect_sections(pages)
    candidate_terms = extract_candidate_terms(pages)

    async def _run_llm() -> dict:
        return await generate_reading_primer(
            title, sections, candidate_terms, target_lang=target_lang, session_id=session_id
        )

    async def _run_figure() -> Optional[dict]:
        try:
            picked = await asyncio.to_thread(_pick_primary_figure, pdf_path)
            if picked and save_primer_figure(doc_id, pdf_path, picked["page"], picked):
                return {"page": picked["page"], "label": picked.get("label")}
        except Exception as e:
            print(f"[primer] Figure 크롭 실패 ({doc_id}): {e}")
        return None

    # LLM 생성(계보/실험 흐름/용어집 등 필드가 늘면서 로컬 모델 기준 1~3분까지
    # 걸릴 수 있다)과 Figure 크롭(이미지가 많은 논문은 PDF 이미지 추출/렌더링에
    # 수십 초가 걸릴 수 있다)은 서로 의존하지 않는데도 예전에는 순차 실행돼
    # 대기 시간이 그대로 합산됐다. 병렬로 돌려 전체 응답 시간을 단축한다.
    llm_part, figure = await asyncio.gather(_run_llm(), _run_figure())

    try:
        reference_map = extract_reference_list(pages)
    except Exception as e:
        print(f"[primer] 참고문헌 파싱 실패 ({doc_id}): {e}")
        reference_map = {}

    library_matches = []
    if reference_map:
        try:
            library_matches = _match_library_references(reference_map, doc_id, username)
        except Exception as e:
            print(f"[primer] 라이브러리 매칭 실패 ({doc_id}): {e}")

    external_matches = []
    recommended_titles = llm_part.get("recommended_titles", [])
    if recommended_titles:
        try:
            library_title_words = [_normalize_words(m["title"]) for m in library_matches]
            external_matches = await _resolve_recommended_titles(recommended_titles, library_title_words)
        except Exception as e:
            print(f"[primer] 관련 논문 추천 검증 실패 ({doc_id}): {e}")

    result = {
        "hook": llm_part.get("hook", ""),
        "lineage": llm_part.get("lineage", ""),
        "feynman": llm_part.get("feynman", ""),
        "questions": llm_part.get("questions", []),
        "checklist": llm_part.get("checklist", []),
        "experiment_flow": llm_part.get("experiment_flow", []),
        "glossary": llm_part.get("glossary", []),
        "figure": figure,
        "citation_graph": {
            "library": library_matches,
            "external": external_matches,
        },
    }

    try:
        save_page_insight(doc_id, 0, _PRIMER_CACHE_KIND, json.dumps(result, ensure_ascii=False), suffix=target_lang)
    except Exception as e:
        print(f"[primer] 캐시 저장 실패 ({doc_id}): {e}")

    return result


def get_cached_primer(doc_id: str, target_lang: str = "한국어") -> Optional[dict]:
    content = get_page_insight(doc_id, 0, _PRIMER_CACHE_KIND, suffix=target_lang)
    if not content:
        return None
    try:
        return json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return None


def invalidate_primer_cache(doc_id: str, target_lang: str = "한국어") -> None:
    """캐시된 브리핑을 지운다("다시 생성하기" 용도). page_insights는
    INSERT OR REPLACE로 저장되므로 재생성 자체는 캐시를 안 지워도 결국
    덮어써지지만, 캐시를 먼저 지워둬야 재생성이 끝나기 전에 들어오는 GET
    요청이 낡은 캐시를 즉시 반환해버리지 않고 올바르게 pending을 반환한다."""
    delete_page_insight(doc_id, 0, _PRIMER_CACHE_KIND, suffix=target_lang)

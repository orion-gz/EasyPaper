"""
파싱된 참고문헌 텍스트를 OpenAlex API로 검색해 실제 논문 링크(가능한 경우 arXiv
링크 우선)를 찾는다. 가입/API 키가 전혀 필요 없는 공개 엔드포인트를 사용하며,
실패/미매칭 시 예외를 던지지 않고 None을 반환해 호출부(참고문헌 링크 연결
기능 전체)가 이 한 건의 실패로 죽지 않게 한다.

원래는 Semantic Scholar를 썼으나, 그 쪽 공개(API 키 없는) 검색 엔드포인트는
IP 기준 공유 레이트리밋이 꽤 엄격해서(실제로 이 프로젝트 배포 환경에서도
반복적으로 429 Too Many Requests를 받았음) 셀프호스팅 환경에서 안정적으로
쓰기 어려웠다. OpenAlex는 API 키/가입 절차 자체가 없고 한도도 훨씬 넉넉해
셀프호스팅 배포에 더 적합하다. config.get_openalex_mailto()에 연락 가능한
이메일을 설정하면(선택 사항) 더 여유로운 한도의 "polite pool"로 분류된다.
"""

import logging
import re
from difflib import SequenceMatcher
from typing import Optional

import httpx

from config import get_openalex_mailto

logger = logging.getLogger(__name__)

_OPENALEX_WORKS_URL = "https://api.openalex.org/works"
_REQUEST_TIMEOUT_SECONDS = 10.0


def _clean_paper_title(raw: str) -> str:
    if not raw:
        return ""
    clean = raw.strip()
    clean = re.sub(r'\.pdf$', '', clean, flags=re.IGNORECASE)
    clean = clean.replace("_", " ")
    return re.sub(r'\s+', ' ', clean).strip()


def _normalize_title_for_match(text: str) -> str:
    cleaned = re.sub(r'[^a-zA-Z0-9\s]', '', text or '').lower()
    return re.sub(r'\s+', ' ', cleaned).strip()


def _calculate_title_similarity(query_title: str, cand_title: str) -> float:
    q_norm = _normalize_title_for_match(query_title)
    c_norm = _normalize_title_for_match(cand_title)
    if not q_norm or not c_norm:
        return 0.0
    if q_norm == c_norm:
        return 1.0

    q_words = set(q_norm.split())
    c_words = set(c_norm.split())
    if not q_words or not c_words:
        return 0.0

    jaccard = len(q_words.intersection(c_words)) / len(q_words.union(c_words))
    seq_ratio = SequenceMatcher(None, q_norm, c_norm).ratio()

    if len(q_words) >= 3 and q_words.issubset(c_words):
        containment = len(q_words) / len(c_words)
        return max(jaccard, seq_ratio, containment * 0.85)

    return max(jaccard, seq_ratio)


# IEEE 등 학술 인용 스타일은 흔히 제목을 따옴표로 감싼다(예: Author, "Title," Venue,
# year.). 저자명·학회명·권/호/페이지 번호까지 통째로 검색하면 관련 없는 논문이
# 최상위로 매칭되는 경우가 실측으로 확인되어(예: "Deep residual learning for image
# recognition" 전체 인용문 검색 시 완전히 무관한 논문이 1위로 나옴, 제목만 검색하면
# 정확히 매칭됨), 따옴표로 감싸진 제목이 있으면 그 부분만 검색어로 쓴다.
_QUOTED_TITLE_RE = re.compile(r'["“]([^"”]{8,300})["”]')
_DOI_RE = re.compile(r'10\.\d{4,9}/[-._;()/:A-Za-z0-9]+', re.IGNORECASE)
_YEAR_RE = re.compile(r'\b(?:19|20)\d{2}[a-z]?\b', re.IGNORECASE)
_VENUE_RE = re.compile(
    r'\b(?:proceedings|conference|journal|transactions|workshop|symposium|'
    r'arxiv|volume|vol\.?|issue|no\.?|pages?|pp\.?|publisher|press|doi)\b',
    re.IGNORECASE,
)


def _clean_title_candidate(value: str) -> str:
    value = re.sub(r'\*\*|["“”]', '', value or '')
    value = re.sub(r'^\s*[-–—,;:.]+|[-–—,;:.]+\s*$', '', value)
    return re.sub(r'\s+', ' ', value).strip()


def _extract_search_query(citation_text: str) -> str:
    """참고문헌에서 저자·연도·게재처·DOI를 제외한 제목 후보를 추출한다."""
    raw = re.sub(r'[\u200b-\u200d\ufeff]', ' ', citation_text or '').strip()
    if not raw:
        return ''

    match = _QUOTED_TITLE_RE.search(raw)
    if match:
        return _clean_title_candidate(match.group(1))

    text = re.sub(r'^\s*(?:\[[^]]+]|\d+[.)])\s*', '', raw)
    text = re.sub(r'https?://\S+|www\.\S+', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'\bdoi\s*:\s*10\.\d{4,9}/\S+', ' ', text, flags=re.IGNORECASE)
    text = _DOI_RE.sub(' ', text)
    text = re.sub(r'\barxiv\s*:\s*\S+', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'\s+', ' ', text).strip()

    # 흔한 "Authors et al. Title" 및 APA "Authors (2020). Title" 앞부분 제거.
    text = re.sub(r'^.*?\bet\s+al\.?(?:\s*[,;:])?\s*', '', text, flags=re.IGNORECASE)
    apa_year = re.match(r'^.*?\((?:19|20)\d{2}[a-z]?\)\s*[.,;:]?\s*(.+)$', text, re.IGNORECASE)
    if apa_year:
        text = apa_year.group(1)

    candidates = []
    for part in re.split(r'\.\s+(?=[A-Z0-9“"])', text):
        part = _clean_title_candidate(part)
        if not part:
            continue
        without_year = _YEAR_RE.sub('', part).strip()
        words = re.findall(r"\w[\w'’-]*", part, flags=re.UNICODE)
        if _YEAR_RE.search(part) and len(without_year.split()) < 3:
            continue
        score = min(len(words), 18)
        if len(words) < 3:
            score -= 10
        if _VENUE_RE.search(part):
            score -= 8
        if part.count(',') >= 3:
            score -= 6
        if re.match(r'^(?:[A-Z]\.?)\s+[A-Z][a-z]+', part):
            score -= 4
        candidates.append((score, part))

    if candidates:
        score, candidate = max(candidates, key=lambda item: item[0])
        if score > 0:
            candidate = re.sub(
                r'\s*\b(?:19|20)\d{2}[a-z]?\b.*$', '', candidate, flags=re.IGNORECASE
            )
            return _clean_title_candidate(candidate)

    fallback = _YEAR_RE.sub(' ', text)
    fallback = re.sub(
        r'\b(?:vol|no|pp|pages?)\.?\s*[\d–—-]+', ' ', fallback, flags=re.IGNORECASE
    )
    return ' '.join(_clean_title_candidate(fallback).split()[:18])

def _pick_url(work: dict) -> Optional[str]:
    """work 메타데이터에서 표시할 링크를 고른다. 원문을 무료로 바로 볼 수 있는
    arXiv 링크를 최우선으로 하고, 그다음은 canonical 대표 링크/DOI, 검증이
    어려운 OpenAlex OA 링크 순으로 폴백한다."""
    for location in work.get("locations") or []:
        source = location.get("source") or {}
        display_name = (source.get("display_name") or "").lower()
        if "arxiv" in display_name and location.get("landing_page_url"):
            return location["landing_page_url"]

    # OpenAlex의 oa_url은 다른 저장소 문서에 잘못 연결된 사례가 있어
    # canonical primary/DOI 링크를 먼저 사용하고, OA URL은 마지막 폴백으로 둔다.
    primary_location = work.get("primary_location") or {}
    if primary_location.get("landing_page_url"):
        return primary_location["landing_page_url"]

    if work.get("doi"):
        return work["doi"]

    open_access = work.get("open_access") or {}
    return open_access.get("oa_url") or None


_ARXIV_ID_RE = re.compile(r'arxiv\.org/abs/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)', re.IGNORECASE)


def _extract_arxiv_id(work: dict) -> Optional[str]:
    for location in work.get("locations") or []:
        url = location.get("landing_page_url") or ""
        m = _ARXIV_ID_RE.search(url)
        if m:
            return m.group(1)
    return None


def _extract_venue(work: dict) -> Optional[str]:
    """게재처 이름을 찾는다. primary_location.source.display_name이 정석이지만,
    실측 결과 상당수 레코드(예: CVPR/ICCV 등 IEEE 학회 논문)가 source를 정식
    Source 객체로 연결해두지 않고 raw_source_name(원문 그대로의 게재처 문자열)에만
    담아둔다 - 그 경우도 정직한 실제 값이므로 폴백으로 사용한다."""
    primary_location = work.get("primary_location") or {}
    source = primary_location.get("source") or {}
    if source.get("display_name"):
        return source["display_name"]
    if primary_location.get("raw_source_name"):
        return primary_location["raw_source_name"]
    for location in work.get("locations") or []:
        source = location.get("source") or {}
        name = source.get("display_name") or location.get("raw_source_name")
        if name and "arxiv" not in name.lower():
            return name
    return None


async def resolve_paper_metadata(title: str) -> Optional[dict]:
    """논문 자신의 제목으로 OpenAlex를 검색해 Venue/DOI/ArXiv ID/피인용수를
    반환합니다(Library 상세 패널의 Quick Info용).
    제목 정제 후 상위 후보(top 5)를 검증하여 유사도가 검증된 항목의 서지 정보를 반환합니다."""
    raw_query = _clean_paper_title(title)
    if not raw_query:
        return None

    doi_match = re.search(r'10\.\d{4,9}/[-._;()/:A-Za-z0-9]+', raw_query)
    arxiv_match = re.search(r'(?:arxiv:)?([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)', raw_query, re.IGNORECASE)

    params = {"search": raw_query[:300], "per_page": 5}
    mailto = get_openalex_mailto()
    if mailto:
        params["mailto"] = mailto

    try:
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.get(_OPENALEX_WORKS_URL, params=params)
            if resp.status_code != 200:
                logger.warning(f"OpenAlex 논문 검색 실패: status={resp.status_code}")
                return None

            data = resp.json()
            works = data.get("results") or []
            if not works:
                return None

            best_work = None
            best_score = 0.0

            for work in works:
                cand_title = work.get("title") or work.get("display_name") or ""
                cand_doi = work.get("doi") or ""
                cand_arxiv = _extract_arxiv_id(work) or ""

                if doi_match and doi_match.group(0).lower() in cand_doi.lower():
                    best_work = work
                    best_score = 1.0
                    break
                if arxiv_match and arxiv_match.group(1).lower() == cand_arxiv.lower():
                    best_work = work
                    best_score = 1.0
                    break

                score = _calculate_title_similarity(raw_query, cand_title)
                if score > best_score:
                    best_score = score
                    best_work = work

            if not best_work or best_score < 0.40:
                logger.info(f"OpenAlex 논문 매칭 실패 (최고 유사도: {best_score:.2f}, query='{raw_query}')")
                return None

            doi = best_work.get("doi")
            if doi and doi.startswith("https://doi.org/"):
                doi = doi[len("https://doi.org/"):]

            return {
                "venue": _extract_venue(best_work),
                "doi": doi,
                "arxiv_id": _extract_arxiv_id(best_work),
                "citation_count": best_work.get("cited_by_count"),
            }
    except Exception as e:
        logger.warning(f"논문 메타데이터 검색 중 오류: {e}")
        return None


async def resolve_reference(query_text: str) -> Optional[dict]:
    """참고문헌을 정제해 OpenAlex 상위 후보를 제목·연도로 검증한 뒤 링크를 반환한다."""
    raw = (query_text or "").strip()
    if not raw:
        return None

    query = _extract_search_query(raw)[:300]
    if not query:
        return None

    expected_years = {int(year[:4]) for year in _YEAR_RE.findall(raw)}
    expected_doi = _DOI_RE.search(raw)
    expected_doi_text = expected_doi.group(0).rstrip(".,;") if expected_doi else None
    params = {"search": query, "per_page": 5}
    mailto = get_openalex_mailto()
    if mailto:
        params["mailto"] = mailto

    try:
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.get(_OPENALEX_WORKS_URL, params=params)

            if resp.status_code != 200:
                logger.warning(f"OpenAlex 검색 실패: status={resp.status_code}")
                return None

            works = (resp.json().get("results") or [])
            if not works:
                return None

            best_work = None
            best_url = None
            best_score = 0.0
            best_title_score = 0.0
            for work in works:
                url = _pick_url(work)
                if not url:
                    continue

                candidate_title = work.get("title") or work.get("display_name") or ""
                candidate_doi = work.get("doi") or ""
                if expected_doi_text and expected_doi_text.lower() in candidate_doi.lower():
                    best_work, best_url, best_score = work, url, 1.0
                    best_title_score = 1.0
                    break

                title_score = _calculate_title_similarity(query, candidate_title)
                score = title_score
                candidate_year = work.get("publication_year")
                if expected_years and candidate_year:
                    year_distance = min(abs(candidate_year - year) for year in expected_years)
                    score += 0.05 if year_distance <= 1 else -0.15

                # 동일 제목 중복 레코드는 정식 DOI와 인용수가 높은 원 레코드를 우선한다.
                if candidate_doi:
                    score += 0.02
                cited_count = max(0, work.get("cited_by_count") or 0)
                score += min(0.05, len(str(cited_count)) * 0.01)

                if score > best_score:
                    best_work, best_url, best_score = work, url, score
                    best_title_score = title_score

            if not best_work or not best_url or best_title_score < 0.50:
                logger.info(
                    f"OpenAlex 참고문헌 매칭 실패 "
                    f"(제목 유사도: {best_title_score:.2f}, 종합 점수: {best_score:.2f}, "
                    f"query='{query}')"
                )
                return None

            resolved_year = best_work.get("publication_year")
            if expected_years and resolved_year:
                closest_year = min(expected_years, key=lambda year: abs(resolved_year - year))
                if abs(resolved_year - closest_year) > 1:
                    resolved_year = closest_year

            return {
                "title": best_work.get("title") or best_work.get("display_name") or "",
                "url": best_url,
                "year": resolved_year,
            }
    except Exception as e:
        logger.warning(f"참고문헌 검색 중 오류: {e}")
        return None

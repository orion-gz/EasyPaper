"""services/reference_linker.py 테스트.

원래는 Semantic Scholar를 썼으나, 그쪽 공개(API 키 없는) 검색 엔드포인트는 이
프로젝트 개발/배포 환경에서도 실제로 여러 차례 429 Too Many Requests를 반환할
만큼 레이트리밋이 엄격해 셀프호스팅에 부적합했다. 가입/키가 필요 없는
OpenAlex로 교체했다. httpx 응답을 모킹해 로직만 검증한다(실제 네트워크 호출에
의존하는 테스트는 신뢰할 수 없음).
"""

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from services.reference_linker import resolve_reference, _extract_search_query


def _make_response(status_code: int, json_data: dict = None):
    request = httpx.Request("GET", "https://api.openalex.org/works")
    return httpx.Response(status_code=status_code, json=json_data or {}, request=request)


@pytest.mark.asyncio
async def test_resolve_reference_returns_none_for_empty_query():
    assert await resolve_reference("") is None
    assert await resolve_reference("   ") is None


@pytest.mark.asyncio
async def test_resolve_reference_prefers_arxiv_link_when_available():
    mock_response = _make_response(200, {
        "results": [{
            "title": "Attention Is All You Need",
            "publication_year": 2017,
            "open_access": {"oa_url": "https://example.com/oa.pdf"},
            "primary_location": {"landing_page_url": "https://example.com/primary"},
            "doi": "https://doi.org/10.0000/xyz",
            "locations": [
                {"source": {"display_name": "NeurIPS"}, "landing_page_url": "https://example.com/neurips"},
                {"source": {"display_name": "arXiv (Cornell University)"}, "landing_page_url": "https://arxiv.org/abs/1706.03762"},
            ],
        }]
    })
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=mock_response)):
        result = await resolve_reference('Vaswani et al. "Attention Is All You Need." 2017.')

    assert result is not None
    assert result["url"] == "https://arxiv.org/abs/1706.03762"
    assert result["title"] == "Attention Is All You Need"
    assert result["year"] == 2017


@pytest.mark.asyncio
async def test_resolve_reference_prefers_canonical_primary_over_untrusted_oa_url():
    # OpenAlex OA 연결이 잘못될 수 있으므로 canonical primary 링크 우선
    mock_response = _make_response(200, {
        "results": [{
            "title": "Some Paper",
            "publication_year": 2020,
            "open_access": {"oa_url": "https://example.com/oa.pdf"},
            "primary_location": {"landing_page_url": "https://example.com/primary"},
            "doi": "https://doi.org/10.0000/xyz",
            "locations": [],
        }]
    })
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=mock_response)):
        result = await resolve_reference("Some Paper query text")
    assert result["url"] == "https://example.com/primary"

    # primary_location이 있으면 OA 유무와 관계없이 canonical 링크 사용
    mock_response = _make_response(200, {
        "results": [{
            "title": "Some Paper",
            "publication_year": 2020,
            "open_access": {},
            "primary_location": {"landing_page_url": "https://example.com/primary"},
            "doi": "https://doi.org/10.0000/xyz",
            "locations": [],
        }]
    })
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=mock_response)):
        result = await resolve_reference("Some Paper query text")
    assert result["url"] == "https://example.com/primary"

    # primary가 없으면 DOI 사용
    mock_response = _make_response(200, {
        "results": [{
            "title": "Some Paper",
            "publication_year": 2020,
            "open_access": {},
            "primary_location": {},
            "doi": "https://doi.org/10.0000/xyz",
            "locations": [],
        }]
    })
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=mock_response)):
        result = await resolve_reference("Some Paper query text")
    assert result["url"] == "https://doi.org/10.0000/xyz"


@pytest.mark.asyncio
async def test_resolve_reference_returns_none_when_no_results():
    mock_response = _make_response(200, {"results": []})
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=mock_response)):
        result = await resolve_reference("a query with no matches")
    assert result is None


@pytest.mark.asyncio
async def test_resolve_reference_returns_none_on_non_200_status():
    mock_response = _make_response(429, {"message": "Too Many Requests"})
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=mock_response)):
        result = await resolve_reference("some query")
    assert result is None


@pytest.mark.asyncio
async def test_resolve_reference_handles_network_exception_gracefully():
    with patch("httpx.AsyncClient.get", new=AsyncMock(side_effect=httpx.ConnectError("연결 실패"))):
        result = await resolve_reference("query during network outage")
    assert result is None


@pytest.mark.asyncio
async def test_resolve_reference_returns_none_when_no_url_available():
    mock_response = _make_response(200, {
        "results": [{
            "title": "No URL Paper",
            "publication_year": 2019,
            "open_access": {},
            "primary_location": {},
            "doi": None,
            "locations": [],
        }]
    })
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=mock_response)):
        result = await resolve_reference("paper with no url")
    assert result is None


def test_extract_search_query_uses_quoted_title_when_present():
    citation = (
        'K. He, X. Zhang, S. Ren, and J. Sun, "Deep residual learning for '
        'image recognition," in Proc. CVPR, 2016, pp. 770-778.'
    )
    assert _extract_search_query(citation) == "Deep residual learning for image recognition"


def test_extract_search_query_cleans_unquoted_et_al_citation():
    citation = "A. Vaswani, N. Shazeer, N. Parmar, et al. Attention is all you need. NeurIPS, 2017."
    assert _extract_search_query(citation) == "Attention is all you need"


def test_extract_search_query_cleans_apa_citation():
    citation = (
        "Smith, J., Doe, A. (2020). Reliable Widget Detection at Scale. "
        "Journal of Widgets, 4(2), 10-20. https://doi.org/10.1234/widgets"
    )
    assert _extract_search_query(citation) == "Reliable Widget Detection at Scale"


@pytest.mark.asyncio
async def test_resolve_reference_sends_extracted_title_as_search_param():
    mock_response = _make_response(200, {"results": []})
    mock_get = AsyncMock(return_value=mock_response)
    with patch("httpx.AsyncClient.get", new=mock_get):
        await resolve_reference('Author, "The Real Title," Venue, 2020, pp. 1-10.')

    sent_params = mock_get.call_args.kwargs["params"]
    assert sent_params["search"] == "The Real Title"


@pytest.mark.asyncio
async def test_resolve_reference_validates_top_candidates_instead_of_using_first():
    mock_response = _make_response(200, {
        "results": [
            {
                "title": "An Unrelated Survey of Neural Networks",
                "publication_year": 2016,
                "primary_location": {"landing_page_url": "https://example.com/wrong"},
                "locations": [],
            },
            {
                "title": "Deep Residual Learning for Image Recognition",
                "publication_year": 2016,
                "primary_location": {"landing_page_url": "https://example.com/correct"},
                "locations": [],
            },
        ]
    })
    mock_get = AsyncMock(return_value=mock_response)
    with patch("httpx.AsyncClient.get", new=mock_get):
        result = await resolve_reference(
            "He et al. Deep Residual Learning for Image Recognition. CVPR, 2016."
        )

    assert result["url"] == "https://example.com/correct"
    assert mock_get.call_args.kwargs["params"]["per_page"] == 5


@pytest.mark.asyncio
async def test_resolve_reference_rejects_unrelated_openalex_candidates():
    mock_response = _make_response(200, {
        "results": [{
            "title": "Completely Different Research Topic",
            "publication_year": 2018,
            "doi": "https://doi.org/10.9999/wrong",
            "cited_by_count": 999999,
            "primary_location": {"landing_page_url": "https://example.com/wrong"},
            "locations": [],
        }]
    })
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=mock_response)):
        result = await resolve_reference(
            "Vaswani et al. Attention Is All You Need. NeurIPS, 2017."
        )

    assert result is None


@pytest.mark.asyncio
async def test_resolve_reference_uses_citation_year_to_break_title_tie():
    mock_response = _make_response(200, {
        "results": [
            {
                "title": "Shared Paper Title",
                "publication_year": 1999,
                "primary_location": {"landing_page_url": "https://example.com/wrong-year"},
                "locations": [],
            },
            {
                "title": "Shared Paper Title",
                "publication_year": 2021,
                "primary_location": {"landing_page_url": "https://example.com/right-year"},
                "locations": [],
            },
        ]
    })
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=mock_response)):
        result = await resolve_reference("Author et al. Shared Paper Title. 2021.")

    assert result["url"] == "https://example.com/right-year"


@pytest.mark.asyncio
async def test_resolve_reference_uses_citation_year_when_openalex_year_is_corrupt():
    mock_response = _make_response(200, {
        "results": [{
            "title": "Attention Is All You Need",
            "publication_year": 2025,
            "cited_by_count": 6000,
            "doi": "https://doi.org/10.fake/duplicate",
            "locations": [{
                "source": {"display_name": "arXiv"},
                "landing_page_url": "https://arxiv.org/abs/1706.03762",
            }],
        }]
    })
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=mock_response)):
        result = await resolve_reference(
            "Vaswani et al. Attention Is All You Need. NeurIPS, 2017."
        )

    assert result["url"] == "https://arxiv.org/abs/1706.03762"
    assert result["year"] == 2017

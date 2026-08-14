"""GET /library/{doc_id}/references, GET /library/{doc_id}/references/{ref_num}
HTTP 레벨 테스트 - 캐싱, 소유자 격리, 외부 API 미매칭 처리를 확인한다.
"""

import json
from unittest.mock import AsyncMock, patch


def _create_doc(isolated_dirs, doc_id="doc-1", username="testuser"):
    db = isolated_dirs["db"]
    db.db_save_document(doc_id, username, "paper.pdf", "/x/paper.pdf", 3, {"title": "Test Paper"})


def test_get_references_parses_and_caches(test_client, isolated_dirs):
    _create_doc(isolated_dirs)

    fake_pages = [{"page_num": 1, "text": "References\n\n[1] Someone. A Paper. 2020."}]
    with patch("services.pdf_parser.extract_pages", return_value=fake_pages), \
         patch("routers.library.get_pdf_path", return_value="/fake/path.pdf"):
        res = test_client.get("/api/library/doc-1/references")

    assert res.status_code == 200
    assert res.json()["references"] == {"1": "Someone. A Paper. 2020."}

    # 두 번째 호출은 캐시를 써야 하므로 extract_pages가 다시 호출되지 않아야 한다
    with patch("services.pdf_parser.extract_pages") as mock_extract:
        res2 = test_client.get("/api/library/doc-1/references")
    assert res2.status_code == 200
    assert res2.json()["references"] == {"1": "Someone. A Paper. 2020."}
    mock_extract.assert_not_called()


def test_get_references_other_users_document_returns_404(test_client, isolated_dirs):
    _create_doc(isolated_dirs, doc_id="doc-other", username="otheruser")
    res = test_client.get("/api/library/doc-other/references")
    assert res.status_code == 404


def test_resolve_reference_returns_url_when_matched(test_client, isolated_dirs):
    _create_doc(isolated_dirs)
    isolated_dirs["db"].db_save_page_insight(
        "doc-1", 0, "reference_list", json.dumps({"1": "Vaswani et al. Attention Is All You Need."})
    )

    mock_result = {"title": "Attention Is All You Need", "url": "https://arxiv.org/abs/1706.03762", "year": 2017}
    with patch("services.reference_linker.resolve_reference", new=AsyncMock(return_value=mock_result)):
        res = test_client.get("/api/library/doc-1/references/1")

    assert res.status_code == 200
    assert res.json()["url"] == "https://arxiv.org/abs/1706.03762"


def test_resolve_reference_caches_result(test_client, isolated_dirs):
    _create_doc(isolated_dirs)
    isolated_dirs["db"].db_save_page_insight(
        "doc-1", 0, "reference_list", json.dumps({"1": "Some paper title."})
    )

    mock_result = {"title": "Some paper title.", "url": "https://example.com/paper", "year": 2020}
    mock_resolve = AsyncMock(return_value=mock_result)
    with patch("services.reference_linker.resolve_reference", new=mock_resolve):
        test_client.get("/api/library/doc-1/references/1")

    # 두 번째 호출은 캐시를 써야 하므로 resolve_reference가 다시 호출되지 않아야 한다
    with patch("services.reference_linker.resolve_reference", new=AsyncMock()) as mock_resolve_2:
        res2 = test_client.get("/api/library/doc-1/references/1")
    assert res2.status_code == 200
    mock_resolve_2.assert_not_called()


def test_resolve_reference_returns_404_when_no_match_found(test_client, isolated_dirs):
    _create_doc(isolated_dirs)
    isolated_dirs["db"].db_save_page_insight(
        "doc-1", 0, "reference_list", json.dumps({"1": "unmatchable nonsense query"})
    )

    with patch("services.reference_linker.resolve_reference", new=AsyncMock(return_value=None)):
        res = test_client.get("/api/library/doc-1/references/1")

    assert res.status_code == 404


def test_resolve_reference_returns_404_when_ref_num_unknown(test_client, isolated_dirs):
    _create_doc(isolated_dirs)
    isolated_dirs["db"].db_save_page_insight(
        "doc-1", 0, "reference_list", json.dumps({"1": "the only reference"})
    )
    res = test_client.get("/api/library/doc-1/references/999")
    assert res.status_code == 404


def test_resolve_reference_other_users_document_returns_404(test_client, isolated_dirs):
    _create_doc(isolated_dirs, doc_id="doc-other2", username="otheruser")
    res = test_client.get("/api/library/doc-other2/references/1")
    assert res.status_code == 404


def test_resolve_reference_ignores_legacy_inaccurate_cache(test_client, isolated_dirs):
    _create_doc(isolated_dirs)
    db = isolated_dirs["db"]
    db.db_save_page_insight(
        "doc-1", 0, "reference_list", json.dumps({"1": "Correct paper title. 2022."})
    )
    db.db_save_page_insight(
        "doc-1", 0, "reference_url",
        json.dumps({"title": "Wrong", "url": "https://example.com/wrong", "year": 1999}),
        suffix="1",
    )

    corrected = {
        "title": "Correct paper title",
        "url": "https://example.com/correct",
        "year": 2022,
    }
    mock_resolve = AsyncMock(return_value=corrected)
    with patch("services.reference_linker.resolve_reference", new=mock_resolve):
        response = test_client.get("/api/library/doc-1/references/1")

    assert response.status_code == 200
    assert response.json()["url"] == "https://example.com/correct"
    mock_resolve.assert_awaited_once()

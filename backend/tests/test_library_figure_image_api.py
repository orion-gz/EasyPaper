"""GET /library/{doc_id}/figure-image/{index} HTTP 레벨 테스트.

지식 그래프 Figure/Table 노드 상세 패널에서 실제 이미지를 보여주기 위한
엔드포인트. 좌표는 클라이언트가 아니라 서버에 캐시된 get_cached_images
결과에서만 가져오므로, 캐시에 없는 index나 다른 사용자 문서는 전부
404여야 한다."""

from unittest.mock import patch


def _create_doc(isolated_dirs, doc_id="doc-1", username="testuser"):
    db = isolated_dirs["db"]
    db.db_save_document(doc_id, username, "paper.pdf", "/x/paper.pdf", 3, {"title": "Test Paper"})


def test_get_figure_image_returns_png(test_client, isolated_dirs, tmp_path):
    _create_doc(isolated_dirs)
    pdf_path = tmp_path / "paper.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake" + b"\0" * 200)

    cached_images = [
        {"page": 1, "left": 10.0, "top": 10.0, "width": 30.0, "height": 20.0, "label": "Figure 1", "caption": "설명"},
    ]
    fake_png = b"\x89PNG fake bytes"
    with patch("routers.library.get_pdf_path", return_value=str(pdf_path)), \
         patch("services.cache.get_cached_images", return_value=cached_images), \
         patch("services.pdf_parser.render_image_crop_bytes", return_value=fake_png) as mock_render:
        res = test_client.get("/api/library/doc-1/figure-image/0")

    assert res.status_code == 200
    assert res.headers["content-type"] == "image/png"
    assert res.content == fake_png
    mock_render.assert_called_once_with(str(pdf_path), 1, cached_images[0])


def test_get_figure_image_out_of_range_index_returns_404(test_client, isolated_dirs, tmp_path):
    _create_doc(isolated_dirs)
    pdf_path = tmp_path / "paper.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake" + b"\0" * 200)

    with patch("routers.library.get_pdf_path", return_value=str(pdf_path)), \
         patch("services.cache.get_cached_images", return_value=[{"page": 1, "label": "Figure 1"}]):
        res = test_client.get("/api/library/doc-1/figure-image/5")

    assert res.status_code == 404


def test_get_figure_image_no_cache_returns_404(test_client, isolated_dirs, tmp_path):
    _create_doc(isolated_dirs)
    pdf_path = tmp_path / "paper.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake" + b"\0" * 200)

    with patch("routers.library.get_pdf_path", return_value=str(pdf_path)), \
         patch("services.cache.get_cached_images", return_value=None):
        res = test_client.get("/api/library/doc-1/figure-image/0")

    assert res.status_code == 404


def test_get_figure_image_other_users_document_returns_404(test_client, isolated_dirs):
    _create_doc(isolated_dirs, doc_id="doc-other", username="otheruser")
    res = test_client.get("/api/library/doc-other/figure-image/0")
    assert res.status_code == 404

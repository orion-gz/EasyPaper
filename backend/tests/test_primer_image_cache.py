"""_pick_primary_figure가 이미지 좌표 디스크 캐시(get_cached_images/
save_images_cache)를 활용하는지 검증하는 회귀 테스트.

수정 전에는 pdf_path만으로 extract_pdf_images()를 직접 호출해 캐시를
완전히 우회했다 - 뷰어에서 이미 캐시가 만들어진 문서라도 읽기 전
브리핑 생성/재생성마다 PDF 전체를 처음부터 재파싱했다."""

import os

import pytest

from services.primer import _pick_primary_figure


def _make_pdf(tmp_path):
    pdf_path = tmp_path / "paper.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake content for cache test")
    return str(pdf_path)


def test_pick_primary_figure_uses_disk_cache_when_available(isolated_dirs, tmp_path, monkeypatch):
    cache = isolated_dirs["cache"]
    pdf_path = _make_pdf(tmp_path)
    doc_id = "doc-primer-cache"

    cached_images = [{"label": "Figure 1", "page": 2, "bbox": {}}]
    cache.save_images_cache(doc_id, pdf_path, cached_images)

    def _fail_if_called(_pdf_path):
        raise AssertionError("캐시가 있는데도 extract_pdf_images를 다시 호출함")

    monkeypatch.setattr("services.pdf_parser.extract_pdf_images", _fail_if_called)

    picked = _pick_primary_figure(doc_id, pdf_path)
    assert picked == cached_images[0]


def test_pick_primary_figure_populates_cache_on_miss(isolated_dirs, tmp_path, monkeypatch):
    cache = isolated_dirs["cache"]
    pdf_path = _make_pdf(tmp_path)
    doc_id = "doc-primer-cache-miss"

    extracted = [{"label": "Figure 1", "page": 3, "bbox": {}}]
    monkeypatch.setattr("services.pdf_parser.extract_pdf_images", lambda _pdf_path: extracted)

    picked = _pick_primary_figure(doc_id, pdf_path)
    assert picked == extracted[0]

    # 캐시가 채워져, 다음 호출부터는 재추출 없이 캐시를 반환해야 한다.
    assert cache.get_cached_images(doc_id, pdf_path) == extracted

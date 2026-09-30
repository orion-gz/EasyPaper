"""services/cache.py의 이미지/표 좌표 추출 결과 디스크 캐시(get_cached_images /
save_images_cache / clear_all_images_cache) 테스트.

extract_pdf_images()는 페이지마다 find_tables()/get_drawings() 등을 두
차례씩 훑는 무거운 연산이라, extract_pages()와 동일하게 디스크에 캐싱해
서버 재시작 이후에도 문서를 다시 열 때마다 재계산하지 않게 한다."""

import os

from services.cache import get_cached_images, save_images_cache, clear_all_images_cache


def _make_pdf(path, size_bytes=200):
    with open(path, "wb") as f:
        f.write(b"%PDF-1.4 fake" + b"\0" * size_bytes)


def test_cache_miss_when_never_saved(isolated_dirs, tmp_path):
    pdf_path = tmp_path / "doc.pdf"
    _make_pdf(pdf_path)
    assert get_cached_images("doc-1", str(pdf_path)) is None


def test_saved_images_are_returned_on_cache_hit(isolated_dirs, tmp_path):
    pdf_path = tmp_path / "doc.pdf"
    _make_pdf(pdf_path)
    images = [{"page": 1, "bbox": [0.1, 0.1, 0.5, 0.5], "label": "Figure 1"}]

    save_images_cache("doc-1", str(pdf_path), images)

    assert get_cached_images("doc-1", str(pdf_path)) == images


def test_cache_invalidated_when_pdf_content_changes(isolated_dirs, tmp_path):
    """PDF가 (같은 경로에서) 다른 내용으로 교체되면(mtime/크기 변경),
    오래된 캐시를 그대로 신뢰하지 않고 재추출을 유도해야 한다."""
    pdf_path = tmp_path / "doc.pdf"
    _make_pdf(pdf_path, size_bytes=200)
    save_images_cache("doc-1", str(pdf_path), [{"page": 1, "bbox": [0, 0, 1, 1]}])

    import time
    time.sleep(0.01)
    _make_pdf(pdf_path, size_bytes=500)

    assert get_cached_images("doc-1", str(pdf_path)) is None


def test_clear_all_images_cache_removes_only_images_cache_files(isolated_dirs, tmp_path):
    pdf_path = tmp_path / "doc.pdf"
    _make_pdf(pdf_path)
    save_images_cache("doc-1", str(pdf_path), [{"page": 1, "bbox": [0, 0, 1, 1]}])
    save_images_cache("doc-2", str(pdf_path), [{"page": 1, "bbox": [0, 0, 1, 1]}])

    # 다른 종류의 캐시 파일(페이지 텍스트 캐시)은 영향을 받으면 안 됨
    from services.cache import save_pages_cache, get_cached_pages
    save_pages_cache("doc-1", str(pdf_path), [{"page_num": 1, "text": "hello"}])

    count, freed_bytes = clear_all_images_cache()

    assert count == 2
    assert freed_bytes > 0
    assert get_cached_images("doc-1", str(pdf_path)) is None
    assert get_cached_images("doc-2", str(pdf_path)) is None
    assert get_cached_pages("doc-1", str(pdf_path)) == [{"page_num": 1, "text": "hello"}], \
        "페이지 텍스트 캐시는 지워지면 안 됨"


def test_legacy_figure_labels_are_reextracted(isolated_dirs, tmp_path):
    import json
    from pathlib import Path
    from services.cache import _images_cache_path

    pdf_path = tmp_path / 'doc.pdf'
    _make_pdf(pdf_path)
    images = [{"page": 1, "label": "Figure 4.18"}]
    save_images_cache('doc-1', str(pdf_path), images)
    assert get_cached_images('doc-1', str(pdf_path)) == images

    path = Path(_images_cache_path('doc-1'))
    data = json.loads(path.read_text())
    data.pop('images_label_version')
    path.write_text(json.dumps(data))
    assert get_cached_images('doc-1', str(pdf_path)) is None

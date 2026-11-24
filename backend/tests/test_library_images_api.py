"""GET /library/{doc_id}/images HTTP 레벨 테스트.

extract_pdf_images()는 페이지마다 find_tables()/get_drawings() 등을 두
차례씩 훑는 무거운 연산이다. 텍스트 추출(extract_pages)과 달리 예전에는
디스크 캐시가 전혀 없어 문서를 열 때마다(같은 세션 안에서도) 매번
처음부터 재계산했다 - 이 테스트는 그 디스크 캐시가 실제로 재계산을
막아주는지 확인한다."""

from unittest.mock import patch


def _create_doc(isolated_dirs, doc_id="doc-1", username="testuser"):
    db = isolated_dirs["db"]
    db.db_save_document(doc_id, username, "paper.pdf", "/x/paper.pdf", 3, {"title": "Test Paper"})


def test_get_images_extracts_and_caches(test_client, isolated_dirs, tmp_path):
    _create_doc(isolated_dirs)
    pdf_path = tmp_path / "paper.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake" + b"\0" * 200)

    fake_images = [{"page": 1, "bbox": [0.1, 0.1, 0.5, 0.5], "label": "Figure 1"}]
    with patch("services.pdf_parser.extract_pdf_images", return_value=fake_images) as mock_extract, \
         patch("routers.library.get_pdf_path", return_value=str(pdf_path)):
        res = test_client.get("/api/library/doc-1/images")

    assert res.status_code == 200
    assert res.json()["images"] == fake_images
    mock_extract.assert_called_once()

    # 두 번째 호출은 디스크 캐시를 써야 하므로 extract_pdf_images가 다시 호출되지 않아야 한다
    with patch("services.pdf_parser.extract_pdf_images") as mock_extract2, \
         patch("routers.library.get_pdf_path", return_value=str(pdf_path)):
        res2 = test_client.get("/api/library/doc-1/images")

    assert res2.status_code == 200
    assert res2.json()["images"] == fake_images
    mock_extract2.assert_not_called()


def test_get_images_other_users_document_returns_404(test_client, isolated_dirs):
    _create_doc(isolated_dirs, doc_id="doc-other", username="otheruser")
    res = test_client.get("/api/library/doc-other/images")
    assert res.status_code == 404


def test_window_extracts_only_missing_pages(test_client, isolated_dirs, tmp_path, monkeypatch):
    import json
    from pathlib import Path
    from types import SimpleNamespace

    import fitz
    from services import image_window

    _create_doc(isolated_dirs)
    pdf_path = tmp_path / "book.pdf"
    with fitz.open() as source:
        for n in range(1, 51):
            source.new_page().insert_text((20, 40), str(n))
        source.save(pdf_path)
    monkeypatch.setattr("routers.library.get_pdf_path", lambda _: str(pdf_path))
    monkeypatch.setattr(image_window, "CACHE_DIR", str(tmp_path))
    calls = []

    def run(command, **kwargs):
        with fitz.open(command[command.index("--pdf") + 1]) as subset:
            pages = [int(p.get_text().strip()) for p in subset]
        calls.append(pages)
        output = Path(command[command.index("--output") + 1])
        output.write_text(json.dumps([{"page": i} for i in range(1, len(pages) + 1)]))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(image_window.subprocess, "run", run)
    url = "/api/library/doc-1/images?page="
    assert test_client.get(url + "22&single=true").json()["images"] == [{"page": 22}]
    data = test_client.get(url + "22").json()
    assert data["images"] == [{"page": n} for n in range(7, 38)]
    assert test_client.get(url + "22").json() == data
    assert test_client.get(url + "24").json()["end"] == 39
    assert calls == [[22], [*range(7, 22), *range(23, 38)], [38, 39]]


def test_resolve_figure_uses_caption_not_body_reference(test_client, isolated_dirs, tmp_path, monkeypatch):
    import fitz
    from services import image_window

    _create_doc(isolated_dirs)
    path = tmp_path / "book.pdf"
    with fitz.open() as pdf:
        for line in ("See Fig 1-2 below.", "Figure 1: Other", "Fig 1-2: Target"):
            pdf.new_page().insert_text((60, 100), line)
        pdf.save(path)
    monkeypatch.setattr("routers.library.get_pdf_path", lambda _: str(path))
    monkeypatch.setattr(image_window, "CACHE_DIR", str(tmp_path))
    parsed = []

    def load_page(doc_id, doc, pdf_path, page, *, single):
        assert single
        parsed.append(page)
        return {"images": [{"page": page, "label": "Figure 1-2"}]}

    monkeypatch.setattr(image_window, "load_image_window", load_page)
    url = "/api/library/doc-1/figure-reference"
    response = test_client.get(url, params={"label": "Figure 1-2", "page": 1})
    assert response.json() == {"image": {"label": "Figure 1-2", "page": 3}}
    absent = test_client.get(url, params={"label": "Figure 1-3", "page": 1})
    assert absent.json() == {"image": None}
    assert parsed == [3]

    monkeypatch.setattr(image_window, "get_cached_pages", lambda *args: [
        {"page_num": 2, "text": "그림 A‑3: OCR caption"}])
    def load_ocr_page(doc_id, doc, pdf_path, page, *, single):
        assert single and page == 2
        return {"images": [{"page": page, "label": "Figure A-3"}]}
    monkeypatch.setattr(image_window, "load_image_window", load_ocr_page)
    response = test_client.get(url, params={"label": "Figure A-3", "page": 1})
    assert response.json()["image"] == {"page": 2, "label": "Figure A-3"}


def test_heavy_engine_window_returns_provisional_and_preempts_older_job(
    test_client, isolated_dirs, tmp_path, monkeypatch
):
    """marker/mineru 윈도우 요청 시:
    1) 정밀 캐시가 없으면 PyMuPDF 기반 provisional 결과를 블로킹 없이 즉시 반환하고
    2) 새로운 페이지 윈도우 요청이 들어오면 이전 윈도우 백그라운드 프로세스를 즉시 중지(terminate) 및
       큐에서 제거하고 최신 윈도우만 처리한 뒤 종료해야 한다."""
    import json
    from pathlib import Path
    import threading
    import fitz
    from services import image_window

    db = isolated_dirs["db"]
    db.db_save_document(
        "doc-heavy", "testuser", "textbook.pdf", "/x/textbook.pdf", 60,
        {"title": "Textbook"}, parser_engine="marker", parser_version="marker-1.0",
    )
    pdf_path = tmp_path / "textbook.pdf"
    with fitz.open() as source:
        for n in range(1, 61):
            page = source.new_page()
            page.insert_text((20, 40), f"Page {n}")
            page.insert_text((60, 200), f"a + b = {n} (1)")
        source.save(pdf_path)

    monkeypatch.setattr("routers.library.get_pdf_path", lambda _: str(pdf_path))
    monkeypatch.setattr(image_window, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(
        image_window, "_worker_command",
        lambda engine, path, output: (["fake-worker", "--pdf", path, "--output", output], {}),
    )

    first_started = threading.Event()
    release_first = threading.Event()
    second_finished = threading.Event()
    spawned_procs = []

    class FakePopen:
        def __init__(self, command, **kwargs):
            self.command = command
            self.pdf_arg = command[command.index("--pdf") + 1]
            self.output_arg = command[command.index("--output") + 1]
            with fitz.open(self.pdf_arg) as subset:
                self.pages = [int(p.get_text().splitlines()[0].split()[-1]) for p in subset]
            self.terminated = False
            self.returncode = None
            spawned_procs.append(self)

        def poll(self):
            return self.returncode

        def terminate(self):
            self.terminated = True
            self.returncode = -15
            release_first.set()

        def kill(self):
            self.terminated = True
            self.returncode = -9
            release_first.set()

        def wait(self, timeout=None):
            return self.returncode

        def communicate(self, timeout=None):
            if 10 in self.pages:
                first_started.set()
                release_first.wait(timeout=5)
                if self.terminated:
                    return b"", b"terminated"
            Path(self.output_arg).write_text(json.dumps([
                {"page": idx + 1, "left": 5, "top": 5, "width": 50, "height": 50, "label": f"Precise {p}"}
                for idx, p in enumerate(self.pages)
            ]))
            self.returncode = 0
            if 40 in self.pages:
                second_finished.set()
            return b"", b""

    monkeypatch.setattr(image_window.subprocess, "Popen", FakePopen)

    try:
        # 1) 10페이지 single=true 후 single=false 연속 요청 -> 동일 워커 재사용(중복 재시작 없음) 및 즉시 provisional 반환
        res1_single = test_client.get("/api/library/doc-heavy/images?page=10&single=true").json()
        assert res1_single["provisional"] is True
        assert res1_single["start"] == 10 and res1_single["end"] == 10
        assert res1_single["extraction_status"]["state"] == "running"
        assert 6 <= res1_single["extraction_status"]["page"] <= 14
        assert 10 <= res1_single["extraction_status"]["percent"] < 100
        assert first_started.wait(timeout=3), "첫 번째 백그라운드 워커가 시작되어야 함"

        res1 = test_client.get("/api/library/doc-heavy/images?page=10").json()
        assert res1["provisional"] is True
        assert res1["start"] == 6 and res1["end"] == 14
        assert len(spawned_procs) == 1, "single=true 직후 single=false 요청은 기존 워커를 죽이지 않고 재사용해야 함"
        assert any(img["page"] == 10 for img in res1["images"])

        # 2) 첫 번째 워커가 아직 돌고 있을 때 40페이지로 스크롤 이동 -> 이전 워커 즉시 중지 & 큐에서 교체
        res2 = test_client.get("/api/library/doc-heavy/images?page=40").json()
        assert res2["provisional"] is True
        assert res2["start"] == 36 and res2["end"] == 44
        assert res2["extraction_status"]["preempted"] is True
        assert 6 <= res2["extraction_status"]["stopped_page"] <= 14
        assert spawned_procs[0].terminated is True, "이전 페이지 윈도우 프로세스는 즉시 중지되어야 함"

        # 3) 최신(40페이지) 윈도우 백그라운드 정밀 추출 완료 대기 후 재조회 -> 정밀 결과 핫스왑 확인
        assert second_finished.wait(timeout=3)
        for proc_job in list(image_window._active_window_jobs.values()):
            if proc_job.thread:
                proc_job.thread.join(timeout=2)

        res3 = test_client.get("/api/library/doc-heavy/images?page=40").json()
        assert res3.get("provisional") is not True
        assert any(img.get("label") == "Precise 40" for img in res3["images"])
        assert "doc-heavy" not in image_window._active_window_jobs, "완료 후 큐에서 제거되어야 함"
    finally:
        release_first.set()
        image_window.cancel_window_jobs()


def test_heavy_engine_worker_failure_stops_provisional_polling(
    test_client, isolated_dirs, tmp_path, monkeypatch
):
    """백그라운드 정밀 워커가 실패(returncode != 0)하면 무한 재시도/무한 폴링을 막기 위해
    다음 요청부터 provisional=False로 PyMuPDF 폴백 좌표를 확정 반환해야 한다."""
    import fitz
    from services import image_window

    db = isolated_dirs["db"]
    db.db_save_document(
        "doc-fail", "testuser", "fail.pdf", "/x/fail.pdf", 20,
        {"title": "Fail"}, parser_engine="mineru", parser_version="mineru-1.0",
    )
    pdf_path = tmp_path / "fail.pdf"
    with fitz.open() as source:
        for n in range(1, 21):
            source.new_page().insert_text((20, 40), f"Page {n}")
        source.save(pdf_path)

    monkeypatch.setattr("routers.library.get_pdf_path", lambda _: str(pdf_path))
    monkeypatch.setattr(image_window, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(
        image_window, "_worker_command",
        lambda engine, path, output: (["fake-worker", "--pdf", path, "--output", output], {}),
    )
    spawn_count = 0

    class FailingPopen:
        def __init__(self, command, **kwargs):
            nonlocal spawn_count
            spawn_count += 1
            self.returncode = 1

        def poll(self):
            return self.returncode

        def communicate(self, timeout=None):
            return b"", b"mineru runtime error"

    monkeypatch.setattr(image_window.subprocess, "Popen", FailingPopen)
    try:
        res1 = test_client.get("/api/library/doc-fail/images?page=5").json()
        assert res1["provisional"] is True
        for proc_job in list(image_window._active_window_jobs.values()):
            if proc_job.thread:
                proc_job.thread.join(timeout=2)

        res2 = test_client.get("/api/library/doc-fail/images?page=5").json()
        assert res2["provisional"] is False
        assert res2["extraction_status"]["state"] == "error"
        assert spawn_count == 1
    finally:
        image_window.cancel_window_jobs()



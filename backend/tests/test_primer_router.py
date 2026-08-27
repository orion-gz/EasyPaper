"""GET /library/{doc_id}/primer 라우터의 pending 응답/중복 생성 방지 테스트.

계보/실험 흐름/용어집까지 만드는 지금의 프롬프트는 로컬 LLM 기준 수 분씩 걸릴
수 있어, 이 엔드포인트가 생성이 끝날 때까지 요청을 블로킹하면 리버스 프록시의
기본 read timeout(보통 60초)에 걸려 끊긴다(실측으로 재현). 그래서 캐시가 없으면
즉시 {"status": "pending"}을 반환하고 실제 생성은 백그라운드 태스크로 돌리도록
바꿨다 - 이 동작만 검증한다(실제 생성 내용 파싱은 test_generate_reading_primer.py,
test_primer.py에서 이미 다룬다).
"""

import asyncio
import time

import pytest

import routers.primer as primer_router


def _create_doc_owned_by(isolated_dirs, doc_id, username):
    db = isolated_dirs["db"]
    db.db_save_document(doc_id, username, "paper.pdf", "/x/paper.pdf", 3, {"title": "My Paper"})


@pytest.fixture()
def fake_generation(monkeypatch):
    """require_session_owner/generate_primer를 대체해 실제 PDF/LLM 없이
    라우터의 pending·중복 방지 로직만 검증한다."""
    calls = {"count": 0}

    def fake_require_session_owner(doc_id, current_user):
        return {"pages": [], "metadata": {"title": "My Paper"}, "pdf_path": "/x/paper.pdf", "source_language": "auto", "detected_source_language": "en"}

    async def fake_generate_primer(doc_id, pages, metadata, username, pdf_path, target_lang, session_id, source_lang="auto"):
        calls["count"] += 1
        await asyncio.sleep(2)  # 두 번째 요청이 들어올 때까지 완료되지 않게 함
        return {"hook": "done"}

    monkeypatch.setattr(primer_router, "require_session_owner", fake_require_session_owner)
    monkeypatch.setattr(primer_router, "generate_primer", fake_generate_primer)
    primer_router._pending_generations.clear()
    primer_router._last_failure_at.clear()
    return calls


def test_returns_cached_content_immediately_without_pending(test_client, isolated_dirs, fake_generation):
    _create_doc_owned_by(isolated_dirs, "doc-cached", "testuser")
    isolated_dirs["library"].save_page_insight(
        "doc-cached", 0, "primer_v2", '{"hook": "cached hook"}', suffix="document-insights-v1:en:ko"
    )
    res = test_client.get("/api/library/doc-cached/primer")
    assert res.status_code == 200
    assert res.json() == {"hook": "cached hook"}
    assert fake_generation["count"] == 0


def test_returns_pending_immediately_when_not_cached(test_client, isolated_dirs, fake_generation):
    _create_doc_owned_by(isolated_dirs, "doc-pending", "testuser")
    res = test_client.get("/api/library/doc-pending/primer")
    assert res.status_code == 200
    assert res.json() == {"status": "pending"}
    assert fake_generation["count"] == 1


def test_does_not_start_duplicate_generation_while_one_is_in_flight(test_client, isolated_dirs, fake_generation):
    _create_doc_owned_by(isolated_dirs, "doc-dup", "testuser")
    res1 = test_client.get("/api/library/doc-dup/primer")
    res2 = test_client.get("/api/library/doc-dup/primer")
    assert res1.json() == {"status": "pending"}
    assert res2.json() == {"status": "pending"}
    assert fake_generation["count"] == 1


def test_regenerate_clears_cache_and_starts_new_generation(test_client, isolated_dirs, fake_generation):
    _create_doc_owned_by(isolated_dirs, "doc-regen", "testuser")
    isolated_dirs["library"].save_page_insight(
        "doc-regen", 0, "primer_v2", '{"hook": "stale hook"}', suffix="한국어"
    )

    res = test_client.post("/api/library/doc-regen/primer/regenerate")
    assert res.status_code == 200
    assert res.json() == {"status": "pending"}
    assert fake_generation["count"] == 1

    # 재생성이 아직 안 끝난 시점에 GET을 호출하면 지워진 캐시 덕분에 낡은
    # 내용을 바로 돌려주지 않고 pending을 반환해야 한다(중복 생성도 없어야 함).
    res_get = test_client.get("/api/library/doc-regen/primer")
    assert res_get.json() == {"status": "pending"}
    assert fake_generation["count"] == 1


def test_regenerate_does_not_duplicate_when_already_in_flight(test_client, isolated_dirs, fake_generation):
    _create_doc_owned_by(isolated_dirs, "doc-regen-dup", "testuser")
    test_client.get("/api/library/doc-regen-dup/primer")
    res = test_client.post("/api/library/doc-regen-dup/primer/regenerate")
    assert res.json() == {"status": "pending"}
    assert fake_generation["count"] == 1


def test_does_not_restart_generation_within_cooldown_after_a_recent_failure():
    """generate_primer가 (설정 오류 등으로) 거의 즉시 실패하는 경우, 쿨다운 없이
    다음 폴링(3초 간격)마다 곧바로 재시도하면 CLI 서브프로세스를 계속 새로
    띄우게 되어 백엔드 CPU를 독점하는 장애로 이어졌다(실제로 재현됨). 최근 실패
    기록이 쿨다운 이내면 새 생성을 시작하지 않아야 한다."""
    task_key = "doc-cooldown:en:ko"
    primer_router._pending_generations.clear()
    primer_router._last_failure_at.clear()
    primer_router._last_failure_at[task_key] = time.monotonic()

    primer_router._ensure_generation_started(
        "doc-cooldown", "ko", "en", {"pages": [], "metadata": {}, "pdf_path": "/x"}, "testuser"
    )

    assert task_key not in primer_router._pending_generations


def test_rejects_invalid_target(test_client, monkeypatch):
    monkeypatch.setattr(primer_router, "require_session_owner", lambda *_: {
        "pages": [], "metadata": {}, "pdf_path": "/x",
        "source_language": "auto", "detected_source_language": "und",
    })
    invalid = test_client.get("/api/library/doc/primer?target_lang=xx")
    assert invalid.status_code == 400
    assert invalid.json()["code"] == "unsupported_target_language"


@pytest.mark.parametrize("detected", ["und", "mul"])
def test_returns_cached_primer_for_unresolved_or_mixed_source(
    test_client, isolated_dirs, monkeypatch, detected,
):
    monkeypatch.setattr(primer_router, "require_session_owner", lambda *_: {
        "pages": [], "metadata": {}, "pdf_path": "/x",
        "source_language": "auto", "detected_source_language": detected,
    })
    isolated_dirs["library"].save_page_insight(
        "doc-special-source", 0, "primer_v2", '{"hook": "cached hook"}',
        suffix=f"document-insights-v1:{detected}:fr",
    )

    response = test_client.get(
        "/api/library/doc-special-source/primer?target_lang=fr"
    )

    assert response.status_code == 200
    assert response.json() == {"hook": "cached hook"}

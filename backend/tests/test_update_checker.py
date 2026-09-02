"""services/update_checker.py 테스트.

실제 git 저장소(읽기 전용 명령만 사용: rev-parse/log/fetch)를 대상으로 동작을
확인한다 - fetch는 원격에서 받아오기만 하고 로컬 브랜치를 바꾸지 않으므로
테스트 실행 중에도 안전하다.
"""

import pytest

from services.update_checker import (
    get_current_version,
    get_current_version_date,
    check_for_update,
    get_update_check_config,
    set_update_check_interval,
    get_post_update_notice,
    _get_changelog,
    get_repository_changelog_markdown,
    VALID_INTERVALS,
)


@pytest.mark.asyncio
async def test_get_current_version_returns_short_sha():
    version = await get_current_version()
    assert version != "unknown"
    assert len(version) >= 7  # git 짧은 해시는 보통 7자 이상


@pytest.mark.asyncio
async def test_get_current_version_is_cached(monkeypatch):
    first = await get_current_version()
    # 캐시되어 있으므로, git 명령이 실패하도록 망가뜨려도 캐시된 값을 그대로 반환해야 한다
    import services.update_checker as uc
    monkeypatch.setattr(uc, "_run_git", None)  # 호출되면 TypeError로 즉시 드러남
    second = await get_current_version()
    assert second == first


@pytest.mark.asyncio
async def test_get_current_version_date_returns_iso_date():
    date = await get_current_version_date()
    assert date is not None
    assert len(date) == 10 and date[4] == "-" and date[7] == "-"  # YYYY-MM-DD


@pytest.mark.asyncio
async def test_check_for_update_reports_no_update_when_up_to_date(monkeypatch):
    import services.update_checker as uc

    async def fake_run_git(*args, timeout=30.0):
        if args[0] == "fetch":
            return 0, "", ""
        if args == ("rev-parse", "--short", "origin/main"):
            return 0, await get_current_version(), ""
        if args[0] == "log" and args[1] == "-1":
            return 0, "2026-01-01", ""
        return 0, "", ""

    monkeypatch.setattr(uc, "_run_git", fake_run_git)
    monkeypatch.setattr(uc, "db_set_meta", lambda k, v: None)

    result = await check_for_update()
    assert result["ok"] is True
    assert result["update_available"] is False
    assert result["changelog"] == []


@pytest.mark.asyncio
async def test_check_for_update_reports_available_with_changelog(monkeypatch):
    import services.update_checker as uc
    current = await get_current_version()

    async def fake_run_git(*args, timeout=30.0):
        if args[0] == "fetch":
            return 0, "", ""
        if args == ("rev-parse", "--short", "origin/main"):
            return 0, "def5678", ""
        if args[0] == "log" and args[1] == "-1":
            return 0, "2026-07-21", ""
        if args[0] == "log" and "--no-merges" in args:
            return 0, "aaa1111|feat: something new\nbbb2222|fix: a bug", ""
        return 0, "", ""

    monkeypatch.setattr(uc, "_run_git", fake_run_git)
    monkeypatch.setattr(uc, "db_set_meta", lambda k, v: None)

    result = await check_for_update()
    assert result["ok"] is True
    assert result["update_available"] is True
    assert result["latest_version"] == "def5678"
    assert result["current_version"] == current
    # _get_changelog는 오래된 순으로 반환해야 한다 (log는 최신이 먼저 나오므로 뒤집힘)
    assert result["changelog"][0]["subject"] == "fix: a bug"
    assert result["changelog"][1]["subject"] == "feat: something new"


@pytest.mark.asyncio
async def test_check_for_update_handles_fetch_failure_gracefully(monkeypatch):
    import services.update_checker as uc

    async def failing_fetch(*args, timeout=30.0):
        return 1, "", "네트워크 연결 실패"

    monkeypatch.setattr(uc, "_run_git", failing_fetch)

    result = await check_for_update()
    assert result["ok"] is False
    assert result["update_available"] is False
    assert "error" in result


@pytest.mark.asyncio
async def test_repository_changelog_markdown_groups_commits_by_date(monkeypatch):
    import services.update_checker as uc

    async def fake_run_git(*args, timeout=30.0):
        assert args[-1] == "HEAD"
        return 0, (
            "2026-09-02\x1fbbb2222\x1ffix: latest change\n"
            "2026-09-01\x1faaa1111\x1ffeat: earlier change"
        ), ""

    monkeypatch.setattr(uc, "_run_git", fake_run_git)
    content = await get_repository_changelog_markdown()

    assert "## 2026-09-02" in content
    assert "- fix: latest change (`bbb2222`)" in content
    assert "## 2026-09-01" in content
    assert content.index("2026-09-02") < content.index("2026-09-01")


@pytest.mark.asyncio
async def test_repository_changelog_markdown_returns_none_without_git(monkeypatch):
    import services.update_checker as uc

    async def fake_run_git(*args, timeout=30.0):
        return 1, "", "not a git repository"

    monkeypatch.setattr(uc, "_run_git", fake_run_git)
    assert await get_repository_changelog_markdown() is None


@pytest.mark.asyncio
async def test_get_changelog_excludes_merge_commits(monkeypatch):
    import services.update_checker as uc

    async def fake_run_git(*args, timeout=30.0):
        assert "--no-merges" in args
        return 0, "aaa|feat: real change", ""

    monkeypatch.setattr(uc, "_run_git", fake_run_git)
    entries = await _get_changelog("abc1234", "HEAD")
    assert entries == [{"sha": "aaa", "subject": "feat: real change"}]


def test_update_check_config_default_and_validation(isolated_dirs):
    cfg = get_update_check_config()
    assert cfg["interval"] == "weekly"
    assert cfg["last_checked_at"] is None

    updated = set_update_check_interval("daily")
    assert updated["interval"] == "daily"
    assert get_update_check_config()["interval"] == "daily"

    with pytest.raises(ValueError):
        set_update_check_interval("hourly")

    assert set(VALID_INTERVALS) == {"daily", "weekly", "never"}


@pytest.mark.asyncio
async def test_post_update_notice_bootstraps_silently_on_first_run(isolated_dirs):
    """안내 기록이 아예 없는 최초 실행에서는, "방금 설치한 것"을 업데이트로
    오인해 팝업을 띄우면 안 된다 - 기준값만 저장하고 조용히 넘어가야 한다."""
    notice = await get_post_update_notice()
    assert notice["show"] is False

    # 같은 버전으로 다시 확인해도 여전히 안 떠야 한다
    notice2 = await get_post_update_notice()
    assert notice2["show"] is False


@pytest.mark.asyncio
async def test_post_update_notice_shows_once_after_version_change(isolated_dirs, monkeypatch):
    import services.update_checker as uc

    # 최초 부팅으로 기준값(old-version) 저장
    monkeypatch.setattr(uc, "get_current_version", lambda: _async_return("old-version"))
    monkeypatch.setattr(uc, "get_current_version_date", lambda: _async_return("2026-01-01"))
    first = await get_post_update_notice()
    assert first["show"] is False

    # 버전이 바뀐 뒤(=업데이트 적용되어 재시작됨) 첫 확인 -> 딱 1번 show=True
    monkeypatch.setattr(uc, "get_current_version", lambda: _async_return("new-version"))
    monkeypatch.setattr(uc, "get_current_version_date", lambda: _async_return("2026-07-21"))
    monkeypatch.setattr(uc, "_get_changelog", lambda a, b: _async_return([{"sha": "x", "subject": "fix: something"}]))

    second = await get_post_update_notice()
    assert second["show"] is True
    assert second["version"] == "new-version"
    assert len(second["changelog"]) == 1

    # 같은 버전으로 다시 확인하면 더 이상 뜨면 안 된다 (1회 한정)
    third = await get_post_update_notice()
    assert third["show"] is False


async def _async_return(value):
    return value

"""GET /settings/changelog 테스트 - 자동 Git 이력과 패키지 fallback을 확인."""

import sys
from unittest.mock import AsyncMock, patch


def test_get_changelog_returns_actual_file_content(test_client):
    res = test_client.get("/api/settings/changelog")
    assert res.status_code == 200
    body = res.json()
    assert "# Changelog" in body["content"]
    assert "## " in body["content"]  # 날짜별 섹션 헤더가 하나 이상 있어야 한다


def test_get_changelog_returns_empty_string_when_file_missing(test_client, tmp_path):
    with (
        patch("routers.auth.get_project_root", return_value=str(tmp_path)),
        patch("services.update_checker.get_repository_changelog_markdown", new=AsyncMock(return_value=None)),
    ):
        res = test_client.get("/api/settings/changelog")
    assert res.status_code == 200
    assert res.json()["content"] == ""


def test_get_changelog_uses_pyinstaller_bundle_path(test_client, tmp_path):
    bundled_changelog = tmp_path / "CHANGELOG.md"
    bundled_changelog.write_text("# Changelog\n\n## Desktop release", encoding="utf-8")

    with (
        patch("routers.auth.get_project_root", return_value=str(tmp_path / "missing")),
        patch.object(sys, "frozen", True, create=True),
        patch.object(sys, "_MEIPASS", str(tmp_path), create=True),
        patch("services.update_checker.get_repository_changelog_markdown", new=AsyncMock(return_value=None)),
    ):
        res = test_client.get("/api/settings/changelog")

    assert res.status_code == 200
    assert res.json()["content"] == "# Changelog\n\n## Desktop release"

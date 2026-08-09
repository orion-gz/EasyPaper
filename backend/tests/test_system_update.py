"""POST /settings/update의 프로젝트 루트 경로 계산 회귀 테스트.

routers/auth.py의 system_update()가 project_dir을
os.path.join(os.path.dirname(__file__), "..")로 직접 계산했었는데, 이
파일(routers/auth.py)이 backend/ 밑 한 단계 더 깊은 routers/ 안에 있다는
걸 놓쳐 실제로는 backend/ 자체를 project_dir로 착각하는 버그가 있었다.
그 결과:
  - frontend_dir이 backend/frontend로 계산되어 존재하지 않으니 프론트엔드
    빌드가 조용히 스킵됨 (index.html은 git pull로 갱신되지만 dist/assets는
    재빌드되지 않아 자산 해시가 어긋나 화면이 깨짐)
  - _restart_server_process에도 같은 project_dir이 전달되어 backend_dir이
    backend/backend로 계산되고, 재시작이 "No such file or directory"로 실패

config.py의 검증된 get_project_root()를 재사용하도록 고쳤으므로, git
pull/npm build가 실제로 올바른 디렉터리를 cwd로 쓰는지 확인한다. 실제
git/npm 명령은 전부 모킹해 테스트 중 진짜 pull/build가 일어나지 않는다.
"""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import config
import pytest


@pytest.fixture(autouse=True)
def configured_admin_matches_test_user(monkeypatch):
    monkeypatch.setattr("services.auth.get_app_username", lambda: "testuser")


def _make_subprocess_mock(returncode=0, stdout=b"", stderr=b""):
    proc = MagicMock()
    proc.returncode = returncode
    proc.communicate = AsyncMock(return_value=(stdout, stderr))
    return proc


def test_system_update_runs_git_pull_in_actual_project_root(test_client):
    calls = []

    async def fake_create_subprocess_exec(*args, **kwargs):
        calls.append({"args": args, "cwd": kwargs.get("cwd")})
        return _make_subprocess_mock(returncode=0, stdout=b"Already up to date.\n")

    with patch("asyncio.create_subprocess_exec", new=fake_create_subprocess_exec), \
         patch("routers.auth._restart_server_process", new=AsyncMock()):
        res = test_client.post("/api/settings/update")

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True

    git_call = next(c for c in calls if c["args"][0] == "git")
    assert git_call["cwd"] == config.get_project_root()
    # 회귀 확인: cwd가 backend/backend나 backend/frontend처럼 backend가 중첩되면 안 된다
    assert not git_call["cwd"].rstrip(os.sep).endswith(f"backend{os.sep}backend")


def test_system_update_rejects_non_admin_user(test_client, monkeypatch):
    monkeypatch.setattr("services.auth.get_app_username", lambda: "admin")
    with patch("asyncio.create_subprocess_exec", new=AsyncMock()) as subprocess_mock:
        res = test_client.post("/api/settings/update")
    assert res.status_code == 403
    assert res.json()["detail"] == "관리자 권한이 필요합니다."
    subprocess_mock.assert_not_awaited()


def test_system_update_builds_frontend_in_actual_frontend_dir_when_pull_has_changes(test_client):
    calls = []

    async def fake_create_subprocess_exec(*args, **kwargs):
        calls.append({"args": args, "cwd": kwargs.get("cwd")})
        if args[0] == "git":
            return _make_subprocess_mock(returncode=0, stdout=b"Updating abc123..def456\n")
        return _make_subprocess_mock(returncode=0, stdout=b"build ok\n")

    with patch("asyncio.create_subprocess_exec", new=fake_create_subprocess_exec), \
         patch("routers.auth._restart_server_process", new=AsyncMock()):
        res = test_client.post("/api/settings/update")

    assert res.status_code == 200
    assert res.json()["ok"] is True

    npm_call = next(c for c in calls if "npm" in c["args"][0] or (len(c["args"]) > 0 and "npm" in str(c["args"])))
    expected_frontend_dir = os.path.join(config.get_project_root(), "frontend")
    assert npm_call["cwd"] == expected_frontend_dir
    assert os.path.isdir(expected_frontend_dir), "frontend_dir 계산이 맞다면 실제로 존재하는 디렉터리여야 한다"


def test_restart_server_process_computes_correct_backend_dir(monkeypatch):
    """_restart_server_process가 올바른 project_dir을 받으면, 새 프로세스를
    backend/backend가 아니라 backend/에서 띄운다."""
    from routers.auth import _restart_server_process

    monkeypatch.setattr("platform.system", lambda: "Darwin")  # systemd 분기 건너뛰기

    captured = {}

    def fake_popen(args, **kwargs):
        captured["args"] = args
        captured["cwd"] = kwargs.get("cwd")
        return MagicMock()

    with patch("subprocess.Popen", side_effect=fake_popen), \
         patch("os._exit", side_effect=lambda code: None):
        import asyncio
        asyncio.run(_restart_server_process(config.get_project_root()))

    assert captured["cwd"] == os.path.join(config.get_project_root(), "backend")
    assert os.path.isdir(captured["cwd"])

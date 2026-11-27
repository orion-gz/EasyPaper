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
    from main import app
    from services.auth import require_admin_user
    app.dependency_overrides.pop(require_admin_user, None)
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


def test_get_npm_exec_env_discovers_nvm_npm_and_injects_path(tmp_path, monkeypatch):
    """systemd 서비스처럼 PATH에 /usr/bin:/bin만 있는 환경에서도 ~/.nvm 하위의
    최신 node/npm을 찾아 PATH 맨 앞에 주입해야 한다."""
    nvm_v18 = tmp_path / ".nvm" / "versions" / "node" / "v18.20.0" / "bin"
    nvm_v25 = tmp_path / ".nvm" / "versions" / "node" / "v25.9.0" / "bin"
    for bdir in (nvm_v18, nvm_v25):
        bdir.mkdir(parents=True)
        for tool in ("node", "npm"):
            exe = bdir / tool
            exe.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            exe.chmod(0o755)

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("NVM_DIR", str(tmp_path / ".nvm"))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.delenv("NPM_PATH", raising=False)
    monkeypatch.setattr("platform.system", lambda: "Linux")

    npm_bin, env = config.get_npm_exec_env()
    assert npm_bin == str(nvm_v25 / "npm")
    assert env["PATH"].split(os.pathsep)[0] == str(nvm_v25)


def test_system_update_rolls_back_git_when_npm_missing_and_retries_cleanly(test_client, tmp_path, monkeypatch):
    """1차 실행에서 git pull 후 npm 미탐색(FileNotFoundError)으로 실패하면 이전 HEAD로
    롤백되어야 하며, 이후 npm이 준비된 2차 실행에서 빌드가 정상 수행되어야 한다."""
    frontend_dir = tmp_path / "frontend"
    (frontend_dir / "node_modules").mkdir(parents=True)
    (frontend_dir / "package.json").write_text('{"name":"test"}', encoding="utf-8")
    dist_dir = frontend_dir / "dist"
    dist_dir.mkdir(parents=True)
    (dist_dir / "index.html").write_text("<html>old</html>", encoding="utf-8")

    monkeypatch.setattr("routers.auth.get_project_root", lambda: str(tmp_path))

    old_sha = "78299dec84d72a9f2d0b04eb42d213ef03a623d6"
    new_sha = "bd125aa011111111111111111111111111111111"
    state = {"head": old_sha, "npm_available": False}
    reset_targets = []
    build_runs = []

    async def fake_exec(*args, **kwargs):
        if args[0] == "git":
            if args[1] == "status":
                return _make_subprocess_mock(0, b"", b"")
            if args[1] == "rev-parse":
                return _make_subprocess_mock(0, f"{state['head']}\n".encode(), b"")
            if args[1] == "pull":
                if state["head"] == new_sha:
                    return _make_subprocess_mock(0, b"Already up to date.\n", b"")
                state["head"] = new_sha
                return _make_subprocess_mock(0, b"Updating 78299dec..bd125aa0\n", b"")
            if args[1] == "diff":
                return _make_subprocess_mock(0, b"frontend/src/main.js\n", b"")
            if args[1] == "reset" and args[2] == "--hard":
                reset_targets.append(args[3])
                state["head"] = args[3]
                return _make_subprocess_mock(0, b"", b"")
        if not state["npm_available"]:
            raise FileNotFoundError(2, "No such file or directory", "npm")
        build_runs.append({"args": args, "cwd": kwargs.get("cwd"), "env": kwargs.get("env")})
        return _make_subprocess_mock(0, b"built\n", b"")

    with patch("asyncio.create_subprocess_exec", new=fake_exec), \
         patch("routers.auth._restart_server_process", new=AsyncMock()):
        first = test_client.post("/api/settings/update").json()
        assert first["ok"] is False
        assert "npm" in first["message"]
        assert reset_targets == [old_sha]
        assert state["head"] == old_sha

        state["npm_available"] = True
        second = test_client.post("/api/settings/update").json()
        assert second["ok"] is True
        assert len(build_runs) == 1
        assert (dist_dir / ".build-commit").read_text(encoding="utf-8").strip() == new_sha


def test_system_update_rebuilds_when_already_up_to_date_but_dist_commit_stale(test_client, tmp_path, monkeypatch):
    """이미 git pull은 되어 'Already up to date'를 반환하더라도 dist/.build-commit이
    현재 HEAD와 다르면 프론트엔드 빌드를 건너뛰지 않고 수행해야 한다."""
    frontend_dir = tmp_path / "frontend"
    (frontend_dir / "node_modules").mkdir(parents=True)
    (frontend_dir / "package.json").write_text('{"name":"test"}', encoding="utf-8")
    dist_dir = frontend_dir / "dist"
    dist_dir.mkdir(parents=True)
    (dist_dir / "index.html").write_text("<html>stale</html>", encoding="utf-8")
    (dist_dir / ".build-commit").write_text("78299dec84d72a9f2d0b04eb42d213ef03a623d6\n", encoding="utf-8")

    monkeypatch.setattr("routers.auth.get_project_root", lambda: str(tmp_path))
    head_sha = "bd125aa011111111111111111111111111111111"
    npm_calls = []

    async def fake_exec(*args, **kwargs):
        if args[0] == "git":
            if args[1] == "status":
                return _make_subprocess_mock(0, b"", b"")
            if args[1] == "rev-parse":
                return _make_subprocess_mock(0, f"{head_sha}\n".encode(), b"")
            if args[1] == "pull":
                return _make_subprocess_mock(0, b"Already up to date.\n", b"")
        npm_calls.append(args)
        return _make_subprocess_mock(0, b"built\n", b"")

    with patch("asyncio.create_subprocess_exec", new=fake_exec), \
         patch("routers.auth._restart_server_process", new=AsyncMock()):
        res = test_client.post("/api/settings/update")

    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert any("build" in call for call in npm_calls)
    assert (dist_dir / ".build-commit").read_text(encoding="utf-8").strip() == head_sha


def test_system_update_installs_changed_backend_and_frontend_dependencies(test_client, tmp_path, monkeypatch):
    """requirements.txt와 package-lock.json이 변경된 업데이트면 pip install과
    npm install을 각각 수행한 뒤 npm run build를 실행해야 한다."""
    backend_dir = tmp_path / "backend"
    backend_dir.mkdir(parents=True)
    (backend_dir / "requirements.txt").write_text("fastapi\n", encoding="utf-8")

    frontend_dir = tmp_path / "frontend"
    (frontend_dir / "node_modules").mkdir(parents=True)
    (frontend_dir / "package.json").write_text('{"name":"test"}', encoding="utf-8")
    dist_dir = frontend_dir / "dist"
    dist_dir.mkdir(parents=True)
    (dist_dir / "index.html").write_text("<html>ok</html>", encoding="utf-8")

    monkeypatch.setattr("routers.auth.get_project_root", lambda: str(tmp_path))

    old_sha = "1111111111111111111111111111111111111111"
    new_sha = "2222222222222222222222222222222222222222"
    rev_calls = {"count": 0}
    executed = []

    async def fake_exec(*args, **kwargs):
        executed.append((args, kwargs.get("cwd")))
        if args[0] == "git":
            if args[1] == "status":
                return _make_subprocess_mock(0, b"", b"")
            if args[1] == "rev-parse":
                rev_calls["count"] += 1
                sha = old_sha if rev_calls["count"] == 1 else new_sha
                return _make_subprocess_mock(0, f"{sha}\n".encode(), b"")
            if args[1] == "pull":
                return _make_subprocess_mock(0, b"Updating 1111111..2222222\n", b"")
            if args[1] == "diff":
                return _make_subprocess_mock(0, b"backend/requirements.txt\nfrontend/package-lock.json\n", b"")
        return _make_subprocess_mock(0, b"ok\n", b"")

    with patch("asyncio.create_subprocess_exec", new=fake_exec), \
         patch("routers.auth._restart_server_process", new=AsyncMock()):
        res = test_client.post("/api/settings/update")

    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert any("pip" in args and cwd == str(backend_dir) for args, cwd in executed)
    assert any("install" in args and cwd == str(frontend_dir) for args, cwd in executed)
    assert any("build" in args and cwd == str(frontend_dir) for args, cwd in executed)


def test_restart_server_process_checks_systemctl_returncode_and_uses_non_interactive_sudo(monkeypatch):
    """systemd 환경에서 sudo -n systemctl restart가 실패(returncode != 0)하면
    조용히 무시하지 않고 대체 재시작으로 이어져야 한다."""
    from routers.auth import _restart_server_process

    monkeypatch.setattr("platform.system", lambda: "Linux")
    monkeypatch.setattr("routers.auth._is_running_under_systemd", lambda: True)
    monkeypatch.setattr("routers.auth._is_in_systemd_service_cgroup", lambda: True)
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/systemctl")

    recorded_args = []
    exit_codes = []

    async def fake_exec(*args, **kwargs):
        recorded_args.append(args)
        return _make_subprocess_mock(1, b"", b"sudo: a password is required")

    with patch("asyncio.create_subprocess_exec", new=fake_exec), \
         patch("os._exit", side_effect=lambda code: exit_codes.append(code)):
        import asyncio
        asyncio.run(_restart_server_process(config.get_project_root()))

    assert recorded_args[0] == ("sudo", "-n", "systemctl", "restart", "easypaper")
    assert exit_codes == [1]

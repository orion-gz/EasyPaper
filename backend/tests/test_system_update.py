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


def test_system_update_uses_npm_ci_with_lockfile_and_resets_dirty_lockfile(test_client, tmp_path, monkeypatch):
    """frontend/package-lock.json이 존재하면 npm ci를 쓰고, 과거 npm install로 인해
    package-lock.json만 단독 수정된 상태라면 git pull 전 자동 복원해야 한다."""
    frontend_dir = tmp_path / "frontend"
    (frontend_dir / "node_modules").mkdir(parents=True)
    (frontend_dir / "package.json").write_text('{"name":"test"}', encoding="utf-8")
    (frontend_dir / "package-lock.json").write_text('{"lockfileVersion":3}', encoding="utf-8")
    dist_dir = frontend_dir / "dist"
    dist_dir.mkdir(parents=True)
    (dist_dir / "index.html").write_text("<html>old</html>", encoding="utf-8")

    monkeypatch.setattr("routers.auth.get_project_root", lambda: str(tmp_path))

    old_sha = "1111111111111111111111111111111111111111"
    new_sha = "2222222222222222222222222222222222222222"
    rev_calls = {"count": 0}
    executed_args = []

    async def fake_exec(*args, **kwargs):
        executed_args.append(args)
        if args[0] == "git":
            if args[1] == "status":
                return _make_subprocess_mock(0, b" M frontend/package-lock.json\n", b"")
            if args[1] == "checkout":
                return _make_subprocess_mock(0, b"", b"")
            if args[1] == "rev-parse":
                rev_calls["count"] += 1
                sha = old_sha if rev_calls["count"] == 1 else new_sha
                return _make_subprocess_mock(0, f"{sha}\n".encode(), b"")
            if args[1] == "pull":
                return _make_subprocess_mock(0, b"Updating 111..222\n", b"")
            if args[1] == "diff":
                return _make_subprocess_mock(0, b"frontend/package-lock.json\n", b"")
        return _make_subprocess_mock(0, b"ok\n", b"")

    with patch("asyncio.create_subprocess_exec", new=fake_exec), \
         patch("routers.auth._restart_server_process", new=AsyncMock()):
        res = test_client.post("/api/settings/update")

    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert ("git", "checkout", "--", "frontend/package-lock.json") in executed_args
    assert any("ci" in call for call in executed_args)


def test_system_update_stages_build_atomically_preserving_dist_on_failure(test_client, tmp_path, monkeypatch):
    """스테이징 디렉터리(.dist-staging) 빌드가 실패하면 기존 dist/index.html이 절대
    삭제·훼손되지 않아야 하며, 성공 시에만 새 산출물과 .build-commit으로 교체된다."""
    frontend_dir = tmp_path / "frontend"
    (frontend_dir / "node_modules").mkdir(parents=True)
    (frontend_dir / "package.json").write_text('{"name":"test"}', encoding="utf-8")
    dist_dir = frontend_dir / "dist"
    (dist_dir / "assets").mkdir(parents=True)
    (dist_dir / "index.html").write_text("<html>working-old-ui</html>", encoding="utf-8")
    (dist_dir / "assets" / "app.js").write_text("console.log('old')", encoding="utf-8")

    monkeypatch.setattr("routers.auth.get_project_root", lambda: str(tmp_path))

    old_sha = "aaaaaaa111111111111111111111111111111111"
    new_sha = "bbbbbbb222222222222222222222222222222222"
    state = {"head": old_sha, "fail_build": True}

    async def fake_exec(*args, **kwargs):
        if args[0] == "git":
            if args[1] == "status":
                return _make_subprocess_mock(0, b"", b"")
            if args[1] == "rev-parse":
                return _make_subprocess_mock(0, f"{state['head']}\n".encode(), b"")
            if args[1] == "pull":
                state["head"] = new_sha
                return _make_subprocess_mock(0, b"Updating aaa..bbb\n", b"")
            if args[1] == "diff":
                return _make_subprocess_mock(0, b"frontend/src/main.js\n", b"")
            if args[1] == "reset":
                state["head"] = args[3]
                return _make_subprocess_mock(0, b"", b"")

        # vite build --outDir .dist-staging 시뮬레이션
        assert "--outDir" in args and ".dist-staging" in args
        staging = frontend_dir / ".dist-staging"
        staging.mkdir(parents=True, exist_ok=True)
        if state["fail_build"]:
            (staging / "partial.txt").write_text("broken", encoding="utf-8")
            return _make_subprocess_mock(1, b"", b"Build OOM error")

        (staging / "assets").mkdir(parents=True, exist_ok=True)
        (staging / "index.html").write_text("<html>new-ui</html>", encoding="utf-8")
        (staging / "assets" / "app-new.js").write_text("console.log('new')", encoding="utf-8")
        return _make_subprocess_mock(0, b"built\n", b"")

    with patch("asyncio.create_subprocess_exec", new=fake_exec), \
         patch("routers.auth._restart_server_process", new=AsyncMock()):
        failed = test_client.post("/api/settings/update").json()
        assert failed["ok"] is False
        assert (dist_dir / "index.html").read_text(encoding="utf-8") == "<html>working-old-ui</html>"
        assert (dist_dir / "assets" / "app.js").is_file()
        assert not (frontend_dir / ".dist-staging").exists()

        state["fail_build"] = False
        succeeded = test_client.post("/api/settings/update").json()
        assert succeeded["ok"] is True
        assert (dist_dir / "index.html").read_text(encoding="utf-8") == "<html>new-ui</html>"
        assert (dist_dir / "assets" / "app-new.js").is_file()
        assert (dist_dir / ".build-commit").read_text(encoding="utf-8").strip() == new_sha
        assert not (frontend_dir / ".dist-staging").exists()


def test_system_update_rejects_concurrent_duplicate_invocation(test_client, monkeypatch):
    """이미 업데이트가 진행 중일 때 중복 요청이 들어오면 즉시 in_progress 응답을 반환한다."""
    import routers.auth as auth_mod

    monkeypatch.setattr(auth_mod, "_system_update_in_progress", True)
    with patch("asyncio.create_subprocess_exec", new=AsyncMock()) as exec_mock:
        res = test_client.post("/api/settings/update")

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert body["in_progress"] is True
    exec_mock.assert_not_awaited()


def test_auth_check_and_update_status_expose_boot_id_and_git_support(test_client, tmp_path, monkeypatch):
    """/api/auth/check는 boot_id, is_admin, system_update_supported를 반환해 Docker/비관리자
    환경에서 프론트가 업데이트 UI를 안전하게 숨기고 재시작 완료를 정확히 판별하게 한다."""
    import routers.auth as auth_mod

    # .git이 없는 디렉터리(Docker/아카이브 배포 시뮬레이션)
    monkeypatch.setattr(auth_mod, "get_project_root", lambda: str(tmp_path))
    check_no_git = test_client.get("/api/auth/check").json()
    assert check_no_git["is_admin"] is True
    assert check_no_git["system_update_supported"] is False
    assert check_no_git["boot_id"] == auth_mod.SERVER_BOOT_ID

    # .git이 존재하는 일반 Git 배포
    (tmp_path / ".git").mkdir()
    check_with_git = test_client.get("/api/auth/check").json()
    assert check_with_git["system_update_supported"] is True

    status_body = test_client.get("/api/settings/update-status").json()
    assert status_body["boot_id"] == auth_mod.SERVER_BOOT_ID
    assert status_body["in_progress"] is False


def test_system_update_updates_both_default_venv_and_active_interpreter(test_client, tmp_path, monkeypatch):
    """MinerU(.venv-mineru) 등 별도 인터프리터로 실행 중일 때 requirements.txt가 바뀌면
    서비스 진입점인 기본 backend/.venv와 현재 sys.executable 모두에 pip install을 수행한다."""
    from venv_manager import venv_python

    backend_dir = tmp_path / "backend"
    backend_dir.mkdir(parents=True)
    (backend_dir / "requirements.txt").write_text("fastapi\n", encoding="utf-8")

    default_py = venv_python(str(backend_dir / ".venv"))
    os.makedirs(os.path.dirname(default_py), exist_ok=True)
    with open(default_py, "w", encoding="utf-8") as f:
        f.write("#!/bin/sh\n")

    active_py = str(tmp_path / ".venv-mineru" / "bin" / "python")
    os.makedirs(os.path.dirname(active_py), exist_ok=True)
    with open(active_py, "w", encoding="utf-8") as f:
        f.write("#!/bin/sh\n")

    monkeypatch.setattr("routers.auth.get_project_root", lambda: str(tmp_path))
    monkeypatch.setattr("sys.executable", active_py)

    old_sha = "1111111111111111111111111111111111111111"
    new_sha = "2222222222222222222222222222222222222222"
    rev_calls = {"count": 0}
    pip_interpreters = []

    async def fake_exec(*args, **kwargs):
        if args[0] == "git":
            if args[1] == "status":
                return _make_subprocess_mock(0, b"", b"")
            if args[1] == "rev-parse":
                rev_calls["count"] += 1
                sha = old_sha if rev_calls["count"] == 1 else new_sha
                return _make_subprocess_mock(0, f"{sha}\n".encode(), b"")
            if args[1] == "pull":
                return _make_subprocess_mock(0, b"Updating 111..222\n", b"")
            if args[1] == "diff":
                return _make_subprocess_mock(0, b"backend/requirements.txt\n", b"")
        if "pip" in args:
            pip_interpreters.append(args[0])
        return _make_subprocess_mock(0, b"ok\n", b"")

    with patch("asyncio.create_subprocess_exec", new=fake_exec), \
         patch("routers.auth._restart_server_process", new=AsyncMock()):
        res = test_client.post("/api/settings/update")

    assert res.json()["ok"] is True
    assert pip_interpreters == [default_py, active_py]

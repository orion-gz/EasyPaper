"""PDF parser package-management endpoints must require authentication."""

import pytest


@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        (
            "get",
            "/api/settings/install-pdf-parser",
            {"params": {"parser_id": "unsupported"}},
        ),
        (
            "post",
            "/api/settings/uninstall-pdf-parser",
            {"json": {"parser_id": "unsupported"}},
        ),
    ],
)
def test_pdf_parser_package_management_rejects_unauthenticated_requests(
    test_client, monkeypatch, method, path, kwargs
):
    """Authentication must run before parser validation or package operations."""
    from main import app
    import services.auth as auth_service

    app.dependency_overrides.pop(auth_service.get_current_user, None)
    monkeypatch.setattr(auth_service, "get_skip_login", lambda: False)

    response = getattr(test_client, method)(path, **kwargs)

    assert response.status_code == 401
    assert response.json() == {"detail": "로그인이 필요합니다."}



def test_packaged_desktop_install_uses_sidecar_pip_mode(test_client, monkeypatch):
    import asyncio
    import routers.auth as auth_router

    commands = []

    class FakeStdout:
        def __init__(self):
            self.lines = [b"Collecting marker-pdf\n", b""]

        async def readline(self):
            return self.lines.pop(0)

    class FakeProcess:
        def __init__(self):
            self.stdout = FakeStdout()
            self.returncode = 0

        async def wait(self):
            return self.returncode

    async def fake_create_subprocess_exec(*cmd, **_kwargs):
        commands.append(list(cmd))
        return FakeProcess()

    monkeypatch.setattr(
        auth_router.venv_manager, "is_packaged_desktop", lambda: True
    )
    monkeypatch.setattr(
        auth_router.venv_manager,
        "parser_install_command",
        lambda engine: ["easypaper-backend", "--easypaper-install-pdf-parser", engine],
    )
    monkeypatch.setattr(
        auth_router.venv_manager, "parser_packages_dir", lambda engine: f"/app-data/{engine}"
    )
    monkeypatch.setattr(
        auth_router.venv_manager, "is_parser_installed", lambda _engine: True
    )
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    response = test_client.get(
        "/api/settings/install-pdf-parser",
        params={"parser_id": "marker"},
    )

    assert response.status_code == 200
    assert commands == [[
        "easypaper-backend",
        "--easypaper-install-pdf-parser",
        "marker",
    ]]
    assert "-m venv" not in response.text
    assert '"status": "success"' in response.text


def test_packaged_desktop_engine_change_requests_app_relaunch(
    test_client, monkeypatch
):
    import routers.auth as auth_router

    monkeypatch.setattr(
        auth_router.venv_manager, "restart_required_for_engine", lambda _engine: True
    )
    monkeypatch.setattr(
        auth_router.venv_manager, "is_packaged_desktop", lambda: True
    )
    monkeypatch.setattr(auth_router, "update_system_settings", lambda **_kwargs: None)
    monkeypatch.setattr(
        auth_router, "update_translation_prompt_template", lambda _value: None
    )

    response = test_client.post(
        "/api/settings/system",
        json={
            "ollama_host": "http://localhost:11434",
            "trans_provider": "ollama",
            "trans_model": "model",
            "chat_provider": "ollama",
            "chat_model": "model",
            "pdf_parser_engine": "marker",
        },
    )

    assert response.status_code == 200
    assert response.json()["restarting"] is True
    assert response.json()["restart_mode"] == "desktop_app"



def test_server_mineru_uninstall_uses_distribution_name_without_extras(
    test_client, monkeypatch
):
    import subprocess
    import routers.auth as auth_router

    commands = []

    class Result:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(cmd, **_kwargs):
        commands.append(cmd)
        return Result()

    monkeypatch.setattr(
        auth_router.venv_manager, "is_packaged_desktop", lambda: False
    )
    monkeypatch.setattr(
        auth_router.venv_manager, "is_venv_available", lambda _path: True
    )
    monkeypatch.setattr(
        auth_router.venv_manager, "venv_python", lambda _path: "python"
    )
    monkeypatch.setattr(subprocess, "run", fake_run)

    response = test_client.post(
        "/api/settings/uninstall-pdf-parser",
        json={"parser_id": "mineru"},
    )

    assert response.status_code == 200
    assert commands == [["python", "-m", "pip", "uninstall", "-y", "mineru"]]

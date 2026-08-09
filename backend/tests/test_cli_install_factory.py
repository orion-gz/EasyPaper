import asyncio
import json
import os
import platform
import tempfile

import pytest

from routers import auth


class _FakeResponse:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def raise_for_status(self):
        return None

    async def aiter_bytes(self):
        yield b"@echo off\r\n"


class _FakeClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def stream(self, method, url):
        assert method == "GET"
        assert url.endswith("/install.cmd")
        return _FakeResponse()


class _FakeStdout:
    async def readline(self):
        return b""


class _FakeProcess:
    returncode = 1
    stdout = _FakeStdout()

    async def wait(self):
        return self.returncode


@pytest.mark.asyncio
async def test_antigravity_factory_downloads_executes_and_cleans_cmd(monkeypatch, tmp_path):
    exec_args = []

    async def fake_exec(*args, **_kwargs):
        exec_args.append(args)
        return _FakeProcess()

    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(auth.httpx, "AsyncClient", lambda **_kwargs: _FakeClient())
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(asyncio, "create_subprocess_shell", lambda *_args, **_kwargs: pytest.fail("shell execution"))

    endpoint = auth._make_native_cli_install_endpoint(
        "https://example.test/install.sh",
        "https://example.test/install.cmd",
        lambda: str(tmp_path / "agy.exe"),
        "already installed",
        windows_installer_filename="antigravity_install.cmd",
        path_aliases=("definitely-not-installed-agy",),
        exit_error_message="installer failed: {returncode}",
    )
    response = await endpoint(current_user="alice")
    chunks = [chunk async for chunk in response.body_iterator]

    events = [json.loads(chunk.removeprefix("data: ").strip()) for chunk in chunks]
    installer_path = str(tmp_path / "antigravity_install.cmd")
    assert [event["status"] for event in events] == ["progress", "progress", "error"]
    assert events[-1]["message"] == "installer failed: 1"
    assert len(exec_args) == 1
    assert installer_path in exec_args[0][-1]
    assert not os.path.exists(installer_path)

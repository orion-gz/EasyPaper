"""Claude Code 인증 환경과 세션 호출 순서의 회귀 테스트."""

import asyncio
import uuid

import pytest

import config
import services.llm_client as llm_client
from services.generation_errors import GenerationError


class FakeStdin:
    def write(self, data):
        pass

    async def drain(self):
        pass

    def close(self):
        pass


class FakeProcess:
    def __init__(self, returncode=0, chunks=None, stderr=b""):
        self.stdin = FakeStdin()
        self.returncode = returncode
        self.chunks = list(chunks or []) + [b""]
        self.stderr_bytes = stderr


@pytest.fixture()
def cli_env(tmp_path, monkeypatch):
    library_dir = tmp_path / "library"
    library_dir.mkdir()
    home_dir = tmp_path / "home"
    home_dir.mkdir()
    monkeypatch.setattr(config, "LIBRARY_DIR", str(library_dir))
    monkeypatch.setattr(llm_client, "get_project_root", lambda: str(tmp_path / "project"))
    monkeypatch.setattr(llm_client, "get_claude_code_path", lambda: "claude")
    monkeypatch.setattr(llm_client, "save_provider_session_meta", lambda *args, **kwargs: None)
    monkeypatch.setenv("HOME", str(home_dir))
    return {"library": library_dir, "home": home_dir, "root": tmp_path / "project"}


def install_fake_cli(monkeypatch, processes, read_chunk=None):
    calls = []

    async def create_process(*args, **kwargs):
        process = processes[len(calls)]
        calls.append({"args": args, "kwargs": kwargs, "process": process})
        return process

    async def read(process, label=None):
        if read_chunk is not None:
            return await read_chunk(process)
        return process.chunks.pop(0)

    async def wait(process, label=None):
        pass

    def start_stderr(process):
        async def drain():
            return process.stderr_bytes
        return asyncio.create_task(drain())

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_process)
    monkeypatch.setattr(llm_client, "_read_chunk_with_timeout", read)
    monkeypatch.setattr(llm_client, "_wait_with_timeout", wait)
    monkeypatch.setattr(llm_client, "_start_stderr_drain", start_stderr)
    return calls


def collect(session_id):
    async def run():
        return [part async for part in llm_client.stream_claude_code("hello", session_id=session_id)]
    return asyncio.run(run())


def test_claude_uses_existing_auth_home_and_document_cwd(cli_env, monkeypatch):
    calls = install_fake_cli(monkeypatch, [FakeProcess(chunks=[b"ok"])])
    session_id = str(uuid.uuid4())

    assert collect(session_id) == ["ok"]
    assert calls[0]["kwargs"]["env"]["HOME"] == str(cli_env["home"])
    assert calls[0]["kwargs"]["cwd"] == str(cli_env["library"] / session_id)
    assert calls[0]["args"][-2:] == ("--resume", session_id)
    assert not (cli_env["root"] / "cache").exists()


def test_different_documents_share_one_cli_slot(cli_env, monkeypatch):
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    first = FakeProcess(chunks=[b"first"])
    second = FakeProcess(chunks=[b"second"])

    async def read(process):
        if process is first and process.chunks[0] != b"":
            first_started.set()
            await release_first.wait()
        return process.chunks.pop(0)

    calls = install_fake_cli(monkeypatch, [first, second], read_chunk=read)

    async def scenario():
        async def run(session_id):
            return [part async for part in llm_client.stream_claude_code("hi", session_id=session_id)]

        first_task = asyncio.create_task(run(str(uuid.uuid4())))
        await first_started.wait()
        second_task = asyncio.create_task(run(str(uuid.uuid4())))
        await asyncio.sleep(0)
        assert len(calls) == 1
        release_first.set()
        assert await first_task == ["first"]
        assert await second_task == ["second"]

    asyncio.run(scenario())
    assert len(calls) == 2


def test_missing_session_creates_it_once(cli_env, monkeypatch):
    processes = [
        FakeProcess(returncode=1, stderr=b"No conversation found"),
        FakeProcess(chunks=[b"created"]),
    ]
    calls = install_fake_cli(monkeypatch, processes)
    session_id = str(uuid.uuid4())

    assert collect(session_id) == ["created"]
    assert calls[0]["args"][-2:] == ("--resume", session_id)
    assert calls[1]["args"][-2:] == ("--session-id", session_id)


def test_missing_session_reported_on_stdout_retries_without_streaming_error(cli_env, monkeypatch):
    processes = [
        FakeProcess(returncode=1, chunks=[b"No conversation found"]),
        FakeProcess(chunks=[b"created"]),
    ]
    calls = install_fake_cli(monkeypatch, processes)

    assert collect(str(uuid.uuid4())) == ["created"]
    assert len(calls) == 2


def test_login_failure_on_stdout_is_not_streamed(cli_env, monkeypatch):
    process = FakeProcess(returncode=1, chunks=[b"Not log", b"ged in - Please run /login"])
    install_fake_cli(monkeypatch, [process])
    yielded = []

    async def run():
        async for part in llm_client.stream_claude_code("hi", session_id=str(uuid.uuid4())):
            yielded.append(part)

    with pytest.raises(GenerationError) as exc_info:
        asyncio.run(run())
    assert exc_info.value.document_task_error_code == "authentication_failed"
    assert yielded == []


def test_successful_answer_starting_with_control_text_is_returned(cli_env, monkeypatch):
    process = FakeProcess(chunks=[b"Not logged in users can still read this."])
    install_fake_cli(monkeypatch, [process])

    assert collect(str(uuid.uuid4())) == ["Not logged in users can still read this."]


def test_cancelled_stream_reaps_process_before_next_call(cli_env, monkeypatch):
    first = FakeProcess(returncode=None)
    second = FakeProcess(chunks=[b"next"])
    first_reading = asyncio.Event()
    killed = asyncio.Event()
    allow_wait = asyncio.Event()

    async def read(process):
        if process is first:
            first_reading.set()
            await asyncio.Event().wait()
        return process.chunks.pop(0)

    async def wait_for_exit():
        await allow_wait.wait()
        return first.returncode

    def kill():
        first.returncode = -9
        killed.set()

    first.kill = kill
    first.wait = wait_for_exit
    calls = install_fake_cli(monkeypatch, [first, second], read_chunk=read)

    async def scenario():
        async def run(session_id):
            return [part async for part in llm_client.stream_claude_code("hi", session_id=session_id)]

        first_task = asyncio.create_task(run(str(uuid.uuid4())))
        await first_reading.wait()
        next_task = asyncio.create_task(run(str(uuid.uuid4())))
        first_task.cancel()
        await killed.wait()
        await asyncio.sleep(0)
        assert len(calls) == 1
        allow_wait.set()
        with pytest.raises(asyncio.CancelledError):
            await first_task
        assert await next_task == ["next"]

    asyncio.run(scenario())
    assert len(calls) == 2

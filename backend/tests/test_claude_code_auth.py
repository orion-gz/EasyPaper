"""macOS에서 Claude Code CLI 인증 실패(#612) 관련 회귀 테스트.

실제 ~/.claude, 키체인, claude 바이너리는 절대 건드리지 않는다 - HOME을
tmp_path로 바꾸고 서브프로세스는 전부 가짜로 대체한다.
"""
import asyncio
import os
import uuid

import pytest

import config
import services.library as library
import services.llm_client as llm_client
from services.generation_errors import GenerationError


@pytest.fixture()
def claude_env(tmp_path, monkeypatch):
    library_dir = tmp_path / "library"
    library_dir.mkdir()
    project_root = tmp_path / "project"
    project_root.mkdir()
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(config, "LIBRARY_DIR", str(library_dir))
    monkeypatch.setattr(llm_client, "get_project_root", lambda: str(project_root))
    monkeypatch.setenv("HOME", str(fake_home))
    return {"project_root": project_root, "home": fake_home}


class FakeStdin:
    def write(self, data):
        pass

    async def drain(self):
        pass

    def close(self):
        pass


def install_fake_claude(monkeypatch, results):
    """results: 호출 순서대로 (returncode, stdout_chunks, stderr_text)."""
    calls = []

    class FakeProcess:
        def __init__(self, returncode, chunks, stderr_text):
            self.stdin = FakeStdin()
            self.returncode = returncode
            self.chunks = list(chunks) + [b""]
            self.stderr_text = stderr_text

    async def fake_create_subprocess_exec(*args, **kwargs):
        calls.append({"args": list(args), "env": kwargs.get("env"), "cwd": kwargs.get("cwd")})
        return FakeProcess(*results[len(calls) - 1])

    async def fake_read_chunk(process, label=None):
        return process.chunks.pop(0)

    async def fake_wait(process, label=None):
        pass

    async def fake_finish_stderr(process):
        return process.stderr_text

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(llm_client, "_read_chunk_with_timeout", fake_read_chunk)
    monkeypatch.setattr(llm_client, "_wait_with_timeout", fake_wait)
    monkeypatch.setattr(llm_client, "_start_stderr_drain", lambda process: process)
    monkeypatch.setattr(llm_client, "_finish_stderr_drain", fake_finish_stderr)
    monkeypatch.setattr(llm_client, "get_claude_code_path", lambda: "claude")
    return calls


def collect(session_id, **kwargs):
    async def run():
        return [token async for token in llm_client.stream_claude_code("hi", session_id=session_id, **kwargs)]

    return asyncio.run(run())


def test_macos_keeps_real_home_and_creates_no_isolated_home(claude_env, monkeypatch):
    monkeypatch.setattr(llm_client.sys, "platform", "darwin")
    calls = install_fake_claude(monkeypatch, [(0, [b"ok"], "")])
    session_id = str(uuid.uuid4())

    assert collect(session_id) == ["ok"]

    assert calls[0]["env"]["HOME"] == str(claude_env["home"])
    assert calls[0]["cwd"] == os.path.abspath(os.path.join(config.LIBRARY_DIR, session_id))
    assert calls[0]["args"][-2:] == ["--resume", session_id]
    cache_dir = claude_env["project_root"] / "cache"
    assert not cache_dir.exists() or not list(cache_dir.glob("claude_home_*"))


def test_linux_still_uses_isolated_home(claude_env, monkeypatch):
    monkeypatch.setattr(llm_client.sys, "platform", "linux")
    calls = install_fake_claude(monkeypatch, [(0, [b"ok"], "")])
    session_id = str(uuid.uuid4())

    assert collect(session_id) == ["ok"]

    isolated_home = claude_env["project_root"] / "cache" / f"claude_home_{session_id}"
    assert calls[0]["env"]["HOME"] == str(isolated_home)
    assert (isolated_home / ".claude").is_dir()


def test_not_logged_in_on_stdout_raises_login_error_without_leaking_it(claude_env, monkeypatch):
    monkeypatch.setattr(llm_client.sys, "platform", "darwin")
    install_fake_claude(monkeypatch, [(1, [b"Not logged in", " · Please run /login\n".encode("utf-8")], "")])
    yielded = []

    async def run():
        async for token in llm_client.stream_claude_code("hi", session_id=str(uuid.uuid4())):
            yielded.append(token)

    with pytest.raises(GenerationError) as exc_info:
        asyncio.run(run())

    assert exc_info.value.document_task_error_code == "authentication_failed"
    assert "로그인" in str(exc_info.value)
    assert "알 수 없는 오류" not in str(exc_info.value)
    # 로그인 에러 문구가 모델 답변처럼 호출부로 흘러가면 안 된다.
    assert yielded == []


def test_failure_with_empty_stderr_includes_stdout_tail(claude_env, monkeypatch):
    monkeypatch.setattr(llm_client.sys, "platform", "darwin")
    install_fake_claude(monkeypatch, [(1, [b"partial answer ", b"API Error: overloaded"], "")])

    with pytest.raises(RuntimeError) as exc_info:
        collect(str(uuid.uuid4()))

    assert not isinstance(exc_info.value, GenerationError)
    assert "API Error: overloaded" in str(exc_info.value)
    assert "알 수 없는 오류" not in str(exc_info.value)


def test_long_stdout_is_bounded_in_error_message(claude_env, monkeypatch):
    monkeypatch.setattr(llm_client.sys, "platform", "darwin")
    install_fake_claude(monkeypatch, [(1, [b"x" * 5000, b"END"], "")])

    with pytest.raises(RuntimeError) as exc_info:
        collect(str(uuid.uuid4()))

    assert str(exc_info.value).endswith("END")
    assert len(str(exc_info.value)) < 600


def test_output_starting_like_login_prefix_is_still_streamed_on_success(claude_env, monkeypatch):
    monkeypatch.setattr(llm_client.sys, "platform", "darwin")
    install_fake_claude(monkeypatch, [(0, [b"No", b"t logged in users are shown."], "")])

    assert "".join(collect(str(uuid.uuid4()))) == "Not logged in users are shown."


@pytest.mark.parametrize("platform", ["darwin", "linux"])
def test_missing_conversation_retries_with_new_session_id(claude_env, monkeypatch, platform):
    monkeypatch.setattr(llm_client.sys, "platform", platform)
    session_id = str(uuid.uuid4())
    calls = install_fake_claude(monkeypatch, [
        (1, [], f"No conversation found with session ID: {session_id}"),
        (0, [b"fresh"], ""),
    ])

    assert collect(session_id) == ["fresh"]

    assert calls[0]["args"][-2:] == ["--resume", session_id]
    assert calls[1]["args"][-2:] == ["--session-id", session_id]


def test_delete_chat_sessions_removes_only_matching_transcript_on_macos(tmp_path, monkeypatch):
    monkeypatch.setattr(llm_client.sys, "platform", "darwin")
    fake_home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setattr(library, "get_project_root", lambda: str(tmp_path / "project"))
    monkeypatch.setattr(library, "LIBRARY_DIR", str(tmp_path / "library"))

    doc_id = str(uuid.uuid4())
    other_id = str(uuid.uuid4())
    projects = fake_home / ".claude" / "projects"
    project_a = projects / "-library-a"
    project_b = projects / "-library-b"
    project_a.mkdir(parents=True)
    project_b.mkdir(parents=True)
    target_a = project_a / f"{doc_id}.jsonl"
    target_b = project_b / f"{doc_id}.jsonl"
    keep = [
        project_a / f"{other_id}.jsonl",
        project_a / f"{doc_id}.jsonl.bak",
        project_b / f"prefix-{doc_id}.jsonl",
        fake_home / ".claude" / f"{doc_id}.jsonl",
    ]
    for path in [target_a, target_b, *keep]:
        path.write_text("{}", encoding="utf-8")
    session_dir = project_a / doc_id
    session_dir.mkdir()

    library.delete_chat_sessions(doc_id)

    assert not target_a.exists()
    assert not target_b.exists()
    assert all(path.exists() for path in keep)
    assert session_dir.is_dir()


def test_delete_chat_sessions_ignores_non_uuid_doc_id_on_macos(tmp_path, monkeypatch):
    monkeypatch.setattr(llm_client.sys, "platform", "darwin")
    fake_home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setattr(library, "get_project_root", lambda: str(tmp_path / "project"))
    monkeypatch.setattr(library, "LIBRARY_DIR", str(tmp_path / "library"))
    project = fake_home / ".claude" / "projects" / "-library"
    project.mkdir(parents=True)
    transcript = project / "abc.jsonl"
    transcript.write_text("{}", encoding="utf-8")

    library.delete_chat_sessions("*")
    library.delete_chat_sessions("abc")

    assert transcript.exists()


def test_delete_chat_sessions_uses_same_cache_dir_as_stream(tmp_path, monkeypatch):
    monkeypatch.setattr(llm_client.sys, "platform", "linux")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setattr(library, "get_project_root", lambda: str(tmp_path / "project"))
    monkeypatch.setattr(library, "LIBRARY_DIR", str(tmp_path / "library"))
    doc_id = str(uuid.uuid4())
    isolated_home = tmp_path / "project" / "cache" / f"claude_home_{doc_id}"
    (isolated_home / ".claude").mkdir(parents=True)

    library.delete_chat_sessions(doc_id)

    assert not isolated_home.exists()

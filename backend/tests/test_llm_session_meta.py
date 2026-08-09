import asyncio
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

import config
import services.llm_client as llm_client


@pytest.fixture()
def session_library(tmp_path, monkeypatch):
    library_dir = tmp_path / "library"
    library_dir.mkdir()
    monkeypatch.setattr(config, "LIBRARY_DIR", str(library_dir))
    return library_dir


def test_legacy_session_meta_is_read_as_provider_map(session_library):
    document_dir = session_library / "paper-1"
    document_dir.mkdir()
    (document_dir / "ai_session.json").write_text(
        json.dumps({"provider": "antigravity", "conversation_id": "legacy-id"}),
        encoding="utf-8",
    )

    assert llm_client.get_last_provider("paper-1") == "antigravity"
    assert llm_client.get_provider_session_meta("paper-1", "antigravity") == {
        "conversation_id": "legacy-id"
    }


def test_provider_session_updates_preserve_other_provider_metadata(session_library):
    llm_client.save_provider_session_meta("paper-1", "antigravity", "agy-id")
    llm_client.save_provider_session_meta("paper-1", "codex", "codex-id")
    llm_client.save_provider_session_meta("paper-1", "antigravity")

    meta = llm_client.get_ai_session_meta("paper-1")
    assert meta == {
        "last_provider": "antigravity",
        "providers": {
            "antigravity": {"conversation_id": "agy-id"},
            "codex": {"conversation_id": "codex-id"},
        },
    }


def test_concurrent_provider_session_updates_do_not_drop_metadata(session_library):
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(llm_client.save_provider_session_meta, "paper-1", "antigravity", "agy-id"),
            executor.submit(llm_client.save_provider_session_meta, "paper-1", "codex", "codex-id"),
        ]
        for future in futures:
            future.result()

    meta = llm_client.get_ai_session_meta("paper-1")
    assert meta["providers"]["antigravity"]["conversation_id"] == "agy-id"
    assert meta["providers"]["codex"]["conversation_id"] == "codex-id"


def test_antigravity_same_session_is_serialized_until_stream_consumed():
    async def scenario():
        events = []

        async def fake_stream(prompt, model=None, session_id=None):
            events.append(f"start:{prompt}")
            await asyncio.sleep(0.02)
            yield prompt
            events.append(f"end:{prompt}")

        serialized_stream = llm_client._serialize_antigravity_session(fake_stream)

        async def consume(prompt):
            return [token async for token in serialized_stream(prompt, session_id="paper-1")]

        first = asyncio.create_task(consume("first"))
        await asyncio.sleep(0)
        second = asyncio.create_task(consume("second"))
        assert await first == ["first"]
        assert await second == ["second"]
        assert events == ["start:first", "end:first", "start:second", "end:second"]

    asyncio.run(scenario())


def test_antigravity_different_sessions_remain_parallel():
    async def scenario():
        started_sessions = set()
        both_started = asyncio.Event()
        release = asyncio.Event()

        async def fake_stream(prompt, model=None, session_id=None):
            started_sessions.add(session_id)
            if len(started_sessions) == 2:
                both_started.set()
            await release.wait()
            yield prompt

        serialized_stream = llm_client._serialize_antigravity_session(fake_stream)

        async def consume(session_id):
            return [token async for token in serialized_stream("result", session_id=session_id)]

        first = asyncio.create_task(consume("paper-1"))
        await asyncio.sleep(0)
        second = asyncio.create_task(consume("paper-2"))
        await asyncio.wait_for(both_started.wait(), timeout=0.1)
        release.set()
        assert await first == ["result"]
        assert await second == ["result"]

    asyncio.run(scenario())


def test_claude_waiter_rechecks_provider_after_session_lock(session_library, monkeypatch):
    first_read_started = asyncio.Event()
    release_first = asyncio.Event()
    prompts = []

    class FakeStdin:
        def write(self, data):
            prompts.append(data.decode())

        async def drain(self):
            pass

        def close(self):
            pass

    class FakeProcess:
        def __init__(self, index):
            self.index = index
            self.stdin = FakeStdin()
            self.returncode = 0
            self.chunks = [b"result", b""]

    async def fake_create_subprocess_exec(*args, **kwargs):
        return FakeProcess(len(prompts))

    async def fake_read_chunk(process, label=None):
        if process.index == 0 and not first_read_started.is_set():
            first_read_started.set()
            await release_first.wait()
        return process.chunks.pop(0)

    async def fake_wait(process, label=None):
        pass

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(llm_client, "_read_chunk_with_timeout", fake_read_chunk)
    monkeypatch.setattr(llm_client, "_wait_with_timeout", fake_wait)
    monkeypatch.setattr(llm_client, "_start_stderr_drain", lambda process: None)
    monkeypatch.setattr(llm_client, "get_claude_code_path", lambda: "claude")
    monkeypatch.setattr(llm_client, "_build_catchup_prefix", lambda session_id: "CATCHUP\n")
    llm_client.save_provider_session_meta("paper-1", "antigravity", "agy-id")

    async def scenario():
        async def consume(prompt):
            return [
                token
                async for token in llm_client.stream_claude_code(
                    prompt,
                    session_id="paper-1",
                    is_chat=True,
                )
            ]

        first = asyncio.create_task(consume("first"))
        await first_read_started.wait()
        second = asyncio.create_task(consume("second"))
        await asyncio.sleep(0)
        release_first.set()
        assert await first == ["result"]
        assert await second == ["result"]

    asyncio.run(scenario())

    assert "CATCHUP\nfirst" in prompts[0]
    assert "CATCHUP" not in prompts[1]


def test_codex_waiter_reads_thread_id_after_session_lock(session_library, monkeypatch):
    class FakeStdin:
        def write(self, data):
            pass

        async def drain(self):
            pass

        def close(self):
            pass

    class FakeProcess:
        def __init__(self):
            self.stdin = FakeStdin()
            self.returncode = 0
            self.lines = [
                json.dumps({"type": "thread.started", "thread_id": "thread-1"}).encode(),
                json.dumps({
                    "type": "item.completed",
                    "item": {"type": "agent_message", "text": "result"},
                }).encode(),
                b"",
            ]

    commands = []

    async def fake_create_subprocess_exec(*args, **kwargs):
        commands.append(args)
        return FakeProcess()

    async def fake_readline(process, label=None):
        return process.lines.pop(0)

    async def fake_wait(process, label=None):
        pass

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(llm_client, "_readline_with_timeout", fake_readline)
    monkeypatch.setattr(llm_client, "_wait_with_timeout", fake_wait)
    monkeypatch.setattr(llm_client, "_start_stderr_drain", lambda process: None)
    monkeypatch.setattr(llm_client, "get_codex_path", lambda: "codex")

    async def scenario():
        async def consume(prompt):
            return [
                token
                async for token in llm_client.stream_codex(
                    prompt,
                    session_id="paper-1",
                )
            ]

        first = asyncio.create_task(consume("first"))
        await asyncio.sleep(0)
        second = asyncio.create_task(consume("second"))
        assert await first == ["result"]
        assert await second == ["result"]

    asyncio.run(scenario())

    assert "resume" not in commands[0]
    resume_index = commands[1].index("resume")
    assert commands[1][resume_index + 1] == "thread-1"

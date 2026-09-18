import asyncio
import threading


def test_lifespan_serves_before_recovery_finishes(monkeypatch):
    import main
    import services.db as db
    import services.usage_tracker as usage

    monkeypatch.setattr(db, 'init_db', lambda: None)
    monkeypatch.setattr(usage, 'init_usage_table', lambda: None)

    async def check():
        started = asyncio.Event()
        stopped = asyncio.Event()

        async def recover():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        monkeypatch.setattr(main.upload, 'restore_sessions_from_library', recover)
        async with main.lifespan(main.app):
            await asyncio.wait_for(started.wait(), 1)
            assert not stopped.is_set()
        assert stopped.is_set()

    asyncio.run(check())


def test_slow_document_recovery_does_not_block_event_loop(monkeypatch):
    import routers.upload as upload
    import services.document_tasks as tasks
    import services.reparse as reparse

    entered = threading.Event()
    release = threading.Event()
    monkeypatch.setattr(tasks, 'recoverable_tasks', lambda: [{'doc_id': 'slow'}])
    monkeypatch.setattr(upload, 'list_documents', lambda: [{'id': 'slow'}])
    monkeypatch.setattr(upload, 'get_job_status', lambda _: None)
    monkeypatch.setattr(tasks, 'recover_document_tasks', lambda _: None)
    monkeypatch.setattr(reparse, 'recover_reparse_previews', lambda: None)
    resumed = []
    monkeypatch.setattr(upload, 'resume_incomplete_jobs', lambda _: resumed.append(True))

    def restore(_):
        entered.set()
        assert release.wait(5), 'event loop was blocked by document restoration'

    monkeypatch.setattr(upload, 'ensure_session', restore)

    async def check():
        recovery = asyncio.create_task(upload.restore_sessions_from_library())
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert not recovery.done()
            assert not resumed
        finally:
            release.set()
            await recovery
        assert resumed == [True]

    asyncio.run(check())


def test_recovery_error_does_not_fail_lifespan(monkeypatch):
    import main
    import services.db as db
    import services.usage_tracker as usage

    monkeypatch.setattr(db, 'init_db', lambda: None)
    monkeypatch.setattr(usage, 'init_usage_table', lambda: None)

    async def fail():
        raise ValueError('invalid persisted task')

    monkeypatch.setattr(main.upload, 'restore_sessions_from_library', fail)

    async def check():
        async with main.lifespan(main.app):
            await asyncio.sleep(0)

    asyncio.run(check())

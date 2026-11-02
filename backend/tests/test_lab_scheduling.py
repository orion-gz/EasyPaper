import asyncio
import pytest
from services import lab, lab_tasks


@pytest.mark.asyncio
async def test_changed_limits_include_existing_work_and_cancelled_waiters(monkeypatch):
    config = {'engine': 'vllm', 'max_concurrent': 2, 'per_user': 2}
    monkeypatch.setattr(lab, 'configuration', lambda: config)
    lab_tasks._limits.clear()
    entered = asyncio.Event()
    async def work():
        async with lab_tasks.admission('bob'):
            entered.set()
    async with lab_tasks.admission('alice'):
        config['max_concurrent'] = 1
        waiting = asyncio.create_task(work())
        await asyncio.sleep(0)
        assert not entered.is_set()
        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)
        waiting = asyncio.create_task(work())
        await asyncio.sleep(0)
        assert not entered.is_set()
    await asyncio.wait_for(waiting, 1)
    assert entered.is_set()
    state = lab_tasks._limits[asyncio.get_running_loop()]
    assert state['total'] == 0 and not any(state['users'].values())

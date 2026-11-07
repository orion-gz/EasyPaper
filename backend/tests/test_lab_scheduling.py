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
    state = lab_tasks._limits[asyncio.get_running_loop()][None]
    assert state['total'] == 0 and not any(state['users'].values())


@pytest.mark.asyncio
async def test_server_pools_are_independent_and_keep_counts_when_limits_change(monkeypatch):
    from services import inference_servers
    configurations = {key: {'engine': 'vllm', 'max_concurrent': 2, 'per_user': 2} for key in ('one', 'two')}
    monkeypatch.setattr(inference_servers, 'get', lambda key, **kwargs: configurations[key])
    lab_tasks._limits.clear()
    entered = asyncio.Event()
    async def work():
        async with lab_tasks.admission('bob', 'one'):
            entered.set()
    async with lab_tasks.admission('alice', 'one'):
        configurations['one']['max_concurrent'] = 1
        waiting = asyncio.create_task(work())
        await asyncio.sleep(0)
        assert not entered.is_set()
        async with lab_tasks.admission('alice', 'two'):
            pools = lab_tasks._limits[asyncio.get_running_loop()]
            assert pools['one']['total'] == pools['two']['total'] == 1
    await asyncio.wait_for(waiting, 1)
    assert entered.is_set()
    assert all(pool['total'] == 0 and not pool['users'] for pool in pools.values())

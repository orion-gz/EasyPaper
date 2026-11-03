import asyncio

import pytest
from fastapi import HTTPException
from routers.data_transfer import _desktop_devices, desktop_devices, request_desktop_sync


def test_device_requests_are_account_scoped_and_require_online_merge():
    import time
    _desktop_devices.clear()
    device = {'id': 'test', 'seen': time.time(), 'action': 'merge', 'requested': False}
    _desktop_devices['owner'] = {'test': device}
    assert asyncio.run(desktop_devices('other')) == {'devices': []}
    with pytest.raises(HTTPException):
        asyncio.run(request_desktop_sync('test', 'other'))
    assert asyncio.run(request_desktop_sync('test', 'owner')) == {'requested': True}
    device['action'] = 'replace_remote'
    with pytest.raises(HTTPException):
        asyncio.run(request_desktop_sync('test', 'owner'))
    device.update(action='merge', seen=0)
    with pytest.raises(HTTPException):
        asyncio.run(request_desktop_sync('test', 'owner'))
    _desktop_devices.clear()

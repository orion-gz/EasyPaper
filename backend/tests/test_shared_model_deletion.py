"""Deletion safeguards and native Hub cache operations."""
import json
import httpx
import pytest
from fastapi import HTTPException
from test_lab_mode import environment
from test_shared_models import create
from services import inference_servers as servers, shared_models as models, shared_model_deletion as deletion
from services.ssh_connections import manager, client as connection_client


def setup(environment, monkeypatch, engine='ollama'):
    identifier = create(environment[0], engine=engine, legacy=True)
    record = models.records(identifier)[0]
    record.update(enabled=False, verified=True)
    models.write(record); models.sync_permissions(identifier)
    monkeypatch.setenv('EASYPAPER_MODEL_MAINTENANCE', json.dumps({identifier: {
        'isolated': True, 'engine_stopped': True,
        'destination': deletion.policy(servers.get(identifier))['destination']}}))
    return identifier, record


def mock_engine(monkeypatch, loaded=False, retained=False, failure=False):
    calls = []
    def handle(request):
        calls.append((request.method, request.url.path))
        if request.url.path == '/api/ps': return httpx.Response(200,json={'models':[{}] if loaded else []})
        if request.url.path == '/api/delete': return httpx.Response(500 if failure else 200)
        return httpx.Response(200,json={'models':[{'name':'old'}] if retained else []})
    monkeypatch.setattr(deletion,'client',lambda *a,**kw:httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    return calls


@pytest.mark.asyncio
async def test_delete_is_opt_in_and_bound_to_destination(environment, monkeypatch):
    sid,record=setup(environment,monkeypatch)
    monkeypatch.delenv('EASYPAPER_MODEL_MAINTENANCE')
    with pytest.raises(HTTPException,match='operator-isolated'): await models.remove(sid,record['id'],True)
    assert models.find(sid,record['id'])['verified']
    sid,record=setup(environment,monkeypatch)
    changed={**servers.get(sid),'url':'http://other:11434'}
    assert not deletion.policy(changed)['allowed']


@pytest.mark.asyncio
@pytest.mark.parametrize('reason',['enabled','loaded','active','reference'])
async def test_delete_refuses_consumers(environment,monkeypatch,reason):
    sid,record=setup(environment,monkeypatch)
    calls=mock_engine(monkeypatch,loaded=reason=='loaded')
    if reason=='enabled': record['enabled']=True;models.write(record)
    if reason=='reference': create(environment[0],legacy=True)
    monkeypatch.setattr(manager,'active',{'inference:another':1} if reason=='active' else {})
    with pytest.raises(HTTPException) as exc: await models.remove(sid,record['id'],True)
    assert exc.value.status_code==409
    assert ('DELETE','/api/delete') not in calls
    assert not manager.maintenance


@pytest.mark.asyncio
@pytest.mark.parametrize('failure,retained',[(False,False),(True,False),(False,True)])
async def test_delete_verifies_and_never_reenables_partial_files(environment,monkeypatch,failure,retained):
    sid,record=setup(environment,monkeypatch)
    mock_engine(monkeypatch,failure=failure,retained=retained)
    if failure or retained:
        with pytest.raises((HTTPException,httpx.HTTPError)): await models.remove(sid,record['id'],True)
        result=models.find(sid,record['id'])
        assert not result['enabled'] and not result['verified'] and result['status']=='Failed'
    else:
        assert (await models.remove(sid,record['id'],True))['files_deleted']
        assert not models.records(sid)
    assert not manager.maintenance
    assert servers.get(sid)['models']==[]


@pytest.mark.asyncio
async def test_maintenance_blocks_plain_http_and_releases_after_error(monkeypatch):
    monkeypatch.setattr(manager,'active',{})
    with pytest.raises(RuntimeError):
        async with manager.inference_maintenance():
            async with connection_client('inference:test',{'url':'http://test'}) as connection:
                with pytest.raises(HTTPException) as exc: await connection.get('http://test/models')
                assert exc.value.status_code==409
            with pytest.raises(HTTPException):
                async with manager.lease('inference:test'): pass
            raise RuntimeError('interrupted')
    assert not manager.maintenance
    async with manager.lease('inference:test'): assert manager.active['inference:test']==1


@pytest.mark.asyncio
@pytest.mark.parametrize('reachable',[True,False])
async def test_vllm_requires_stopped_endpoint(environment,monkeypatch,reachable):
    sid,record=setup(environment,monkeypatch,engine='vllm')
    record['model_id']='owner/model';models.write(record)
    monkeypatch.setattr(models,'target',lambda sid:{})
    async def worker(*args): return {'files_deleted':True}
    monkeypatch.setattr(models,'worker',worker)
    def handle(request):
        if reachable:return httpx.Response(503)
        raise httpx.ConnectError('stopped',request=request)
    monkeypatch.setattr(deletion,'client',lambda *a,**kw:httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    if reachable:
        with pytest.raises(HTTPException,match='Stop the isolated'): await models.remove(sid,record['id'],True)
    else: assert (await models.remove(sid,record['id'],True))['files_deleted']


def cache_repo(root,name,revision):
    repo=root/('models--owner--'+name)
    (repo/'blobs').mkdir(parents=True); (repo/'refs').mkdir()
    snapshot=repo/'snapshots'/revision;snapshot.mkdir(parents=True)
    (repo/'blobs'/'content').write_text('{}')
    (snapshot/'config.json').symlink_to('../../blobs/content')
    (repo/'refs'/'main').write_text(revision)
    return repo


def test_native_hub_deletion_preserves_other_repo(tmp_path):
    from services.hf_model_worker import delete_cached_model
    selected=cache_repo(tmp_path,'selected','a'*40)
    other=cache_repo(tmp_path,'other','b'*40)
    assert delete_cached_model('owner/selected',tmp_path)['files_deleted']
    assert not selected.exists() and (other/'blobs'/'content').read_text()=='{}'
    assert delete_cached_model('owner/selected',tmp_path)['files_deleted']


def test_native_hub_deletion_rejects_revision_collision_and_symlink(tmp_path):
    from services.hf_model_worker import delete_cached_model
    selected=cache_repo(tmp_path,'selected','a'*40)
    other=cache_repo(tmp_path,'other','a'*40)
    with pytest.raises(ValueError,match='shares a revision'): delete_cached_model('owner/selected',tmp_path)
    (tmp_path/'models--owner--linked').symlink_to(selected,target_is_directory=True)
    with pytest.raises(ValueError,match='symlinked'): delete_cached_model('owner/linked',tmp_path)
    assert selected.exists() and other.exists()


@pytest.mark.asyncio
async def test_open_plain_http_stream_blocks_deletion_until_closed(monkeypatch):
    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'chunk'
    monkeypatch.setattr(manager,'active',{})
    monkeypatch.setattr(httpx,'AsyncHTTPTransport',lambda:httpx.MockTransport(
        lambda request:httpx.Response(200,stream=Stream())))
    async with connection_client('inference:stream',{'url':'http://test'}) as connection:
        async with connection.stream('GET','http://test/chat'):
            with pytest.raises(HTTPException):
                async with manager.inference_maintenance(): pass
        async with manager.inference_maintenance(): assert manager.maintenance
    assert manager.active['inference:stream']==0

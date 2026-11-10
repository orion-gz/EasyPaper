"""Opt-in real engine test. Point ONLY at a disposable, empty Ollama instance."""
import asyncio
import json
import os

import httpx
import pytest
from services import inference_servers as servers, shared_models as models
from test_lab_mode import environment


@pytest.mark.asyncio
async def test_live_ollama_download_verify_and_infer(environment, monkeypatch):
    url = os.getenv('EASYPAPER_TEST_OLLAMA_URL')
    model = os.getenv('EASYPAPER_TEST_OLLAMA_MODEL')
    if not url or not model:
        pytest.skip('Set EASYPAPER_TEST_OLLAMA_URL and EASYPAPER_TEST_OLLAMA_MODEL for a disposable engine')
    async with httpx.AsyncClient(timeout=120,trust_env=False) as connection:
        tags = await connection.get(url+'/api/tags'); tags.raise_for_status()
        assert not tags.json()['models'], 'Live test requires a fresh empty engine; existing models will not be touched'
        server = await servers.save(servers.ServerSettings(name='Disposable integration',engine='ollama',url=url))
        record = await models.add(server['id'],model)
        try:
            task = models._tasks[record['id']]
            await asyncio.wait_for(task,300)
            result = models.find(server['id'],record['id'])
            assert result['status']=='Completed', result.get('error')
            assert result['verified'] and result['total']>0
            assert (await models.listing(server['id']))[0]['available']
            loaded = await connection.get(url+'/api/ps'); loaded.raise_for_status()
            assert not loaded.json()['models'], 'Downloading must not load weights for inference'
            response = await connection.post(url+'/api/chat',json={'model':model,'messages':[{'role':'user','content':'Hello'}],
                'stream':False,'keep_alive':0,'options':{'num_predict':1,'num_ctx':512}})
            response.raise_for_status()
            assert response.json().get('message') and response.json().get('done')
            from services.shared_model_deletion import policy
            await models.action(server['id'], record['id'], 'disable')
            monkeypatch.setenv('EASYPAPER_MODEL_MAINTENANCE', json.dumps({server['id']: {
                'isolated': True, 'destination': policy(servers.get(server['id']))['destination']}}))
            deleted = await models.remove(server['id'], record['id'], delete_files=True)
            assert deleted['files_deleted'] and not models.records(server['id'])
            assert not (await connection.get(url+'/api/tags')).json()['models']
            print('REAL_OLLAMA',{'model':model,'bytes':result['total'],'download_verified':True,'inference_verified':True})
        finally:
            await models.stop()
            # This test owns the initially-empty isolated engine and its only model.
            response = await connection.request('DELETE',url+'/api/delete',json={'model':model})
            assert response.status_code in (200,404)

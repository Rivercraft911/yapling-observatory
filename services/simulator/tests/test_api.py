import asyncio
import hashlib
import json
import os
from pathlib import Path
import struct
import time

from fastapi.testclient import TestClient
import pytest

from cubesat_sim.api import create_app
from cubesat_sim.jobs import JobManager
from cubesat_sim.models import Scenario, default_scenario


def wait_terminal(client, run_id):
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        r=client.get('/api/runs/'+run_id).json()
        if r['status']in('complete','failed','cancelled'):return r
        time.sleep(.02)
    raise AssertionError('Worker failed to complete within 15 seconds')


def test_api_real_subprocess_roundtrip_and_defaults():
    with TestClient(create_app())as client:
        assert client.get('/api/health').json()['status']=='ok'
        default=client.get('/api/scenarios/default').json();s=default['scenario'];s['duration_s']=10
        assert s['uplink']['profile']['waveform']==s['downlink']['profile']['waveform']=='dvb_s2'
        response=client.post('/api/runs',json={'scenario':s});assert response.status_code==202
        run=wait_terminal(client,response.json()['run_id'])
        assert run['status']=='complete',run
        assert run['scenario_hash']==run['result']['manifest']['scenario_hash']
        assert run['result']['summary']['sample_count']==11
        assert client.delete('/api/runs/'+run['run_id']).json()['status']=='complete'
        assert client.get('/api/runs/not-real').status_code==404
        assert client.get('/api/radio-profiles').json()['lora']['threshold_db']is None
        s['step_s']=.0001
        assert client.post('/api/runs',json={'scenario':s}).status_code==422


def test_true_running_worker_cancellation_and_cleanup():
    async def exercise():
        manager=JobManager();s=default_scenario().model_dump(mode='json');s.update(duration_s=3600,step_s=.5)
        job=manager.submit(Scenario.model_validate(s))
        for _ in range(1000):
            if job.process is not None:break
            await asyncio.sleep(.001)
        assert job.process is not None
        pid=job.process.pid;directory=job.directory
        assert job.process.returncode is None
        await manager.cancel(job.run_id)
        assert job.status=='cancelled'and job.result is None
        assert job.process.returncode is not None
        assert not Path(directory).exists()
        if os.name=='posix':
            with pytest.raises(ProcessLookupError):os.kill(pid,0)
        await manager.close()
    asyncio.run(exercise())


def test_queued_cancellation_and_queue_bound():
    async def exercise():
        manager=JobManager(max_active=2)
        a=manager.submit(default_scenario());b=manager.submit(default_scenario())
        with pytest.raises(OverflowError):manager.submit(default_scenario())
        await manager.cancel(b.run_id)
        assert b.status=='cancelled'and b.result is None
        await manager.close()
        assert a.status=='cancelled'
    asyncio.run(exercise())


def test_worker_failure_retains_failed_not_complete():
    async def exercise():
        manager=JobManager(timeout_s=0.00001)
        job=manager.submit(default_scenario());await job.task
        assert job.status=='failed'and job.result is None
        assert job.process.returncode is not None
        assert not Path(job.directory).exists()
    asyncio.run(exercise())


def test_asset_allowlist_identity_and_missing_metadata(tmp_path,monkeypatch):
    payload=json.dumps({'asset':{'version':'2.0'}}).encode();payload+=b' '*((-len(payload))%4)
    data=struct.pack('<4sII',b'glTF',2,20+len(payload))+struct.pack('<I4s',len(payload),b'JSON')+payload
    glb=tmp_path/'example.glb';glb.write_bytes(data);digest=hashlib.sha256(data).hexdigest()
    manifest=tmp_path/'models.json';manifest.write_text(json.dumps({'dipole':{'path':str(glb),'revision':'test-v02','sha256':digest,'fallback':False}}))
    monkeypatch.setenv('CUBESAT_MODEL_MANIFEST',str(manifest))
    with TestClient(create_app())as client:
        metadata=client.get('/api/assets').json();assert metadata['variants']['dipole']['available']is True
        assert str(tmp_path)not in json.dumps(metadata)
        response=client.get('/api/assets/spacecraft.glb?variant=dipole');assert response.content==data
        assert response.headers['content-type']=='model/gltf-binary'
        assert response.headers['etag']=='"'+digest+'"'
        assert client.get('/api/assets/spacecraft.glb?variant=../../etc/passwd').status_code==422
        assert client.get('/api/assets/spacecraft.glb?variant=turnstile').status_code==404
        glb.write_bytes(data+b'x')
        assert client.get('/api/assets/spacecraft.glb?variant=dipole').status_code==409
        monkeypatch.delenv('CUBESAT_MODEL_MANIFEST')
        assert client.get('/api/assets').json()['variants']['dipole']['available']is False


def test_actual_request_body_byte_limit_including_chunked():
    with TestClient(create_app())as client:
        scenario=default_scenario().model_dump(mode='json');scenario['duration_s']=10
        body=json.dumps({'scenario':scenario}).encode()
        assert client.post('/api/runs',content=iter([b' '*(600*1024),body]),headers={'Content-Type':'application/json'}).status_code==413
        # A valid bounded chunked request is replayed intact to Pydantic.
        response=client.post('/api/runs',content=iter([body[:100],body[100:]]),headers={'Content-Type':'application/json'})
        assert response.status_code==202
        client.delete('/api/runs/'+response.json()['run_id'])
        assert client.post('/api/runs',content=b' '*(600*1024),headers={'Content-Type':'application/json'}).status_code==413

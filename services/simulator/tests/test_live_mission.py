"""Real process LIVE transport, deterministic replay and bounded API lifecycle."""
import asyncio
from collections import deque
import json
import math
import time

from fastapi.testclient import TestClient
import pytest

from cubesat_sim.api import create_app
from cubesat_sim.geometry.frames import WGS84_A_M, WGS84_F, geodetic_ecef
from cubesat_sim.geometry.ground_target import ground_target_from_ecef
from cubesat_sim.live_mission_jobs import LiveMissionJobManager, LiveSession
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission_archive import import_archive
from cubesat_sim.mission_models import MissionScenario, PointingIntent
from cubesat_sim.models import canonical_json


def mission(duration=60):
    values = default_mission_scenario().model_dump(mode='json')
    values['duration_s'] = duration
    values['clocks'].update(output_step_s=10, thermal_step_s=10, controller_period_s=2)
    return MissionScenario.model_validate(values)


async def until(predicate, timeout=5):
    started = time.monotonic()
    while not predicate():
        if time.monotonic() - started > timeout:
            raise AssertionError('Timed out waiting for LIVE state')
        await asyncio.sleep(0.02)


def assert_replay(snapshot):
    config = MissionScenario.model_validate(snapshot['scenario'])
    result = snapshot['run']['result']
    replay = run_mission(config)
    for field in ('samples', 'summary', 'events'):
        assert canonical_json(replay[field]) == canonical_json(result[field]), field


def test_actual_live_worker_finishes_and_streamed_rows_equal_final_history():
    async def execute():
        manager = LiveMissionJobManager()
        job = manager.create(mission(), 1000)
        try:
            await asyncio.wait_for(job.task, 10)
            assert job.status == 'complete', job.error
            record = manager.record(job)
            assert record['final_snapshot'] is not None
            assert record['initial_scenario_hash'] == job.scenario.identity()[1]
            assert [item['row']['time_s'] for item in record['samples']] == [0, 10, 20, 30, 40, 50, 60]
            columns = job.final_snapshot['run']['result']['samples']
            def check(row, column, index):
                for key, value in row.items():
                    if isinstance(value, dict):
                        check(value, column[key], index)
                    else:
                        assert value == column[key][index], key
            for index, item in enumerate(record['samples']):
                check(item['row'], columns, index)
            assert import_archive(job.archive)['snapshot'] == job.final_snapshot
            assert_replay(job.final_snapshot)
            assert job.base is None and job.process is None
        finally:
            await manager.close()
    asyncio.run(execute())


def test_pause_command_resume_and_graceful_stop_replay_exactly():
    async def execute():
        manager = LiveMissionJobManager()
        job = manager.create(mission(120), 20)
        manager.control(job, paused=True)
        manager.command(job, PointingIntent(command_id='ground-pick', mode='imaging',
                                           target_latitude_deg=37.4, target_longitude_deg=-122.2))
        try:
            await until(lambda: job.status == 'paused')
            assert job.final_snapshot is None and job.archive is None
            assert job.sample_count == 0
            manager.control(job, paused=False)
            await until(lambda: 'ground-pick' in job.accepted)
            await until(lambda: job.progress.get('computed_time_s', 0) >= 5)
            manager.control(job, stop=True)
            await asyncio.wait_for(job.task, 10)
            assert job.status == 'complete', job.error
            final = job.final_snapshot
            stop = final['scenario']['stop_time_s']
            assert 5 <= stop < 120
            assert final['run']['result']['summary']['computed_duration_s'] == stop
            assert final['run']['result']['summary']['end_reason'] == 'user_stop'
            assert job.accepted['ground-pick']['effective_time_s'] % 2 == 0
            assert final['scenario']['pointing_commands'] == list(job.accepted.values())
            assert_replay(final)
            assert import_archive(job.archive)['snapshot'] == final
        finally:
            await manager.close()
    asyncio.run(execute())


def test_expired_poll_lease_pauses_and_requires_explicit_resume():
    async def execute():
        manager = LiveMissionJobManager(lease_s=0.25)
        job = manager.create(mission(300), 20)
        try:
            await until(lambda: job.progress.get('lease_expired') is True)
            at_expiry = job.progress['computed_time_s']
            await asyncio.sleep(0.2)
            assert job.progress['computed_time_s'] == at_expiry
            manager.record(job)  # Poll renews ownership; it must not silently resume.
            await asyncio.sleep(0.15)
            assert job.status == 'paused'
            assert job.progress['computed_time_s'] == at_expiry
            manager.control(job, paused=False, stop=True)
            await asyncio.wait_for(job.task, 10)
            assert job.status == 'complete', job.error
        finally:
            await manager.close()
    asyncio.run(execute())


def test_actual_process_cancel_and_shutdown_do_not_publish_completed_result():
    async def execute():
        manager = LiveMissionJobManager()
        job = manager.create(mission(300), 1)
        await until(lambda: job.process is not None)
        process = job.process
        await manager.close()
        assert process.returncode is not None
        assert job.status == 'cancelled'
        assert job.final_snapshot is None and job.archive is None
        assert job.base is None
    asyncio.run(execute())


def test_cancel_before_worker_start_releases_owned_directory():
    async def execute():
        manager = LiveMissionJobManager()
        job = manager.create(mission(), 1)
        directory = job.base
        await manager.cancel(job.live_id)
        assert job.status == 'cancelled'
        assert job.base is None and not directory.exists()
        assert job.process is None
    asyncio.run(execute())


def test_delivery_watermark_limits_retention_gap_and_command_queue_bounds():
    manager = LiveMissionJobManager()
    job = LiveSession(mission(), 1)
    # Constructed transport rows only, not simulated mission telemetry.
    for sequence in range(1, 1001):
        job.events.append(dict(sequence=sequence, kind='sample', value={'time_s': sequence}))
    job.latest_sequence = 1000
    first = manager.record(job, 0, renew=False)
    assert first['next_sequence'] == 512 and first['latest_sequence'] == 1000
    second = manager.record(job, first['next_sequence'], renew=False)
    assert len(second['samples']) == 488 and second['next_sequence'] == 1000
    job.events = deque(list(job.events)[-2:], maxlen=2)
    missing = manager.record(job, 0, renew=False)
    assert missing['gap'] and missing['first_sequence'] == 999
    with pytest.raises(ValueError):
        manager.record(job, 1001)
    for index in range(128):
        manager.command(job, PointingIntent(command_id=str(index), mode='sun_pointing'))
    manager.command(job, PointingIntent(command_id='0', mode='sun_pointing'))
    assert len(job.intents) == 128
    with pytest.raises(ValueError):
        manager.command(job, PointingIntent(command_id='overflow', mode='auto'))
    with pytest.raises(ValueError):
        manager.command(job, PointingIntent(command_id='0', mode='auto'))


@pytest.mark.parametrize('latitude,longitude', [(0, 0), (37.4275, -122.1697), (-30, 180), (89.9, -179.9)])
def test_map_pick_radial_projection_matches_surface_geodetic_coordinates(latitude, longitude):
    surface = geodetic_ecef(latitude, longitude, 0)
    result = ground_target_from_ecef(tuple(value * 0.998 for value in surface))
    assert result['latitude_deg'] == pytest.approx(latitude, abs=1e-11)
    assert result['longitude_deg'] == pytest.approx(longitude, abs=1e-11)


def test_map_pick_poles_and_off_planet_rejection():
    b = WGS84_A_M * (1 - WGS84_F)
    assert ground_target_from_ecef((0, 0, b)) == dict(latitude_deg=90, longitude_deg=0)
    assert ground_target_from_ecef((0, 0, -b)) == dict(latitude_deg=-90, longitude_deg=0)
    for position in ((0, 0, 0), (7e6, 0, 0), (6e6, 0, 0), (math.nan, 0, 0)):
        with pytest.raises(ValueError):
            ground_target_from_ecef(position)


def test_http_live_route_validation_ground_target_and_complete_archive_bridge():
    with TestClient(create_app()) as client:
        for payload in ({'speed': 0}, {'speed': 1001}, {'speed': True}):
            assert client.post('/api/live', json={'scenario': mission().model_dump(mode='json'), **payload}).status_code == 422
        pick = client.post('/api/live/ground-target', json={'position_ecef_m': geodetic_ecef(37.4275, -122.1697, 0)})
        assert pick.status_code == 200
        assert pick.json()['latitude_deg'] == pytest.approx(37.4275)
        assert client.post('/api/live/ground-target', json={'position_ecef_m': [7e6, 0, 0]}).status_code == 422
        created = client.post('/api/live', json={'scenario': mission().model_dump(mode='json'), 'speed': 1000})
        assert created.status_code == 202
        identifier = created.json()['session']['live_id']
        invalid = client.post(f'/api/live/{identifier}/commands', json={'command_id': 'bad', 'mode': 'auto', 'effective_time_s': 0})
        assert invalid.status_code == 422
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            record = client.get(f'/api/live/{identifier}').json()['session']
            if record['status'] not in ('starting', 'running', 'paused', 'stopping'):
                break
            time.sleep(0.03)
        assert record['status'] == 'complete', record['error']
        archive = client.get(f'/api/live/{identifier}/archive')
        assert archive.status_code == 200
        assert import_archive(archive.content)['snapshot'] == record['final_snapshot']
        assert client.get(f'/api/live/{identifier}?after_sequence=999999').status_code == 422


def test_latest_one_second_state_is_separate_from_archive_cadence():
    async def execute():
        manager = LiveMissionJobManager()
        job = manager.create(mission(120), 5)
        try:
            await until(lambda: job.latest_telemetry is not None and job.latest_telemetry['time_s'] >= 3)
            manager.control(job, paused=True)
            await until(lambda: job.status == 'paused')
            latest_time = job.latest_telemetry['time_s']
            assert 3 <= latest_time < 10
            assert [event['value']['time_s'] for event in job.events if event['kind'] == 'sample'] == [0]
            assert manager.record(job)['latest_telemetry']['time_s'] == latest_time
            manager.control(job, stop=True)
            await asyncio.wait_for(job.task, 10)
            assert job.status == 'complete', job.error
            final = job.final_snapshot['run']['result']
            assert job.latest_telemetry['time_s'] == final['summary']['computed_duration_s']
            assert [event['value']['time_s'] for event in job.events if event['kind'] == 'sample'] == final['samples']['time_s']
            assert job.sample_count == len(final['samples']['time_s']) == 2
            assert_replay(job.final_snapshot)
        finally:
            await manager.close()
    asyncio.run(execute())


def test_latest_disk_publication_is_wall_bounded_without_throttling_archive_rows(tmp_path, monkeypatch):
    from cubesat_sim import live_mission_worker as worker
    now = [100.0]
    monkeypatch.setattr(worker.time, 'monotonic', lambda: now[0])
    control = tmp_path / 'control.json'
    control.write_text(json.dumps(dict(speed=1000, paused=False, stop=False,
        resume_generation=0, lease_until=130, commands=[])))
    runtime = worker.FileRuntime(control, tmp_path / 'progress.json', tmp_path / 'telemetry.jsonl', 30)
    try:
        for time_s in range(1000):
            runtime.on_telemetry({'time_s': time_s, 'actual': [time_s, None]})
        assert json.loads(runtime.latest_path.read_text())['time_s'] == 0
        runtime.on_sample({'time_s': 999, 'actual': [999, None]})
        runtime.journal.flush()
        assert len((tmp_path / 'telemetry.jsonl').read_text().splitlines()) == 1
        assert json.loads(runtime.latest_path.read_text())['time_s'] == 0
        now[0] += 0.16
        runtime.on_telemetry({'time_s': 1000, 'actual': [1000, None]})
        assert json.loads(runtime.latest_path.read_text())['time_s'] == 1000
        runtime.on_sample({'time_s': 1001, 'actual': [1001, None]})
        runtime.write_latest(runtime.latest_row, force=True)
        assert json.loads(runtime.latest_path.read_text())['time_s'] == 1001
        assert len((tmp_path / 'telemetry.jsonl').read_text().splitlines()) == 2
    finally:
        runtime.close()

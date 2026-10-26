import math
import time

from fastapi.testclient import TestClient
from cubesat_sim.api import create_app


def test_mission_default_and_linked_orbital_controls():
    with TestClient(create_app()) as client:
        config = client.get('/api/mission/default').json()['scenario']
        assert config['run_kind'] == 'long_mission'
        assert config['duration_s'] == 86400
        orbit = config['orbit']
        assert orbit['force_model'] == 'j2'
        assert math.isclose(orbit['ltan_hours_at_epoch'], 18, abs_tol=1e-8)
        initial_i = orbit['elements']['inclination_deg']
        dusk_raan = orbit['elements']['raan_deg']
        dawn = client.post('/api/mission/orbit', json={'orbit': orbit, 'ltan_hours': 6}).json()['orbit']
        assert math.isclose((dawn['elements']['raan_deg']-dusk_raan)%360,180,abs_tol=1e-8)
        assert dawn['elements']['inclination_deg'] == initial_i
        dawn['elements']['inclination_deg'] = 70
        dawn['elements']['eccentricity'] = .005
        custom = client.post('/api/mission/orbit', json={'orbit':dawn}).json()['orbit']
        assert custom['elements']['inclination_deg'] == 70
        assert custom['elements']['eccentricity'] == .005
        assert math.isclose(custom['ltan_hours_at_epoch'],6,abs_tol=1e-8)
        sso = client.post('/api/mission/orbit', json={'orbit':custom,'sso':True})
        assert sso.status_code == 200
        assert 90 < sso.json()['orbit']['elements']['inclination_deg'] < 110
        assert client.post('/api/mission/orbit', json={'orbit':custom,'ltan_hours':24}).status_code == 422


def test_mission_worker_returns_identified_common_history():
    with TestClient(create_app()) as client:
        config = client.get('/api/mission/default').json()['scenario']
        config['duration_s'] = 60
        started = client.post('/api/mission/runs', json={'scenario':config})
        assert started.status_code == 202
        job = started.json()
        deadline=time.monotonic()+15
        while job['status'] in ('queued','running','cancelling') and time.monotonic()<deadline:
            time.sleep(.03)
            job = client.get('/api/mission/runs/'+job['run_id']).json()
        assert job['status'] == 'complete', job.get('error')
        result=job['result']
        assert result['manifest']['scenario_hash'] == job['scenario_hash']
        samples=result['samples']
        assert samples['time_s'] == [0,30,60]
        assert samples['uplink']['cumulative_ideal_bits'][0] == 0
        assert len(samples['thermal']['node_temperature_k']['bus']) == len(samples['time_s'])
        assert all(value is not None and math.isfinite(value) for value in samples['power']['battery_voltage_v'])
        assert samples['power']['battery_soc'][0] == 0.5
        assert result['summary']['end_reason'] == 'requested_duration'


def test_queued_mission_can_be_cancelled_and_apps_keep_separate_histories():
    with TestClient(create_app()) as client:
        config = client.get('/api/mission/default').json()['scenario']
        first = client.post('/api/mission/runs', json={'scenario':config}).json()
        second = client.post('/api/mission/runs', json={'scenario':config}).json()
        cancelled = client.delete('/api/mission/runs/'+second['run_id'])
        assert cancelled.status_code == 200
        assert cancelled.json()['status'] == 'cancelled'
        assert cancelled.json()['result'] is None
        client.delete('/api/mission/runs/'+first['run_id'])
    with TestClient(create_app()) as other:
        assert other.get('/api/mission/runs/'+first['run_id']).status_code == 404


def test_wheel_reference_default_has_traceable_mechanics_and_explicit_budget():
    with TestClient(create_app()) as client:
        config = client.get('/api/mission/default').json()['scenario']
        evidence = client.get('/api/mission/wheel-reference').json()['example']
        assert evidence['status'] == 'editable_preliminary_planning_example'
        assert len(config['spacecraft']['wheels']) == evidence['powered_axis_count'] == 3
        for wheel in config['spacecraft']['wheels']:
            for key, value in evidence['model_parameters'].items():
                assert wheel['spec'][key] == value
            assert wheel['spec']['idle_power_w'] == .4
            assert wheel['spec']['max_bus_power_w'] == .5
        assert evidence['sources'][0]['url'].startswith('https://www.astrofein.com/')
        assert evidence['assumptions']


def test_advertised_mission_presets_have_http_routes_and_editable_scenarios():
    from cubesat_sim.mission_models import MissionScenario
    with TestClient(create_app()) as client:
        names = []
        for path in ("daytime-pass", "terminator"):
            response = client.get("/api/mission/demo/" + path)
            assert response.status_code == 200, response.text
            scenario = MissionScenario.model_validate(response.json()["scenario"])
            assert scenario.duration_s == 86400
            assert scenario.power.battery.electrical.initial_soc == .5
            names.append(scenario.name)
            custom = scenario.model_dump(mode="json")
            custom["duration_s"] = 2 * 86400
            custom["orbit"]["elements"]["semi_major_axis_m"] += 10000
            custom["power"]["spacecraft_tx_electrical_w"] = 15
            assert MissionScenario.model_validate(custom).duration_s == 2 * 86400
        assert names[0] != names[1]

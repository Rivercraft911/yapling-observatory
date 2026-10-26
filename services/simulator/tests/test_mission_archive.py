"""Exact bounded replay import/export; no worker or numerical recomputation."""
from copy import deepcopy
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from cubesat_sim.api import create_app
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim import mission_archive as archive


def snapshot_for(data):
    scenario = MissionScenario.model_validate(data)
    result = run_mission(scenario)
    identity, digest = scenario.identity()
    return json.loads(json.dumps(dict(
        scenario=scenario.model_dump(mode="json"),
        run=dict(run_id="test-only-archive-wrapper", status="complete", scenario_id=identity,
                 scenario_hash=digest, result=result, error=None, progress=None),
    )))


@pytest.fixture(scope="module")
def snapshot():
    data = default_mission_scenario().model_dump(mode="json")
    data["duration_s"] = 60
    return snapshot_for(data)


def rehashed(snapshot):
    return archive.canonical_json(dict(
        format=archive.FORMAT, version=archive.VERSION, snapshot=snapshot,
        integrity=dict(algorithm="sha256", canonicalization=archive.CANONICALIZATION,
                       sha256=archive.content_digest(snapshot)),
    )).encode()


def test_exact_complete_roundtrip_and_cache_independent_raw_record_export(snapshot):
    original = deepcopy(snapshot)
    data = archive.export_archive(snapshot)
    opened = archive.import_archive(data)
    assert opened["snapshot"] == original == snapshot
    assert archive.export_archive(opened["snapshot"]) == data
    assert opened["import_metadata"] == dict(
        format=archive.FORMAT, version=1, sha256=archive.content_digest(snapshot),
        validation="structural_and_integrity_only", source_identity="retained_not_recomputed",
    )
    # Raw response retention preserves lexical negative zero lost by JSON.stringify.
    raw_record = json.dumps(snapshot["run"], separators=(",", ":")).encode()
    assert b"-0.0" in raw_record
    assert archive.import_archive(archive.export_request(raw_record))["snapshot"] == snapshot


@pytest.mark.parametrize("fraction,zero", [(0, True), (.0001, False)])
def test_stopped_valid_prefix_including_one_initial_sample(fraction, zero):
    data = default_mission_scenario().model_dump(mode="json")
    data["duration_s"] = 60
    data["power"]["battery"].pop("electrical", None)
    data["power"]["battery"]["initial_energy_fraction"] = fraction
    for panel in data["power"]["panels"]:
        panel["enabled"] = False
    snapshot = snapshot_for(data)
    result = snapshot["run"]["result"]
    completed = result["summary"]["computed_duration_s"]
    assert result["summary"]["end_reason"] == "power_unserved"
    assert completed == 0 if zero else 0 < completed < data["clocks"]["output_step_s"]
    snapshot["run"]["progress"] = dict(
        state="finished", completed_time_s=completed, requested_duration_s=60,
        fraction=completed/60, output_samples=len(result["samples"]["time_s"]), end_reason="power_unserved",
    )
    assert archive.import_archive(archive.export_archive(snapshot))["snapshot"] == snapshot


def test_old_source_hashes_and_dynamic_identifiers_are_retained_as_data(snapshot, monkeypatch):
    changed = deepcopy(snapshot)
    changed["run"]["result"]["manifest"]["source_code_hashes"] = {"old/source.py": "f"*64}
    changed["run"]["result"]["samples"]["power"]["component_electrical_w"]["custom.load"] = [0, 1, 2]
    encoded = rehashed(changed)
    monkeypatch.setattr(Path, "read_text", lambda *_args, **_kw: pytest.fail("Archive must not read source paths"))
    opened = archive.import_archive(encoded)
    assert opened["snapshot"] == changed
    assert opened["snapshot"]["run"]["run_id"] == "test-only-archive-wrapper"


def test_supported_older_scenario_presence_is_not_expanded_or_reidentified(snapshot):
    old = deepcopy(snapshot)
    raw = old["scenario"]
    raw["spacecraft"].pop("magnetic_unloading_enabled")
    raw["spacecraft"].pop("magnetic_unloading_time_constant_s")
    for wheel in raw["spacecraft"]["wheels"]:
        wheel.pop("initial_speed_rpm")
    digest = archive.content_digest(raw)
    identity = "mission-"+digest[:16]
    old["run"].update(scenario_hash=digest, scenario_id=identity)
    manifest = old["run"]["result"]["manifest"]
    manifest.update(scenario=deepcopy(raw), scenario_hash=digest, scenario_id=identity)
    for name in archive.UNLOADING_FIELDS:
        old["run"]["result"]["samples"]["gnc"].pop(name)
    opened = archive.import_archive(archive.export_archive(old))["snapshot"]
    assert opened == old
    assert "magnetic_unloading_enabled" not in opened["scenario"]["spacecraft"]


@pytest.mark.parametrize("mutation", [
    lambda s: s["run"].update(status="queued"),
    lambda s: s["run"].update(status="running"),
    lambda s: s["run"].update(status="cancelled"),
    lambda s: s["run"].update(status="failed"),
    lambda s: s["run"].update(error="failed"),
    lambda s: s["run"].update(result=None),
    lambda s: s["run"].update(progress={"state": "running"}),
    lambda s: s["run"]["result"]["manifest"].update(partial=True),
    lambda s: s["run"]["result"]["summary"].update(end_reason=[]),
    lambda s: s["run"]["result"]["summary"].update(end_reason={}),
    lambda s: s["run"]["result"]["summary"].update(computed_duration_s=0),
    lambda s: s["scenario"]["station"].update(latitude_deg=0),
    lambda s: s["run"]["result"]["manifest"]["scenario"]["station"].update(latitude_deg=0),
    lambda s: s["run"]["result"]["samples"]["time_s"].__setitem__(1, 0),
    lambda s: s["run"]["result"]["samples"]["elapsed_ns"].__setitem__(1, "1"),
    lambda s: s["run"]["result"]["samples"]["downlink"]["margin_db"].pop(),
    lambda s: s["run"]["result"]["samples"]["q_body_from_inertial_wxyz"].__setitem__(1, [1, 1, 0, 0]),
    lambda s: s["run"]["result"]["samples"]["satellite_position_m"].__setitem__(1, [1, 2]),
    lambda s: s["run"]["result"]["samples"]["sun_direction_ecef"].__setitem__(1, [0, 0, 0]),
    lambda s: s["run"]["result"]["samples"]["range_m"].__setitem__(1, True),
    lambda s: s["run"]["result"]["samples"]["power"]["pv_terminal_w"].__setitem__(1, False),
    lambda s: s["run"]["result"]["samples"]["power"]["energy_fraction"].__setitem__(1, -1),
    lambda s: s["run"]["result"]["samples"]["uplink"]["polarization_coupling"].__setitem__(1, 2),
    lambda s: s["run"]["result"]["summary"]["energy_j"].update(closure_residual_j=True),
    lambda s: s["scenario"]["clocks"].update(dynamics_step_s="1"),
    lambda s: s["scenario"]["spacecraft"]["wheels"][0]["spec"].update(spin_inertia_kg_m2=True),
    lambda s: s["run"]["result"]["samples"].update(time_s=list(range(20002))),
])
def test_rehashed_malformed_archives_reach_structural_rejection(snapshot, mutation):
    broken = deepcopy(snapshot)
    mutation(broken)
    with pytest.raises(archive.ArchiveError):
        archive.import_archive(rehashed(broken))


@pytest.mark.parametrize("body", [
    b'{"x":NaN}', b'{"x":Infinity}', b'{"x":-Infinity}', b'{"x":1e999}',
    b'{"x":1,"x":2}', b'{"nested":{"same":1,"same":2}}', b'{', b'\xff',
    b'['*(archive.MAX_DEPTH+1)+b'0'+b']'*(archive.MAX_DEPTH+1),
])
def test_invalid_json_depth_constants_and_duplicate_keys_are_rejected(body):
    with pytest.raises(archive.ArchiveError):
        archive.import_archive(body)


def test_corruption_versions_path_requests_and_size_limits(snapshot, monkeypatch):
    body = archive.export_archive(snapshot)
    for corrupted in (body[:-1], body.replace(b'"version":1', b'"version":2'),
                      body.replace(b'"ssi-json-v1"', b'"other"')):
        with pytest.raises(archive.ArchiveError):
            archive.import_archive(corrupted)
    envelope = json.loads(body)
    envelope["snapshot"]["run"]["run_id"] = "changed-without-checksum"
    with pytest.raises(archive.ArchiveError, match="checksum"):
        archive.import_archive(json.dumps(envelope).encode())
    with pytest.raises(archive.ArchiveError):
        archive.export_request(b'{"path":"/tmp/run.json"}')
    monkeypatch.setattr(archive, "MAX_ARCHIVE_BYTES", 1024)
    with pytest.raises(archive.ArchiveError, match="byte limit"):
        archive.parse_json(b' '*1025)
    monkeypatch.setattr(archive, "MAX_NODES", 3)
    with pytest.raises(archive.ArchiveError, match="node limit"):
        archive.parse_json(b'[1,2,3]')


def test_archive_routes_are_idle_worker_independent_and_byte_preserving(snapshot, monkeypatch):
    import cubesat_sim.mission_lab as routes
    calls = []
    real_threadpool = routes.run_in_threadpool
    async def traced_threadpool(function, *args, **kwargs):
        calls.append(function)
        return await real_threadpool(function, *args, **kwargs)
    monkeypatch.setattr(routes, "run_in_threadpool", traced_threadpool)
    raw = json.dumps(snapshot["run"], separators=(",", ":")).encode()
    with TestClient(create_app()) as client:
        manager = client.app.state.mission_jobs
        monkeypatch.setattr(manager, "create", lambda *_: pytest.fail("Archive must not start a worker"))
        saved = client.post("/api/mission/archive/export", content=raw, headers={"Content-Type": "application/json"})
        assert saved.status_code == 200
        opened = client.post("/api/mission/archive/import", content=saved.content, headers={"Content-Type": "application/json"})
        assert opened.status_code == 200
        assert opened.json()["snapshot"] == snapshot
        assert manager.jobs == {} and client.app.state.jobs.jobs == {}
        assert client.get("/api/mission/runs/"+snapshot["run"]["run_id"]).status_code == 404
        assert client.get("/api/health").status_code == 200
        assert client.post("/api/mission/archive/import", content=b'{').status_code == 422
    assert archive.export_request in calls and archive.import_archive in calls


def test_route_specific_limits_include_chunked_streams_without_length(monkeypatch):
    import cubesat_sim.api as api
    assert archive.MAX_ARCHIVE_BYTES == 64*1024*1024
    with TestClient(create_app()) as client:
        # The raised cap exists only on exact dedicated POST paths.
        large = b' '*(524288+1)
        assert client.post("/api/mission/archive/import", content=large).status_code == 422
        for path in ("/api/mission/runs", "/api/mission/archive/import/", "/api/mission/archive/import//",
                     "/api/mission/archive/%69mport"):
            assert client.post(path, content=large, follow_redirects=False).status_code == 413
        assert client.post("/api/mission/archive/import", content=b'', headers={"Content-Length": str(64*1024*1024+1)}).status_code == 413
    # Exercise actual streamed accounting at a small configured route cap.
    monkeypatch.setattr(api, "MAX_ARCHIVE_BYTES", 1024)
    with TestClient(create_app()) as client:
        def chunks():
            yield b' '*600
            yield b' '*600
        response = client.post("/api/mission/archive/import", content=chunks())
        assert response.status_code == 413
        assert "64 MiB" in response.json()["detail"]


def test_legitimate_binary_floating_clock_endpoint_roundoff_is_supported():
    data = default_mission_scenario().model_dump(mode="json")
    data["duration_s"] = .3
    data["clocks"].update(dynamics_step_s=.1, controller_period_s=.1,
                           thermal_step_s=.1, output_step_s=.1)
    snapshot = snapshot_for(data)
    assert snapshot["run"]["result"]["summary"]["computed_duration_s"] > .3
    assert archive.import_archive(archive.export_archive(snapshot))["snapshot"] == snapshot


def test_export_envelope_itself_obeys_depth_and_node_bounds(snapshot):
    bounded = deepcopy(snapshot)
    nested = 0
    for _ in range(20):
        nested = [nested]
    bounded["run"]["result"]["manifest"]["extra_metadata"] = nested
    archive.validate_snapshot(bounded)
    with pytest.raises(archive.ArchiveError, match="depth"):
        archive.export_archive(bounded)


@pytest.mark.parametrize("path", [
    ("samples", "power", "pv_terminal_w"),
    ("samples", "power", "stored_energy_j"),
    ("samples", "thermal", "node_absorbed_environment_w"),
    ("samples", "thermal", "node_emitted_ir_w"),
    ("summary", "energy_j", "mechanical_residual_j"),
])
def test_missing_core_history_columns_are_not_mislabeled_complete(snapshot, path):
    changed = deepcopy(snapshot)
    parent = changed["run"]["result"]
    for key in path[:-1]:
        parent = parent[key]
    parent.pop(path[-1])
    with pytest.raises(archive.ArchiveError):
        archive.import_archive(rehashed(changed))

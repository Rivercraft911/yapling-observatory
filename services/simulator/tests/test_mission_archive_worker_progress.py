"""Actual isolated-worker progress and synthetic archive-clock boundary checks."""
from copy import deepcopy
import asyncio
import json

import pytest

from cubesat_sim import mission_archive as archive
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission_jobs import MissionJobManager
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.operations.radio_delivery_models import delivery_example


@pytest.fixture(scope="module")
def worker_record():
    data = default_mission_scenario().model_dump(mode="json")
    data["duration_s"] = 60
    config = MissionScenario.model_validate(data)
    data["radio_delivery"] = delivery_example(config.uplink, config.downlink).model_dump(mode="json")
    config = MissionScenario.model_validate(data)
    async def execute():
        manager = MissionJobManager(timeout_s=10)
        job = manager.create(config)
        await asyncio.wait_for(job.task, timeout=15)
        assert job.status == "complete", job.error
        return json.loads(json.dumps(job.record()))
    return asyncio.run(execute())


def test_actual_worker_progress_roundtrips_without_reconstruction(worker_record):
    progress = worker_record["progress"]
    assert progress["state"] == "finished"
    assert {"reporting", "worker_elapsed_s", "execution_limits"} <= progress.keys()
    assert progress["worker_elapsed_s"] > 0
    raw = json.dumps(worker_record, separators=(",", ":")).encode()
    opened = archive.import_archive(archive.export_request(raw))["snapshot"]
    assert opened["run"] == worker_record
    assert archive.import_archive(archive.export_archive(opened))["snapshot"] == opened


@pytest.mark.parametrize("mutate", [
    lambda p: p.update(worker_elapsed_s=-1),
    lambda p: p["execution_limits"].update(maximum_dynamics_ticks=True),
    lambda p: p["execution_limits"].update(maximum_output_intervals=0),
    lambda p: p["execution_limits"].update(estimated_work_units=1e20),
    lambda p: p["execution_limits"].update(unrecognized=1),
    lambda p: p["reporting"]["days"][0]["downlink"].update(delivered_useful_bits=1),
])
def test_actual_progress_metadata_must_be_bounded_and_consistent(worker_record, mutate):
    changed = deepcopy(worker_record)
    mutate(changed["progress"])
    with pytest.raises(archive.ArchiveError):
        archive.export_request(json.dumps(changed).encode())


def test_thirty_day_tick_bound_without_a_thirty_day_simulation(worker_record):
    # This is an explicitly synthetic transport-validation scaffold, not a
    # simulated thirty-day trajectory. Actual long histories are checked privately.
    record = deepcopy(worker_record)
    record["progress"] = None
    result = record["result"]
    data = result["manifest"]["scenario"]
    data.pop("radio_delivery")
    data["duration_s"] = 30 * 86400
    data["clocks"]["output_step_s"] = 15 * 86400
    data["provenance"].append("Constructed archive clock-bound scaffold; state/energy history is not a30-day prediction")
    config = MissionScenario.model_validate(data)
    identity, digest = config.identity()
    data = config.model_dump(mode="json")
    record.update(scenario_id=identity, scenario_hash=digest)
    manifest = result["manifest"]
    manifest.update(scenario=data,scenario_id=identity,scenario_hash=digest)
    manifest.pop("radio_delivery",None)
    manifest["numerical_settings"].update(output_step_s=15*86400,completed_dynamics_ticks=30*86400)
    summary = result["summary"]
    summary.update(requested_duration_s=30*86400,computed_duration_s=30*86400)
    summary.pop("reporting")
    summary.pop("radio_delivery")
    samples = result["samples"]
    samples.pop("radio_delivery")
    samples["time_s"] = [0,15*86400,30*86400]
    samples["elapsed_ns"] = [str(value*1_000_000_000) for value in samples["time_s"]]
    snapshot = dict(scenario=data,run=record)
    opened = archive.import_archive(archive.export_archive(snapshot))["snapshot"]
    assert opened == snapshot
    assert opened["run"]["result"]["manifest"]["numerical_settings"]["completed_dynamics_ticks"] == 2_592_000
    record["result"]["manifest"]["numerical_settings"]["completed_dynamics_ticks"] = 3_000_001
    with pytest.raises(archive.ArchiveError):
        archive.export_archive(snapshot)

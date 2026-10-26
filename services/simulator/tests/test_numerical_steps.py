"""Continuous recorded step changes, exact replay and bounded LIVE transport."""
from copy import deepcopy
import asyncio
import json

import pytest
from pydantic import ValidationError

from cubesat_sim.mission import driver
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.numerics import NumericalStepIntent, numerical_step_options, planned_dynamics_ticks
from cubesat_sim.mission.runtime import RuntimeDirective
from cubesat_sim.mission_models import MissionScenario, PointingIntent
from cubesat_sim.mission_archive import export_archive, import_archive, ArchiveError
from cubesat_sim.live_mission_jobs import LiveMissionJobManager
from cubesat_sim.models import canonical_json


def mission(**changes):
    values = default_mission_scenario().model_dump(mode="json")
    values.update(duration_s=40, **changes)
    values["clocks"].update(controller_period_s=1, output_step_s=10)
    return MissionScenario.model_validate(values)


def normalized(value):
    return json.loads(json.dumps(value, allow_nan=False))


def snapshot(result):
    manifest = result["manifest"]
    return normalized(dict(scenario=manifest["scenario"], run=dict(run_id="step-test", status="complete",
        scenario_id=manifest["scenario_id"], scenario_hash=manifest["scenario_hash"], result=result, error=None)))


def replay(result):
    repeated = driver.run_mission(MissionScenario.model_validate(result["manifest"]["scenario"]))
    for key in ("samples", "summary", "events"):
        assert canonical_json(normalized(repeated[key])) == canonical_json(normalized(result[key])), key
    archive = export_archive(snapshot(result))
    assert import_archive(archive)["snapshot"] == snapshot(result)
    assert export_archive(import_archive(archive)["snapshot"]) == archive


class Runtime:
    telemetry_period_s = 1

    def __init__(self, commands=None, stop=None):
        self.commands = commands or {}
        self.stop = stop
        self.accepted, self.rejected, self.rows, self.transient, self.calls = [], [], [], [], []

    def before_step(self, time_s, boundary):
        self.calls.append((time_s, boundary))
        return RuntimeDirective(numerical_steps=tuple(self.commands.get(time_s, ())), stop=time_s == self.stop)

    def on_numerical_step(self, command):
        self.accepted.append(deepcopy(command))
        command["dynamics_step_s"] = 999

    def on_numerical_step_rejected(self, error):
        self.rejected.append(deepcopy(error))

    def on_command(self, command):
        pass

    def on_sample(self, row):
        self.rows.append(deepcopy(row))

    def on_telemetry(self, row):
        self.transient.append(deepcopy(row))


def intent(identifier, step):
    return NumericalStepIntent(command_id=identifier, dynamics_step_s=step)


def test_omitted_null_runtime_fields_preserve_identity_and_serialization():
    original = mission()
    for value in (None,):
        selected = MissionScenario.model_validate(original.model_dump(mode="json") | dict(
            numerical_step_commands=value, pointing_target_diagnostics=value))
        assert selected.identity() == original.identity()
        assert selected.model_dump(mode="json") == original.model_dump(mode="json")
    assert "numerical_step_commands" not in original.model_dump(mode="json")
    assert "pointing_target_diagnostics" not in original.model_dump(mode="json")


def test_live_changes_preserve_prefix_thermal_clock_receiver_and_exact_stopped_replay(monkeypatch):
    durations = []
    advance = driver.advance_thermal
    def thermal(*args, **kwargs):
        durations.append(args[3])
        return advance(*args, **kwargs)
    monkeypatch.setattr(driver, "advance_thermal", thermal)
    config = mission(pointing_target_diagnostics="ecef_v1")
    runtime = Runtime({3: (intent("fine", .25),), 7: (intent("medium", .5),), 13: (intent("normal", 1),)}, stop=17)
    result = driver.run_mission(config, runtime=runtime)
    assert [command["effective_time_s"] for command in runtime.accepted] == [3, 7, 13]
    assert not runtime.rejected
    assert durations == [10, 7]
    assert result["manifest"]["numerical_settings"]["completed_dynamics_ticks"] == 35
    assert result["samples"]["time_s"] == [0, 10, 17]
    assert result["summary"]["computed_duration_s"] == 17
    assert result["summary"]["uhf_beacon"]["tx_airtime_s"] == pytest.approx(.987136)
    before = Runtime()
    driver.run_mission(config, runtime=before)
    assert normalized([row for row in runtime.transient if row["time_s"] <= 3]) == normalized([row for row in before.transient if row["time_s"] <= 3])
    replay(result)


def test_stop_on_new_fractional_grid_and_stop_wins_over_same_batch():
    runtime = Runtime({2: (intent("fine", .5),)}, stop=3.5)
    result = driver.run_mission(mission(), runtime=runtime)
    assert result["samples"]["time_s"][-1] == 3.5
    assert result["manifest"]["scenario"]["stop_time_s"] == 3.5
    replay(result)
    stopped = Runtime({0: (intent("ignored", .25),)}, stop=0)
    result = driver.run_mission(mission(), runtime=stopped)
    assert not stopped.accepted and not stopped.rejected
    assert "numerical_step_commands" not in result["manifest"]["scenario"]
    replay(result)


def test_invalid_late_numerics_reject_without_reset_or_losing_valid_pointing_command():
    class Combined(Runtime):
        def before_step(self, time_s, boundary):
            if time_s == 2:
                return RuntimeDirective(numerical_steps=(intent("invalid", 2),), commands=(PointingIntent(command_id="sun", mode="sun_pointing"),))
    runtime = Combined()
    result = driver.run_mission(mission(), runtime=runtime)
    assert not runtime.accepted and len(runtime.rejected) == 1
    assert "does not divide" in runtime.rejected[0]["error"]
    assert result["manifest"]["scenario"]["pointing_commands"][0]["command_id"] == "sun"
    assert result["summary"]["computed_duration_s"] == 40
    assert "numerical_step_commands" not in result["manifest"]["scenario"]
    replay(result)


@pytest.mark.parametrize("step", [True, 0, .1, 3, float("nan"), float("inf")])
def test_invalid_step_intents(step):
    with pytest.raises(ValidationError):
        intent("invalid", step)


def test_only_aligned_choices_and_explicit_piecewise_tick_budget_are_allowed():
    config = mission()
    options = {item["dynamics_step_s"]: item for item in numerical_step_options(config, 1.25)}
    assert all(options[step]["allowed"] for step in (.25, .5, 1))
    assert not options[2]["allowed"] and "controller period" in options[2]["reason"]
    values = config.model_dump(mode="json")
    values["schedule"].update(uplink_duration_s=10, downlink_duration_s=60)
    values["clocks"]["controller_period_s"] = 2
    aligned = MissionScenario.model_validate(values | dict(numerical_step_commands=[dict(command_id="coarse", effective_time_s=4, dynamics_step_s=2)]))
    assert planned_dynamics_ticks(aligned) == 22
    replay(driver.run_mission(aligned))
    with pytest.raises(ValidationError, match="controller boundaries"):
        MissionScenario.model_validate(values | dict(numerical_step_commands=[dict(command_id="off", effective_time_s=3, dynamics_step_s=.5)]))
    values.update(duration_s=2592000)
    values["clocks"]["output_step_s"] = 180
    with pytest.raises(ValidationError, match="tick budget"):
        MissionScenario.model_validate(values | dict(numerical_step_commands=[dict(command_id="too-fine", effective_time_s=0, dynamics_step_s=.25)]))


def test_target_diagnostics_follow_accepted_operation_and_archive_rejects_invention():
    class Pointing(Runtime):
        def before_step(self, time_s, boundary):
            if time_s == 2:
                return RuntimeDirective(commands=(PointingIntent(command_id="map", mode="imaging", target_latitude_deg=37.4, target_longitude_deg=-122.2),))
    runtime = Pointing()
    result = driver.run_mission(mission(pointing_target_diagnostics="ecef_v1"), runtime=runtime)
    rows = runtime.transient
    assert next(row for row in rows if row["time_s"] == 2)["pointing_target_ecef_m"] is None
    assert next(row for row in rows if row["time_s"] == 3)["pointing_target_ecef_m"] is not None
    replay(result)
    changed = snapshot(result)
    changed["run"]["result"]["samples"]["pointing_target_ecef_m"][0] = [1,2,3]
    with pytest.raises(ArchiveError, match="invent"):
        export_archive(changed)


def test_actual_live_process_numerical_command_ack_stop_and_archive_replay():
    async def run():
        manager = LiveMissionJobManager()
        job = manager.create(mission(), speed=1)
        try:
            manager.numerical_command(job, intent("fine", .5))
            for _ in range(250):
                await asyncio.sleep(.02)
                if job.accepted_numerical:
                    break
            assert job.accepted_numerical, job.error
            manager.control(job, paused=True)
            for _ in range(100):
                await asyncio.sleep(.02)
                if job.progress.get("paused"):
                    break
            assert job.progress.get("paused")
            manager.numerical_command(job, intent("normal", 1))
            await asyncio.sleep(.06)
            assert "normal" not in job.accepted_numerical
            manager.control(job, speed=1000, paused=False)
            await asyncio.wait_for(job.task, 10)
            assert job.status == "complete", job.error
            record = manager.record(job)
            assert record["numerical_step_s"] == 1
            assert job.accepted_numerical["normal"]["effective_time_s"] % 1 == 0
            assert record["numerical_step_acks"][0]["command"]["command_id"] == "fine"
            assert record["pending_numerical_steps"] == 0
            assert record["initial_scenario"]["pointing_target_diagnostics"] == "ecef_v1"
            replay(job.final_snapshot["run"]["result"])
        finally:
            await manager.close()
    asyncio.run(run())


def test_numerics_api_validates_options_and_preserves_receipt_contract():
    from fastapi.testclient import TestClient
    from cubesat_sim.api import create_app
    with TestClient(create_app()) as client:
        response = client.post("/api/live", json=dict(scenario=mission().model_dump(mode="json"), speed=1))
        assert response.status_code == 202
        created = response.json()["session"]
        assert created["initial_scenario"]["pointing_target_diagnostics"] == "ecef_v1"
        identifier = created["live_id"]
        base = f"/api/live/{identifier}"
        assert client.post(base + "/numerics", json=dict(command_id="invalid", dynamics_step_s=2)).status_code == 409
        assert client.post(base + "/numerics", json=dict(command_id="invalid", dynamics_step_s=.1)).status_code == 422
        queued = client.post(base + "/numerics", json=dict(command_id="fine", dynamics_step_s=.5))
        assert queued.status_code == 202
        assert queued.json()["receipt"] == "queued"
        assert queued.json()["command_id"] == "fine"
        assert queued.json()["session"]["pending_numerical_steps"] >= 0
        assert client.post(base + "/numerics", json=dict(command_id="fine", dynamics_step_s=.25)).status_code == 409
        assert client.delete(base).status_code == 200


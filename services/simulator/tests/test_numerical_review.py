"""Independent boundary, malformed archive and mixed journal regression checks."""
import json

import pytest

from cubesat_sim import mission_archive as archive
from cubesat_sim.live_mission_jobs import LiveMissionJobManager, LiveSession
from cubesat_sim.mission import driver
from cubesat_sim.mission.numerics import NumericalStepIntent, planned_dynamics_ticks
from cubesat_sim.mission_models import MissionScenario, mission_execution_limits
from test_numerical_steps import Runtime, intent, mission, replay, snapshot


def test_coarser_then_finer_runtime_keeps_absolute_clocks_and_continuous_state(monkeypatch):
    values = mission().model_dump(mode="json")
    values["clocks"]["controller_period_s"] = 2
    values["schedule"].update(uplink_duration_s=10, downlink_duration_s=60)
    config = MissionScenario.model_validate(values)
    states, steps, thermal_spans = [], [], []
    integrate = driver.attitude_step
    advance_thermal = driver.advance_thermal

    def attitude(body, state, forcing, dt):
        if states:
            assert state == states[-1]
        result = integrate(body, state, forcing, dt)
        states.append(result.state)
        steps.append(dt)
        return result

    def thermal(*args, **kwargs):
        thermal_spans.append(args[3])
        return advance_thermal(*args, **kwargs)

    monkeypatch.setattr(driver, "attitude_step", attitude)
    monkeypatch.setattr(driver, "advance_thermal", thermal)
    runtime = Runtime({4: (intent("coarse", 2),), 12: (intent("fine", .5),),
                       18: (intent("normal", 1),)}, stop=23)
    result = driver.run_mission(config, runtime=runtime)
    assert steps == [1] * 4 + [2] * 4 + [.5] * 12 + [1] * 5
    assert thermal_spans == [10, 10, 3]
    assert result["samples"]["time_s"] == [0, 10, 20, 23]
    assert result["manifest"]["numerical_settings"]["completed_dynamics_ticks"] == 25
    assert [row["effective_time_s"] for row in runtime.accepted] == [4, 12, 18]
    assert not runtime.rejected
    final = MissionScenario.model_validate(result["manifest"]["scenario"])
    assert planned_dynamics_ticks(final) == 42
    environment_work = (40 / 10 * len(final.power.surfaces)
                        * final.power.earth_quadrature_rings
                        * final.power.earth_quadrature_azimuths)
    assert mission_execution_limits(final)["estimated_work_units"] == (
        42 * (1 + len(final.spacecraft.wheels) + final.clocks.orbit_substeps)
        + environment_work
    )
    monkeypatch.setattr(driver, "attitude_step", integrate)
    monkeypatch.setattr(driver, "advance_thermal", advance_thermal)
    replay(result)


def test_diagnostic_archive_missing_mode_is_a_normal_validation_rejection():
    result = driver.run_mission(mission(pointing_target_diagnostics="ecef_v1"))
    invalid = snapshot(result)
    invalid["run"]["result"]["samples"].pop("mode")
    with pytest.raises(archive.ArchiveError, match="mode"):
        archive.export_archive(invalid)


def test_mixed_numerical_ack_rejection_and_sample_journal_shares_one_watermark(tmp_path):
    manager = LiveMissionJobManager()
    job = LiveSession(mission(), speed=1)
    job.base = tmp_path
    job.status = "running"
    job.progress = dict(computed_time_s=10)
    for identifier in ("accepted", "rejected", "pending"):
        job.numerical_intents[identifier] = NumericalStepIntent(
            command_id=identifier, dynamics_step_s=.5
        )
    accepted = dict(command_id="accepted", effective_time_s=2, dynamics_step_s=.5)
    rejected = dict(command_id="rejected", effective_time_s=2, error="Constructed rejection")
    events = [
        dict(sequence=1, kind="sample", value=dict(time_s=0)),
        dict(sequence=2, kind="numerical_step", value=accepted),
        dict(sequence=3, kind="numerical_step_rejection", value=rejected),
        dict(sequence=4, kind="sample", value=dict(time_s=10)),
    ]
    (tmp_path / "telemetry.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
    manager._drain(job)
    record = manager.record(job, 1, renew=False)
    assert record["next_sequence"] == record["latest_sequence"] == 4
    assert record["numerical_step_acks"] == [dict(sequence=2, command=accepted)]
    assert record["numerical_step_errors"] == [dict(sequence=3, **rejected)]
    assert record["samples"] == [dict(sequence=4, row=dict(time_s=10))]
    assert record["pending_numerical_steps"] == 1
    assert record["numerical_step_s"] == .5
    drained = manager.record(job, 4, renew=False)
    assert not drained["numerical_step_acks"] and not drained["numerical_step_errors"]
    assert not drained["samples"] and drained["next_sequence"] == 4
    job.status = "complete"
    final = manager.record(job, 4, renew=False)
    assert final["pending_numerical_steps"] == 0
    assert final["unapplied_numerical_step_ids"] == ["pending"]

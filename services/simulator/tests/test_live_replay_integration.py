"""Independent real-process replay checks with nonzero RF and fractional clocks."""

import asyncio

import pytest

from cubesat_sim.live_mission_jobs import LiveMissionJobManager
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission_archive import import_archive
from cubesat_sim.mission_models import MissionScenario, PointingIntent
from cubesat_sim.models import canonical_json
from test_mission_rf_efficiency import config as visible_rf_config


def assert_exact_replay(job):
    snapshot = job.final_snapshot
    assert import_archive(job.archive)["snapshot"] == snapshot
    scenario = MissionScenario.model_validate(snapshot["scenario"])
    result = snapshot["run"]["result"]

    def final_row(columns):
        return {
            key: final_row(value) if isinstance(value, dict) else value[-1]
            for key, value in columns.items()
        }

    assert canonical_json(job.latest_telemetry) == canonical_json(
        final_row(result["samples"])
    )
    replay = run_mission(scenario)
    for field in ("samples", "summary", "events"):
        assert canonical_json(replay[field]) == canonical_json(result[field]), field
    assert scenario.identity() == (
        snapshot["run"]["scenario_id"],
        snapshot["run"]["scenario_hash"],
    )
    return result


@pytest.mark.parametrize("additional_efficiency", [0, 0.5])
def test_real_worker_preserves_rf_zero_and_half_loss_during_exact_replay(
    additional_efficiency,
):
    async def execute():
        manager = LiveMissionJobManager()
        job = manager.create(visible_rf_config(additional_efficiency), 1000)
        try:
            await asyncio.wait_for(job.task, 10)
            assert job.status == "complete", job.error
            result = assert_exact_replay(job)
            assert result["samples"]["visible"] == [True] * 5
            energy = result["summary"]["energy_j"]["escaped_rf_j"]
            payload = result["samples"]["radio_delivery"]["downlink"][
                "delivered_useful_bits"
            ][-1]
            if additional_efficiency == 0:
                assert energy == payload == 0
                assert result["samples"]["downlink"]["received_power_dbw"] == [None] * 5
            else:
                assert energy > 0 and payload > 0
        finally:
            await manager.close()

    asyncio.run(execute())


def test_paused_stop_at_zero_does_not_apply_queued_command_or_advance_state():
    async def execute():
        initial = visible_rf_config(0.5)
        manager = LiveMissionJobManager()
        job = manager.create(initial, 1000)
        manager.control(job, paused=True)
        manager.command(job, PointingIntent(command_id="never-applied", mode="imaging"))
        manager.control(job, stop=True)
        try:
            await asyncio.wait_for(job.task, 10)
            assert job.status == "complete", job.error
            result = assert_exact_replay(job)
            assert result["summary"]["end_reason"] == "user_stop"
            assert result["summary"]["computed_duration_s"] == 0
            assert result["samples"]["time_s"] == [0]
            assert result["samples"]["q_body_from_inertial_wxyz"][0] == list(
                initial.spacecraft.initial_q_body_from_inertial_wxyz
            )
            assert result["summary"]["energy_j"]["escaped_rf_j"] == 0
            assert result["manifest"]["scenario"]["pointing_commands"] is None
            assert job.accepted == {}
            record = manager.record(job)
            assert record["unapplied_command_ids"] == ["never-applied"]
            assert record["pending_commands"] == 0
            expected_inputs = initial.model_dump(mode="json") | dict(pointing_target_diagnostics="ecef_v1")
            assert record["initial_scenario"] == expected_inputs
            accepted_initial = MissionScenario.model_validate(expected_inputs)
            assert (record["initial_scenario_id"], record["initial_scenario_hash"]) == accepted_initial.identity()
            assert record["initial_scenario_hash"] != initial.identity()[1]
            assert job.final_snapshot["run"]["scenario_hash"] != accepted_initial.identity()[1]
        finally:
            await manager.close()

    asyncio.run(execute())


def test_fractional_clock_command_and_continuous_rotating_state_replay_with_real_rf():
    async def execute():
        values = visible_rf_config(0.5).model_dump(mode="json")
        values["clocks"].update(
            dynamics_step_s=0.25, controller_period_s=0.5, output_step_s=2
        )
        rate = [0.0003, -0.0002, 0.0001]
        values["spacecraft"]["initial_omega_body_rad_s"] = rate
        values["pointing_commands"] = [
            dict(command_id="preplanned-sun", effective_time_s=2, mode="sun_pointing")
        ]
        initial = MissionScenario.model_validate(values)
        manager = LiveMissionJobManager()
        job = manager.create(initial, 1000)
        manager.control(job, paused=True)
        manager.command(
            job, PointingIntent(command_id="live-ground", mode="ground_tracking")
        )
        manager.control(job, paused=False)
        try:
            await asyncio.wait_for(job.task, 10)
            assert job.status == "complete", job.error
            result = assert_exact_replay(job)
            assert job.accepted["live-ground"]["effective_time_s"] == 0
            assert result["samples"]["time_s"] == [0, 2, 4]
            assert result["samples"]["mode"] == [
                "ground_tracking",
                "ground_tracking",
                "sun_pointing",
            ]
            assert result["summary"]["energy_j"]["escaped_rf_j"] > 0
            assert (
                result["samples"]["radio_delivery"]["downlink"][
                    "delivered_useful_bits"
                ][-1]
                > 0
            )
            assert result["samples"]["gnc"]["omega_body_rad_s"] == [rate] * 3
            assert (
                result["samples"]["q_body_from_inertial_wxyz"][0]
                != result["samples"]["q_body_from_inertial_wxyz"][1]
            )
            assert [
                command["command_id"]
                for command in result["manifest"]["scenario"]["pointing_commands"]
            ] == ["live-ground", "preplanned-sun"]
        finally:
            await manager.close()

    asyncio.run(execute())

"""Explicit month budgets, clock bounds and isolated-worker failure semantics."""

import asyncio
from copy import deepcopy
import pytest
from pydantic import ValidationError
from fastapi.testclient import TestClient
from cubesat_sim.api import create_app
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission_models import MissionScenario, mission_execution_limits
from cubesat_sim.mission_jobs import MissionJobManager


def config(days=30):
    value = default_mission_scenario().model_dump(mode="json")
    value["duration_s"] = days * 86400
    value["clocks"]["output_step_s"] = 120 if days == 7 else 180
    return value


def test_month_and_week_keep_physics_clocks_and_bound_samples_work_and_wall():
    for days, output in ((7, 120), (30, 180)):
        c = MissionScenario.model_validate(config(days))
        assert c.clocks.dynamics_step_s == 1
        assert c.clocks.controller_period_s == 2
        assert c.clocks.thermal_step_s == 10
        assert c.clocks.output_step_s == output
        limits = mission_execution_limits(c)
        assert limits["estimated_work_units"] < limits["maximum_work_units"]
        assert 180 < limits["worker_wall_limit_s"] <= 3600
        assert c.duration_s / c.clocks.output_step_s <= 20000
    short = default_mission_scenario()
    assert mission_execution_limits(short)["worker_wall_limit_s"] == 180


def test_month_is_explicit_not_unbounded_and_never_silently_coarsens():
    for mutation, match in (
        (lambda v: v.update(duration_s=31 * 86400), "less than or equal"),
        (lambda v: v.update(run_kind="targeted"), "long_mission"),
        (lambda v: v["clocks"].update(output_step_s=30), "20000"),
        (lambda v: v["clocks"].update(dynamics_step_s=0.25), "3000000"),
        (lambda v: v["clocks"].update(orbit_substeps=3), "6000000"),
    ):
        value = config()
        mutation(value)
        with pytest.raises(ValidationError, match=match):
            MissionScenario.model_validate(value)
    value = config()
    value["orbit"]["elements"]["epoch_utc"] = "2029-12-15T00:00:00Z"
    with pytest.raises(ValidationError, match="2030"):
        MissionScenario.model_validate(value)


def test_expensive_month_rejected_by_api_and_manager_before_retention_mutation():
    value = config()
    value["power"].update(earth_quadrature_rings=16, earth_quadrature_azimuths=64)
    scenario = MissionScenario.model_validate(value)
    assert mission_execution_limits(scenario)["estimated_work_units"] > 300_000_000
    manager = MissionJobManager()
    sentinel = object()
    manager.jobs = {"previous": sentinel}
    with pytest.raises(ValueError, match="work-unit"):
        manager.create(scenario)
    assert manager.jobs == {"previous": sentinel}
    with TestClient(create_app()) as client:
        response = client.post("/api/mission/runs", json={"scenario": value})
        assert response.status_code == 422
        assert "work-unit" in response.json()["detail"]


def test_explicit_worker_timeout_cannot_publish_complete_or_fabricated_result():
    async def run():
        manager = MissionJobManager(timeout_s=0)
        value = default_mission_scenario().model_dump(mode="json")
        value["duration_s"] = 30
        job = manager.create(MissionScenario.model_validate(value))
        await job.task
        assert job.status == "failed"
        assert job.result is None
        assert "time budget" in job.error
        assert job.process is None
        await manager.close()
    asyncio.run(run())


def test_worker_publication_size_guard_is_atomic_and_does_not_replace_valid_data(tmp_path):
    from cubesat_sim.mission_worker import atomic_json
    destination = tmp_path / "result.json"
    atomic_json(destination, {"valid": True}, maximum_bytes=100)
    original = destination.read_bytes()
    with pytest.raises(ValueError, match="64 MiB"):
        atomic_json(destination, {"too_wide": "x" * 101}, maximum_bytes=100)
    assert destination.read_bytes() == original
    assert not destination.with_suffix(".partial").exists()

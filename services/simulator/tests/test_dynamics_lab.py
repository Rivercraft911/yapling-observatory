"""Strict standalone transport defaults and genuinely computed route outputs."""

from copy import deepcopy
import math

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from cubesat_sim.dynamics_lab import (
    AttitudeStudyRequest,
    OrbitStudyRequest,
    defaults,
    router,
)


def client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_defaults_are_validated_json_inputs_and_return_computed_results():
    with client() as connection:
        payload = connection.get("/api/dynamics-lab/defaults").json()
        assert payload["controllers"] == ["coast", "quaternion_pd", "magnetic_bdot"]
        assert "Illustrative" in payload["scope"]
        orbit = connection.post("/api/dynamics-lab/orbit", json=payload["orbit"])
        assert orbit.status_code == 200
        assert orbit.json()["result"]["steps"] == 1200
        assert len(orbit.json()["result"]["states"]) == 601
        attitude = connection.post(
            "/api/dynamics-lab/attitude", json=payload["attitude"]
        )
        assert attitude.status_code == 200
        result = attitude.json()
        assert result["summary"]["physics_steps"] == 2500
        assert result["samples"][-1]["pointing_error_rad"] < 0.001
        assert not result["summary"]["wheel_overspeed"]
        assert all(
            math.isfinite(s["mechanics"]["rotational_energy_j"])
            for s in result["samples"]
        )
        payload["orbit"]["config"]["method"] = "velocity_verlet"
        verlet = connection.post(
            "/api/dynamics-lab/orbit", json=payload["orbit"]
        ).json()
        assert verlet["result"]["method"] == "velocity_verlet"
        assert verlet["result"]["maximum_relative_angular_momentum_change"] < 1e-13


def test_strict_inputs_reject_unknown_fields_numeric_strings_bad_inertia_and_clocks():
    original = defaults()["attitude"]
    changes = [
        ("extra", True),
        ("controller", "lqr"),
        ("duration_s", "50"),
        ("free_roll", 1),
        ("controller_period_s", 0.03),
    ]
    with client() as connection:
        for key, value in changes:
            payload = deepcopy(original)
            payload[key] = value
            assert (
                connection.post("/api/dynamics-lab/attitude", json=payload).status_code
                == 422
            )
        for tensor in (
            ((0.001, 0, 0), (0, 0.001, 0), (0, 0, 0.003)),
            ((0.002, 0.001, 0), (0, 0.002, 0), (0, 0, 0.002)),
        ):
            payload = deepcopy(original)
            payload["body"]["locked_inertia_kg_m2"] = tensor
            assert (
                connection.post("/api/dynamics-lab/attitude", json=payload).status_code
                == 422
            )
        payload = deepcopy(original)
        payload["initial"]["q_body_from_inertial_wxyz"] = [2, 0, 0, 0]
        assert (
            connection.post("/api/dynamics-lab/attitude", json=payload).status_code
            == 422
        )
        payload = deepcopy(original)
        payload["body"]["wheels"][0]["invented_hardware_gain"] = 1
        assert (
            connection.post("/api/dynamics-lab/attitude", json=payload).status_code
            == 422
        )


def test_nonfinite_inputs_and_unbounded_work_rejected_before_numerical_run():
    for field in ("physics_step_s", "duration_s", "unloading_gain_s_inv"):
        payload = defaults()["attitude"]
        payload[field] = float("nan")
        with pytest.raises(ValidationError):
            AttitudeStudyRequest.model_validate(payload)
    payload = defaults()["attitude"]
    payload["duration_s"] = 7200
    with pytest.raises(ValidationError):
        AttitudeStudyRequest.model_validate(payload)
    orbit = defaults()["orbit"]
    orbit["initial"]["position_m"][0] = float("inf")
    with pytest.raises(ValidationError):
        OrbitStudyRequest.model_validate(orbit)
    orbit = defaults()["orbit"]
    orbit["config"]["method"] = "energy_exact"
    with pytest.raises(ValidationError):
        OrbitStudyRequest.model_validate(orbit)

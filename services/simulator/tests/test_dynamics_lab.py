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
from cubesat_sim.mission.ephemeris import mean_sun_ra_deg
from cubesat_sim.orbit.elements import elements_to_cartesian


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


def test_elements_j2_route_uses_full_potential_and_reports_actual_node_drift():
    payload = defaults()["orbit"]
    payload.update(initialization="elements", duration_s=86400.0, output_step_s=120.0)
    payload["config"].update(force_model="j2", method="velocity_verlet", step_s=20.0)
    payload["elements"].update(
        semi_major_axis_m=7e6,
        eccentricity=0.03,
        inclination_deg=97.8,
        raan_deg=20.0,
        argument_of_periapsis_deg=30.0,
        true_anomaly_deg=40.0,
    )
    with client() as connection:
        response = connection.post("/api/dynamics-lab/orbit", json=payload)
    assert response.status_code == 200
    value = response.json()
    assert value["request"] == payload
    assert value["result"]["force_model"] == "j2"
    assert value["result"]["maximum_relative_energy_change"] < 2e-5
    assert value["result"]["maximum_scaled_axial_angular_momentum_change"] < 1e-13
    assert value["result"]["maximum_relative_angular_momentum_change"] > 0.01
    assert 0.9 < value["nodes"]["fitted_raan_rate_deg_day"] < 1.1
    assert value["resolved_initial_elements"]["inclination_deg"] == 97.8
    assert "full selected potential" in " ".join(value["limits"])


def test_solar_time_routes_and_linked_initialization_have_one_epoch_mean_sun():
    epoch = "2026-10-25T00:00:00Z"
    with client() as connection:
        for hours, expected in ((18.0, 120.0), (6.0, 300.0)):
            response = connection.post(
                "/api/dynamics-lab/orbit/solar-node",
                json=dict(
                    epoch_utc=epoch,
                    mean_sun_ra_deg=30.0,
                    local_mean_solar_time_hours=hours,
                ),
            )
            assert response.status_code == 200
            assert response.json()["raan_deg"] == expected
        result = connection.post(
            "/api/dynamics-lab/orbit/solar-node",
            json=dict(
                epoch_utc=epoch,
                node_definition="raan",
                raan_deg=480.0,
            ),
        ).json()
        assert result["mean_sun_ra_deg"] == mean_sun_ra_deg(epoch)
        assert result["raan_deg"] == 120.0
        assert "MEAN" in result["convention"]
        assert (
            connection.post(
                "/api/dynamics-lab/orbit/solar-node",
                json=dict(
                    epoch_utc="2026-10-25",
                    node_definition="raan",
                    raan_deg=120.0,
                ),
            ).status_code
            == 422
        )
        reference = connection.post(
            "/api/dynamics-lab/orbit/sso-reference",
            json=dict(
                semi_major_axis_m=7078136.3,
            ),
        ).json()
        assert reference["inclination_deg"] == pytest.approx(98.2, abs=0.1)
        assert "not an exact SSO" in reference["convention"]
    payload = defaults()["orbit"]
    payload.update(initialization="elements", node_definition="ltan")
    payload["elements"]["raan_deg"] = 999.0
    request = OrbitStudyRequest.model_validate(payload)
    resolved = request.resolved_elements()
    assert resolved.raan_deg == pytest.approx((mean_sun_ra_deg(epoch) + 90) % 360)
    expected = elements_to_cartesian(resolved, request.config.mu_m3_s2)
    assert request.to_input().initial.position_m == expected.position_m


def test_strict_gravity_and_element_validation_before_propagation():
    for key, value in (
        ("force_model", "egm2008_full"),
        ("j2", float("nan")),
        ("reference_radius_m", -1.0),
    ):
        payload = defaults()["orbit"]
        payload["config"][key] = value
        with pytest.raises(ValidationError):
            OrbitStudyRequest.model_validate(payload)
    for key, value in (
        ("eccentricity", 1.0),
        ("inclination_deg", 181.0),
        ("epoch_utc", "2026-10-25T00:00:00"),
    ):
        payload = defaults()["orbit"]
        payload["elements"][key] = value
        with pytest.raises(ValidationError):
            OrbitStudyRequest.model_validate(payload)
    orbit = defaults()["orbit"]
    orbit["config"]["method"] = "energy_exact"
    with pytest.raises(ValidationError):
        OrbitStudyRequest.model_validate(orbit)

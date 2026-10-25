import math

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from cubesat_sim.antenna_lab import PatternRequest, RunProbe, orientation_matrix, pattern_response, probe_response, sample_pattern
from cubesat_sim.api import create_app
from cubesat_sim.physics import dot, matvec, norm, polarization_coupling


@pytest.mark.parametrize("model", ["dipole", "turnstile", "patch"])
def test_lab_power_and_complex_field_normalization(model):
    request = PatternRequest(model=model, efficiency=.73, polar_steps=72, azimuth_steps=144)
    result = sample_pattern(request)
    assert result["sphere_mean_gain"] == pytest.approx(.73, abs=5e-4)
    grid = result["grid"]
    for direction, gain, real, imaginary in zip(grid["directions_body"], grid["gain_linear"], grid["field_real"], grid["field_imag"]):
        if real is None:
            assert gain == 0
        else:
            field = [complex(a, b) for a, b in zip(real, imaginary)]
            assert norm(field)**2 == pytest.approx(gain, abs=1e-14)
            assert abs(dot(direction, field)) < 1e-13


def test_patch_power_quadrature_converges_with_angular_resolution():
    coarse = sample_pattern(PatternRequest(model="patch", efficiency=.73, polar_steps=24, azimuth_steps=48))
    fine = sample_pattern(PatternRequest(model="patch", efficiency=.73, polar_steps=72, azimuth_steps=144))
    assert abs(fine["sphere_mean_gain"]-.73) < abs(coarse["sphere_mean_gain"]-.73)/4


@pytest.mark.parametrize("model", ["dipole", "turnstile", "patch"])
def test_lab_rotation_preserves_gain_and_polarization(model):
    original = PatternRequest(model=model)
    rotated = PatternRequest(model=model, orientation_deg=(17, -28, 42))
    matrix = orientation_matrix(rotated.orientation_deg)
    look = (.2, .9, .3)
    a = pattern_response(original, look)
    b = pattern_response(rotated, matvec(matrix, look))
    assert b.gain_linear == pytest.approx(a.gain_linear, abs=1e-14)
    assert b.polarization == pytest.approx(matvec(matrix, a.polarization), abs=1e-14)
    analyzer = (1, 0, 0)
    assert polarization_coupling(b.polarization, matvec(matrix, analyzer)) == pytest.approx(polarization_coupling(a.polarization, analyzer), abs=1e-14)


def test_lab_null_and_circular_linear_limits():
    null = probe_response(PatternRequest(model="dipole", probe_azimuth_deg=0))
    assert null["gain_linear"] == 0
    assert null["gain_dbi"] is None and null["linear_coupling"] is None
    assert null["field_real"] is None
    for roll in (0, 21, 90):
        circular = probe_response(PatternRequest(model="turnstile", probe_azimuth_deg=90, linear_feed_roll_deg=roll))
        assert circular["gain_linear"] == pytest.approx(1.5)
        assert circular["linear_coupling"] == pytest.approx(.5)
    patch_back = probe_response(PatternRequest(model="patch", probe_azimuth_deg=-90))
    assert patch_back["gain_linear"] == 0 and patch_back["linear_coupling"] is None


def test_v45_is_unresolved_and_zero_efficiency_is_zero():
    unknown = sample_pattern(PatternRequest(model="v45", polar_steps=12, azimuth_steps=24))
    assert unknown["status"] == "unresolved" and unknown["grid"] is None
    assert unknown["probe"]["gain_linear"] is None and unknown["probe"]["linear_coupling"] is None
    zero = probe_response(PatternRequest(model="dipole", efficiency=0))
    assert zero["gain_linear"] == 0 and zero["linear_coupling"] is None


def test_run_probe_uses_declared_hamilton_body_rotation_and_validates_inputs():
    run = RunProbe(spacecraft_position_m=(0, 0, 0), station_position_m=(1, 0, 0),
                   q_body_from_inertial_wxyz=(2**-.5, 0, 0, 2**-.5))
    result = probe_response(PatternRequest(model="turnstile", run_probe=run))
    assert result["direction_body"] == pytest.approx((0, 1, 0), abs=1e-14)
    assert result["gain_linear"] == pytest.approx(1.5)
    with pytest.raises(ValidationError):
        RunProbe.model_validate(run.model_dump() | {"q_body_from_inertial_wxyz": (2, 0, 0, 0)})
    for change in ({"efficiency": float("nan")}, {"orientation_deg": (0, float("inf"), 0)}, {"polar_steps": 1000}, {"unknown": 1}):
        with pytest.raises(ValidationError): PatternRequest.model_validate(change)


def test_lab_routes_are_bounded_and_probe_does_not_sample_sphere(monkeypatch):
    with TestClient(create_app()) as client:
        assert set(client.get("/api/antenna-lab/catalog").json()["models"]) == {"dipole", "turnstile", "patch", "v45", "bent_v_up_45", "bent_v_out_45"}
        def should_not_sample(*_args, **_kwargs):
            raise AssertionError("Probe must not resample the sphere")
        monkeypatch.setattr("cubesat_sim.antenna_lab.sample_pattern", should_not_sample)
        response = client.post("/api/antenna-lab/probe", json={"model": "turnstile"})
        assert response.status_code == 200
        assert response.json()["linear_coupling"] == pytest.approx(.5)
        assert client.post("/api/antenna-lab/pattern", json={"azimuth_steps": 100000}).status_code == 422

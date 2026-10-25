"""Standalone bent-current lab contract; installed v45 remains unresolved."""
import math

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from cubesat_sim.antenna_models import PatternRequest
from cubesat_sim.api import create_app
from cubesat_sim.geometry.vectors import dot, matvec, norm
from cubesat_sim.rf.free_space import C_M_S
from cubesat_sim.rf.pattern_sampling import _bent_model, orientation_matrix, pattern_response, sample_pattern


@pytest.mark.parametrize("model", ["bent_v_up_45", "bent_v_out_45"])
def test_lab_complex_field_power_orientation_and_source(model):
    request = PatternRequest(model=model, efficiency=0.73, polar_steps=48, azimuth_steps=96)
    result = sample_pattern(request)
    assert result["status"] == "analytical"
    assert result["sphere_mean_gain"] == pytest.approx(0.73, abs=3e-4)
    assert result["expected_sphere_mean_gain"] == 0.73
    assert result["source"]["path"].endswith("rf/bent_wire.py")
    assert "prescribed-current" in result["source"]["evidence"]
    grid = result["grid"]
    for direction, gain, real, imaginary in zip(grid["directions_body"], grid["gain_linear"], grid["field_real"], grid["field_imag"]):
        field = tuple(complex(a, b) for a, b in zip(real, imaginary))
        assert norm(field) ** 2 == pytest.approx(gain, abs=1e-14)
        assert abs(dot(direction, field)) < 2e-14
    angles = (17, -28, 42)
    rotated = request.model_copy(update={"orientation_deg": angles})
    matrix = orientation_matrix(angles)
    look = (0.7, 0.4, 0.5)
    original = pattern_response(request, look)
    actual = pattern_response(rotated, matvec(matrix, look))
    assert actual.gain_linear == pytest.approx(original.gain_linear, abs=1e-14)
    assert actual.polarization == pytest.approx(matvec(matrix, original.polarization), abs=1e-14)


def test_shape_cache_ignores_probe_grid_and_pose():
    _bent_model.cache_clear()
    first = PatternRequest(model="bent_v_up_45")
    pattern_response(first, (0, 1, 0))
    cached = _bent_model(first.model, first.frequency_hz, first.arm_length_m, first.efficiency)
    integral = cached.normalization_integral
    second = first.model_copy(update={"orientation_deg": (12, 8, 31), "probe_azimuth_deg": 15, "polar_steps": 24})
    pattern_response(second, (0.2, 0.9, 0.3))
    assert _bent_model.cache_info().misses == 1
    assert cached.normalization_integral is integral


@pytest.mark.parametrize("change", [
    dict(frequency_hz=float("nan")), dict(frequency_hz=float("inf")), dict(frequency_hz=1),
    dict(arm_length_m=0), dict(arm_length_m=float("nan")), dict(arm_length_m=0.4),
    dict(efficiency=1.01), dict(frequency_hz=2.4e9),
])
def test_bent_contract_rejects_nonfinite_or_out_of_scope_inputs(change):
    with pytest.raises(ValidationError):
        PatternRequest(model="bent_v_up_45", **change)


def test_quarter_wave_reference_is_explicit_and_does_not_retune_with_frequency():
    request = PatternRequest(model="bent_v_up_45")
    assert request.frequency_hz == 438e6
    assert request.arm_length_m == pytest.approx(C_M_S / (4 * 438e6))
    changed = PatternRequest(model="bent_v_up_45", frequency_hz=500e6)
    assert changed.arm_length_m == request.arm_length_m
    assert pattern_response(changed, (0, 1, 0)).gain_linear != pytest.approx(pattern_response(request, (0, 1, 0)).gain_linear, abs=1e-3)


def test_http_bent_pattern_probe_and_old_installed_v45_boundary():
    with TestClient(create_app()) as client:
        for model in ("bent_v_up_45", "bent_v_out_45"):
            payload = dict(model=model, polar_steps=12, azimuth_steps=24, efficiency=0.73)
            result = client.post("/api/antenna-lab/pattern", json=payload)
            assert result.status_code == 200
            body = result.json()
            assert body["status"] == "analytical"
            assert body["sphere_mean_gain"] == pytest.approx(0.73, abs=0.003)
            assert all(math.isfinite(g) and g >= 0 for g in body["grid"]["gain_linear"])
            probe = client.post("/api/antenna-lab/probe", json=payload).json()
            assert 0 <= probe["linear_coupling"] <= 1
            assert sum(a*a + b*b for a, b in zip(probe["field_real"], probe["field_imag"])) == pytest.approx(probe["gain_linear"])
        unknown = client.post("/api/antenna-lab/pattern", json=dict(model="v45", polar_steps=12, azimuth_steps=24)).json()
        assert unknown["status"] == "unresolved" and unknown["grid"] is None
        assert unknown["probe"]["gain_linear"] is None
        assert client.post("/api/antenna-lab/pattern", json=dict(model="bent_v_up_45", arm_length_m=0.4)).status_code == 422

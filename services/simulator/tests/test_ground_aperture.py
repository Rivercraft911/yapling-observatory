"""Independent aperture reference, scaling, validation and API boundaries."""

import math

from fastapi.testclient import TestClient
import pytest

from cubesat_sim.api import create_app
from cubesat_sim.models import Scenario, default_scenario
from cubesat_sim.rf.aperture import circular_aperture_gain


def test_reported_dish_with_explicit_example_efficiency_matches_decimal_reference():
    # Independent 60-digit Decimal calculation; eta=0.55 is a test, not a default.
    result = circular_aperture_gain(1.9, 2.4e9, 0.55)
    assert result["wavelength_m"] == pytest.approx(0.12491352416666666667, rel=1e-15)
    assert result["peak_gain_dbi"] == pytest.approx(30.98950714355526414, abs=1e-12)
    assert result["aperture_efficiency"] == 0.55
    assert result["evidence_status"] == "analytical_estimate"
    assert "printed p. 8" in result["source"]["locator"]
    assert "not a measured gain" in result["assumptions"]


def test_aperture_invariants_and_efficiency_are_distinct_from_transmitter_power():
    ideal = circular_aperture_gain(299792458 / (2.4e9 * math.pi), 2.4e9, 1)
    assert ideal["peak_gain_dbi"] == pytest.approx(0, abs=1e-12)
    base = circular_aperture_gain(1.9, 2.4e9, 0.5)["peak_gain_dbi"]
    doubled_diameter = circular_aperture_gain(3.8, 2.4e9, 0.5)["peak_gain_dbi"]
    doubled_frequency = circular_aperture_gain(1.9, 4.8e9, 0.5)["peak_gain_dbi"]
    half_efficiency = circular_aperture_gain(1.9, 2.4e9, 0.25)["peak_gain_dbi"]
    assert doubled_diameter - base == pytest.approx(6.020599913279624, abs=1e-12)
    assert doubled_frequency - base == pytest.approx(6.020599913279624, abs=1e-12)
    assert half_efficiency - base == pytest.approx(-3.010299956639812, abs=1e-12)


@pytest.mark.parametrize("position", [0, 1, 2])
@pytest.mark.parametrize("value", [0, -1, True, "1", float("nan"), float("inf")])
def test_invalid_physical_inputs_are_rejected(position, value):
    values = [1.9, 2.4e9, 0.55]
    values[position] = value
    with pytest.raises(ValueError):
        circular_aperture_gain(*values)


def test_aperture_efficiency_cannot_exceed_unity():
    with pytest.raises(ValueError, match="must not exceed 1"):
        circular_aperture_gain(1.9, 2.4e9, 1.01)


def test_api_requires_declared_efficiency_and_does_not_change_legacy_link_inputs():
    scenario = default_scenario()
    before = scenario.model_dump(mode="json")
    identity = scenario.identity()
    with TestClient(create_app()) as client:
        response = client.post("/api/ground-antennas/dish-gain", json={
            "diameter_m": 1.9, "frequency_hz": 2.4e9, "aperture_efficiency": 0.55,
        })
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["peak_gain_dbi"] == pytest.approx(30.98950714355526414, abs=1e-12)
        for changes in (
            {}, {"aperture_efficiency": 0}, {"aperture_efficiency": 1.1},
            {"aperture_efficiency": True}, {"aperture_efficiency": "0.55"},
            {"aperture_efficiency": 0.55, "diameter_m": 0},
            {"aperture_efficiency": 0.55, "frequency_hz": 41e9},
            {"aperture_efficiency": 0.55, "unexpected": 1},
        ):
            invalid = {"diameter_m": 1.9, "frequency_hz": 2.4e9} | changes
            assert client.post("/api/ground-antennas/dish-gain", json=invalid).status_code == 422
    assert scenario.model_dump(mode="json") == before
    assert Scenario.model_validate(before).identity() == identity
    assert before["uplink"]["ground_peak_gain_dbi"] == 31
    assert before["downlink"]["ground_peak_gain_dbi"] == 31

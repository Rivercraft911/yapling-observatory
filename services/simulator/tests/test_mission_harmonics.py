"""Shared coefficient fields retain RF identity and conserve exported RF heat."""
import math

import pytest
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission.ephemeris import inertial_to_ecef
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.models import content_hash
from cubesat_sim.orbit.elements import elements_to_cartesian
from cubesat_sim.rf.spherical_harmonics import reference_profiles


def overhead_case(efficiency):
    default = default_mission_scenario()
    data = default.model_dump(mode="json")
    data.update(duration_s=60, uhf_beacon=None)
    position = elements_to_cartesian(default.orbit.elements, default.orbit.mu_m3_s2).position_m
    x, y, z = inertial_to_ecef(position, default.epoch_utc, 0)
    assert abs(z) < 1e-8
    data["station"].update(latitude_deg=0, longitude_deg=math.degrees(math.atan2(y, x)), height_m=0)
    profile = reference_profiles()[0]["profile"]
    profile["radiation_efficiency"] = efficiency
    for direction in ("uplink", "downlink"):
        data[direction].update(
            spacecraft_antenna="spherical_harmonic",
            spherical_harmonic_profile=profile,
            antenna_orientation_deg=[0, 0, 0],
            frequency_hz=profile["frequency_hz"],
        )
    data["power"]["transmit_radiation_efficiency"] = .17
    return MissionScenario.model_validate(data)


def test_profile_efficiency_drives_exported_rf_and_thermal_balance_once():
    high, low = (run_mission(overhead_case(efficiency)) for efficiency in (1, .5))
    a, b = (run["summary"]["energy_j"] for run in (high, low))
    assert a["escaped_rf_j"] > 0
    assert b["escaped_rf_j"] == pytest.approx(.5*a["escaped_rf_j"], abs=1e-10)
    assert b["requested_load_j"] == pytest.approx(a["requested_load_j"], abs=1e-9)
    assert low["samples"]["thermal"]["node_temperature_k"]["radio"][-1] > high["samples"]["thermal"]["node_temperature_k"]["radio"][-1]
    for run in (high, low):
        assert abs(run["summary"]["energy_j"]["closure_residual_j"]) < 1e-6
        assert run["manifest"]["rf_transmit_radiation_efficiency"]["source"] == "downlink coefficient profile"
        for direction in ("uplink", "downlink"):
            recorded = run["manifest"]["antenna_patterns"][direction]
            profile = run["manifest"]["scenario"][direction]["spherical_harmonic_profile"]
            assert recorded["profile_sha256"] == content_hash(profile)
            assert recorded["radiation_efficiency"] == profile["radiation_efficiency"]
            assert len(run["samples"][direction]["margin_db"]) == len(run["samples"]["time_s"])

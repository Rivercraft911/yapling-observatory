"""Strong counterfactual RF budgets cannot bypass visibility or scheduling.

The constructed equatorial cases use the actual mission geometry and driver,
not patched visibility flags. High dish gain deliberately leaves positive raw
margins even through Earth so that gating is the only reason for zero service.
"""

import math

import pytest

from cubesat_sim.attitude.dynamics import AttitudeState
from cubesat_sim.attitude.kinematics import boresight_reference
from cubesat_sim.geometry.frames import WGS84_A_M, WGS84_F
from cubesat_sim.geometry.vectors import scale
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission.ephemeris import gmst_rad
from cubesat_sim.mission.geometry import geometry_at
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.operations.radio_delivery_models import delivery_example
from cubesat_sim.orbit.elements import elements_to_cartesian
from cubesat_sim.orbit.two_body import CartesianState
from cubesat_sim.rf.link_budget import evaluate_link_budget

DIRECTIONS = ("uplink", "downlink")


def mission_at_central_angle(angle_deg, scheduled_direction):
    values = default_mission_scenario().model_dump(mode="json")
    values["duration_s"] = 4
    values["magnetic_model"] = "igrf14_degree1"
    values["clocks"].update(
        dynamics_step_s=1,
        controller_period_s=1,
        thermal_step_s=1,
        output_step_s=1,
    )
    values["station"].update(
        latitude_deg=0,
        longitude_deg=0,
        height_m=30,
        minimum_elevation_deg=10,
    )
    epoch = values["orbit"]["elements"]["epoch_utc"]
    values["orbit"].update(force_model="central", ltan_hours_at_epoch=None, preset=None)
    values["orbit"]["elements"].update(
        semi_major_axis_m=WGS84_A_M + 550000,
        eccentricity=0,
        inclination_deg=0,
        raan_deg=math.degrees(gmst_rad(epoch)) % 360,
        argument_of_periapsis_deg=0,
        true_anomaly_deg=angle_deg,
    )
    values["spacecraft"].update(
        controller="coast",
        wheels=[],
        magnetorquer=None,
        initial_omega_body_rad_s=[0, 0, 0],
        initial_q_body_from_inertial_wxyz=[1, 0, 0, 0],
        magnetic_unloading_enabled=False,
    )
    # Explicit tracking mode even when hidden prevents a mode change from
    # concealing an accidentally removed visibility gate in the driver.
    values["conops"]["windows"] = [
        dict(
            window_id="constructed_tracking",
            start_s=0,
            end_s=4,
            mode="ground_tracking",
        )
    ]
    values["schedule"].update(first_direction=scheduled_direction, slot_duration_s=30)
    values["antenna_variant"] = "turnstile"
    for direction in DIRECTIONS:
        values[direction].update(
            spacecraft_antenna="wire",
            spherical_harmonic_profile=None,
            spacecraft_peak_gain_dbi=2.15,
            ground_peak_gain_dbi=70,
            antenna_orientation_deg=[0, 0, 0],
        )
    values["power"]["battery"].pop("electrical", None)
    config = MissionScenario.model_validate(values)
    initial = elements_to_cartesian(config.orbit.elements, config.orbit.mu_m3_s2)
    orbit = CartesianState(0, initial.position_m, initial.velocity_m_s)
    state = AttitudeState(0, (1, 0, 0, 0), (0, 0, 0))
    geo = geometry_at(config, orbit, state)
    values["spacecraft"]["initial_q_body_from_inertial_wxyz"] = boresight_reference(
        (1, 0, 0, 0),
        (0, 1, 0),
        scale(geo["k"], -1),
    )
    values["radio_delivery"] = delivery_example(
        config.uplink, config.downlink
    ).model_dump(mode="json")
    return MissionScenario.model_validate(values)


def segment_minimum_ellipsoid_level(station, spacecraft):
    """Independent convex-quadratic obstruction check, ECEF metres."""
    axes = (WGS84_A_M, WGS84_A_M, WGS84_A_M * (1 - WGS84_F))
    start = [coordinate / axis for coordinate, axis in zip(station, axes)]
    delta = [
        (end - begin) / axis for begin, end, axis in zip(station, spacecraft, axes)
    ]
    u = -sum(a * b for a, b in zip(start, delta)) / sum(b * b for b in delta)
    u = max(0, min(1, u))
    return sum((a + u * b) ** 2 for a, b in zip(start, delta))


@pytest.mark.parametrize(
    "angle,case", [(180, "earth_blocked"), (20, "below_mask"), (0, "visible")]
)
@pytest.mark.parametrize("scheduled_direction", DIRECTIONS)
def test_positive_raw_margin_cannot_bypass_geometry_or_direction(
    angle, case, scheduled_direction
):
    config = mission_at_central_angle(angle, scheduled_direction)
    result = run_mission(config)
    samples, summary = result["samples"], result["summary"]
    assert summary["computed_duration_s"] == 4
    assert samples["mode"][:4] == ["ground_tracking"] * 4
    # The explicit window is half-open; the final sample carries no interval.
    assert samples["mode"][-1] == (
        "ground_tracking" if case == "visible" else "sun_pointing"
    )
    assert samples["active_direction"] == [scheduled_direction] * 5
    expected_visible = case == "visible"
    assert samples["visible"] == [expected_visible] * 5
    assert samples["radio_active"] == [expected_visible] * 5
    for station, spacecraft, elevation in zip(
        samples["station_position_ecef_m"],
        samples["satellite_position_ecef_m"],
        samples["elevation_deg"],
    ):
        level = segment_minimum_ellipsoid_level(station, spacecraft)
        if case == "earth_blocked":
            assert elevation < -80
            assert level < 0.01
        else:
            assert level > 1
            if case == "below_mask":
                assert 0 < elevation < 10
            else:
                assert elevation > 80
    for direction in DIRECTIONS:
        link = samples[direction]
        # These remain raw, counterfactual budgets in the historical contract.
        assert all(value > 0 for value in link["margin_db"])
        assert all(link["valid"])
        assert all(reason == "ideal_gate" for reason in link["reason"])
        delivery = samples["radio_delivery"][direction]
        served = expected_visible and direction == scheduled_direction
        if served:
            assert all(value > 0 for value in link["ideal_rate_bps"])
            assert summary["ideal_capacity_bits"][direction] > 0
            assert delivery["delivered_frames"][-1] > 0
            assert delivery["delivered_useful_bits"][-1] > 0
        else:
            assert link["ideal_rate_bps"] == [0.0] * 5
            assert link["cumulative_ideal_bits"] == [0.0] * 5
            assert summary["ideal_capacity_bits"][direction] == 0
            assert delivery["delivered_frames"] == [0] * 5
            assert delivery["delivered_useful_bits"] == [0] * 5
            assert delivery["receiver_state"] == ["idle"] * 5
            assert delivery["delivery_available"] == [True] * 5
    report = summary["reporting"]["days"][0]
    assert report["geometric_visible_s"] == (4 if expected_visible else 0)
    for direction in DIRECTIONS:
        assert (
            report[direction]["ideal_capacity_bits"]
            == summary["ideal_capacity_bits"][direction]
        )
        assert (
            report[direction]["delivered_useful_bits"]
            == samples["radio_delivery"][direction]["delivered_useful_bits"][-1]
        )


@pytest.mark.parametrize("scheduled", [False, True])
@pytest.mark.parametrize("direction", DIRECTIONS)
def test_rf_budget_visibility_gate_is_independent_of_scheduling(direction, scheduled):
    config = mission_at_central_angle(180, direction)
    initial = elements_to_cartesian(config.orbit.elements, config.orbit.mu_m3_s2)
    orbit = CartesianState(0, initial.position_m, initial.velocity_m_s)
    state = AttitudeState(
        0, config.spacecraft.initial_q_body_from_inertial_wxyz, (0, 0, 0)
    )
    geo = geometry_at(config, orbit, state)
    assert geo["elevation_deg"] < -89
    assert geo["visible"] is False
    link = evaluate_link_budget(config, direction, geo, scheduled)
    assert link["margin_db"] > 0
    assert link["cn0_dbhz"] is not None
    assert link["ideal_rate_bps"] == 0

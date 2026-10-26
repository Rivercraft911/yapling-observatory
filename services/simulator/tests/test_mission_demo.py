"""The daylight example contains real sequential passes and pre-slew Sun pointing."""
import math

import pytest

from cubesat_sim.attitude.dynamics import AttitudeState
from cubesat_sim.attitude.kinematics import rotate
from cubesat_sim.geometry.vectors import dot
from cubesat_sim.mission.daytime_demo import daytime_overhead_demo
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.environment import sun_visibility
from cubesat_sim.mission.ephemeris import sun_direction_inertial
from cubesat_sim.mission.geometry import geometry_at, operation_at
from cubesat_sim.orbit.elements import elements_to_cartesian
from cubesat_sim.orbit.two_body import CartesianState, TwoBodyConfig, step


@pytest.fixture(scope="module")
def demo():
    return daytime_overhead_demo()


@pytest.fixture(scope="module")
def geometry(demo):
    initial = elements_to_cartesian(demo.orbit.elements, demo.orbit.mu_m3_s2)
    state = CartesianState(0, initial.position_m, initial.velocity_m_s)
    integration = TwoBodyConfig(
        demo.orbit.mu_m3_s2, 1, "rk4", demo.orbit.reference_radius_m,
        demo.orbit.force_model, demo.orbit.reference_radius_m, demo.orbit.j2,
    )
    attitude = AttitudeState(0, (1, 0, 0, 0), (0, 0, 0))
    passes, eclipses = [], []
    current, eclipse_start, first_tracking = None, None, None
    initial_sunlit = None
    for tick in range(int(demo.duration_s) + 1):
        geo = geometry_at(demo, state, attitude)
        sun = sun_direction_inertial(demo.epoch_utc, tick)
        shadow = sun_visibility(state.position_m, sun, demo.orbit.reference_radius_m) == 0
        if initial_sunlit is None:
            initial_sunlit = not shadow
        if shadow and eclipse_start is None:
            eclipse_start = tick
        if not shadow and eclipse_start is not None:
            eclipses.append((eclipse_start, tick))
            eclipse_start = None
        mode = operation_at(demo, tick, geo["visible"], geo["elevation_deg"])[0]
        if mode == "ground_tracking" and first_tracking is None:
            first_tracking = tick
        if geo["visible"]:
            if current is None:
                current = dict(aos_s=tick, peak_deg=-90, acquired=False)
            current["acquired"] |= mode == "ground_tracking"
            if geo["elevation_deg"] > current["peak_deg"]:
                current.update(
                    peak_deg=geo["elevation_deg"], peak_s=tick,
                    station_sun_elevation_deg=math.degrees(math.asin(dot(geo["up"], sun))),
                    satellite_sunlit=not shadow,
                )
        elif current is not None:
            current["los_s"] = tick
            passes.append(current)
            current = None
        state = step(state, integration)
    return dict(
        passes=passes, eclipses=eclipses, initial_sunlit=initial_sunlit,
        first_tracking_s=first_tracking, end_partial_pass=current,
        end_partial_eclipse=eclipse_start,
    )


def test_demo_explicit_inputs_preserve_normal_default_and_independent_masks(demo):
    ordinary = default_mission_scenario()
    assert ordinary.conops.ground_tracking_min_elevation_deg is None
    assert demo.conops.ground_tracking_min_elevation_deg == 25
    assert demo.station.minimum_elevation_deg == 10
    assert demo.conops.auto_ground_tracking
    assert demo.conops.default_mode == "sun_pointing"
    assert demo.conops.windows == ()
    assert demo.power.battery.electrical.initial_soc == 0.5
    assert demo.spacecraft.pointing_reference == "moving_boresight"
    assert demo.orbit.force_model == "j2"
    assert demo.orbit.method == "rk4"
    assert demo.clocks.dynamics_step_s == demo.clocks.controller_period_s == 1
    assert demo.clocks.output_step_s == 10
    period = 2 * math.pi * math.sqrt(
        demo.orbit.elements.semi_major_axis_m**3 / demo.orbit.mu_m3_s2
    )
    assert 5 * period <= demo.duration_s < 5 * period + 10
    assert 7.5 * 3600 < demo.duration_s < 8.5 * 3600
    assert any("no global worst-case" in source for source in demo.provenance)


def test_demo_starts_sunlit_and_sun_pointed_well_before_first_slew(demo, geometry):
    sun_body = rotate(
        demo.spacecraft.initial_q_body_from_inertial_wxyz,
        sun_direction_inertial(demo.epoch_utc),
    )
    assert dot(sun_body, demo.spacecraft.body_boresight) == pytest.approx(1, abs=2e-14)
    assert demo.spacecraft.initial_omega_body_rad_s == (0, 0, 0)
    assert geometry["initial_sunlit"]
    assert geometry["passes"][0]["aos_s"] >= 179
    assert geometry["first_tracking_s"] >= 180
    assert geometry["first_tracking_s"] > geometry["passes"][0]["aos_s"]


def test_demo_j2_earth_rotation_produces_distinct_moderate_overhead_and_receding_passes(geometry):
    passes = geometry["passes"]
    assert len(passes) == 5
    bounds = ((25, 40), (65, 85), (89, 90.000001), (35, 55), (10, 20))
    for entry, (low, high) in zip(passes, bounds):
        assert low <= entry["peak_deg"] <= high
        assert entry["aos_s"] < entry["peak_s"] < entry["los_s"]
        assert entry["station_sun_elevation_deg"] > 15
        assert entry["satellite_sunlit"]
    assert all(a["los_s"] < b["aos_s"] for a, b in zip(passes, passes[1:]))
    assert [entry["acquired"] for entry in passes] == [True, True, True, True, False]
    assert geometry["end_partial_pass"] is None


def test_demo_has_five_complete_eclipse_cycles_without_claiming_worst_case(geometry):
    assert len(geometry["eclipses"]) == 5
    for start, end in geometry["eclipses"]:
        assert 1600 < end - start < 1800
    assert geometry["end_partial_eclipse"] is None
    assert 8000 < sum(end - start for start, end in geometry["eclipses"]) < 9000

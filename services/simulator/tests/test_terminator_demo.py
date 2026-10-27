"""Check real increasing contacts, independent tracking and post-pass operation."""
import pytest

from cubesat_sim.attitude.dynamics import AttitudeState
from cubesat_sim.attitude.kinematics import rotate
from cubesat_sim.geometry.vectors import dot
from cubesat_sim.mission.terminator_demo import terminator_pass_demo
from cubesat_sim.mission.environment import sun_visibility
from cubesat_sim.mission.ephemeris import sun_direction_inertial
from cubesat_sim.mission.geometry import geometry_at, operation_at
from cubesat_sim.orbit.elements import elements_to_cartesian
from cubesat_sim.orbit.two_body import CartesianState, TwoBodyConfig, step


@pytest.fixture(scope="module")
def scenario():
    return terminator_pass_demo()


def test_terminator_inputs_and_initial_attitude(scenario):
    assert scenario.orbit.ltan_hours_at_epoch == pytest.approx(18, abs=0.001)
    assert 97 < scenario.orbit.elements.inclination_deg < 98
    assert scenario.orbit.force_model == "j2"
    assert scenario.power.battery.electrical.initial_soc == 0.5
    assert scenario.duration_s == 86400
    assert scenario.spacecraft.magnetic_unloading_enabled
    assert scenario.conops.ground_tracking_min_elevation_deg == 25
    assert scenario.station.minimum_elevation_deg == 10
    sun_body = rotate(scenario.spacecraft.initial_q_body_from_inertial_wxyz, sun_direction_inertial(scenario.epoch_utc))
    assert dot(sun_body, scenario.spacecraft.body_boresight) == pytest.approx(1, abs=1e-12)
    assert scenario.spacecraft.initial_omega_body_rad_s == (0, 0, 0)


@pytest.fixture(scope="module")
def geometry(scenario):
    initial = elements_to_cartesian(scenario.orbit.elements, scenario.orbit.mu_m3_s2)
    state = CartesianState(0, initial.position_m, initial.velocity_m_s)
    propagation = TwoBodyConfig(scenario.orbit.mu_m3_s2, 1, "rk4", scenario.orbit.reference_radius_m,
        "j2", scenario.orbit.reference_radius_m, scenario.orbit.j2)
    attitude = AttitudeState(0, (1, 0, 0, 0), (0, 0, 0))
    first_visible = first_tracking = None
    passes = []
    current = None
    post_group_sun_pointing = []
    sunlit = True
    for tick in range(int(scenario.duration_s) + 1):
        geometry = geometry_at(scenario, state, attitude)
        mode = operation_at(scenario, tick, geometry["visible"], geometry["elevation_deg"])[0]
        if tick == 0:
            assert not geometry["visible"]
            assert mode == "sun_pointing"
        if geometry["visible"] and first_visible is None:
            first_visible = tick
        if mode == "ground_tracking" and first_tracking is None:
            first_tracking = tick
        sunlit &= sun_visibility(
            state.position_m,
            sun_direction_inertial(scenario.epoch_utc, tick),
            scenario.orbit.reference_radius_m,
        ) == 1
        if geometry["visible"]:
            if current is None:
                current = dict(aos_s=tick, peak_s=tick, peak_deg=-90, tracked=False)
            current["tracked"] |= mode == "ground_tracking"
            if geometry["elevation_deg"] > current["peak_deg"]:
                current.update(peak_s=tick, peak_deg=geometry["elevation_deg"])
        elif current is not None:
            current["los_s"] = tick
            passes.append(current)
            current = None
        if len(passes) == 3:
            post_group_sun_pointing.append(mode == "sun_pointing")
            if tick >= passes[2]["los_s"] + 1800:
                break
        state = step(state, propagation)
    return dict(
        passes=passes,
        first_visible_s=first_visible,
        first_tracking_s=first_tracking,
        sunlit=sunlit,
        post_group_sun_pointing=post_group_sun_pointing,
    )


def test_terminator_starts_before_low_contact_and_delays_tracking_until_a_higher_pass(geometry):
    assert geometry["first_visible_s"] == pytest.approx(180, abs=1)
    passes = geometry["passes"]
    assert len(passes) == 3
    assert [entry["tracked"] for entry in passes] == [False, True, True]
    assert passes[1]["aos_s"] < geometry["first_tracking_s"] < passes[1]["peak_s"]
    assert geometry["sunlit"]


def test_terminator_real_contacts_rise_to_near_overhead_with_the_actual_long_gap(geometry):
    passes = geometry["passes"]
    for entry, (low, high) in zip(passes, ((14, 15), (34, 35), (89, 90))):
        assert low < entry["peak_deg"] < high
        assert entry["aos_s"] < entry["peak_s"] < entry["los_s"]
    assert passes[0]["los_s"] < passes[1]["aos_s"] < passes[1]["los_s"] < passes[2]["aos_s"]
    assert 5500 < passes[1]["peak_s"] - passes[0]["peak_s"] < 5900
    assert 10 * 3600 < passes[2]["peak_s"] - passes[1]["peak_s"] < 11 * 3600


def test_terminator_continues_sun_pointing_after_the_group_with_a_longer_power_horizon(scenario, geometry):
    assert scenario.duration_s - geometry["passes"][2]["los_s"] > 11 * 3600
    assert len(geometry["post_group_sun_pointing"]) == 1801
    assert all(geometry["post_group_sun_pointing"])

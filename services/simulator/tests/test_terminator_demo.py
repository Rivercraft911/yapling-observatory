"""Check the preset's real pass geometry and declared Sun-pointing start."""
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
    assert scenario.conops.ground_tracking_min_elevation_deg == 25
    assert scenario.station.minimum_elevation_deg == 10
    sun_body = rotate(scenario.spacecraft.initial_q_body_from_inertial_wxyz, sun_direction_inertial(scenario.epoch_utc))
    assert dot(sun_body, scenario.spacecraft.body_boresight) == pytest.approx(1, abs=1e-12)
    assert scenario.spacecraft.initial_omega_body_rad_s == (0, 0, 0)


def test_terminator_starts_before_a_real_tracking_slew(scenario):
    initial = elements_to_cartesian(scenario.orbit.elements, scenario.orbit.mu_m3_s2)
    state = CartesianState(0, initial.position_m, initial.velocity_m_s)
    propagation = TwoBodyConfig(scenario.orbit.mu_m3_s2, 1, "rk4", scenario.orbit.reference_radius_m,
        "j2", scenario.orbit.reference_radius_m, scenario.orbit.j2)
    attitude = AttitudeState(0, (1, 0, 0, 0), (0, 0, 0))
    first_visible = first_tracking = None
    maximum = -90
    for tick in range(1600):
        geometry = geometry_at(scenario, state, attitude)
        mode = operation_at(scenario, tick, geometry["visible"], geometry["elevation_deg"])[0]
        if tick == 0:
            assert not geometry["visible"]
            assert mode == "sun_pointing"
        if geometry["visible"] and first_visible is None:
            first_visible = tick
        if mode == "ground_tracking" and first_tracking is None:
            first_tracking = tick
        maximum = max(maximum, geometry["elevation_deg"])
        assert sun_visibility(state.position_m, sun_direction_inertial(scenario.epoch_utc, tick), scenario.orbit.reference_radius_m) == 1
        state = step(state, propagation)
    assert first_visible == pytest.approx(180, abs=1)
    assert first_tracking > first_visible
    assert maximum > 80

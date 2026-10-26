"""Dusk-ascending SSO example, initialized before a real Stanford pass.

The starting plane uses the existing first-order mean-J2 SSO estimate as
osculating elements. J2 propagation locates the pass; no contacts are inserted.
"""
from datetime import timedelta

from ..attitude.dynamics import AttitudeState
from ..attitude.kinematics import boresight_reference
from ..mission_models import MissionScenario
from ..orbit.elements import elements_to_cartesian, osculating_elements
from ..orbit.two_body import CartesianState, TwoBodyConfig, step
from .defaults import default_mission_scenario, orbit_metadata
from .ephemeris import sun_direction_inertial, utc_datetime
from .geometry import geometry_at


def terminator_pass_demo():
    seed = default_mission_scenario()
    initial = elements_to_cartesian(seed.orbit.elements, seed.orbit.mu_m3_s2)
    state = CartesianState(0, initial.position_m, initial.velocity_m_s)
    propagation = TwoBodyConfig(
        mu_m3_s2=seed.orbit.mu_m3_s2, step_s=1, method="rk4", force_model="j2",
        reference_radius_m=seed.orbit.reference_radius_m, j2=seed.orbit.j2,
    )
    attitude = AttitudeState(0, (1, 0, 0, 0), (0, 0, 0))
    approach = None
    for _ in range(86400):
        geometry = geometry_at(seed, state, attitude)
        if geometry["visible"]:
            if approach is None:
                approach = state
            if geometry["elevation_deg"] >= 25:
                break
        else:
            approach = None
        state = step(state, propagation)
    else:
        raise ValueError("No Stanford pass reaches the acquisition elevation in the seed day")
    state = approach
    for _ in range(180):
        state = step(state, propagation, backward=True)
    elements = osculating_elements(state.position_m, state.velocity_m_s, seed.orbit.mu_m3_s2)
    epoch = (utc_datetime(seed.epoch_utc) + timedelta(seconds=state.time_s)).isoformat().replace("+00:00", "Z")
    values = seed.model_dump(mode="json")
    values.update(name="Stanford terminator SSO · dusk ascending", duration_s=86400, run_kind="long_mission")
    values["orbit"].update(
        preset="first_order_mean_J2_terminator_estimate", force_model="j2", method="rk4", ltan_hours_at_epoch=None,
        elements=dict(
            semi_major_axis_m=elements.semi_major_axis_m,
            eccentricity=elements.eccentricity, inclination_deg=elements.inclination_deg,
            raan_deg=elements.raan_deg, argument_of_periapsis_deg=elements.argument_of_periapsis_deg or 0,
            true_anomaly_deg=(elements.true_anomaly_deg if elements.true_anomaly_deg is not None else elements.argument_of_latitude_deg),
            epoch_utc=epoch,
        ),
    )
    values["clocks"].update(dynamics_step_s=1, controller_period_s=1, thermal_step_s=10, output_step_s=10)
    values["spacecraft"].update(
        pointing_reference="moving_boresight",
        initial_q_body_from_inertial_wxyz=boresight_reference(
            (1, 0, 0, 0), values["spacecraft"]["body_boresight"], sun_direction_inertial(epoch),
        ),
        initial_omega_body_rad_s=[0, 0, 0],
    )
    values["conops"].update(default_mode="sun_pointing", auto_ground_tracking=True, ground_tracking_min_elevation_deg=25, windows=[])
    values["power"]["battery"]["electrical"]["initial_soc"] = 0.5
    values["provenance"].append(
        "Terminator comparison: the 550 km, 18:00 LTAN first-order mean-J2 SSO seed "
        "is propagated with 1 s RK4+J2 steps to its first Stanford pass reaching "
        "25 degrees elevation. The scenario starts Sun-pointed at 50% charge SOC, "
        "180 s before that pass crosses the 10 degree RF mask. Its initial elements "
        "are the propagated osculating state at the shifted epoch; LTAN is recomputed. "
        "The 24-hour mission uses real geometric contacts and calculated eclipse. "
        "This is a representative planning orbit, not a flight ephemeris or an "
        "assumption that all terminator orbits remain sunlit in every season."
    )
    result = MissionScenario.model_validate(values)
    values["orbit"]["ltan_hours_at_epoch"] = orbit_metadata(result.orbit.elements)["ltan_hours"]
    return MissionScenario.model_validate(values)

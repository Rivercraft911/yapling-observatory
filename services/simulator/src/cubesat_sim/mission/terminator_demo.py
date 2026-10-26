"""Dusk-ascending SSO example, initialized before a rising Stanford pass group.

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
    maximum_elevation_deg = -90
    for _ in range(86400):
        geometry = geometry_at(seed, state, attitude)
        if geometry["visible"]:
            if approach is None:
                approach = state
            maximum_elevation_deg = max(maximum_elevation_deg, geometry["elevation_deg"])
        elif approach is not None:
            if maximum_elevation_deg >= 80:
                break
            approach = None
            maximum_elevation_deg = -90
        state = step(state, propagation)
    else:
        raise ValueError("No near-overhead Stanford pass occurs in the seed day")
    overhead = (approach, maximum_elevation_deg)
    state = step(approach, propagation, backward=True)
    preceding = []
    approach = None
    maximum_elevation_deg = -90
    for _ in range(86400):
        geometry = geometry_at(seed, state, attitude)
        if geometry["visible"]:
            approach = state
            maximum_elevation_deg = max(maximum_elevation_deg, geometry["elevation_deg"])
        elif approach is not None:
            preceding.append((approach, maximum_elevation_deg))
            if len(preceding) == 2:
                break
            approach = None
            maximum_elevation_deg = -90
        state = step(state, propagation, backward=True)
    else:
        raise ValueError("Two preceding Stanford contacts were not found within one day")
    rising_passes = (*reversed(preceding), overhead)
    if not all(a[1] < b[1] for a, b in zip(rising_passes, rising_passes[1:])):
        raise ValueError("The seed orbit does not produce the rising terminator pass group")
    state = rising_passes[0][0]
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
        "80 degrees elevation, then backward to the two preceding real contacts. "
        "Their calculated peaks increase toward the near-overhead pass for this "
        "seed; they are not three successive revolutions. The scenario starts "
        "Sun-pointed at 50% charge SOC, 180 s before the first contact crosses "
        "the 10 degree RF mask. A contact below the independent 25 degree "
        "tracking threshold remains Sun-pointed. Its initial elements "
        "are the propagated osculating state at the shifted epoch; LTAN is recomputed. "
        "The 24-hour mission continues after the group with real geometric contacts "
        "and calculated eclipse; later pass peaks need not keep increasing. "
        "This is a representative planning orbit, not a flight ephemeris or an "
        "assumption that all terminator orbits remain sunlit in every season."
    )
    result = MissionScenario.model_validate(values)
    values["orbit"]["ltan_hours_at_epoch"] = orbit_metadata(result.orbit.elements)["ltan_hours"]
    return MissionScenario.model_validate(values)

"""A constructed Stanford daylight pass cluster, propagated with RK4 and J2.

The chosen near-eastward plane produces successive real ground passes as Earth
rotates. This is an editable numerical example, not a forecast or a worst-case
power envelope. Sun, eclipse and attitude remain computed by the mission models.
"""

from datetime import timedelta
import math

from ..attitude.dynamics import AttitudeState
from ..attitude.kinematics import boresight_reference
from ..geometry.frames import enu_axes, geodetic_ecef
from ..geometry.vectors import add, dot, norm, scale, unit
from ..mission_models import MissionScenario
from ..orbit.elements import osculating_elements
from ..orbit.two_body import CartesianState, TwoBodyConfig, step
from .defaults import default_mission_scenario, orbit_metadata
from .ephemeris import ecef_to_inertial, sun_direction_inertial, utc_datetime
from .geometry import geometry_at

PEAK_EPOCH_UTC = "2026-10-25T20:00:00Z"
PEAK_ALTITUDE_M = 550000
HEADING_EAST_OF_NORTH_DEG = 95
SUN_POINTING_LEAD_S = 180
ACQUISITION_ELEVATION_DEG = 25


def daytime_overhead_demo():
    values = default_mission_scenario().model_dump(mode="json")
    values["orbit"]["elements"]["epoch_utc"] = PEAK_EPOCH_UTC
    values["orbit"]["ltan_hours_at_epoch"] = None
    reference = MissionScenario.model_validate(values)
    station = reference.station
    position = ecef_to_inertial(
        geodetic_ecef(station.latitude_deg, station.longitude_deg, PEAK_ALTITUDE_M),
        PEAK_EPOCH_UTC,
    )
    radial = unit(position)
    east, north, _ = (
        ecef_to_inertial(axis, PEAK_EPOCH_UTC)
        for axis in enu_axes(station.latitude_deg, station.longitude_deg)
    )
    heading = math.radians(HEADING_EAST_OF_NORTH_DEG)
    tangent = add(scale(north, math.cos(heading)), scale(east, math.sin(heading)))
    tangent = unit(add(tangent, scale(radial, -dot(tangent, radial))))
    velocity = scale(tangent, math.sqrt(reference.orbit.mu_m3_s2 / norm(position)))
    state = CartesianState(0, position, velocity)
    period = 2 * math.pi * math.sqrt(norm(position)**3 / reference.orbit.mu_m3_s2)
    integration = TwoBodyConfig(
        mu_m3_s2=reference.orbit.mu_m3_s2,
        step_s=1,
        method="rk4",
        force_model="j2",
        reference_radius_m=reference.orbit.reference_radius_m,
        j2=reference.orbit.j2,
    )
    attitude = AttitudeState(0, (1, 0, 0, 0), (0, 0, 0))
    for _ in range(math.ceil(2.5 * period)):
        state = step(state, integration, backward=True)
    for _ in range(math.ceil(period)):
        if geometry_at(reference, state, attitude)["visible"]:
            break
        state = step(state, integration)
    else:
        raise ValueError("Demo first approach did not cross the station mask")
    for _ in range(SUN_POINTING_LEAD_S):
        state = step(state, integration, backward=True)
    initial = osculating_elements(
        state.position_m, state.velocity_m_s, reference.orbit.mu_m3_s2
    )
    start_epoch = (
        utc_datetime(PEAK_EPOCH_UTC) + timedelta(seconds=state.time_s)
    ).isoformat().replace("+00:00", "Z")
    values["name"] = "Stanford daylight pass cluster · five orbits"
    values["run_kind"] = "long_mission"
    values["orbit"].update(
        force_model="j2", method="rk4", preset=None, ltan_hours_at_epoch=None,
        elements=dict(
            semi_major_axis_m=initial.semi_major_axis_m,
            eccentricity=initial.eccentricity,
            inclination_deg=initial.inclination_deg,
            raan_deg=initial.raan_deg,
            argument_of_periapsis_deg=initial.argument_of_periapsis_deg or 0,
            true_anomaly_deg=(
                initial.true_anomaly_deg
                if initial.true_anomaly_deg is not None
                else initial.argument_of_latitude_deg
            ),
            epoch_utc=start_epoch,
        ),
    )
    initial_period = 2 * math.pi * math.sqrt(
        initial.semi_major_axis_m**3 / reference.orbit.mu_m3_s2
    )
    values["duration_s"] = math.ceil(5 * initial_period / 10) * 10
    values["clocks"].update(
        dynamics_step_s=1, controller_period_s=1, thermal_step_s=10, output_step_s=10
    )
    values["conops"].update(
        auto_ground_tracking=True,
        ground_tracking_min_elevation_deg=ACQUISITION_ELEVATION_DEG,
        default_mode="sun_pointing",
        windows=[],
    )
    values["spacecraft"].update(
        pointing_reference="moving_boresight",
        initial_q_body_from_inertial_wxyz=boresight_reference(
            (1, 0, 0, 0), values["spacecraft"]["body_boresight"],
            sun_direction_inertial(start_epoch),
        ),
        initial_omega_body_rad_s=[0, 0, 0],
    )
    values["power"]["battery"]["electrical"]["initial_soc"] = 0.5
    values["provenance"].append(
        "Constructed example: 550 km geodetic altitude directly over Stanford at "
        "2026-10-25T20:00:00Z, with central circular speed and a tangent heading "
        "95 degrees east of north. RK4 + J2 backward/forward 1 s steps locate the "
        "first real 10 degree station-mask crossing in the preceding 2.5 periods; "
        "the run begins 180 s earlier, Sun-pointed at 50% electrical charge SOC. "
        "Five initial osculating periods are rounded up to 10 s. Automatic ground "
        "tracking starts at an independently editable 25 degree elevation; the "
        "station RF mask remains 10 degrees. Earth rotation produces the moderate, "
        "high, overhead and receding pass cluster. Nonzero solar beta still produces "
        "eclipses; no global worst-case power, temperature or flight-fit claim follows."
    )
    result = MissionScenario.model_validate(values)
    values["orbit"]["ltan_hours_at_epoch"] = orbit_metadata(result.orbit.elements)["ltan_hours"]
    return MissionScenario.model_validate(values)

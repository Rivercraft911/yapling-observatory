"""Mission station geometry in the single declared epoch-equatorial frame."""

import math
from ..geometry.frames import geodetic_ecef, enu_axes
from ..geometry.vectors import add, scale, dot, cross, norm, unit
from ..attitude.kinematics import rotate, conjugate
from ..attitude.guidance import direction_motion
from .ephemeris import sun_direction_derivatives_inertial
from .ephemeris import ecef_to_inertial, inertial_to_ecef, gmst_rad, EARTH_OMEGA_RAD_S


def geometry_at(config, orbit, attitude):
    time_s = orbit.time_s
    station_ecef = geodetic_ecef(
        config.station.latitude_deg,
        config.station.longitude_deg,
        config.station.height_m,
    )
    station = ecef_to_inertial(station_ecef, config.epoch_utc, time_s)
    axes = enu_axes(config.station.latitude_deg, config.station.longitude_deg)
    east, north, up = (ecef_to_inertial(a, config.epoch_utc, time_s) for a in axes)
    relative = add(orbit.position_m, scale(station, -1))
    distance = norm(relative)
    look = scale(relative, 1 / distance)
    elevation = math.degrees(math.asin(max(-1.0, min(1.0, dot(look, up)))))
    azimuth = math.degrees(math.atan2(dot(look, east), dot(look, north))) % 360
    velocity_station = cross((0, 0, EARTH_OMEGA_RAD_S), station)
    range_rate = dot(add(orbit.velocity_m_s, scale(velocity_station, -1)), look)
    q_inverse = conjugate(attitude.q_body_from_inertial_wxyz)
    x, y, z = (rotate(q_inverse, a) for a in ((1, 0, 0), (0, 1, 0), (0, 0, 1)))
    return dict(
        time_s=time_s,
        k=look,
        east=east,
        north=north,
        up=up,
        x=x,
        y=y,
        z=z,
        range_m=distance,
        range_rate_m_s=range_rate,
        elevation_deg=elevation,
        azimuth_deg=azimuth,
        visible=elevation >= config.station.minimum_elevation_deg,
        station_position_m=station,
        station_position_ecef_m=station_ecef,
        satellite_position_ecef_m=inertial_to_ecef(
            orbit.position_m, config.epoch_utc, time_s
        ),
        ecef_from_inertial_angle_rad=-gmst_rad(config.epoch_utc, time_s),
    )


def operation_at(config, time_s, visible, elevation_deg=None):
    for window in config.conops.windows:
        if window.start_s <= time_s < window.end_s:
            return window.mode, window.window_id, window
    threshold = config.conops.ground_tracking_min_elevation_deg
    if config.conops.auto_ground_tracking and visible and threshold is not None and elevation_deg is None:
        raise ValueError("Automatic acquisition elevation requires station geometry")
    ground_ready = visible and (threshold is None or (elevation_deg is not None and elevation_deg >= threshold))
    mode = (
        "ground_tracking"
        if ground_ready and config.conops.auto_ground_tracking
        else config.conops.default_mode
    )
    return mode, "auto_" + mode, None


def target_direction(config, geometry, sun, mode, window, orbit):
    if mode == "ground_tracking":
        return scale(geometry["k"], -1)
    if mode == "imaging":
        if window and window.target_latitude_deg is not None:
            target = ecef_to_inertial(
                geodetic_ecef(
                    window.target_latitude_deg, window.target_longitude_deg, 0
                ),
                config.epoch_utc,
                orbit.time_s,
            )
            return unit(add(target, scale(orbit.position_m, -1)))
        return scale(unit(orbit.position_m), -1)
    return sun


def target_motion(config, geometry, mode, window, orbit, satellite_acceleration_m_s2):
    """Target direction, zero-twist rate and acceleration in inertial axes.

    Ground targets rotate with the same constant Earth-rate approximation used
    by range-rate geometry. Spacecraft acceleration uses the selected gravity.
    Mode transitions remain instantaneous commands, not preplanned slews.
    """
    if mode == "ground_tracking":
        target = geometry["station_position_m"]
    elif mode == "imaging":
        target = (
            ecef_to_inertial(
                geodetic_ecef(window.target_latitude_deg, window.target_longitude_deg, 0),
                config.epoch_utc, orbit.time_s,
            )
            if window and window.target_latitude_deg is not None
            else (0.0, 0.0, 0.0)
        )
    else:
        return direction_motion(*sun_direction_derivatives_inertial(
            config.epoch_utc, orbit.time_s
        ))
    earth_rate = (0.0, 0.0, EARTH_OMEGA_RAD_S)
    target_velocity = cross(earth_rate, target)
    target_acceleration = cross(earth_rate, target_velocity)
    return direction_motion(
        add(target, scale(orbit.position_m, -1)),
        add(target_velocity, scale(orbit.velocity_m_s, -1)),
        add(target_acceleration, scale(satellite_acceleration_m_s2, -1)),
    )

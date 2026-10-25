"""Mission station geometry in the single declared epoch-equatorial frame."""

import math
from ..geometry.frames import geodetic_ecef, enu_axes
from ..geometry.vectors import add, scale, dot, cross, norm, unit
from ..attitude.kinematics import rotate, conjugate
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


def operation_at(config, time_s, visible):
    for window in config.conops.windows:
        if window.start_s <= time_s < window.end_s:
            return window.mode, window.window_id, window
    mode = (
        "ground_tracking"
        if visible and config.conops.auto_ground_tracking
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

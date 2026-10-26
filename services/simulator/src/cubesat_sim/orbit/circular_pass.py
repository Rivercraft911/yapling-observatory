"""Synthetic central circular pass with uniformly rotating WGS84 station."""
from __future__ import annotations
import math
from ..models import Scenario
from ..geometry.frames import WGS84_A_M, rz, geodetic_ecef, enu_axes, quaternion_from_matrix
from ..geometry.vectors import add, scale, dot, cross, norm, unit, matvec, transpose
from ..attitude.prescribed import tracking_matrix, prescribed_body_from_inertial
EARTH_MU_M3_S2 = 3.986004418e14  # WGS84 defining GM, atmosphere included.
EARTH_OMEGA_RAD_S = 7.292115e-5  # WGS84 nominal angular velocity.


class CircularPass:
    """Central point-mass orbit, with uniformly rotating WGS84 station.

    Analytic inertial axes coincide with Earth-fixed XYZ at pass midpoint. This
    deliberately synthetic frame is not GCRF/TEME/realized ITRF. Epoch labels the
    first sample; UTC labels use POSIX-like elapsed seconds without leap seconds.
    Orbit radius is WGS84 equatorial semi-major axis + input altitude. At midpoint
    the satellite is radially above the station's geocentric direction. Ellipsoidal
    geodetic up differs slightly, so maximum geodetic elevation need not be 90 deg.
    """
    def __init__(self, scenario: Scenario):
        self.scenario = scenario
        station = scenario.station
        self.station_ecef = geodetic_ecef(station.latitude_deg, station.longitude_deg, station.height_m)
        self.enu_ecef = enu_axes(station.latitude_deg, station.longitude_deg)
        self.radial = unit(self.station_ecef)
        heading = math.radians(scenario.orbit.ground_track_heading_deg)
        horizontal = add(scale(self.enu_ecef[1], math.cos(heading)), scale(self.enu_ecef[0], math.sin(heading)))
        # Preserve the requested ENU bearing while making the relative tangent
        # perpendicular to geocentric radius. A simple radial projection would
        # slightly change the ENU bearing because geodetic up is not radial.
        relative_tangent = unit(add(horizontal, scale(self.enu_ecef[2], -dot(horizontal, self.radial)/dot(self.enu_ecef[2], self.radial))))
        self.radius = WGS84_A_M + scenario.orbit.altitude_m
        self.mean_motion = math.sqrt(EARTH_MU_M3_S2/self.radius**3)
        mid_sat = scale(self.radial, self.radius)
        rotation_velocity = cross((0, 0, EARTH_OMEGA_RAD_S), mid_sat)
        circular_speed = self.radius*self.mean_motion
        projection = dot(relative_tangent, rotation_velocity)
        relative_speed = -projection + math.sqrt(projection**2+circular_speed**2-dot(rotation_velocity, rotation_velocity))
        # v_inertial = v_earth_fixed + omega cross r, with fixed |v|=sqrt(mu/r).
        self.along = unit(add(scale(relative_tangent, relative_speed), rotation_velocity))
        self.mid_tracking = tracking_matrix(add(self.station_ecef, scale(mid_sat, -1)), self.enu_ecef[1], self.enu_ecef[0])

    def state(self, time_s):
        scn = self.scenario
        t = time_s - scn.duration_s/2
        theta = self.mean_motion*t
        sat = scale(add(scale(self.radial, math.cos(theta)), scale(self.along, math.sin(theta))), self.radius)
        sat_velocity = scale(add(scale(self.radial, -math.sin(theta)), scale(self.along, math.cos(theta))), self.radius*self.mean_motion)
        earth_rotation = rz(EARTH_OMEGA_RAD_S*t)
        station = matvec(earth_rotation, self.station_ecef)
        station_velocity = cross((0, 0, EARTH_OMEGA_RAD_S), station)
        east, north, up = (matvec(earth_rotation, a) for a in self.enu_ecef)
        ground_to_sat = add(sat, scale(station, -1))
        distance = norm(ground_to_sat)
        k = unit(ground_to_sat)
        range_rate = dot(add(sat_velocity, scale(station_velocity, -1)), k)
        east_component, north_component = dot(k, east), dot(k, north)
        horizontal = math.hypot(east_component, north_component)
        azimuth = math.degrees(math.atan2(east_component, north_component)) % 360 if horizontal > 1e-10 else None
        elevation = math.degrees(math.asin(max(-1, min(1, dot(k, up)))))
        body_from_inertial = prescribed_body_from_inertial(scn.attitude, k, north, east, self.mid_tracking, t)
        inertial_from_body = transpose(body_from_inertial)
        x, y, z = (matvec(inertial_from_body, axis) for axis in ((1,0,0),(0,1,0),(0,0,1)))
        pointing_error = math.degrees(math.acos(max(-1, min(1, dot(y, scale(k, -1))))))
        relative_velocity = add(sat_velocity, scale(station_velocity, -1))
        los_rate = norm(add(relative_velocity, scale(k, -range_rate)))/distance
        return dict(time_s=time_s, satellite_position_m=sat, station_position_m=station,
                    satellite_position_ecef_m=matvec(transpose(earth_rotation), sat),
                    satellite_velocity_m_s=sat_velocity, station_velocity_m_s=station_velocity,
                    q_body_from_inertial_wxyz=quaternion_from_matrix(body_from_inertial),
                    range_m=distance, range_rate_m_s=range_rate,
                    elevation_deg=elevation, azimuth_deg=azimuth,
                    visible=elevation >= scn.station.minimum_elevation_deg,
                    attitude_angle_deg=pointing_error, tracking_rate_deg_s=math.degrees(los_rate),
                    east=east, north=north, k=k, x=x, y=y, z=z)

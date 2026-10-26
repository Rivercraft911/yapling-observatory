"""Kinematic tracking and body-axis spin; no torque or control solve."""
import math
from ..geometry.frames import rotation
from ..geometry.vectors import cross, norm, unit, transverse, scale, matmul


def tracking_matrix(sc_to_station, north, east):
    """Body +Y points to station; +Z is projected station north (east fallback)."""
    y = unit(sc_to_station)
    z = transverse(north, y)
    if norm(z) < 1e-10:
        z = transverse(east, y)
    x = unit(cross(y, unit(z)))
    return (x, y, unit(cross(x, y)))


def prescribed_body_from_inertial(attitude, k, north, east, midpoint_tracking, time_from_midpoint_s):
    if attitude.mode == "tracking":
        body_from_inertial = tracking_matrix(scale(k, -1), north, east)
    else:
        body_from_inertial = matmul(rotation(attitude.spin_axis_body, -math.radians(attitude.spin_rate_deg_s)*time_from_midpoint_s), midpoint_tracking)
    return matmul(rotation((1, 0, 0), math.radians(attitude.pointing_error_deg)), body_from_inertial)

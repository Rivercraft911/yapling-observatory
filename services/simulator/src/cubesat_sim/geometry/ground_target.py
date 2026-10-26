"""Approximate rendered-map picks projected radially onto the WGS84 ellipsoid."""
import math

from .frames import WGS84_A_M, WGS84_F


def ground_target_from_ecef(position_ecef_m):
    if len(position_ecef_m) != 3 or not all(math.isfinite(v) for v in position_ecef_m):
        raise ValueError('Map pick requires three finite ECEF metres')
    x, y, z = position_ecef_m
    radius = math.hypot(x, y, z)
    if radius < 1:
        raise ValueError('Map pick must lie near the Earth surface')
    a = WGS84_A_M
    b = a * (1 - WGS84_F)
    radial_scale = 1 / math.sqrt((x*x + y*y)/(a*a) + z*z/(b*b))
    if abs(radius - radial_scale * radius) > 100000:
        raise ValueError('Map pick must lie within 100 km of the WGS84 surface')
    # On the projected surface, tan(geodetic latitude)=a² z/(b² horizontal radius).
    latitude = math.degrees(math.atan2(z*a*a, math.hypot(x, y)*b*b))
    longitude = math.degrees(math.atan2(y, x)) if x or y else 0.0
    return dict(latitude_deg=latitude, longitude_deg=longitude)

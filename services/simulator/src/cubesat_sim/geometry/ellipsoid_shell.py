"""Station azimuth rays on a constant WGS84 geodetic-height surface.

This is the normal offset of the reference ellipsoid, not an ellipsoid with
both semiaxes increased by the requested height. Positions use the existing
WGS84 forward transform. No refraction, terrain or station horizon survey.
"""

import math

from .frames import WGS84_A_M, WGS84_F, enu_axes, geodetic_ecef

AZIMUTH_SEGMENTS = 144
ROOT_ITERATIONS = 42


def ecef_geodetic(position_m):
    """Invert WGS84 forward equations near or outside the reference ellipsoid.

    N(phi)=a/sqrt(1-e²sin²phi), phi=atan2(z+e²Nsin(phi),p).
    The height follows the projection on geodetic up; this avoids p/cos(phi)
    at the poles. Eight fixed-point updates are sufficient in this exterior
    domain, whose contraction is below 0.007. Tests check the forward residual.
    """
    x, y, z = position_m
    horizontal = math.hypot(x, y)
    e2 = WGS84_F * (2 - WGS84_F)
    latitude = math.atan2(z, horizontal * (1 - e2))
    for _ in range(8):
        sine = math.sin(latitude)
        normal_radius = WGS84_A_M / math.sqrt(1 - e2 * sine * sine)
        latitude = math.atan2(z + e2 * normal_radius * sine, horizontal)
    sine, cosine = math.sin(latitude), math.cos(latitude)
    height = (horizontal * cosine + z * sine
              - WGS84_A_M * math.sqrt(1 - e2 * sine * sine))
    return (math.degrees(latitude),
            (math.degrees(math.atan2(y, x)) + 180) % 360 - 180,
            height)


class StationShell:
    """Bounded visible-shell search for constant endpoint gain and RF range.

    A positive-height normal offset of an ellipsoid is convex. Above a
    nonnegative local elevation mask, range to this enclosing surface grows
    from zenith toward the mask. At a fixed admissible range its height grows
    with elevation. These restrictions justify each scalar bisection here;
    they do not establish monotonicity of an attitude-dependent antenna link.
    """

    def __init__(self, station, altitude_m):
        if (not math.isfinite(altitude_m)
                or not 100000 <= altitude_m <= 50000000):
            raise ValueError("Planning geodetic height must be within 100..50000 km")
        self.altitude_m = altitude_m
        self.minimum_range_m = altitude_m - station.height_m
        self.origin = geodetic_ecef(
            station.latitude_deg, station.longitude_deg, station.height_m
        )
        east, north, self.up = enu_axes(station.latitude_deg, station.longitude_deg)
        self.mask_rad = math.radians(station.minimum_elevation_deg)
        self.horizontals = []
        self.mask_ranges = []
        self.mask_points = []
        for index in range(AZIMUTH_SEGMENTS):
            azimuth = 2 * math.pi * index / AZIMUTH_SEGMENTS
            horizontal = tuple(math.cos(azimuth) * n + math.sin(azimuth) * e
                               for n, e in zip(north, east))
            self.horizontals.append(horizontal)
            lower, upper = 0.0, altitude_m + 2 * WGS84_A_M + abs(station.height_m)
            for _ in range(ROOT_ITERATIONS):
                middle = (lower + upper) / 2
                if self._position(horizontal, self.mask_rad, middle)[2] < altitude_m:
                    lower = middle
                else:
                    upper = middle
            distance = (lower + upper) / 2
            self.mask_ranges.append(distance)
            self.mask_points.append(self._point(horizontal, self.mask_rad, distance))

    def _ecef(self, horizontal, elevation_rad, distance_m):
        sine, cosine = math.sin(elevation_rad), math.cos(elevation_rad)
        return tuple(origin + distance_m * (cosine * h + sine * u)
                     for origin, h, u in zip(self.origin, horizontal, self.up))

    def _position(self, horizontal, elevation_rad, distance_m):
        return ecef_geodetic(self._ecef(horizontal, elevation_rad, distance_m))

    def _point(self, horizontal, elevation_rad, distance_m):
        position = self._ecef(horizontal, elevation_rad, distance_m)
        latitude, longitude, _ = ecef_geodetic(position)
        x, y, z = position
        # A radial intersection scales x,y,z equally, so its normal latitude
        # follows directly from tan(phi)=a²z/(b² hypot(x,y)).
        radial_latitude = math.degrees(math.atan2(
            z, math.hypot(x, y) * (1 - WGS84_F)**2
        ))
        return dict(latitude_deg=radial_latitude, longitude_deg=longitude,
                    satellite_latitude_deg=latitude, satellite_longitude_deg=longitude)

    def boundary(self, maximum_range_m):
        if maximum_range_m < self.minimum_range_m:
            return [], "below_zenith_threshold"
        points = []
        mask_count = 0
        for horizontal, mask_range, mask_point in zip(
            self.horizontals, self.mask_ranges, self.mask_points
        ):
            if maximum_range_m >= mask_range:
                points.append(dict(mask_point))
                mask_count += 1
                continue
            lower, upper = self.mask_rad, math.pi / 2
            for _ in range(ROOT_ITERATIONS):
                middle = (lower + upper) / 2
                if self._position(horizontal, middle, maximum_range_m)[2] < self.altitude_m:
                    lower = middle
                else:
                    upper = middle
            points.append(self._point(horizontal, (lower + upper) / 2, maximum_range_m))
        points.append(dict(points[0]))
        limit = ("elevation_mask" if mask_count == AZIMUTH_SEGMENTS else
                 "rf_threshold" if mask_count == 0 else "mixed_rf_and_elevation_mask")
        return points, limit

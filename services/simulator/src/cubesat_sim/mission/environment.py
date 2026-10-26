"""Reference spherical occultation and degree1 magnetic field.

IGRF14 degree1 only, not the complete degree13 IGRF. NCEI official coefficient
file, 2025 values plus2025..2030 secular variation; B=-grad(V), a=6371.2km.
Earth thermal forcing below uses a uniform Lambertian sphere, not weather.
"""

import math
from datetime import timedelta
from ..geometry.vectors import add, cross, dot, norm, scale, unit
from .ephemeris import utc_datetime

IGRF_URL = "https://www.ngdc.noaa.gov/IAGA/vmod/coeffs/igrf14coeffs.txt"
MAGNETIC_MODEL = "IGRF14-degree1-only-2025-SV-reference"
MAGNETIC_RADIUS_M = 6371200.0


def decimal_year(epoch_utc, elapsed_s=0.0):
    epoch = utc_datetime(epoch_utc) + timedelta(seconds=elapsed_s)
    start = epoch.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
    end = start.replace(year=start.year + 1)
    return (
        start.year
        + (epoch - start).total_seconds() / (end - start).total_seconds()
    )


def magnetic_field_ecef_t(position_ecef_m, epoch_utc, elapsed_s=0.0):
    years = decimal_year(epoch_utc, elapsed_s) - 2025
    if not 0 <= years <= 5:
        raise ValueError("IGRF14 predictive coefficients valid2025..2030 only")
    g10, g11, h11 = -29350 + 12.6 * years, -1410.3 + 10 * years, 4545.5 - 21.5 * years
    moment = (g11, h11, g10)
    radius = norm(position_ecef_m)
    radial = scale(position_ecef_m, 1 / radius)
    factor = 1e-9 * (MAGNETIC_RADIUS_M / radius) ** 3
    return scale(add(scale(radial, 3 * dot(moment, radial)), scale(moment, -1)), factor)


def sun_visibility(position_m, sun_direction, earth_radius_m):
    along = dot(position_m, sun_direction)
    perpendicular_squared = max(0.0, dot(position_m, position_m) - along * along)
    return 0.0 if along < 0 and perpendicular_squared < earth_radius_m**2 else 1.0


def earth_disk_irradiance(
    position_m,
    sun_direction,
    normals_inertial,
    earth_radius_m,
    solar_w_m2,
    albedo,
    olr_w_m2,
    rings=4,
    azimuths=12,
):
    """Integrate incident flat-surface irradiance over the apparent Earth disk.

    Midpoint quadrature is uniform in solid angle. IR radiance=OLR/pi;
    reflected solar radiance=albedo*S*max(n_Earth.sun,0)/pi. No self shadow.
    """
    radius = norm(position_m)
    if radius <= earth_radius_m:
        raise ValueError("Exterior Earth position required")
    centre = scale(position_m, -1 / radius)
    tangent = unit(cross(centre, (0, 0, 1) if abs(centre[2]) < 0.9 else (1, 0, 0)))
    second = cross(centre, tangent)
    edge = math.sqrt(1 - (earth_radius_m / radius) ** 2)
    solid_angle = 2 * math.pi * (1 - edge) / (rings * azimuths)
    ir = [0.0] * len(normals_inertial)
    reflected = [0.0] * len(normals_inertial)
    for ring in range(rings):
        mu = edge + (1 - edge) * (ring + 0.5) / rings
        sine = math.sqrt(max(0.0, 1 - mu * mu))
        for j in range(azimuths):
            angle = 2 * math.pi * (j + 0.5) / azimuths
            look = add(
                scale(centre, mu),
                add(
                    scale(tangent, sine * math.cos(angle)),
                    scale(second, sine * math.sin(angle)),
                ),
            )
            projection = dot(position_m, look)
            length = -projection - math.sqrt(
                max(
                    0.0, projection * projection - (radius * radius - earth_radius_m**2)
                )
            )
            earth_normal = scale(
                add(position_m, scale(look, length)), 1 / earth_radius_m
            )
            solar_radiance = (
                albedo
                * solar_w_m2
                * max(0.0, dot(earth_normal, sun_direction))
                / math.pi
            )
            for k, normal in enumerate(normals_inertial):
                weight = max(0.0, dot(normal, look)) * solid_angle
                ir[k] += olr_w_m2 / math.pi * weight
                reflected[k] += solar_radiance * weight
    return tuple(zip(reflected, ir))

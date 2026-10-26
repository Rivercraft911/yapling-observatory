"""Low-precision epoch-equatorial Sun and GMST adapter, UTC approximated as UT1.

NOAA/NESDIS MAG coordinate ATBD v1.3 (2009), sections3.4.2.3/4, pp26/27.
The equator/equinox is held fixed at epoch; no precession, nutation, EOP or leap
second dynamics. This is not GCRF, TEME or a realized ITRF transformation.
"""

from datetime import datetime, timezone, timedelta
import math
from ..geometry.frames import rz
from ..geometry.vectors import matvec

MODEL_VERSION = "epoch-mean-equatorial-sun-gmst-approx-0.1.0"
EARTH_OMEGA_RAD_S = 7.29211585530659e-5


def utc_datetime(epoch_utc):
    value = datetime.fromisoformat(epoch_utc.replace("Z", "+00:00"))
    if value.tzinfo is None or value.utcoffset().total_seconds() != 0:
        raise ValueError("Epoch must explicitly identify UTC")
    if not 2025 <= value.year < 2030:
        raise ValueError("Current mission reference models support2025..2029 only")
    return value.astimezone(timezone.utc)


def julian_day(epoch_utc, elapsed_s=0.0):
    return (utc_datetime(epoch_utc).timestamp() + elapsed_s) / 86400 + 2440587.5


def gmst_rad(epoch_utc, elapsed_s=0.0):
    days = julian_day(epoch_utc, elapsed_s) - 2451545.0
    centuries = days / 36525
    return math.radians(
        (
            280.46061837
            + 360.98564736629 * days
            + 0.0003875 * centuries**2
            - 0.0000000258333 * centuries**3
        )
        % 360
    )


def mean_sun_ra_deg(epoch_utc, elapsed_s=0.0):
    # Fictitious equatorial mean Sun: GMST minus the UTC mean-solar hour angle.
    when = utc_datetime(epoch_utc) + timedelta(seconds=elapsed_s)
    hours = when.hour + when.minute / 60 + (when.second + when.microsecond / 1e6) / 3600
    return (math.degrees(gmst_rad(epoch_utc, elapsed_s)) - 15 * (hours - 12)) % 360


def sun_direction_inertial(epoch_utc, elapsed_s=0.0):
    epoch = utc_datetime(epoch_utc)
    midnight = epoch.replace(hour=0, minute=0, second=0, microsecond=0)
    t0 = (midnight.timestamp() / 86400 + 2440587.5 - 2451545) / 36525
    hours = (epoch - midnight).total_seconds() / 3600 + elapsed_s / 3600
    mean_anomaly = math.radians((357.528 + 35999.050 * t0 + 0.04107 * hours) % 360)
    mean_longitude = 280.460 + 36000.772 * t0 + 0.04107 * hours
    longitude = math.radians(
        mean_longitude
        + (1.915 - 0.0048 * t0) * math.sin(mean_anomaly)
        + 0.020 * math.sin(2 * mean_anomaly)
    )
    obliquity = math.radians(23.439 - 0.013 * t0)
    return (
        math.cos(longitude),
        math.cos(obliquity) * math.sin(longitude),
        math.sin(obliquity) * math.sin(longitude),
    )


def inertial_to_ecef(vector, epoch_utc, elapsed_s=0.0):
    return matvec(rz(-gmst_rad(epoch_utc, elapsed_s)), vector)


def ecef_to_inertial(vector, epoch_utc, elapsed_s=0.0):
    return matvec(rz(gmst_rad(epoch_utc, elapsed_s)), vector)


def sun_direction_derivatives_inertial(epoch_utc, elapsed_s=0.0):
    """Analytical derivatives of this module's approximate Sun direction.

    Obliquity and midnight-century coefficients are held exactly as in
    sun_direction_inertial; no external ephemeris accuracy is implied.
    """
    epoch = utc_datetime(epoch_utc)
    midnight = epoch.replace(hour=0, minute=0, second=0, microsecond=0)
    t0 = (midnight.timestamp() / 86400 + 2440587.5 - 2451545) / 36525
    hours = (epoch - midnight).total_seconds() / 3600 + elapsed_s / 3600
    anomaly = math.radians((357.528 + 35999.050 * t0 + 0.04107 * hours) % 360)
    base_rate = math.radians(0.04107) / 3600
    first = math.radians(1.915 - 0.0048 * t0)
    second = math.radians(0.020)
    longitude = math.radians(
        280.460 + 36000.772 * t0 + 0.04107 * hours
        + (1.915 - 0.0048 * t0) * math.sin(anomaly)
        + 0.020 * math.sin(2 * anomaly)
    )
    obliquity = math.radians(23.439 - 0.013 * t0)
    longitude_rate = base_rate * (
        1 + first * math.cos(anomaly) + 2 * second * math.cos(2 * anomaly)
    )
    longitude_acceleration = -base_rate**2 * (
        first * math.sin(anomaly) + 4 * second * math.sin(2 * anomaly)
    )
    direction = sun_direction_inertial(epoch_utc, elapsed_s)
    tangent = (
        -math.sin(longitude),
        math.cos(obliquity) * math.cos(longitude),
        math.sin(obliquity) * math.cos(longitude),
    )
    derivative = tuple(longitude_rate * v for v in tangent)
    second_derivative = tuple(
        longitude_acceleration * v - longitude_rate**2 * u
        for v, u in zip(tangent, direction)
    )
    return direction, derivative, second_derivative

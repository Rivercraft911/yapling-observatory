"""IGRF-14 internal field, geocentric Earth-fixed metres to Earth-fixed tesla.

Only the 2025 main field and 2025–2030 linear secular variation are supported.
The harmonic sum uses Schmidt semi-normalization without Condon–Shortley phase.
P/sin(theta) is propagated by recurrence, never obtained by pole division.
"""

from datetime import datetime, timedelta, timezone
from functools import lru_cache
import hashlib
import math
from pathlib import Path

MODEL_VERSION = "igrf14-degree13-2025-sv-0.1.0"
COEFFICIENT_URL = "https://www.ngdc.noaa.gov/IAGA/vmod/coeffs/igrf14coeffs.txt"
COEFFICIENT_SHA256 = "8f8d88403028fc4ee92c4f38d97b46e0a87e2cfc496045b43c9e26c1d6b0903c"
REFERENCE_RADIUS_M = 6_371_200.0
MINIMUM_RADIUS_M = 3_485_000.0
MAX_DEGREE = 13
SV_DEGREE = 8
START_YEAR = 2025.0
END_YEAR = 2030.0
_DATA_PATH = Path(__file__).with_name("igrf14coeffs.txt")


def _read_coefficients():
    raw = _DATA_PATH.read_bytes()
    if hashlib.sha256(raw).hexdigest() != COEFFICIENT_SHA256:
        raise ValueError(
            "Bundled IGRF-14 coefficients do not match the checked source hash"
        )
    rows = {}
    header = None
    for line in raw.decode("ascii").splitlines():
        if not line or line.startswith("#") or line.startswith("c/s"):
            continue
        fields = line.split()
        if fields[0] == "g/h":
            header = fields
            continue
        if header is None or len(fields) != len(header):
            raise ValueError("Invalid IGRF-14 coefficient header/row")
        family, n, m = fields[0], int(fields[1]), int(fields[2])
        key = family, n, m
        if (
            family not in {"g", "h"}
            or not 1 <= n <= MAX_DEGREE
            or not 0 <= m <= n
            or family == "h"
            and m == 0
            or key in rows
        ):
            raise ValueError("Invalid or duplicate IGRF-14 degree/order")
        value, sv = float(fields[-2]), float(fields[-1])
        if (
            not math.isfinite(value)
            or not math.isfinite(sv)
            or n > SV_DEGREE
            and sv != 0
        ):
            raise ValueError("Invalid IGRF-14 main-field/secular-variation value")
        rows[key] = value, sv
    if header is None or header[-2:] != ["2025.0", "2025-30"] or len(rows) != 195:
        raise ValueError("Incomplete IGRF-14 2025 coefficient set")
    coefficients = []
    for n in range(1, MAX_DEGREE + 1):
        degree = []
        for m in range(n + 1):
            g, dg = rows["g", n, m]
            h, dh = rows["h", n, m] if m else (0.0, 0.0)
            schmidt = math.sqrt(
                (2.0 if m else 1.0) * math.factorial(n - m) / math.factorial(n + m)
            )
            degree.append((g * schmidt, h * schmidt, dg * schmidt, dh * schmidt))
        coefficients.append(tuple(degree))
    return tuple(coefficients)


_COEFFICIENTS = _read_coefficients()
# Flat triangular indexes and recurrence constants are independent of position/time.
_RECURRENCE = tuple(
    tuple(
        (
            n * (n + 1) // 2 + m,
            (n - 1) * n // 2 + m,
            (n - 2) * (n - 1) // 2 + m,
            (2 * n - 1) / (n - m) if n != m else 2 * n - 1,
            (n + m - 1) / (n - m) if n != m else 0.0,
        )
        for m in range(n + 1)
    )
    for n in range(1, MAX_DEGREE + 1)
)


def _real(value, name):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise ValueError(f"{name} must be a finite real SI value")
    return float(value)


@lru_cache(maxsize=4)
def _coefficients_at_year(year):
    delta = year - START_YEAR
    return tuple(
        tuple((g + delta * dg, h + delta * dh) for g, h, dg, dh in degree)
        for degree in _COEFFICIENTS
    )


def field_ecef_t(position_ecef_m, decimal_year, *, max_degree=MAX_DEGREE):
    """Return (Bx, By, Bz) T in the input ECEF axes; no geodetic conversion.

    X crosses the equator/Greenwich meridian, Y crosses 90 degrees east, Z is north.
    Radius must exceed 3485 km. Decimal year is calendar-year fraction, inclusive
    2025.0 through 2030.0. This is an internal main-field model, without external fields.
    """
    try:
        position = tuple(position_ecef_m)
    except TypeError as error:
        raise ValueError(
            "ECEF position must contain three finite metre coordinates"
        ) from error
    if len(position) != 3:
        raise ValueError("ECEF position must contain exactly three coordinates")
    x, y, z = (_real(value, "ECEF coordinate in metres") for value in position)
    year = _real(decimal_year, "decimal year")
    if not START_YEAR <= year <= END_YEAR:
        raise ValueError(
            "IGRF-14 2025 secular-variation model supports 2025.0 through 2030.0 only"
        )
    if type(max_degree) is not int or not 1 <= max_degree <= MAX_DEGREE:
        raise ValueError("Harmonic degree must be an integer in 1..13")
    horizontal = math.hypot(x, y)
    radius = math.hypot(horizontal, z)
    if not math.isfinite(radius) or radius <= MINIMUM_RADIUS_M:
        raise ValueError(
            "IGRF-14 requires geocentric radius > 3485000 m; check position units"
        )
    st, ct = horizontal / radius, z / radius
    cp, sp = (x / horizontal, y / horizontal) if horizontal else (1.0, 0.0)
    cos_m = [1.0, cp]
    sin_m = [0.0, sp]
    for m in range(2, max_degree + 1):
        cos_m.append(cp * cos_m[-1] - sp * sin_m[-1])
        sin_m.append(sp * cos_m[-2] + cp * sin_m[-1])
    size = (max_degree + 1) * (max_degree + 2) // 2
    p, dp, q = [0.0] * size, [0.0] * size, [0.0] * size
    p[0] = 1.0
    ratio = REFERENCE_RADIUS_M / radius
    radial = ratio * ratio
    br = bt = bp = 0.0
    coefficients = _coefficients_at_year(year)
    for n in range(1, max_degree + 1):
        radial *= ratio
        for m, (index, previous, previous2, a, b) in enumerate(_RECURRENCE[n - 1]):
            if n == m:
                diagonal = previous - 1
                p[index] = a * st * p[diagonal]
                dp[index] = a * (ct * p[diagonal] + st * dp[diagonal])
                q[index] = a * p[diagonal]
            elif m == n - 1:
                p[index] = a * ct * p[previous]
                dp[index] = a * (ct * dp[previous] - st * p[previous])
                if m:
                    q[index] = a * ct * q[previous]
            else:
                p[index] = a * ct * p[previous] - b * p[previous2]
                dp[index] = (
                    a * (ct * dp[previous] - st * p[previous]) - b * dp[previous2]
                )
                if m:
                    q[index] = a * ct * q[previous] - b * q[previous2]
            g, h = coefficients[n - 1][m]
            harmonic = g * cos_m[m] + h * sin_m[m]
            br += radial * (n + 1) * harmonic * p[index]
            bt -= radial * harmonic * dp[index]
            if m:
                bp += radial * m * (g * sin_m[m] - h * cos_m[m]) * q[index]
    transverse = br * st + bt * ct
    return (
        (transverse * cp - bp * sp) * 1e-9,
        (transverse * sp + bp * cp) * 1e-9,
        (br * ct - bt * st) * 1e-9,
    )


@lru_cache(maxsize=4)
def _utc_epoch(epoch_utc):
    if not isinstance(epoch_utc, str):
        raise ValueError("Epoch must be an explicit ISO UTC string")
    try:
        epoch = datetime.fromisoformat(epoch_utc.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("Invalid ISO UTC epoch") from error
    if epoch.tzinfo is None or epoch.utcoffset() != timedelta(0):
        raise ValueError("Epoch must explicitly identify UTC")
    return epoch.astimezone(timezone.utc)


def utc_decimal_year(epoch_utc, elapsed_s=0.0):
    """UTC calendar fraction, including leap years and rollover; microsecond epoch precision."""
    elapsed = _real(elapsed_s, "elapsed SI seconds")
    try:
        when = _utc_epoch(epoch_utc) + timedelta(seconds=elapsed)
    except (OverflowError, TypeError) as error:
        raise ValueError("UTC time offset exceeds the supported date range") from error
    if (
        not datetime(2025, 1, 1, tzinfo=timezone.utc)
        <= when
        <= datetime(2030, 1, 1, tzinfo=timezone.utc)
    ):
        raise ValueError(
            "IGRF-14 UTC date must be within 2025-01-01 through 2030-01-01 inclusive"
        )
    start = datetime(when.year, 1, 1, tzinfo=timezone.utc)
    end = datetime(when.year + 1, 1, 1, tzinfo=timezone.utc)
    return when.year + (when - start).total_seconds() / (end - start).total_seconds()


def field_ecef_t_at_utc(
    position_ecef_m, epoch_utc, elapsed_s=0.0, *, max_degree=MAX_DEGREE
):
    return field_ecef_t(
        position_ecef_m, utc_decimal_year(epoch_utc, elapsed_s), max_degree=max_degree
    )


def model_metadata():
    return dict(
        model_version=MODEL_VERSION,
        name="IGRF-14 full internal main field",
        coefficient_source=COEFFICIENT_URL,
        coefficient_sha256=COEFFICIENT_SHA256,
        coefficient_release="IAGA IGRF-14, November 2024; Zenodo v2, 25 November 2024",
        coefficient_archive="https://doi.org/10.5281/zenodo.14218973",
        coefficient_license="CC BY 4.0; https://creativecommons.org/licenses/by/4.0/",
        citation="Beggan et al. (2026), International geomagnetic reference field: the fourteenth generation, Earth Planets Space 78, 127; https://doi.org/10.1186/s40623-025-02360-0",
        max_degree=MAX_DEGREE,
        secular_variation_degree=SV_DEGREE,
        reference_radius_m=REFERENCE_RADIUS_M,
        minimum_radius_m_exclusive=MINIMUM_RADIUS_M,
        decimal_year_bounds=[START_YEAR, END_YEAR],
        input_frame="ECEF",
        output_frame="ECEF",
        input_units="metres",
        output_units="tesla",
        normalization="Schmidt semi-normalized, no Condon–Shortley phase",
        synthesis="B = -gradient(V); P, dP/dtheta and P/sin(theta) recurrence with no pole division",
        time_coefficients="Exact linear 2025–2030 SV, bounded 4-entry coefficient/UTC-epoch caches; no time quantization",
        limits=[
            "Internal main field only; no magnetospheric/ionospheric disturbance, local spacecraft magnetic field or sensor model.",
            "2025 main-field coefficients are non-definitive and 2025–2030 secular variation is predictive. Degrees 9..13 have no supplied SV and remain constant.",
            "No geodetic/ECEF or inertial/Earth-fixed transformation is inferred. Caller supplies the same declared terrestrial axes used to define longitude.",
            "Numerical agreement with official synthesis validates implementation, not instantaneous magnetic-field accuracy or GNC performance.",
        ],
    )

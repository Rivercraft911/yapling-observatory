"""Physical limits, time/units contract and stable synthesis independent of orbit UI."""

import hashlib
import json
import math
from pathlib import Path

import pytest

from cubesat_sim.geomagnetism import igrf14
from cubesat_sim.mission.environment import magnetic_field_ecef_t as legacy_degree_one


@pytest.mark.parametrize("year", [2025.0, 2027.5, 2030.0])
@pytest.mark.parametrize(
    "position",
    [
        (6928137.0, 0.0, 0.0),
        (0.0, 6928137.0, 0.0),
        (0.0, 0.0, 6928137.0),
        (0.0, 0.0, -6928137.0),
        (1e6, -4e6, 5e6),
    ],
)
def test_degree_one_matches_independent_cartesian_dipole(position, year):
    elapsed_years = year - 2025
    moment = (
        -1410.3 + 10 * elapsed_years,
        4545.5 - 21.5 * elapsed_years,
        -29350 + 12.6 * elapsed_years,
    )
    radius = math.hypot(*position)
    radial = tuple(value / radius for value in position)
    projection = math.fsum(a * b for a, b in zip(moment, radial))
    factor = 1e-9 * (6371200 / radius) ** 3
    expected = tuple(factor * (3 * projection * u - m) for u, m in zip(radial, moment))
    assert igrf14.field_ecef_t(position, year, max_degree=1) == pytest.approx(
        expected, abs=2e-19
    )


def test_degree_one_utc_wrapper_matches_legacy_and_radius_cubed_scaling():
    position = (2e6, -4e6, 5e6)
    epoch = "2028-12-31T23:59:59Z"
    for elapsed in [0, 1, 86401]:
        actual = igrf14.field_ecef_t_at_utc(position, epoch, elapsed, max_degree=1)
        assert actual == pytest.approx(
            legacy_degree_one(position, epoch, elapsed), abs=2e-19
        )
    first = igrf14.field_ecef_t(position, 2027.5, max_degree=1)
    second = igrf14.field_ecef_t(tuple(2 * v for v in position), 2027.5, max_degree=1)
    assert second == pytest.approx(tuple(v / 8 for v in first), abs=2e-20)


@pytest.mark.parametrize("sign", [-1, 1])
def test_exact_pole_is_finite_and_nearby_longitudes_share_one_cartesian_limit(sign):
    radius = 6928137.0
    pole = igrf14.field_ecef_t((0, 0, sign * radius), 2027.5)
    assert all(math.isfinite(value) for value in pole)
    for longitude_deg in range(-180, 181, 30):
        phi = math.radians(longitude_deg)
        rho = 0.001
        position = (
            rho * math.cos(phi),
            rho * math.sin(phi),
            sign * math.sqrt(radius**2 - rho**2),
        )
        nearby = igrf14.field_ecef_t(position, 2027.5)
        assert math.dist(pole, nearby) < 2e-13


def test_full_synthesis_uses_linear_sv_and_fixed_high_degrees():
    position = (4e6, -3e6, 5e6)
    first = igrf14.field_ecef_t(position, 2025)
    middle = igrf14.field_ecef_t(position, 2027.5)
    last = igrf14.field_ecef_t(position, 2030)
    assert middle == pytest.approx(
        tuple((a + b) / 2 for a, b in zip(first, last)), abs=5e-20
    )
    lower_first = igrf14.field_ecef_t(position, 2025, max_degree=8)
    lower_last = igrf14.field_ecef_t(position, 2030, max_degree=8)
    assert tuple(b - a for a, b in zip(first, last)) == pytest.approx(
        tuple(b - a for a, b in zip(lower_first, lower_last)), abs=5e-20
    )
    assert math.dist(first, igrf14.field_ecef_t(position, 2025, max_degree=12)) > 1e-13


def test_utc_calendar_fraction_leap_year_rollover_and_endpoint_bounds():
    assert igrf14.utc_decimal_year("2025-01-01T00:00:00Z", 365 * 86400 / 2) == 2025.5
    assert igrf14.utc_decimal_year("2028-01-01T00:00:00Z", 366 * 86400 / 2) == 2028.5
    assert igrf14.utc_decimal_year("2028-12-31T23:59:59Z", 1) == 2029
    assert igrf14.utc_decimal_year("2030-01-01T00:00:00+00:00") == 2030
    for epoch, elapsed in [
        ("2024-12-31T23:59:59Z", 0),
        ("2030-01-01T00:00:00Z", 0.001),
        ("2025-01-01", 0),
        ("2025-01-01T00:00:00+01:00", 0),
    ]:
        with pytest.raises(ValueError):
            igrf14.utc_decimal_year(epoch, elapsed)


@pytest.mark.parametrize(
    "position,year,degree",
    [
        ((6928.137, 0, 0), 2025, 13),
        ((0, 0, 0), 2025, 13),
        ((3485000, 0, 0), 2025, 13),
        ((7e6, 0), 2025, 13),
        ((7e6, 0, 0, 0), 2025, 13),
        ((7e6, True, 0), 2025, 13),
        ((7e6, float("nan"), 0), 2025, 13),
        ((7e6, float("inf"), 0), 2025, 13),
        ((7e6, 0, 0), 2024.999, 13),
        ((7e6, 0, 0), 2030.001, 13),
        ((7e6, 0, 0), float("nan"), 13),
        ((7e6, 0, 0), True, 13),
        ((7e6, 0, 0), 2025, True),
        ((7e6, 0, 0), 2025, 0),
        ((7e6, 0, 0), 2025, 14),
        ((7e6, 0, 0), 2025, 3.0),
    ],
)
def test_reject_invalid_frames_units_values_dates_and_degree(position, year, degree):
    with pytest.raises(ValueError):
        igrf14.field_ecef_t(position, year, max_degree=degree)


def test_checked_runtime_identity_terms_and_bounded_exact_time_caches(
    tmp_path, monkeypatch
):
    root = Path(igrf14.__file__).parent
    data = (root / "igrf14coeffs.txt").read_bytes()
    assert hashlib.sha256(data).hexdigest() == igrf14.COEFFICIENT_SHA256
    provenance = json.loads((root / "igrf14-source.json").read_text())
    assert provenance["sha256"] == igrf14.COEFFICIENT_SHA256
    assert provenance["license_id"] == "CC-BY-4.0"
    assert (
        provenance["creator"]
        == "International Association of Geomagnetism and Aeronomy (IAGA)"
    )
    json.dumps(igrf14.model_metadata(), allow_nan=False)
    igrf14._coefficients_at_year.cache_clear()
    igrf14._utc_epoch.cache_clear()
    for second in range(100):
        epoch = f"2025-01-01T00:{second//60:02d}:{second%60:02d}Z"
        igrf14.field_ecef_t_at_utc((7e6, 0, 0), epoch)
    assert igrf14._coefficients_at_year.cache_info().currsize <= 4
    assert igrf14._utc_epoch.cache_info().currsize <= 4
    assert igrf14._coefficients_at_year.cache_info().maxsize == 4
    changed = tmp_path / "changed.txt"
    changed.write_bytes(data + b"\n")
    monkeypatch.setattr(igrf14, "_DATA_PATH", changed)
    with pytest.raises(ValueError, match="checked source hash"):
        igrf14._read_coefficients()

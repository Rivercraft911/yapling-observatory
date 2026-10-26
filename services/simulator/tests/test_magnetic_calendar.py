from datetime import datetime, timezone
import pytest
from cubesat_sim.mission.environment import decimal_year, magnetic_field_ecef_t


def test_decimal_year_uses_actual_year_after_crossing_into_leap_year():
    start = datetime(2027, 12, 20, tzinfo=timezone.utc)
    end = datetime(2028, 1, 19, tzinfo=timezone.utc)
    elapsed = (end-start).total_seconds()
    assert decimal_year(start.isoformat(), elapsed) == pytest.approx(2028 + 18/366, abs=1e-12)
    assert decimal_year(start.isoformat(), elapsed) == decimal_year(end.isoformat())
    assert magnetic_field_ecef_t((7000000, 1000000, 0), start.isoformat(), elapsed) == magnetic_field_ecef_t((7000000, 1000000, 0), end.isoformat())


def test_prediction_endpoint_is_inclusive_and_not_extrapolated():
    assert decimal_year("2029-12-31T00:00:00Z", 86400) == 2030
    magnetic_field_ecef_t((7000000, 0, 0), "2029-12-31T00:00:00Z", 86400)
    with pytest.raises(ValueError):
        magnetic_field_ecef_t((7000000, 0, 0), "2030-01-01T00:00:00Z", 1)

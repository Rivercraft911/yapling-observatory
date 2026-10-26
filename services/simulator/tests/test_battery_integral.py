"""Bit-for-bit checks against the preserved trapezoid arithmetic and solver."""
import math
import random
import struct

import pytest

from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.power import battery_electrical as model


def original_integral(values, start, end):
    if start == end:
        return 0.0
    if start > end:
        return -original_integral(values, end, start)
    cuts = [start, *[s for s in model._SOC if start < s < end], end]
    return math.fsum(
        (b - a) * (model._interpolate(values, a) + model._interpolate(values, b)) / 2
        for a, b in zip(cuts, cuts[1:])
    )


def binary(value):
    return struct.pack("!d", value)


@pytest.mark.parametrize("table", ["ocv", "resistance", "signed_zero", "mixed"])
def test_knot_neighbors_and_reversed_intervals_preserve_every_float_bit(table):
    rng = random.Random(20261025)
    values = {
        "ocv": model._OCV,
        "resistance": model._RESISTANCE,
        "signed_zero": tuple(-0.0 if i % 2 else 0.0 for i in range(21)),
        "mixed": tuple((-1)**i * 2.0**rng.randrange(-100, 100) for i in range(21)),
    }[table]
    points = [point for knot in model._SOC for point in
              (math.nextafter(knot, -math.inf), knot, math.nextafter(knot, math.inf))]
    points += [0.0, -0.0, 1.0]
    for start in points:
        for end in points:
            assert binary(model._integral(values, start, end)) == binary(original_integral(values, start, end))


def test_seeded_random_and_adjacent_float_intervals_remain_exact_without_prefix_subtraction():
    rng = random.Random(20261025)
    for _ in range(10000):
        start, end = rng.random(), rng.random()
        for values in (model._OCV, model._RESISTANCE):
            assert binary(model._integral(values, start, end)) == binary(original_integral(values, start, end))
            neighbor = math.nextafter(start, 1)
            integral = model._integral(values, start, neighbor)
            assert integral > 0
            assert binary(integral) == binary(original_integral(values, start, neighbor))


def test_cached_full_terms_follow_changed_immutable_tables_and_knots(monkeypatch):
    original = model._integral(model._OCV, .1, .9)
    for values in ((3.6,) * 21, list(model._OCV), tuple(reversed(model._OCV))):
        assert binary(model._integral(values, .1, .9)) == binary(original_integral(values, .1, .9))
    monkeypatch.setattr(model, "_SOC", (0.0, .1, .3, .7, 1.0))
    values = (2.7, 3.4, 3.1, 4.2, 4.0)
    assert binary(model._integral(values, .05, .95)) == binary(original_integral(values, .05, .95))
    assert original > 0


def test_full_battery_steps_preserve_all_fields_through_limits_and_knot_crossings(monkeypatch):
    rng = random.Random(20261025)
    spec = default_mission_scenario().power.battery
    points = [point for knot in model._SOC for point in
              (max(0.0, math.nextafter(knot, -math.inf)), knot,
               min(1.0, math.nextafter(knot, math.inf)))]
    cases = [
        (spec, rng.choice(points) if i < 100 else rng.random(), rng.random() * 30,
         rng.random() * 30, 10**rng.uniform(-2, 5),
         rng.choice((250.0, 278.0, 298.15, 310.0, 325.0)))
        for i in range(200)
    ]
    optimized = [model.advance_electrical_battery(*case) for case in cases]
    monkeypatch.setattr(model, "_integral", original_integral)
    reference = [model.advance_electrical_battery(*case) for case in cases]
    for actual, expected in zip(optimized, reference):
        for name, value in expected.__dict__.items():
            other = getattr(actual, name)
            assert binary(other) == binary(value) if type(value) is float else other == value

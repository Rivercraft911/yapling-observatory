"""Exact arithmetic and validation parity for hot numerical kernels."""

import math
import random
import struct

import pytest

from cubesat_sim.geometry.vectors import add, dot
from cubesat_sim.attitude.kinematics import (
    finite_vector,
    multiply,
    normalize_quaternion,
    unit_vector,
)


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def _norm(a):
    return math.sqrt(sum(abs(x) ** 2 for x in a))


def _finite_vector(value, size=3):
    if len(value) != size or not all(math.isfinite(v) for v in value):
        raise ValueError("Invalid vector")
    return tuple(float(v) for v in value)


def _unit_vector(value):
    vector = _finite_vector(value)
    if not math.isfinite(_norm(vector)) or _norm(vector) < 1e-14:
        raise ValueError("Invalid unit direction")
    magnitude = _norm(vector)
    return tuple((1 / magnitude) * value for value in vector)


def _normalize(value, *, validate=True):
    value = _finite_vector(value, 4)
    magnitude = math.hypot(*value)
    if magnitude < 1e-14 or (validate and abs(magnitude - 1) > 1e-6):
        raise ValueError("Invalid quaternion")
    result = tuple(v / magnitude for v in value)
    sign_reference = (
        result[0]
        if abs(result[0]) > 1e-14
        else next((v for v in result[1:] if abs(v) > 1e-14), 1)
    )
    return tuple(-v for v in result) if sign_reference < 0 else result


def _multiply(a, b):
    av, bv = a[1:], b[1:]
    cross = (
        av[1] * bv[2] - av[2] * bv[1],
        av[2] * bv[0] - av[0] * bv[2],
        av[0] * bv[1] - av[1] * bv[0],
    )
    vector = tuple(a[0] * y + b[0] * x + z for x, y, z in zip(av, bv, cross))
    return a[0] * b[0] - _dot(av, bv), *vector


def _identical(actual, expected):
    if isinstance(expected, tuple):
        assert len(actual) == len(expected)
        for a, b in zip(actual, expected):
            _identical(a, b)
    elif isinstance(expected, complex):
        _identical(actual.real, expected.real)
        _identical(actual.imag, expected.imag)
    elif isinstance(expected, float):
        assert struct.pack("!d", actual) == struct.pack("!d", expected)
    else:
        assert actual == expected


@pytest.mark.parametrize(
    "a,b",
    [
        ((), ()),
        ((1, 2, 3, 4), (5, 6, 7, 8)),
        ((1, 2), (3,)),
        ((-0.0, 0.0, -0.0), (0.0, -0.0, -0.0)),
        ((2**53 * 1.0, 1.0, -(2**53) * 1.0), (1.0, 1.0, 1.0)),
        ((1e150, 1e-150, -1e150), (1e-150, 1e150, 1e-150)),
        ((1 + 2j, -3 + 4j, -0j), (2 - 3j, 5 + 6j, -1j)),
    ],
)
def test_vector_iteration_preserves_sum_order_types_and_signed_zero(a, b):
    _identical(dot(a, b), _dot(a, b))
    _identical(add(a, b), _add(a, b))
    _identical(dot(iter(a), iter(b)), _dot(iter(a), iter(b)))
    _identical(add(iter(a), iter(b)), _add(iter(a), iter(b)))


def test_quaternion_and_validation_kernels_match_original_arithmetic():
    rng = random.Random(20261025)
    quaternions = [
        (1.0, -0.0, 0.0, -0.0),
        (-1.0, -0.0, 0.0, 0.0),
        (0.0, -1.0, 0.0, -0.0),
        (0.0, 0.0, -1.0, 0.0),
        (0.0, 0.0, 0.0, -1.0),
    ]
    quaternions += [
        tuple(rng.uniform(-1, 1) * 10 ** rng.uniform(-75, 75) for _ in range(4))
        for _ in range(500)
    ]
    for a, b in zip(quaternions, reversed(quaternions)):
        _identical(multiply(a, b), _multiply(a, b))
        if math.hypot(*a) >= 1e-14:
            _identical(normalize_quaternion(a, validate=False), _normalize(a, validate=False))
        else:
            for evaluator in (normalize_quaternion, _normalize):
                with pytest.raises(ValueError):
                    evaluator(a, validate=False)
        if _norm(a[1:]) >= 1e-14:
            _identical(unit_vector(a[1:]), _unit_vector(a[1:]))
        _identical(finite_vector(a, 4), _finite_vector(a, 4))
    _identical(multiply((1, 2, 3, 4, 5), (6, 7, 8, 9, 10)),
               _multiply((1, 2, 3, 4, 5), (6, 7, 8, 9, 10)))


@pytest.mark.parametrize("value", [(0, 0), (math.nan, 0, 0), (math.inf, 1, 2)])
def test_vector_validation_still_rejects_invalid_inputs(value):
    for evaluator in (finite_vector, unit_vector):
        with pytest.raises(ValueError):
            evaluator(value)


@pytest.mark.parametrize("value", [(0, 0, 0, 0), (1, 0, 0), (2, 0, 0, 0), (math.nan, 0, 0, 0)])
def test_quaternion_validation_still_rejects_invalid_inputs(value):
    with pytest.raises(ValueError):
        normalize_quaternion(value)

"""Hamilton q_B_from_I: v_B=q v_I q*, omega_B=B relative to I in B."""

import math

from ..geometry.vectors import cross, dot, norm, scale, unit


def finite_vector(value, size=3):
    if len(value) != size or not all(map(math.isfinite, value)):
        raise ValueError(f"Expected {size} finite real components")
    return tuple(map(float, value))


def unit_vector(value):
    vector = finite_vector(value)
    magnitude = norm(vector)
    if not math.isfinite(magnitude) or magnitude < 1e-14:
        raise ValueError("Direction must have a finite nonzero norm")
    return scale(vector, 1 / magnitude)


def normalize_quaternion(value, *, validate=True):
    value = finite_vector(value, 4)
    magnitude = math.hypot(*value)
    if magnitude < 1e-14 or (validate and abs(magnitude - 1) > 1e-6):
        raise ValueError("Quaternion must have unit norm within 1e-6")
    result = (
        value[0] / magnitude,
        value[1] / magnitude,
        value[2] / magnitude,
        value[3] / magnitude,
    )
    sign_reference = (
        result[0]
        if abs(result[0]) > 1e-14
        else next((v for v in result[1:] if abs(v) > 1e-14), 1)
    )
    return tuple(-v for v in result) if sign_reference < 0 else result


def conjugate(q):
    return q[0], -q[1], -q[2], -q[3]


def multiply(a, b):
    if len(a) == len(b) == 4:
        return (
            a[0] * b[0] - sum((a[1] * b[1], a[2] * b[2], a[3] * b[3])),
            a[0] * b[1] + b[0] * a[1] + (a[2] * b[3] - a[3] * b[2]),
            a[0] * b[2] + b[0] * a[2] + (a[3] * b[1] - a[1] * b[3]),
            a[0] * b[3] + b[0] * a[3] + (a[1] * b[2] - a[2] * b[1]),
        )
    av, bv = a[1:], b[1:]
    vector = tuple(a[0] * y + b[0] * x + z for x, y, z in zip(av, bv, cross(av, bv)))
    return a[0] * b[0] - dot(av, bv), *vector


def rotate(q, vector):
    q = normalize_quaternion(q, validate=False)
    return multiply(multiply(q, (0.0, *vector)), conjugate(q))[1:]


def minimum_rotation(source, target):
    """Active shortest rotation source->target, with deterministic antipodal axis."""
    source, target = unit_vector(source), unit_vector(target)
    cosine = max(-1.0, min(1.0, dot(source, target)))
    vector = cross(source, target)
    sine = norm(vector)
    if sine < 1e-14 and cosine < 0:
        basis = min(
            ((1, 0, 0), (0, 1, 0), (0, 0, 1)), key=lambda axis: abs(dot(source, axis))
        )
        return normalize_quaternion((0.0, *unit(cross(source, basis))))
    if sine < 1e-14:
        return (1.0, 0.0, 0.0, 0.0)
    half_angle = math.atan2(sine, cosine) / 2
    return normalize_quaternion(
        (math.cos(half_angle), *scale(vector, math.sin(half_angle) / sine)),
        validate=False,
    )


def boresight_reference(q_body_from_inertial_wxyz, body_boresight, target_inertial):
    """Closest attitude aligning a boresight; roll about the target remains free.

    This is an instantaneous geometric reference, not a reachable trajectory or
    a claim that roll/polarization requirements are satisfied.
    """
    q = normalize_quaternion(q_body_from_inertial_wxyz)
    current = rotate(conjugate(q), unit_vector(body_boresight))
    change_inertial = minimum_rotation(current, target_inertial)
    return normalize_quaternion(multiply(q, conjugate(change_inertial)), validate=False)

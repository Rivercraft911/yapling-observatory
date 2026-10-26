"""Independent integral, power, straight-limit and complex-vector checks."""
from dataclasses import replace
import cmath
import math

import pytest

from cubesat_sim.geometry.frames import rotation
from cubesat_sim.geometry.vectors import cross, dot, matvec, norm, unit
from cubesat_sim.rf.antennas import half_wave_dipole
from cubesat_sim.rf.bent_wire import (
    BentWire, OUTWARD_45_ARMS, UPWARD_45_ARMS, _arm_integral, _power_integral,
)
from cubesat_sim.rf.free_space import C_M_S
from cubesat_sim.rf.polarization import polarization_coupling

FREQUENCY_HZ = 438e6
ARM_LENGTH_M = C_M_S / (4 * FREQUENCY_HZ)


def fibonacci_directions(count):
    for i in range(count):
        z = 1 - 2 * (i + 0.5) / count
        phi = i * math.pi * (3 - math.sqrt(5))
        r = math.sqrt(1 - z * z)
        yield r * math.cos(phi), r * math.sin(phi), z


def midpoint_arm_integral(kappa, cosine, count):
    # Independent direct current-element sum, not the closed-form implementation.
    return sum(math.sin(kappa * (1 - t)) / kappa * cmath.exp(1j * kappa * cosine * t)
               for t in ((i + 0.5) / count for i in range(count))) / count


@pytest.mark.parametrize("kappa", [1e-7, 1e-3, math.pi / 2, math.pi])
@pytest.mark.parametrize("cosine", [-1, -0.73, 0, 0.4, 1])
def test_closed_form_matches_independent_current_elements(kappa, cosine):
    exact = _arm_integral(kappa, cosine)
    error_coarse = abs(midpoint_arm_integral(kappa, cosine, 128) - exact)
    error_fine = abs(midpoint_arm_integral(kappa, cosine, 1024) - exact)
    assert error_fine < 2e-7
    if error_coarse > 1e-12:
        assert error_fine < error_coarse / 50


def test_straight_quarter_wave_limit_matches_existing_halfwave_vector_pattern():
    model = BentWire(FREQUENCY_HZ, ARM_LENGTH_M, (1, 0, 0), (-1, 0, 0), efficiency=0.73)
    for look in [*fibonacci_directions(300), (1, 0, 0), (-1, 0, 0), (0, 1, 0)]:
        actual = model.response(look)
        expected = half_wave_dipole((1, 0, 0), look, efficiency=0.73)
        assert actual.gain_linear == pytest.approx(expected.gain_linear, abs=2e-14)
        if expected.polarization is None:
            assert actual.polarization is None
        else:
            assert actual.polarization == pytest.approx(expected.polarization, abs=3e-14)


@pytest.mark.parametrize("arms", [UPWARD_45_ARMS, OUTWARD_45_ARMS])
def test_independent_equal_area_power_is_one_efficiency_budget(arms):
    model = BentWire(FREQUENCY_HZ, ARM_LENGTH_M, *arms, efficiency=0.73)
    average = math.fsum(model.response(look).gain_linear for look in fibonacci_directions(16000)) / 16000
    assert average == pytest.approx(0.73, abs=2e-6)
    response = model.response((0.2, 0.9, 0.3))
    assert replace(model, efficiency=1).response((0.2, 0.9, 0.3)).gain_linear * 0.73 == pytest.approx(response.gain_linear)
    zero = replace(model, efficiency=0).response((0.2, 0.9, 0.3))
    assert zero.gain_linear == 0 and zero.polarization is None


@pytest.mark.parametrize("kappa", [math.pi / 2, math.pi])
@pytest.mark.parametrize("cosine_included", [-1, 0, 0.9])
def test_sphere_quadrature_convergence(kappa, cosine_included):
    coarse = _power_integral(kappa, cosine_included, 8, 16)
    medium = _power_integral(kappa, cosine_included, 16, 32)
    fine = _power_integral(kappa, cosine_included, 32, 64)
    assert abs(medium - fine) < 2e-12
    assert abs(medium - fine) <= abs(coarse - fine) + 2e-14


def test_whole_scene_rotation_preserves_complex_field_and_analyzer_coupling():
    model = BentWire(FREQUENCY_HZ, ARM_LENGTH_M, *UPWARD_45_ARMS)
    matrix = rotation((0.3, 0.7, -0.4), 1.27)
    rotated = replace(model, arm_a=matvec(matrix, model.arm_a), arm_b=matvec(matrix, model.arm_b))
    for look in fibonacci_directions(40):
        original = model.response(look)
        actual = rotated.response(matvec(matrix, look))
        assert actual.gain_linear == pytest.approx(original.gain_linear, abs=3e-14)
        assert actual.polarization == pytest.approx(matvec(matrix, original.polarization), abs=3e-14)
        analyzer = unit(cross(look, (0, 0, 1)))
        assert polarization_coupling(actual.polarization, matvec(matrix, analyzer)) == pytest.approx(
            polarization_coupling(original.polarization, analyzer), abs=3e-14)


def test_upward_and_outward_are_the_same_free_space_shape_rotated_in_body():
    up = BentWire(FREQUENCY_HZ, ARM_LENGTH_M, *UPWARD_45_ARMS)
    out = BentWire(FREQUENCY_HZ, ARM_LENGTH_M, *OUTWARD_45_ARMS)
    matrix = rotation((1, 0, 0), math.pi / 2)
    for look in fibonacci_directions(60):
        a, b = up.response(look), out.response(matvec(matrix, look))
        assert b.gain_linear == pytest.approx(a.gain_linear, abs=2e-14)
        assert b.polarization == pytest.approx(matvec(matrix, a.polarization), abs=2e-14)
    assert up.response((0, 1, 0)).gain_linear != pytest.approx(out.response((0, 1, 0)).gain_linear, abs=0.01)


def test_complex_transverse_polarization_and_explicit_circular_analyzers():
    model = BentWire(FREQUENCY_HZ, ARM_LENGTH_M, *UPWARD_45_ARMS)
    look = unit((0.7, 0.4, 0.5))
    response = model.response(look)
    pol = response.polarization
    assert norm(pol) == pytest.approx(1)
    assert abs(dot(pol, look)) < 1e-15
    e1 = unit(cross(look, (0, 0, 1)))
    e2 = cross(look, e1)
    plus = tuple((a + 1j * b) / math.sqrt(2) for a, b in zip(e1, e2))
    minus = tuple(v.conjugate() for v in plus)
    p_plus, p_minus = polarization_coupling(pol, plus), polarization_coupling(pol, minus)
    assert p_plus + p_minus == pytest.approx(1)
    assert abs(p_plus - p_minus) > 0.1  # The vector integral retains elliptical polarization.
    assert polarization_coupling(pol, e1) + polarization_coupling(pol, e2) == pytest.approx(1)
    reverse = model.response(tuple(-v for v in look))
    assert reverse.gain_linear == pytest.approx(response.gain_linear)
    assert reverse.polarization == pytest.approx(tuple(v.conjugate() for v in pol))


def test_axis_directions_short_limit_and_nulls_are_finite():
    straight = BentWire(FREQUENCY_HZ, ARM_LENGTH_M, (1, 0, 0), (-1, 0, 0))
    assert straight.response((1, 0, 0)).polarization is None
    assert straight.response((-1, 0, 0)).gain_linear == 0
    bent = BentWire(FREQUENCY_HZ, ARM_LENGTH_M, *UPWARD_45_ARMS)
    for look in [(1, 0, 0), (-1, 0, 0), (0, 0, 1), (0, 0, -1), *fibonacci_directions(100)]:
        response = bent.response(look)
        assert math.isfinite(response.gain_linear) and response.gain_linear >= 0
        assert response.polarization is not None
        assert all(math.isfinite(v.real) and math.isfinite(v.imag) for v in response.polarization)
    short = replace(straight, arm_length_m=1e-12)
    assert short.response((0, 1, 0)).gain_linear == pytest.approx(1.5, abs=1e-13)


@pytest.mark.parametrize("changes", [
    dict(frequency_hz=float("nan")), dict(frequency_hz=0), dict(arm_length_m=-1),
    dict(arm_length_m=C_M_S / FREQUENCY_HZ), dict(efficiency=1.01), dict(efficiency=float("inf")),
    dict(arm_a=(0, 0, 0)), dict(arm_b=(0, 0, float("nan"))), dict(arm_b=UPWARD_45_ARMS[0]),
])
def test_invalid_inputs_are_rejected(changes):
    values = dict(frequency_hz=FREQUENCY_HZ, arm_length_m=ARM_LENGTH_M, arm_a=UPWARD_45_ARMS[0], arm_b=UPWARD_45_ARMS[1])
    with pytest.raises(ValueError):
        BentWire(**(values | changes))


def test_bad_probe_direction_rejected_and_normalization_cached():
    model = BentWire(FREQUENCY_HZ, ARM_LENGTH_M, *UPWARD_45_ARMS)
    with pytest.raises(ValueError):
        model.response((0, float("nan"), 1))
    with pytest.raises(ValueError):
        model.response((0, 0, 0))
    model.response((0, 1, 0))
    assert "normalization_integral" in model.__dict__

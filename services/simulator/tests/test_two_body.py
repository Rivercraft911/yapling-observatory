"""Kepler references, order, reversibility and conservative diagnostics."""

from dataclasses import replace
import math

import pytest

from cubesat_sim.geometry.vectors import add, norm, scale
from cubesat_sim.orbit.study import OrbitStudyInput, run_orbit_study
from cubesat_sim.orbit.two_body import (
    CartesianState,
    TwoBodyConfig,
    invariants,
    propagate,
    step,
)


def kepler_ellipse(time_s, eccentricity=0.2):
    # Independent nondimensional a=mu=1 elliptic Kepler solution, pericenter t=0.
    mean = math.remainder(time_s, 2 * math.pi)
    anomaly = mean
    for _ in range(15):
        anomaly -= (anomaly - eccentricity * math.sin(anomaly) - mean) / (
            1 - eccentricity * math.cos(anomaly)
        )
    c, s = math.cos(anomaly), math.sin(anomaly)
    root = math.sqrt(1 - eccentricity**2)
    denominator = 1 - eccentricity * c
    return CartesianState(
        time_s,
        (c - eccentricity, root * s, 0),
        (-s / denominator, root * c / denominator, 0),
    )


@pytest.mark.parametrize("method,ratio", [("rk4", 16), ("velocity_verlet", 4)])
def test_convergence_to_independent_kepler_solution(method, ratio):
    initial = kepler_ellipse(0)
    exact = kepler_ellipse(6)
    errors = []
    for dt in (0.015, 0.0075, 0.00375):
        result = propagate(
            initial, TwoBodyConfig(1, dt, method, minimum_radius_m=0.1), 6, 6
        )
        errors.append(
            norm(add(result.states[-1].position_m, scale(exact.position_m, -1)))
        )
    assert errors[0] / errors[1] == pytest.approx(ratio, rel=0.15)
    assert errors[1] / errors[2] == pytest.approx(ratio, rel=0.1)


def test_verlet_bounded_energy_does_not_imply_exact_energy_or_phase():
    initial = kepler_ellipse(0)
    dt = 2 * math.pi / 200
    config = TwoBodyConfig(1, dt, "velocity_verlet", minimum_radius_m=0.1)
    short = propagate(initial, config, 1000 * dt, 20 * dt)
    long = propagate(initial, config, 8000 * dt, 20 * dt)
    assert 1e-6 < long.maximum_relative_energy_change < 0.002
    assert (
        long.maximum_relative_energy_change
        < 1.02 * short.maximum_relative_energy_change
    )
    assert long.maximum_relative_angular_momentum_change < 3e-14
    exact = kepler_ellipse(8000 * dt)
    assert norm(add(long.states[-1].position_m, scale(exact.position_m, -1))) > 0.01


def test_verlet_is_time_reversible_and_output_clock_does_not_change_state():
    initial = kepler_ellipse(0)
    config = TwoBodyConfig(1, 0.01, "velocity_verlet", minimum_radius_m=0.1)
    state = initial
    for _ in range(1000):
        state = step(state, config)
    for _ in range(1000):
        state = step(state, config, backward=True)
    assert state.position_m == pytest.approx(initial.position_m, abs=3e-13)
    assert state.velocity_m_s == pytest.approx(initial.velocity_m_s, abs=3e-13)
    dense = propagate(initial, config, 2, 0.01)
    sparse = propagate(initial, config, 2, 0.2)
    assert sparse.states == dense.states[::20]
    assert dense.acceleration_evaluations == 400


def test_rk4_circular_si_orbit_and_parabolic_relative_energy_is_undefined():
    mu = 3.986004418e14
    radius = 7e6
    speed = math.sqrt(mu / radius)
    initial = CartesianState(123, (radius, 0, 0), (0, speed, 0))
    result = propagate(initial, TwoBodyConfig(mu, 2), 1000, 20)
    angle = math.sqrt(mu / radius**3) * 1000
    assert result.states[-1].position_m == pytest.approx(
        (radius * math.cos(angle), radius * math.sin(angle), 0), abs=3e-6
    )
    parabolic = CartesianState(0, (2, 0, 0), (0, 1, 0))
    assert invariants(parabolic, 1).specific_energy_j_kg == 0
    assert (
        propagate(
            parabolic, TwoBodyConfig(1, 0.01, minimum_radius_m=0.1), 0.1, 0.1
        ).maximum_relative_energy_change
        is None
    )


def test_json_study_is_explicit_and_cancellable():
    request = OrbitStudyInput(
        kepler_ellipse(0), TwoBodyConfig(1, 0.01, minimum_radius_m=0.1), 1, 0.1
    )
    result = run_orbit_study(request)
    assert isinstance(result["result"]["states"], list)
    assert result["result"]["method"] == "rk4"
    assert len(result["result"]["states"]) == 11
    with pytest.raises(InterruptedError):
        run_orbit_study(request, cancelled=lambda: True)


@pytest.mark.parametrize(
    "config",
    [
        dict(mu_m3_s2=0, step_s=1),
        dict(mu_m3_s2=float("nan"), step_s=1),
        dict(mu_m3_s2=1, step_s=-1),
        dict(mu_m3_s2=1, step_s=1, method="symplectic_exact"),
    ],
)
def test_invalid_config_rejected(config):
    with pytest.raises(ValueError):
        TwoBodyConfig(**config)


def test_invalid_state_clock_and_radius_guard():
    with pytest.raises(ValueError):
        CartesianState(0, (0, 0, 0), (0, 1, 0))
    with pytest.raises(ValueError):
        CartesianState(0, (1, 0, 0), (0, float("inf"), 0))
    config = TwoBodyConfig(1, 0.1, minimum_radius_m=0.1)
    with pytest.raises(ValueError):
        propagate(kepler_ellipse(0), config, 1.01)
    with pytest.raises(ValueError):
        propagate(kepler_ellipse(0), config, 1, 0.3)
    with pytest.raises(ValueError):
        step(CartesianState(0, (0.05, 0, 0), (0, 1, 0)), config)

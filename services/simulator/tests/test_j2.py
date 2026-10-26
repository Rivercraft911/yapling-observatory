"""Potential-gradient, invariant, element and first-order secular references."""

from dataclasses import asdict, replace
import hashlib
import json
import math

import pytest

from cubesat_sim.geometry.frames import rz
from cubesat_sim.geometry.vectors import cross, matvec, norm
from cubesat_sim.orbit.gravity import (
    GravityPotential,
    EGM2008_MU_M3_S2,
    EGM2008_REFERENCE_RADIUS_M,
    EGM2008_J2,
)
from cubesat_sim.orbit.elements import (
    OrbitElements,
    elements_to_cartesian,
    osculating_elements,
    node_history,
    first_order_raan_rate_rad_s,
    first_order_sso_inclination_deg,
    raan_from_ltan_deg,
    ltan_from_raan_hours,
)
from cubesat_sim.orbit.two_body import (
    CartesianState,
    TwoBodyConfig,
    invariants,
    propagate,
)

MU = EGM2008_MU_M3_S2
GRAVITY = GravityPotential(MU, EGM2008_REFERENCE_RADIUS_M, EGM2008_J2)


def initial(inclination=97.8):
    elements = OrbitElements(7e6, 0.03, inclination, 20, 30, 40, "2026-10-25T00:00:00Z")
    cartesian = elements_to_cartesian(elements, MU)
    return CartesianState(0, cartesian.position_m, cartesian.velocity_m_s), elements


@pytest.mark.parametrize(
    "position", [(7e6, 2e6, 3e6), (8e6, 0, 0), (0, 0, 8e6), (-4e6, 6e6, -2e6)]
)
def test_acceleration_is_negative_gradient_of_full_potential(position):
    actual = GRAVITY.acceleration_m_s2(position)
    for axis in range(3):
        plus = list(position)
        minus = list(position)
        plus[axis] += 10
        minus[axis] -= 10
        difference = (
            -(
                GRAVITY.specific_potential_j_kg(plus)
                - GRAVITY.specific_potential_j_kg(minus)
            )
            / 20
        )
        assert actual[axis] == pytest.approx(difference, abs=2e-9)


def test_equator_pole_limits_and_axisymmetry():
    r = 8e6
    factor = MU * EGM2008_J2 * EGM2008_REFERENCE_RADIUS_M**2 / r**4
    assert GRAVITY.acceleration_m_s2((r, 0, 0)) == pytest.approx(
        (-MU / r**2 - 1.5 * factor, 0, 0), abs=2e-15
    )
    assert GRAVITY.acceleration_m_s2((0, 0, r)) == pytest.approx(
        (0, 0, -MU / r**2 + 3 * factor), abs=2e-15
    )
    position = (7e6, 2e6, 3e6)
    matrix = rz(0.83)
    assert GRAVITY.acceleration_m_s2(matvec(matrix, position)) == pytest.approx(
        matvec(matrix, GRAVITY.acceleration_m_s2(position)), abs=2e-15
    )
    assert GRAVITY.specific_potential_j_kg(matvec(matrix, position)) == pytest.approx(
        GRAVITY.specific_potential_j_kg(position), abs=2e-8
    )
    assert cross(position, GRAVITY.acceleration_m_s2(position))[2] == pytest.approx(
        0, abs=1e-8
    )


@pytest.mark.parametrize(
    "method,digest",
    [
        ("rk4", "d060436e14f7f4a43ae968757aab018cb38fefbabb89f47c888f2b28b883770d"),
        (
            "velocity_verlet",
            "128413a79214a1f6009f509051e37a3b699b80b2208819b518e5fc81ce641694",
        ),
    ],
)
def test_frozen_bb47489_central_and_zero_j2_states_and_invariants_are_exact(
    method, digest
):
    state = CartesianState(10, (6928137.0, 0, 0), (0, 7000, 2400))
    base = TwoBodyConfig(3.986004418e14, 10, method)
    for config in (base, replace(base, force_model="j2", j2=0)):
        result = propagate(state, config, 1200, 20)
        payload = dict(
            states=[asdict(s) for s in result.states],
            invariants=[asdict(s) for s in result.invariants],
        )
        actual = hashlib.sha256(
            json.dumps(
                payload, sort_keys=True, separators=(",", ":"), allow_nan=False
            ).encode()
        ).hexdigest()
        assert actual == digest


@pytest.mark.parametrize("method,ratio", [("rk4", 16), ("velocity_verlet", 4)])
def test_j2_position_refinement_against_resolved_rk4_reference(method, ratio):
    state, _ = initial()
    reference = propagate(
        state, TwoBodyConfig(MU, 1, "rk4", force_model="j2"), 7200, 7200
    ).states[-1]
    errors = []
    for dt in (40, 20, 10):
        result = propagate(
            state, TwoBodyConfig(MU, dt, method, force_model="j2"), 7200, 7200
        )
        errors.append(math.dist(result.states[-1].position_m, reference.position_m))
    assert errors[0] / errors[1] == pytest.approx(ratio, rel=0.3)
    assert errors[1] / errors[2] == pytest.approx(ratio, rel=0.2)


def test_full_j2_energy_and_axial_momentum_not_total_vector_are_conserved():
    state, _ = initial()
    coarse = propagate(
        state, TwoBodyConfig(MU, 40, "velocity_verlet", force_model="j2"), 86400, 120
    )
    fine = propagate(
        state, TwoBodyConfig(MU, 20, "velocity_verlet", force_model="j2"), 86400, 120
    )
    assert (
        coarse.maximum_relative_energy_change / fine.maximum_relative_energy_change
        == pytest.approx(4, rel=0.03)
    )
    assert fine.maximum_scaled_axial_angular_momentum_change < 2e-14
    assert fine.maximum_relative_angular_momentum_change > 0.01
    central0 = invariants(state, MU).specific_energy_j_kg
    central_variation = max(
        abs(invariants(s, MU).specific_energy_j_kg - central0) / abs(central0)
        for s in fine.states
    )
    assert central_variation > 10 * fine.maximum_relative_energy_change


@pytest.mark.parametrize("inclination", [45, 97.8])
def test_nodal_drift_matches_first_order_theory_with_mean_osculating_limit(inclination):
    state, elements = initial(inclination)
    result = propagate(
        state, TwoBodyConfig(MU, 10, "rk4", force_model="j2"), 86400, 120
    )
    actual = node_history(result.states, MU).fitted_raan_rate_deg_day
    theory = (
        math.degrees(
            first_order_raan_rate_rad_s(
                elements.semi_major_axis_m, elements.eccentricity, inclination, GRAVITY
            )
        )
        * 86400
    )
    assert actual == pytest.approx(theory, rel=0.015)
    assert actual * theory > 0


def test_element_hand_cases_round_trip_and_degenerate_angles():
    e = OrbitElements(7e6, 0, 90, 0, 0, 90, "2026-10-25T00:00:00Z")
    c = elements_to_cartesian(e, MU)
    assert c.position_m == pytest.approx((0, 0, 7e6), abs=1e-8)
    assert c.velocity_m_s == pytest.approx((-math.sqrt(MU / 7e6), 0, 0), abs=1e-10)
    state, original = initial()
    derived = osculating_elements(state.position_m, state.velocity_m_s, MU)
    for name in (
        "semi_major_axis_m",
        "eccentricity",
        "inclination_deg",
        "raan_deg",
        "argument_of_periapsis_deg",
        "true_anomaly_deg",
    ):
        assert getattr(derived, name) == pytest.approx(
            getattr(original, name), abs=1e-7
        )
    circular = elements_to_cartesian(replace(e, inclination_deg=0), MU)
    derived = osculating_elements(circular.position_m, circular.velocity_m_s, MU)
    assert (
        derived.raan_deg is None
        and derived.argument_of_periapsis_deg is None
        and derived.true_anomaly_deg is None
    )
    assert derived.true_longitude_deg == pytest.approx(90)
    assert osculating_elements((7e6, 0, 0), (1, 0, 0), MU).inclination_deg is None


def test_sso_reference_and_mean_ltan_known_angles():
    inclination = first_order_sso_inclination_deg(
        EGM2008_REFERENCE_RADIUS_M + 700e3, 0, 360 / 365.2422, GRAVITY
    )
    assert inclination == pytest.approx(
        98.2, abs=0.1
    )  # NASA GSFC 2018 slide7 rounded reference.
    assert first_order_sso_inclination_deg(7e6, 0, 1e5, GRAVITY) is None
    assert raan_from_ltan_deg(18, 0) == 90
    assert raan_from_ltan_deg(6, 0) == 270
    for hours in (0, 6, 12, 18, 23.9):
        assert ltan_from_raan_hours(
            raan_from_ltan_deg(hours, 213), 213
        ) == pytest.approx(hours, abs=1e-14)


def test_invalid_elements_epoch_and_exterior_gravity_rejected():
    _, valid = initial()
    for changes in (
        dict(eccentricity=1),
        dict(inclination_deg=181),
        dict(epoch_utc="2026-10-25T00:00:00"),
        dict(epoch_utc="2026-10-25T00:00:00+01:00"),
        dict(raan_deg=float("nan")),
    ):
        with pytest.raises(ValueError):
            replace(valid, **changes)
    with pytest.raises(ValueError):
        GRAVITY.acceleration_m_s2((1, 0, 0))
    with pytest.raises(ValueError):
        GravityPotential(MU, j2=float("nan"))

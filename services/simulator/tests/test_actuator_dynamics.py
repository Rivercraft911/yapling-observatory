"""Mechanical conservation, motor energy accounting and magnetic authority."""

from dataclasses import replace
import math

import pytest

from cubesat_sim.attitude.actuators import (
    MagnetorquerSpec,
    WheelSpec,
    allocate_magnetic_torque,
    allocate_wheel_net_torques,
    bdot_dipole,
    magnetic_torque,
    unloading_dipole,
    wheel_output,
)
from cubesat_sim.attitude.dynamics import (
    AttitudeForcing,
    AttitudeState,
    RigidBody,
    derivative,
    mechanical_invariants,
    state_from_relative_wheel_speeds,
    step,
)
from cubesat_sim.attitude.kinematics import conjugate, rotate
from cubesat_sim.geometry.frames import rotation
from cubesat_sim.geometry.vectors import add, cross, dot, matmul, norm, scale, transpose


def wheel(axis=(0, 0, 1), **changes):
    values = dict(
        axis_body=axis,
        spin_inertia_kg_m2=5e-7,
        max_speed_rpm=6000,
        max_motor_torque_nm=5e-5,
        motor_torque_constant_nm_a=0.005,
        winding_resistance_ohm=8,
        non_ohmic_drive_efficiency=0.8,
        idle_power_w=0.01,
    )
    return WheelSpec(**(values | changes))


def test_full_inertia_validation_and_rotated_tensor():
    matrix = rotation((1, 2, 3), 0.71)
    tensor = matmul(
        matmul(matrix, ((0.002, 0, 0), (0, 0.003, 0), (0, 0, 0.004))), transpose(matrix)
    )
    body = RigidBody(tensor)
    for row, expected in zip(
        matmul(body.effective_inertia_kg_m2, body.effective_inverse),
        ((1, 0, 0), (0, 1, 0), (0, 0, 1)),
    ):
        assert row == pytest.approx(expected, abs=1e-14)


@pytest.mark.parametrize(
    "tensor",
    [
        ((1, 1, 0), (0, 1, 0), (0, 0, 1)),
        ((1, 0, 0), (0, -1, 0), (0, 0, 1)),
        ((1, 0, 0), (0, 1, 0), (0, 0, 3)),
        ((1, 0, 0), (0, 1, 0), (0, 0, float("nan"))),
    ],
)
def test_nonphysical_or_nonfinite_inertia_rejected(tensor):
    with pytest.raises(ValueError):
        RigidBody(tensor)


def test_incompatible_rotor_inertia_rejected():
    with pytest.raises(ValueError):
        RigidBody(
            ((0.002, 0, 0), (0, 0.002, 0), (0, 0, 0.002)),
            (wheel(spin_inertia_kg_m2=0.003),),
        )


def test_torque_free_asymmetric_body_conserves_inertial_momentum_and_energy():
    body = RigidBody(
        ((0.002, 0.0001, 0.0002), (0.0001, 0.003, 0.0001), (0.0002, 0.0001, 0.004))
    )
    state = AttitudeState(0, (1, 0, 0, 0), (0.3, 0.2, -0.15))
    initial = mechanical_invariants(body, state)
    for _ in range(2000):
        state = step(body, state, AttitudeForcing(), 0.005).state
    final = mechanical_invariants(body, state)
    assert final.rotational_energy_j == pytest.approx(
        initial.rotational_energy_j, rel=2e-13
    )
    assert final.angular_momentum_inertial_nms == pytest.approx(
        initial.angular_momentum_inertial_nms, abs=2e-15
    )
    assert math.hypot(*state.q_body_from_inertial_wxyz) == pytest.approx(1, abs=2e-16)


def test_quaternion_body_from_inertial_known_constant_spin():
    body = RigidBody(((0.002, 0, 0), (0, 0.002, 0), (0, 0, 0.002)))
    state = AttitudeState(0, (1, 0, 0, 0), (0, 0, 0.2))
    for _ in range(1000):
        state = step(body, state, AttitudeForcing(), 0.01).state
    assert rotate(state.q_body_from_inertial_wxyz, (1, 0, 0)) == pytest.approx(
        (math.cos(2), -math.sin(2), 0), abs=2e-13
    )


def test_rigid_body_rk4_timestep_converges_at_fourth_order():
    body = RigidBody(
        ((0.002, 0.0001, 0.0002), (0.0001, 0.003, 0.0001), (0.0002, 0.0001, 0.004))
    )
    initial = AttitudeState(0, (1, 0, 0, 0), (3, 2, -1.5))
    quaternions = []
    for dt in (0.05, 0.025, 0.0125, 0.001):
        state = initial
        for _ in range(round(2 / dt)):
            state = step(body, state, AttitudeForcing(), dt).state
        quaternions.append(state.q_body_from_inertial_wxyz)
    errors = [
        min(norm(add(q, scale(quaternions[-1], sign))) for sign in (-1, 1))
        for q in quaternions[:-1]
    ]
    assert errors[0] / errors[1] == pytest.approx(16, rel=0.02)
    assert errors[1] / errors[2] == pytest.approx(16, rel=0.02)


def test_exact_one_axis_wheel_reaction_and_electrical_energy_closure():
    spec = wheel()
    body = RigidBody(((0.002, 0, 0), (0, 0.002, 0), (0, 0, 0.002)), (spec,))
    state = state_from_relative_wheel_speeds(body, wheel_relative_speed_rad_s=(0,))
    bus = heat = 0.0
    for _ in range(100):
        result = step(body, state, AttitudeForcing((1e-5,)), 0.01)
        state = result.state
        bus += result.wheel_bus_energy_j
        heat += result.wheel_heat_j
    expected_h = 1e-5
    assert state.wheel_absolute_axial_momentum_nms[0] == pytest.approx(
        expected_h, rel=2e-14
    )
    assert state.omega_body_rad_s[2] == pytest.approx(
        -expected_h / (0.002 - spec.spin_inertia_kg_m2), rel=2e-14
    )
    assert result.invariants.angular_momentum_inertial_nms == pytest.approx(
        (0, 0, 0), abs=2e-19
    )
    assert result.invariants.rotational_energy_j == pytest.approx(bus - heat, abs=3e-17)
    assert result.derivative.wheels[0].relative_speed_rad_s == pytest.approx(
        expected_h / spec.spin_inertia_kg_m2 - state.omega_body_rad_s[2]
    )


def test_unpowered_spinning_wheel_and_asymmetric_body_conserve_total_energy():
    body = RigidBody(
        ((0.002, 0, 0), (0, 0.003, 0), (0, 0, 0.004)), (wheel(idle_power_w=0),)
    )
    state = state_from_relative_wheel_speeds(
        body, omega_body_rad_s=(0.2, 0.3, 0.1), wheel_relative_speed_rad_s=(400,)
    )
    initial = mechanical_invariants(body, state)
    for _ in range(1000):
        state = step(body, state, AttitudeForcing(), 0.005).state
    final = mechanical_invariants(body, state)
    assert final.rotational_energy_j == pytest.approx(
        initial.rotational_energy_j, rel=2e-13
    )
    assert final.angular_momentum_inertial_nms == pytest.approx(
        initial.angular_momentum_inertial_nms, abs=2e-15
    )


def test_wheel_torque_speed_and_bus_power_limits_braking_and_overspeed():
    spec = wheel(max_bus_power_w=0.011)
    at_rest = wheel_output(spec, 0, (0, 0, 0), 1)
    assert at_rest.torque_saturated and not at_rest.overspeed
    assert at_rest.motor_torque_nm <= spec.max_motor_torque_nm
    fast_h = spec.spin_inertia_kg_m2 * spec.max_relative_speed_rad_s
    saturated = wheel_output(spec, fast_h, (0, 0, 0), 1e-5)
    assert saturated.motor_torque_nm == 0 and saturated.at_speed_limit
    braking = wheel_output(spec, fast_h, (0, 0, 0), -1e-5)
    assert braking.motor_torque_nm < 0 and braking.shaft_power_w < 0
    assert braking.dissipated_heat_w > braking.bus_power_w
    power_limited = wheel_output(spec, fast_h / 2, (0, 0, 0), 5e-5)
    assert power_limited.power_saturated
    assert power_limited.bus_power_w == pytest.approx(0.011, abs=2e-15)
    assert wheel_output(spec, fast_h * 1.01, (0, 0, 0), 0).overspeed


def test_regeneration_is_explicit_and_heat_never_hides_mechanical_power():
    spec = wheel(regenerative_efficiency=0.7, viscous_friction_nm_s=1e-8)
    for motor in (-2e-5, 0, 2e-5):
        report = wheel_output(spec, 0.0002, (0, 0, 0), motor)
        assert report.dissipated_heat_w >= 0
        assert report.bus_power_w - report.dissipated_heat_w == pytest.approx(
            report.net_spin_torque_nm * report.relative_speed_rad_s
        )
    regenerative = wheel_output(replace(spec, idle_power_w=0), 0.0002, (0, 0, 0), -2e-5)
    assert regenerative.bus_power_w < 0


def test_torque_speed_envelope_approaches_capacity_without_clipping_momentum():
    spec = wheel(max_speed_rpm=60, max_motor_torque_nm=1e-5)
    body = RigidBody(((0.002, 0, 0), (0, 0.002, 0), (0, 0, 0.002)), (spec,))
    state = state_from_relative_wheel_speeds(body, wheel_relative_speed_rad_s=(0,))
    for _ in range(3000):
        state = step(body, state, AttitudeForcing((1e-5,)), 0.001).state
    speed = mechanical_invariants(body, state).wheel_relative_speed_rad_s[0]
    assert 0.99 * spec.max_relative_speed_rad_s < speed <= spec.max_relative_speed_rad_s
    # An external body acceleration can exceed relative RPM even with u=0.
    boundary = state_from_relative_wheel_speeds(
        body, wheel_relative_speed_rad_s=(spec.max_relative_speed_rad_s,)
    )
    forced = step(
        body,
        boundary,
        AttitudeForcing((0,), external_torque_body_nm=(0, 0, -0.001)),
        0.01,
    )
    assert forced.derivative.wheels[0].overspeed
    assert (
        forced.state.wheel_absolute_axial_momentum_nms
        == boundary.wheel_absolute_axial_momentum_nms
    )


def test_magnetic_projection_saturation_and_bdot_energy_sign():
    spec = MagnetorquerSpec(0.2)
    field = (0, 0, 40e-6)
    report = allocate_magnetic_torque((2e-6, 3e-6, 4e-6), field, spec)
    assert report.torque_body_nm == pytest.approx((2e-6, 3e-6, 0), abs=1e-20)
    assert dot(report.torque_body_nm, field) == 0
    limited = allocate_magnetic_torque((1, 0, 0), field, spec)
    assert limited.dipole_saturated and norm(limited.dipole_body_am2) == pytest.approx(
        0.2
    )
    assert norm(limited.torque_body_nm) == pytest.approx(0.2 * 40e-6)
    assert (
        allocate_magnetic_torque((1, 2, 3), (0, 0, 0), spec).field_has_authority
        is False
    )
    omega = (0.3, -0.2, 0.1)
    moment, _ = bdot_dipole(scale(cross(omega, field), -1), 2e4, spec)
    assert dot(omega, magnetic_torque(moment, field)) < 0


def test_wheel_allocation_rank_residual_and_unloading_sign():
    wheels = (wheel((1, 0, 0)), wheel((0, 1, 0)), wheel((0, 0, 1)))
    target = (1e-5, -2e-5, 3e-5)
    motor = allocate_wheel_net_torques(wheels, target)
    assert motor == pytest.approx(tuple(-v for v in target), abs=1e-20)
    assert allocate_wheel_net_torques(wheels[:1], target) == pytest.approx((-1e-5,))
    # While attitude wheels cancel magnetic torque, hdot equals the external
    # unloading torque: perpendicular momentum decays, parallel stays unavailable.
    result = unloading_dipole(
        (0.001, 0.002, 0.003), (0, 0, 40e-6), 0.01, MagnetorquerSpec(1)
    )
    assert result.torque_body_nm == pytest.approx((-1e-5, -2e-5, 0), abs=1e-20)
    held = allocate_wheel_net_torques(wheels, (0, 0, 0), result.torque_body_nm)
    assert held == pytest.approx(result.torque_body_nm, abs=1e-20)


def test_invalid_wheel_field_and_state_inputs():
    with pytest.raises(ValueError):
        wheel(spin_inertia_kg_m2=0)
    with pytest.raises(ValueError):
        wheel(non_ohmic_drive_efficiency=0)
    with pytest.raises(ValueError):
        wheel(max_bus_power_w=0.001)
    with pytest.raises(ValueError):
        MagnetorquerSpec(float("inf"))
    with pytest.raises(ValueError):
        AttitudeState(0, (2, 0, 0, 0), (0, 0, 0))
    with pytest.raises(ValueError):
        magnetic_torque((1, 0, 0), (float("nan"), 0, 0))

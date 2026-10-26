"""Quaternion convention, closed-loop responses, unloading and clock checks."""

from dataclasses import replace
import math

import pytest

from cubesat_sim.attitude.actuators import MagnetorquerSpec, WheelSpec
from cubesat_sim.attitude.actuators import allocate_magnetic_torque
from cubesat_sim.attitude.control import (
    AttitudeReference,
    PDConfig,
    minimum_rotation_reference,
    quaternion_pd,
)
from cubesat_sim.attitude.dynamics import (
    AttitudeState,
    RigidBody,
    state_from_relative_wheel_speeds,
)
from cubesat_sim.attitude.kinematics import conjugate, minimum_rotation, rotate
from cubesat_sim.attitude.study import AttitudeStudyInput, run_attitude_study
from cubesat_sim.geometry.vectors import dot, norm, unit


def body_with_wheels():
    wheels = tuple(
        WheelSpec(axis, 5e-7, 6000, 5e-5, 0.005, 8, 0.8, 0.01)
        for axis in ((1, 0, 0), (0, 1, 0), (0, 0, 1))
    )
    return RigidBody(
        ((0.002, 0, 0), (0, 0.002, 0), (0, 0, 0.002)), wheels, MagnetorquerSpec(0.2)
    )


def test_minimum_rotation_alignment_regular_and_antipodal():
    source = unit((0.3, 0.7, -0.4))
    for target in (
        (0, 1, 0),
        (0, -1, 0),
        tuple(-v for v in source),
        (source[0] + 1e-8, source[1], source[2]),
    ):
        change = minimum_rotation(source, target)
        assert rotate(change, source) == pytest.approx(unit(target), abs=5e-15)
    near_antipodal = (-1, 1e-9, 0)
    assert rotate(
        minimum_rotation((1, 0, 0), near_antipodal), (1, 0, 0)
    ) == pytest.approx(unit(near_antipodal), abs=5e-15)
    state = AttitudeState(0, (math.cos(0.2), 0, 0, -math.sin(0.2)), (0, 0, 0))
    reference = minimum_rotation_reference(state, (0, 1, 0), (0, 0, 1))
    assert rotate(
        conjugate(reference.q_reference_from_inertial_wxyz), (0, 1, 0)
    ) == pytest.approx((0, 0, 1), abs=2e-15)


def test_pd_known_axis_torque_short_rotation_and_quaternion_sign_equivalence():
    body = RigidBody(((0.002, 0, 0), (0, 0.002, 0), (0, 0, 0.002)))
    gains = PDConfig((0.001,) * 3, (0.003,) * 3)
    state = AttitudeState(0, (math.cos(0.2), 0, 0, -math.sin(0.2)), (0, 0, 0.1))
    output = quaternion_pd(body, state, AttitudeReference((1, 0, 0, 0)), gains)
    assert output.rotation_error_body_rad == pytest.approx((0, 0, -0.4), abs=1e-15)
    assert output.requested_body_control_torque_nm == pytest.approx(
        (0, 0, -0.0007), abs=1e-18
    )
    same = quaternion_pd(body, state, AttitudeReference((-1, 0, 0, 0)), gains)
    assert same == output
    long = AttitudeState(0, (math.cos(1.7), 0, 0, -math.sin(1.7)), (0, 0, 0))
    shortest = quaternion_pd(body, long, AttitudeReference((1, 0, 0, 0)), gains)
    assert shortest.attitude_error_rad == pytest.approx(2 * math.pi - 3.4)
    assert shortest.requested_body_control_torque_nm[2] > 0


def test_free_roll_does_not_damp_boresight_spin():
    body = RigidBody(((0.002, 0, 0), (0, 0.002, 0), (0, 0, 0.002)))
    state = AttitudeState(0, (1, 0, 0, 0), (0, 0.3, 0))
    gains = PDConfig((0.001,) * 3, (0.003,) * 3)
    free = quaternion_pd(body, state, AttitudeReference((1, 0, 0, 0)), gains, (0, 1, 0))
    fixed = quaternion_pd(body, state, AttitudeReference((1, 0, 0, 0)), gains)
    assert free.requested_body_control_torque_nm == (0, 0, 0)
    assert fixed.requested_body_control_torque_nm[1] == pytest.approx(-0.0009)


def test_explicit_all_axis_rate_damping_keeps_roll_angle_free_and_respects_magnetic_rank():
    body = RigidBody(((0.002, 0, 0), (0, 0.002, 0), (0, 0, 0.002)))
    gains = PDConfig((0.001,) * 3, (0.003,) * 3)
    reference = AttitudeReference((1, 0, 0, 0))
    rolled = AttitudeState(0, (math.cos(0.6), 0, math.sin(0.6), 0), (0, 0, 0))
    command = quaternion_pd(
        body, rolled, reference, gains, (0, 1, 0), damp_free_roll_rate=True
    )
    assert command.requested_body_control_torque_nm == pytest.approx(
        (0, 0, 0), abs=1e-18
    )
    spin = AttitudeState(0, (1, 0, 0, 0), (0, 0.3, 0))
    command = quaternion_pd(
        body, spin, reference, gains, (0, 1, 0), damp_free_roll_rate=True
    )
    assert command.requested_body_control_torque_nm == pytest.approx(
        (0, -0.0009, 0), abs=1e-18
    )
    magnetic = allocate_magnetic_torque(
        command.requested_body_control_torque_nm, (0, 40e-6, 0), MagnetorquerSpec(0.2)
    )
    assert magnetic.torque_body_nm == (0, 0, 0)
    assert magnetic.residual_torque_body_nm == pytest.approx(
        command.requested_body_control_torque_nm
    )


def test_zero_roll_angle_torque_with_unequal_gains_and_arbitrary_boresight():
    body = RigidBody(((0.002, 0, 0), (0, 0.002, 0), (0, 0, 0.002)))
    axis = unit((1, 1, 0))
    error_axis = unit((1, -1, 0))
    q = (math.cos(0.2), *(math.sin(0.2) * v for v in error_axis))
    command = quaternion_pd(
        body,
        AttitudeState(0, q, (0, 0, 0)),
        AttitudeReference((1, 0, 0, 0)),
        PDConfig((0.001, 0.002, 0.003), (0.003,) * 3),
        axis,
        damp_free_roll_rate=True,
    )
    assert dot(command.requested_body_control_torque_nm, axis) == pytest.approx(
        0, abs=1e-18
    )


def test_actual_wheel_pd_acquisition_and_output_sampling_independence():
    body = body_with_wheels()
    state = state_from_relative_wheel_speeds(
        body,
        q_body_from_inertial_wxyz=(math.cos(0.2), 0, 0, -math.sin(0.2)),
        wheel_relative_speed_rad_s=(0, 0, 0),
    )
    request = AttitudeStudyInput(
        body,
        state,
        50,
        0.01,
        0.05,
        0.1,
        "quaternion_pd",
        PDConfig((0.0001,) * 3, (0.0008,) * 3),
        free_roll=False,
    )
    result = run_attitude_study(request)
    assert result["samples"][0]["pointing_error_rad"] == pytest.approx(0.4)
    assert result["samples"][-1]["pointing_error_rad"] < 0.001
    assert not result["summary"]["wheel_overspeed"]
    assert abs(result["samples"][-1]["energy_balance_residual_j"]) < 2e-11
    dense = run_attitude_study(replace(request, duration_s=1, output_step_s=0.01))
    sparse = run_attitude_study(replace(request, duration_s=1, output_step_s=0.1))
    assert [s["state"] for s in sparse["samples"]] == [
        s["state"] for s in dense["samples"][::10]
    ]


def test_magnetic_unloading_reduces_perpendicular_wheel_momentum_while_holding_body():
    body = body_with_wheels()
    initial = state_from_relative_wheel_speeds(
        body, wheel_relative_speed_rad_s=(200, 0, 100)
    )
    request = AttitudeStudyInput(
        body,
        initial,
        30,
        0.01,
        0.1,
        0.5,
        "quaternion_pd",
        PDConfig((0.0001,) * 3, (0.0008,) * 3),
        free_roll=False,
        magnetic_field_inertial_t=(0, 0, 40e-6),
        unloading_gain_s_inv=0.01,
    )
    result = run_attitude_study(request)
    final = result["samples"][-1]
    h = final["state"]["wheel_absolute_axial_momentum_nms"]
    assert h[0] == pytest.approx(
        initial.wheel_absolute_axial_momentum_nms[0] * (1 - 0.01 * 0.1) ** 300,
        rel=2e-12,
    )
    assert h[2] == pytest.approx(
        initial.wheel_absolute_axial_momentum_nms[2], abs=1e-18
    )
    assert norm(final["state"]["omega_body_rad_s"]) < 1e-12
    assert final["pointing_error_rad"] < 1e-7


def test_bdot_is_real_damping_under_constant_inertial_field_and_leaves_parallel_rate():
    body = RigidBody(
        ((0.002, 0, 0), (0, 0.002, 0), (0, 0, 0.002)),
        magnetorquer=MagnetorquerSpec(0.2),
    )
    initial = AttitudeState(0, (1, 0, 0, 0), (0.3, 0, 0))
    request = AttitudeStudyInput(
        body,
        initial,
        20,
        0.02,
        0.1,
        0.2,
        "magnetic_bdot",
        magnetic_field_inertial_t=(0, 0, 40e-6),
        bdot_gain_am2_s_t=1e5,
    )
    result = run_attitude_study(request)
    assert (
        result["samples"][-1]["mechanics"]["rotational_energy_j"]
        < result["samples"][0]["mechanics"]["rotational_energy_j"]
    )
    assert result["summary"]["dipole_saturation"]
    parallel = run_attitude_study(
        replace(request, initial=replace(initial, omega_body_rad_s=(0, 0, 0.3)))
    )
    assert parallel["samples"][-1]["state"]["omega_body_rad_s"] == pytest.approx(
        (0, 0, 0.3), abs=1e-15
    )


def test_invalid_controllers_clocks_and_cancellation():
    body = body_with_wheels()
    state = state_from_relative_wheel_speeds(body, wheel_relative_speed_rad_s=(0, 0, 0))
    valid = AttitudeStudyInput(body, state, 1, 0.01, 0.1, 0.1)
    with pytest.raises(ValueError):
        replace(valid, controller="lqr")
    with pytest.raises(ValueError):
        replace(valid, controller="quaternion_pd")
    with pytest.raises(ValueError):
        replace(valid, controller_period_s=0.015)
    with pytest.raises(ValueError):
        replace(valid, body_boresight=(0, 0, 0))
    with pytest.raises(InterruptedError):
        run_attitude_study(valid, cancelled=lambda: True)

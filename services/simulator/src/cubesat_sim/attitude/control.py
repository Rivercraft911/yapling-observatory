"""Shortest-rotation quaternion PD and free-roll boresight guidance.

Truth-state feedback only: no estimator, sensor delay, jitter model or guaranteed
tracking after actuator saturation. Gains are user inputs, not tuned hardware.
"""

from dataclasses import dataclass
import math

from ..geometry.vectors import add, cross, matvec, norm, scale, transverse
from .dynamics import AttitudeState, RigidBody, mechanical_invariants
from .actuators import MagneticOutput, allocate_wheel_net_torques, unloading_dipole
from .kinematics import (
    boresight_reference,
    conjugate,
    finite_vector,
    multiply,
    normalize_quaternion,
    rotate,
    unit_vector,
)


@dataclass(frozen=True)
class AttitudeReference:
    q_reference_from_inertial_wxyz: tuple[float, float, float, float]
    omega_reference_inertial_rad_s: tuple[float, float, float] = (0.0, 0.0, 0.0)
    alpha_reference_inertial_rad_s2: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def __post_init__(self):
        object.__setattr__(
            self,
            "q_reference_from_inertial_wxyz",
            normalize_quaternion(self.q_reference_from_inertial_wxyz),
        )
        for name in (
            "omega_reference_inertial_rad_s",
            "alpha_reference_inertial_rad_s2",
        ):
            object.__setattr__(self, name, finite_vector(getattr(self, name)))


@dataclass(frozen=True)
class PDConfig:
    proportional_nm_per_rad: tuple[float, float, float]
    derivative_nm_s_per_rad: tuple[float, float, float]
    gyroscopic_compensation: bool = True

    def __post_init__(self):
        for name in ("proportional_nm_per_rad", "derivative_nm_s_per_rad"):
            value = finite_vector(getattr(self, name))
            if any(v < 0 for v in value):
                raise ValueError("PD gains must be finite and nonnegative")
            object.__setattr__(self, name, value)


@dataclass(frozen=True)
class PDOutput:
    requested_body_control_torque_nm: tuple[float, float, float]
    rotation_error_body_rad: tuple[float, float, float]
    rate_error_body_rad_s: tuple[float, float, float]
    attitude_error_rad: float
    free_roll: bool


def quaternion_pd(
    body: RigidBody,
    state: AttitudeState,
    reference: AttitudeReference,
    gains: PDConfig,
    free_roll_axis_body=None,
    *,
    damp_free_roll_rate=False,
) -> PDOutput:
    """Torque = Kp*shortest_rotation - Kd*rate_error + optional gyro/feedforward.

    q_error=q_B_from_I*q_I_from_R. Its rotation vector points toward the reference
    in current body axes. Canonical q/-q handling avoids quaternion unwinding.
    Legacy free roll projects final torque perpendicular to the boresight.
    damp_free_roll_rate keeps zero roll-angle cost but damps all rate axes.
    """
    error = normalize_quaternion(
        multiply(
            state.q_body_from_inertial_wxyz,
            conjugate(reference.q_reference_from_inertial_wxyz),
        ),
        validate=False,
    )
    sine = norm(error[1:])
    angle = 2 * math.atan2(sine, error[0])
    rotation_error = scale(error[1:], angle / sine) if sine > 1e-14 else (0.0, 0.0, 0.0)
    reference_rate = rotate(
        state.q_body_from_inertial_wxyz, reference.omega_reference_inertial_rad_s
    )
    rate_error = add(state.omega_body_rad_s, scale(reference_rate, -1))
    axis = unit_vector(free_roll_axis_body) if free_roll_axis_body is not None else None
    if axis is not None:
        rotation_error = transverse(rotation_error, axis)
        if not damp_free_roll_rate:
            rate_error = transverse(rate_error, axis)
    torque = tuple(
        k * e - d * w
        for k, e, d, w in zip(
            gains.proportional_nm_per_rad,
            rotation_error,
            gains.derivative_nm_s_per_rad,
            rate_error,
        )
    )
    if axis is not None and damp_free_roll_rate:
        proportional = tuple(
            k * e for k, e in zip(gains.proportional_nm_per_rad, rotation_error)
        )
        torque = add(
            transverse(proportional, axis),
            tuple(-d * w for d, w in zip(gains.derivative_nm_s_per_rad, rate_error)),
        )
    if gains.gyroscopic_compensation:
        angular = mechanical_invariants(body, state).angular_momentum_body_nms
        torque = add(torque, cross(state.omega_body_rad_s, angular))
    reference_acceleration = add(
        rotate(
            state.q_body_from_inertial_wxyz, reference.alpha_reference_inertial_rad_s2
        ),
        scale(cross(state.omega_body_rad_s, reference_rate), -1),
    )
    torque = add(torque, matvec(body.effective_inertia_kg_m2, reference_acceleration))
    if axis is not None and not damp_free_roll_rate:
        torque = transverse(torque, axis)
    return PDOutput(
        torque, rotation_error, rate_error, norm(rotation_error), axis is not None
    )


def minimum_rotation_reference(
    state: AttitudeState, body_boresight, target_direction_inertial
) -> AttitudeReference:
    """Instantaneous fixed-direction reference with the closest current roll."""
    return AttitudeReference(
        boresight_reference(
            state.q_body_from_inertial_wxyz, body_boresight, target_direction_inertial
        )
    )


@dataclass(frozen=True)
class WheelControlAllocation:
    wheel_motor_torques_nm: tuple[float, ...]
    wheel_momentum_body_nms: tuple[float, float, float]
    unloading: MagneticOutput | None


def wheel_momentum_body(body: RigidBody, state: AttitudeState):
    """Sum stored ABSOLUTE rotor axial momenta in body axes, H_w = Σ a_i h_i.

    h_i = J_i(Ω_relative,i + a_i·ω). This is not per-wheel RPM management;
    redundant-wheel momentum in the axis matrix's nullspace remains invisible.
    Hogan & Schaub (2015), JGCD 38(10), equations (2), (3), (17).
    """
    if len(body.wheels) != len(state.wheel_absolute_axial_momentum_nms):
        raise ValueError("State wheel count differs from rigid-body configuration")
    momentum = (0.0, 0.0, 0.0)
    for wheel, h in zip(body.wheels, state.wheel_absolute_axial_momentum_nms):
        momentum = add(momentum, scale(wheel.axis_body, h))
    return momentum


def allocate_wheel_pd_control(
    body: RigidBody,
    state: AttitudeState,
    requested_body_control_torque_nm,
    magnetic_field_body_t,
    unloading_time_constant_s: float | None = None,
) -> WheelControlAllocation:
    """Wheel control plus optional field-projected magnetic unloading.

    Desired external unload torque is -H_w/T. Use the achieved, dipole-limited
    magnetic torque in wheel allocation: τ_body = τ_mag - Σ a_i hdot_i.
    Cancellation holds at allocation time when wheel span and drive limits
    permit it. Held commands, subsequent field motion and drive clipping leave
    a physical residual; wheel_output and the dynamics retain those limits.
    """
    if unloading_time_constant_s is not None and (
        not math.isfinite(unloading_time_constant_s) or unloading_time_constant_s <= 0
    ):
        raise ValueError("Unloading time constant must be positive and finite")
    momentum = wheel_momentum_body(body, state)
    unloading = None
    magnetic = (0.0, 0.0, 0.0)
    if (
        unloading_time_constant_s is not None
        and body.wheels
        and body.magnetorquer
        and body.magnetorquer.max_dipole_am2 > 0
    ):
        unloading = unloading_dipole(
            momentum,
            magnetic_field_body_t,
            1 / unloading_time_constant_s,
            body.magnetorquer,
        )
        magnetic = unloading.torque_body_nm
    net = allocate_wheel_net_torques(
        body.wheels, requested_body_control_torque_nm, magnetic
    )
    relative = mechanical_invariants(body, state).wheel_relative_speed_rad_s
    motors = tuple(
        t + w.viscous_friction_nm_s * speed
        for t, w, speed in zip(net, body.wheels, relative)
    )
    return WheelControlAllocation(motors, momentum, unloading)

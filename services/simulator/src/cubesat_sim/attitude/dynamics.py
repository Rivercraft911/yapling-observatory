"""Rigid platform plus ideal balanced fixed-axis rotors, integrated by RK4.

q_B_from_I maps inertial vectors into body axes. omega is B relative to I in B.
J_locked includes wheel mass and locked rotor inertia about the common COM.
J_eff=J_locked-sum(Is*a*a^T). Stored h_i=Is*(Omega_relative+a.omega) is ABSOLUTE
axial momentum, not relative wheel momentum. This retains acceleration coupling.

H_B=J_eff*omega+sum(a*h); J_eff*omega_dot=tau_external-omega cross H_B-sum(a*h_dot)
h_dot=u_motor-b*Omega_relative. No imbalance, flexible modes or bearing dynamics.
See Basilisk reactionWheelStateEffector technical note, balanced-wheel model.
"""

from dataclasses import dataclass
from functools import cached_property
import math

from ..geometry.vectors import add, cross, dot, matvec, norm, scale
from .actuators import (
    MagnetorquerSpec,
    WheelOutput,
    WheelSpec,
    limited_dipole,
    wheel_output,
)
from .kinematics import conjugate, finite_vector, multiply, normalize_quaternion, rotate
from .matrices import positive_inertia

MODEL_VERSION = "balanced-rigid-body-rk4-0.1.0"
Vector = tuple[float, float, float]
Matrix = tuple[Vector, Vector, Vector]


@dataclass(frozen=True)
class RigidBody:
    locked_inertia_kg_m2: Matrix
    wheels: tuple[WheelSpec, ...] = ()
    magnetorquer: MagnetorquerSpec | None = None

    def __post_init__(self):
        matrix, _, _ = positive_inertia(self.locked_inertia_kg_m2)
        object.__setattr__(self, "locked_inertia_kg_m2", matrix)
        object.__setattr__(self, "wheels", tuple(self.wheels))
        if len(self.wheels) > 16 or any(
            not isinstance(wheel, WheelSpec) for wheel in self.wheels
        ):
            raise ValueError("Expected at most 16 validated wheel specifications")
        if self.magnetorquer is not None and not isinstance(
            self.magnetorquer, MagnetorquerSpec
        ):
            raise ValueError("Expected a validated magnetorquer specification")
        positive_inertia(self.effective_inertia_kg_m2)

    @cached_property
    def effective_inertia_kg_m2(self):
        return tuple(
            tuple(
                self.locked_inertia_kg_m2[i][j]
                - sum(
                    w.spin_inertia_kg_m2 * w.axis_body[i] * w.axis_body[j]
                    for w in self.wheels
                )
                for j in range(3)
            )
            for i in range(3)
        )

    @cached_property
    def effective_inverse(self):
        return positive_inertia(self.effective_inertia_kg_m2)[1]


@dataclass(frozen=True)
class AttitudeState:
    time_s: float
    q_body_from_inertial_wxyz: tuple[float, float, float, float]
    omega_body_rad_s: Vector
    wheel_absolute_axial_momentum_nms: tuple[float, ...] = ()

    def __post_init__(self):
        if not math.isfinite(self.time_s):
            raise ValueError("Time must be finite")
        object.__setattr__(
            self,
            "q_body_from_inertial_wxyz",
            normalize_quaternion(self.q_body_from_inertial_wxyz),
        )
        object.__setattr__(
            self, "omega_body_rad_s", finite_vector(self.omega_body_rad_s)
        )
        if len(self.wheel_absolute_axial_momentum_nms) > 16 or not all(
            math.isfinite(v) for v in self.wheel_absolute_axial_momentum_nms
        ):
            raise ValueError("Wheel absolute axial momenta must be finite")
        object.__setattr__(
            self,
            "wheel_absolute_axial_momentum_nms",
            tuple(self.wheel_absolute_axial_momentum_nms),
        )


def state_from_relative_wheel_speeds(
    body: RigidBody,
    *,
    time_s=0.0,
    q_body_from_inertial_wxyz=(1, 0, 0, 0),
    omega_body_rad_s=(0, 0, 0),
    wheel_relative_speed_rad_s=()
):
    omega = finite_vector(omega_body_rad_s)
    if len(wheel_relative_speed_rad_s) != len(body.wheels) or not all(
        math.isfinite(v) for v in wheel_relative_speed_rad_s
    ):
        raise ValueError("One finite relative speed per wheel required")
    momenta = tuple(
        w.spin_inertia_kg_m2 * (speed + dot(w.axis_body, omega))
        for w, speed in zip(body.wheels, wheel_relative_speed_rad_s)
    )
    return AttitudeState(time_s, q_body_from_inertial_wxyz, omega, momenta)


@dataclass(frozen=True)
class AttitudeForcing:
    wheel_motor_torques_nm: tuple[float, ...] = ()
    magnetic_dipole_body_am2: Vector = (0.0, 0.0, 0.0)
    magnetic_field_inertial_t: Vector = (0.0, 0.0, 0.0)
    external_torque_body_nm: Vector = (0.0, 0.0, 0.0)

    def __post_init__(self):
        if len(self.wheel_motor_torques_nm) > 16 or not all(
            math.isfinite(v) for v in self.wheel_motor_torques_nm
        ):
            raise ValueError("Motor torque commands must be finite")
        object.__setattr__(
            self, "wheel_motor_torques_nm", tuple(self.wheel_motor_torques_nm)
        )
        for name in (
            "magnetic_dipole_body_am2",
            "magnetic_field_inertial_t",
            "external_torque_body_nm",
        ):
            object.__setattr__(self, name, finite_vector(getattr(self, name)))


@dataclass(frozen=True)
class MechanicalInvariants:
    rotational_energy_j: float
    angular_momentum_body_nms: Vector
    angular_momentum_inertial_nms: Vector
    wheel_relative_speed_rad_s: tuple[float, ...]


@dataclass(frozen=True)
class AttitudeDerivative:
    quaternion_rate_s_inv: tuple[float, float, float, float]
    omega_dot_body_rad_s2: Vector
    wheel_absolute_axial_momentum_rate_nm: tuple[float, ...]
    wheels: tuple[WheelOutput, ...]
    magnetic_field_body_t: Vector
    magnetic_dipole_body_am2: Vector
    magnetic_torque_body_nm: Vector
    dipole_saturated: bool
    total_external_torque_body_nm: Vector
    wheel_bus_power_w: float
    wheel_heat_w: float
    external_mechanical_power_w: float


@dataclass(frozen=True)
class AttitudeStep:
    state: AttitudeState
    derivative: AttitudeDerivative
    invariants: MechanicalInvariants
    wheel_bus_energy_j: float
    wheel_heat_j: float
    external_mechanical_work_j: float
    energy_balance_residual_j: float
    quaternion_norm_error_before_projection: float


def mechanical_invariants(
    body: RigidBody, state: AttitudeState
) -> MechanicalInvariants:
    if len(state.wheel_absolute_axial_momentum_nms) != len(body.wheels):
        raise ValueError("State wheel count differs from rigid-body configuration")
    omega = state.omega_body_rad_s
    momentum = matvec(body.effective_inertia_kg_m2, omega)
    energy = dot(omega, momentum) / 2
    relative = []
    for wheel, h in zip(body.wheels, state.wheel_absolute_axial_momentum_nms):
        momentum = add(momentum, scale(wheel.axis_body, h))
        energy += h * h / (2 * wheel.spin_inertia_kg_m2)
        relative.append(h / wheel.spin_inertia_kg_m2 - dot(wheel.axis_body, omega))
    return MechanicalInvariants(
        energy,
        momentum,
        rotate(conjugate(state.q_body_from_inertial_wxyz), momentum),
        tuple(relative),
    )


def _evaluate(body, values, forcing):
    q, omega, momenta = values[:4], values[4:7], values[7:]
    commands = forcing.wheel_motor_torques_nm or (0.0,) * len(body.wheels)
    if len(momenta) != len(body.wheels) or len(commands) != len(body.wheels):
        raise ValueError(
            "State/command wheel count differs from rigid-body configuration"
        )
    if body.magnetorquer is None:
        if norm(forcing.magnetic_dipole_body_am2) != 0:
            raise ValueError(
                "A nonzero dipole command requires a magnetorquer specification"
            )
        dipole, saturated = (0.0, 0.0, 0.0), False
    else:
        dipole, saturated = limited_dipole(
            forcing.magnetic_dipole_body_am2, body.magnetorquer
        )
    field = rotate(q, forcing.magnetic_field_inertial_t)
    magnetic = cross(dipole, field)
    external = add(forcing.external_torque_body_nm, magnetic)
    outputs = tuple(
        wheel_output(w, h, omega, u) for w, h, u in zip(body.wheels, momenta, commands)
    )
    momentum = matvec(body.effective_inertia_kg_m2, omega)
    spin_torque = (0.0, 0.0, 0.0)
    for wheel, h, output in zip(body.wheels, momenta, outputs):
        momentum = add(momentum, scale(wheel.axis_body, h))
        spin_torque = add(
            spin_torque, scale(wheel.axis_body, output.net_spin_torque_nm)
        )
    omega_dot = matvec(
        body.effective_inverse,
        add(add(external, scale(cross(omega, momentum), -1)), scale(spin_torque, -1)),
    )
    qdot = scale(multiply((0.0, *omega), q), -0.5)
    return AttitudeDerivative(
        qdot,
        omega_dot,
        tuple(o.net_spin_torque_nm for o in outputs),
        outputs,
        field,
        dipole,
        magnetic,
        saturated,
        external,
        sum(o.bus_power_w for o in outputs),
        sum(o.dissipated_heat_w for o in outputs),
        dot(external, omega),
    )


def derivative(
    body: RigidBody, state: AttitudeState, forcing: AttitudeForcing = AttitudeForcing()
) -> AttitudeDerivative:
    return _evaluate(
        body,
        (
            *state.q_body_from_inertial_wxyz,
            *state.omega_body_rad_s,
            *state.wheel_absolute_axial_momentum_nms,
        ),
        forcing,
    )


def step(
    body: RigidBody, state: AttitudeState, forcing: AttitudeForcing, step_s: float
) -> AttitudeStep:
    """One RK4 physics step; command held, envelope evaluated at each substage.

    No wheel momentum clipping. Excess relative speed from integration or an
    external torque is reported as overspeed, not silently discarded momentum.
    Magnetorquer electrical/thermal power is unknown without a coil/drive model.
    """
    if not math.isfinite(step_s) or step_s <= 0:
        raise ValueError("Physics step must be positive finite")
    initial = mechanical_invariants(body, state)
    values = (
        *state.q_body_from_inertial_wxyz,
        *state.omega_body_rad_s,
        *state.wheel_absolute_axial_momentum_nms,
    )

    def flattened(report):
        return (
            *report.quaternion_rate_s_inv,
            *report.omega_dot_body_rad_s2,
            *report.wheel_absolute_axial_momentum_rate_nm,
        )

    def intermediate(report, fraction):
        return tuple(
            a + step_s * fraction * b for a, b in zip(values, flattened(report))
        )

    a = _evaluate(body, values, forcing)
    b = _evaluate(body, intermediate(a, 0.5), forcing)
    c = _evaluate(body, intermediate(b, 0.5), forcing)
    d = _evaluate(body, intermediate(c, 1.0), forcing)
    result = tuple(
        y + step_s * (aa + 2 * bb + 2 * cc + dd) / 6
        for y, aa, bb, cc, dd in zip(
            values, flattened(a), flattened(b), flattened(c), flattened(d)
        )
    )
    norm_error = abs(math.hypot(*result[:4]) - 1)
    new_state = AttitudeState(
        state.time_s + step_s,
        normalize_quaternion(result[:4], validate=False),
        result[4:7],
        result[7:],
    )
    final = mechanical_invariants(body, new_state)

    def integrate(name):
        return (
            step_s
            * (
                getattr(a, name)
                + 2 * getattr(b, name)
                + 2 * getattr(c, name)
                + getattr(d, name)
            )
            / 6
        )

    bus, heat, work = (
        integrate(name)
        for name in ("wheel_bus_power_w", "wheel_heat_w", "external_mechanical_power_w")
    )
    residual = (
        final.rotational_energy_j - initial.rotational_energy_j - (work + bus - heat)
    )
    return AttitudeStep(
        new_state,
        derivative(body, new_state, forcing),
        final,
        bus,
        heat,
        work,
        residual,
        norm_error,
    )

"""Balanced wheel drive and spherical magnetic-dipole envelopes, all SI.

Wheel limits/power are explicit user-supplied model parameters, not hardware
profiles. Relative shaft speed and absolute axial momentum are distinct.
"""

from dataclasses import dataclass
import math

from ..geometry.vectors import add, cross, dot, norm, scale
from .kinematics import finite_vector, unit_vector
from .matrices import minimum_norm_wheel_torques


@dataclass(frozen=True)
class WheelSpec:
    axis_body: tuple[float, float, float]
    spin_inertia_kg_m2: float
    max_speed_rpm: float
    max_motor_torque_nm: float
    motor_torque_constant_nm_a: float
    winding_resistance_ohm: float
    non_ohmic_drive_efficiency: float
    idle_power_w: float
    constant_torque_until_rpm: float = 0.0
    regenerative_efficiency: float = 0.0
    viscous_friction_nm_s: float = 0.0
    max_bus_power_w: float | None = None

    def __post_init__(self):
        object.__setattr__(self, "axis_body", unit_vector(self.axis_body))
        positive = (
            self.spin_inertia_kg_m2,
            self.max_speed_rpm,
            self.motor_torque_constant_nm_a,
        )
        nonnegative = (
            self.max_motor_torque_nm,
            self.winding_resistance_ohm,
            self.idle_power_w,
            self.constant_torque_until_rpm,
            self.viscous_friction_nm_s,
        )
        if not all(math.isfinite(v) and v > 0 for v in positive) or not all(
            math.isfinite(v) and v >= 0 for v in nonnegative
        ):
            raise ValueError(
                "Wheel dimensional parameters must be finite with positive inertia/speed/torque constant"
            )
        if not 0 <= self.constant_torque_until_rpm < self.max_speed_rpm:
            raise ValueError("Torque-envelope knee must be below maximum speed")
        if (
            not math.isfinite(self.non_ohmic_drive_efficiency)
            or not 0 < self.non_ohmic_drive_efficiency <= 1
        ):
            raise ValueError("Non-ohmic drive efficiency must be in (0,1]")
        if (
            not math.isfinite(self.regenerative_efficiency)
            or not 0 <= self.regenerative_efficiency <= 1
        ):
            raise ValueError("Regenerative efficiency must be in [0,1]")
        if self.max_bus_power_w is not None and (
            not math.isfinite(self.max_bus_power_w)
            or self.max_bus_power_w < self.idle_power_w
        ):
            raise ValueError(
                "Bus power limit must be finite and at least the idle demand"
            )

    @property
    def max_relative_speed_rad_s(self):
        return self.max_speed_rpm * 2 * math.pi / 60

    @property
    def relative_momentum_capacity_nms(self):
        return self.spin_inertia_kg_m2 * self.max_relative_speed_rad_s


@dataclass(frozen=True)
class WheelOutput:
    requested_motor_torque_nm: float
    motor_torque_nm: float
    net_spin_torque_nm: float
    relative_speed_rad_s: float
    absolute_axial_momentum_nms: float
    relative_axial_momentum_nms: float
    maximum_relative_axial_momentum_nms: float
    torque_speed_envelope_nm: float
    torque_saturated: bool
    power_saturated: bool
    at_speed_limit: bool
    overspeed: bool
    motor_current_a: float
    shaft_power_w: float
    bus_power_w: float
    dissipated_heat_w: float


def wheel_output(
    spec: WheelSpec,
    absolute_axial_momentum_nms: float,
    omega_body_rad_s,
    requested_motor_torque_nm: float,
) -> WheelOutput:
    omega = finite_vector(omega_body_rad_s)
    if not all(
        math.isfinite(v)
        for v in (absolute_axial_momentum_nms, requested_motor_torque_nm)
    ):
        raise ValueError("Wheel momentum and requested torque must be finite")
    relative_speed = absolute_axial_momentum_nms / spec.spin_inertia_kg_m2 - dot(
        spec.axis_body, omega
    )
    rpm = abs(relative_speed) * 60 / (2 * math.pi)
    limit = spec.max_motor_torque_nm
    # A stated piecewise linear motoring envelope; braking retains the torque
    # limit. A real four-quadrant drive needs its measured envelope instead.
    if requested_motor_torque_nm * relative_speed > 0:
        remaining = (spec.max_speed_rpm - rpm) / (
            spec.max_speed_rpm - spec.constant_torque_until_rpm
        )
        limit *= max(0.0, min(1.0, remaining))
    motor = max(-limit, min(limit, requested_motor_torque_nm))
    power_saturated = False
    if spec.max_bus_power_w is not None and motor != 0:
        coefficient = spec.winding_resistance_ohm / spec.motor_torque_constant_nm_a**2
        linear = math.copysign(1, motor) * relative_speed
        linear *= (
            1 / spec.non_ohmic_drive_efficiency
            if motor * relative_speed >= 0
            else spec.regenerative_efficiency
        )
        headroom = spec.max_bus_power_w - spec.idle_power_w
        if coefficient * motor * motor + linear * abs(motor) > headroom:
            if coefficient > 0:
                discriminant = math.sqrt(linear * linear + 4 * coefficient * headroom)
                available = (
                    2 * headroom / (discriminant + linear)
                    if linear > 0
                    else (discriminant - linear) / (2 * coefficient)
                )
            else:
                available = headroom / linear
            motor = math.copysign(min(abs(motor), max(0, available)), motor)
            power_saturated = True
    current = motor / spec.motor_torque_constant_nm_a
    shaft_power = motor * relative_speed
    conversion = (
        shaft_power / spec.non_ohmic_drive_efficiency
        if shaft_power >= 0
        else shaft_power * spec.regenerative_efficiency
    )
    bus = (
        spec.idle_power_w + current * current * spec.winding_resistance_ohm + conversion
    )
    friction_torque = spec.viscous_friction_nm_s * relative_speed
    heat = bus - shaft_power + friction_torque * relative_speed
    return WheelOutput(
        requested_motor_torque_nm=requested_motor_torque_nm,
        motor_torque_nm=motor,
        net_spin_torque_nm=motor - friction_torque,
        relative_speed_rad_s=relative_speed,
        absolute_axial_momentum_nms=absolute_axial_momentum_nms,
        relative_axial_momentum_nms=spec.spin_inertia_kg_m2 * relative_speed,
        maximum_relative_axial_momentum_nms=spec.relative_momentum_capacity_nms,
        torque_speed_envelope_nm=limit,
        torque_saturated=abs(motor - requested_motor_torque_nm) > 1e-15,
        power_saturated=power_saturated,
        at_speed_limit=rpm >= spec.max_speed_rpm * (1 - 1e-10),
        overspeed=rpm > spec.max_speed_rpm * (1 + 1e-8),
        motor_current_a=current,
        shaft_power_w=shaft_power,
        bus_power_w=bus,
        dissipated_heat_w=heat,
    )


@dataclass(frozen=True)
class MagnetorquerSpec:
    max_dipole_am2: float

    def __post_init__(self):
        if not math.isfinite(self.max_dipole_am2) or self.max_dipole_am2 < 0:
            raise ValueError("Maximum dipole must be finite and nonnegative")


@dataclass(frozen=True)
class MagneticOutput:
    dipole_body_am2: tuple[float, float, float]
    torque_body_nm: tuple[float, float, float]
    requested_torque_body_nm: tuple[float, float, float]
    residual_torque_body_nm: tuple[float, float, float]
    dipole_saturated: bool
    field_has_authority: bool
    electrical_power_w: None = None


def limited_dipole(requested_body_am2, spec: MagnetorquerSpec):
    requested = finite_vector(requested_body_am2)
    magnitude = norm(requested)
    ratio = min(1.0, spec.max_dipole_am2 / magnitude) if magnitude > 0 else 1.0
    return scale(requested, ratio), ratio < 1


def magnetic_torque(dipole_body_am2, field_body_t):
    return cross(finite_vector(dipole_body_am2), finite_vector(field_body_t))


def allocate_magnetic_torque(
    requested_torque_body_nm, field_body_t, spec: MagnetorquerSpec
) -> MagneticOutput:
    target, field = finite_vector(requested_torque_body_nm), finite_vector(field_body_t)
    squared = dot(field, field)
    raw = (
        scale(cross(field, target), 1 / squared) if squared > 1e-40 else (0.0, 0.0, 0.0)
    )
    moment, saturated = limited_dipole(raw, spec)
    torque = cross(moment, field)
    return MagneticOutput(
        moment,
        torque,
        target,
        add(target, scale(torque, -1)),
        saturated,
        squared > 1e-40,
    )


def bdot_dipole(field_derivative_body_t_s, gain_am2_s_t: float, spec: MagnetorquerSpec):
    """m=-k Bdot: rate damping only when inertial B changes slowly.

    Caller owns Bdot estimation and magnetometer blanking. Not a pointing law.
    NASA NTRS 20110007876, PDF p.31, magnetic momentum-management example.
    """
    if not math.isfinite(gain_am2_s_t) or gain_am2_s_t < 0:
        raise ValueError("B-dot gain must be finite and nonnegative")
    return limited_dipole(
        scale(finite_vector(field_derivative_body_t_s), -gain_am2_s_t), spec
    )


def unloading_dipole(
    wheel_momentum_body_nms, field_body_t, gain_s_inv: float, spec: MagnetorquerSpec
) -> MagneticOutput:
    """External torque toward -k h_w; attitude wheels must counteract it.

    Only momentum perpendicular to B can be removed instantaneously. This
    vector law does not control redundant-wheel nullspace momentum separately.
    """
    if not math.isfinite(gain_s_inv) or gain_s_inv < 0:
        raise ValueError("Unloading gain must be finite and nonnegative")
    return allocate_magnetic_torque(
        scale(finite_vector(wheel_momentum_body_nms), -gain_s_inv), field_body_t, spec
    )


def allocate_wheel_net_torques(
    wheels, desired_body_control_torque_nm, magnetic_torque_body_nm=(0.0, 0.0, 0.0)
):
    """Unconstrained minimum-norm net axial wheel torques.

    Body control torque = magnetic torque - sum(axis*net_spin_torque).
    Per-wheel saturation follows in wheel_output; no bounded-optimal reallocation
    is claimed. Rank-deficient layouts leave an explicitly measurable residual.
    """
    target = add(
        finite_vector(magnetic_torque_body_nm),
        scale(finite_vector(desired_body_control_torque_nm), -1),
    )
    net = minimum_norm_wheel_torques(tuple(w.axis_body for w in wheels), target)
    return net

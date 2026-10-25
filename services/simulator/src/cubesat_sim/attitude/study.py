"""Headless actuator study with independent physics/controller/output clocks.

The magnetic vector is a supplied CONSTANT INERTIAL field. This is a controlled
reference experiment, not an IGRF orbit, estimator or installed spacecraft model.
"""

from dataclasses import asdict, dataclass, replace
import json
import math
from typing import Literal

from ..geometry.vectors import add, cross, dot, norm, scale
from .actuators import (
    allocate_magnetic_torque,
    allocate_wheel_net_torques,
    bdot_dipole,
    unloading_dipole,
)
from .control import (
    AttitudeReference,
    PDConfig,
    minimum_rotation_reference,
    quaternion_pd,
)
from .dynamics import (
    AttitudeForcing,
    AttitudeState,
    RigidBody,
    derivative,
    mechanical_invariants,
    step,
)
from .kinematics import (
    boresight_reference,
    conjugate,
    finite_vector,
    rotate,
    unit_vector,
)
from .actuators import MagnetorquerSpec, WheelSpec
from .dynamics import state_from_relative_wheel_speeds

MODEL_VERSION = "standalone-actuator-study-0.1.0"


def _ticks(interval, step_s, *, zero=False):
    if not math.isfinite(interval) or interval < 0 or (interval == 0 and not zero):
        raise ValueError("Clock interval must be positive finite")
    ratio = interval / step_s
    if not math.isfinite(ratio) or ratio > 200_000 or abs(ratio - round(ratio)) > 1e-8:
        raise ValueError(
            "Clock intervals must be integer physics ticks, at most 200,000"
        )
    return round(ratio)


@dataclass(frozen=True)
class AttitudeStudyInput:
    body: RigidBody
    initial: AttitudeState
    duration_s: float
    physics_step_s: float
    controller_period_s: float
    output_step_s: float
    controller: Literal["coast", "quaternion_pd", "magnetic_bdot"] = "coast"
    pd_gains: PDConfig | None = None
    body_boresight: tuple[float, float, float] = (0.0, 1.0, 0.0)
    target_direction_inertial: tuple[float, float, float] = (0.0, 1.0, 0.0)
    free_roll: bool = True
    magnetic_field_inertial_t: tuple[float, float, float] = (0.0, 0.0, 0.0)
    disturbance_torque_body_nm: tuple[float, float, float] = (0.0, 0.0, 0.0)
    unloading_gain_s_inv: float = 0.0
    wheel_momentum_bias_body_nms: tuple[float, float, float] = (0.0, 0.0, 0.0)
    bdot_gain_am2_s_t: float = 0.0

    def __post_init__(self):
        if not isinstance(self.body, RigidBody) or not isinstance(
            self.initial, AttitudeState
        ):
            raise ValueError("Validated rigid body and initial attitude state required")
        mechanical_invariants(self.body, self.initial)
        if not math.isfinite(self.physics_step_s) or self.physics_step_s <= 0:
            raise ValueError("Physics step must be positive finite")
        count = _ticks(self.duration_s, self.physics_step_s, zero=True)
        control = _ticks(self.controller_period_s, self.physics_step_s)
        output = _ticks(self.output_step_s, self.physics_step_s)
        if control < 1 or output < 1 or count % output or count // output > 20_000:
            raise ValueError(
                "Output must divide duration; controller/output ticks >=1, at most20,000 samples"
            )
        if self.controller not in ("coast", "quaternion_pd", "magnetic_bdot"):
            raise ValueError(
                "Implemented controllers are coast, quaternion_pd and magnetic_bdot"
            )
        if self.controller == "quaternion_pd" and (
            not isinstance(self.pd_gains, PDConfig)
            or not (self.body.wheels or self.body.magnetorquer)
        ):
            raise ValueError("Quaternion PD needs validated gains and an actuator")
        if self.controller == "magnetic_bdot" and self.body.magnetorquer is None:
            raise ValueError("B-dot needs a magnetorquer")
        for name in ("body_boresight", "target_direction_inertial"):
            object.__setattr__(self, name, unit_vector(getattr(self, name)))
        for name in (
            "magnetic_field_inertial_t",
            "disturbance_torque_body_nm",
            "wheel_momentum_bias_body_nms",
        ):
            object.__setattr__(self, name, finite_vector(getattr(self, name)))
        for value in (self.unloading_gain_s_inv, self.bdot_gain_am2_s_t):
            if not math.isfinite(value) or value < 0:
                raise ValueError(
                    "Unloading and B-dot gains must be finite and nonnegative"
                )
        if self.unloading_gain_s_inv > 0 and (
            not self.body.wheels or self.body.magnetorquer is None
        ):
            raise ValueError("Magnetic unloading needs wheels and a magnetorquer")


def run_attitude_study(request: AttitudeStudyInput, cancelled=None):
    """JSON-safe results; optional cancellation callback raises InterruptedError.

    Motor commands and body dipole are held between control updates; actuator
    limits and the body-rotated field are evaluated at RK4 substages. Only
    implemented controllers are accepted. Coast disables controller/unloading.
    """
    body, state = request.body, request.initial
    initial_mechanics = mechanical_invariants(body, state)
    count = _ticks(request.duration_s, request.physics_step_s, zero=True)
    control_stride = _ticks(request.controller_period_s, request.physics_step_s)
    output_stride = _ticks(request.output_step_s, request.physics_step_s)
    fixed_reference = AttitudeReference(
        boresight_reference(
            state.q_body_from_inertial_wxyz,
            request.body_boresight,
            request.target_direction_inertial,
        )
    )
    reference = fixed_reference
    requested_control = None
    magnetic_allocation = None
    controller_dipole_saturated = False
    forcing = AttitudeForcing(
        magnetic_field_inertial_t=request.magnetic_field_inertial_t,
        external_torque_body_nm=request.disturbance_torque_body_nm,
    )
    cumulative_bus = cumulative_heat = cumulative_work = 0.0
    rows = []
    any_overspeed = any_torque_saturation = any_dipole_saturation = (
        any_power_saturation
    ) = False
    maximum_quaternion_norm_error = 0.0

    def control_update():
        nonlocal reference, requested_control, forcing, magnetic_allocation, controller_dipole_saturated
        field = rotate(
            state.q_body_from_inertial_wxyz, request.magnetic_field_inertial_t
        )
        moment = (0.0, 0.0, 0.0)
        motors = (0.0,) * len(body.wheels)
        requested_control = None
        magnetic_allocation = None
        controller_dipole_saturated = False
        if request.controller == "quaternion_pd":
            reference = (
                minimum_rotation_reference(
                    state, request.body_boresight, request.target_direction_inertial
                )
                if request.free_roll
                else fixed_reference
            )
            control = quaternion_pd(
                body,
                state,
                reference,
                request.pd_gains,
                request.body_boresight if request.free_roll else None,
            )
            requested_control = control.requested_body_control_torque_nm
            if body.wheels:
                if request.unloading_gain_s_inv > 0:
                    momentum = (0.0, 0.0, 0.0)
                    for wheel, h in zip(
                        body.wheels, state.wheel_absolute_axial_momentum_nms
                    ):
                        momentum = add(momentum, scale(wheel.axis_body, h))
                    excess = add(
                        momentum, scale(request.wheel_momentum_bias_body_nms, -1)
                    )
                    allocation = unloading_dipole(
                        excess, field, request.unloading_gain_s_inv, body.magnetorquer
                    )
                    moment = allocation.dipole_body_am2
                    magnetic_allocation = asdict(allocation)
                    controller_dipole_saturated = allocation.dipole_saturated
                net = allocate_wheel_net_torques(
                    body.wheels, requested_control, cross(moment, field)
                )
                relative = mechanical_invariants(body, state).wheel_relative_speed_rad_s
                motors = tuple(
                    t + w.viscous_friction_nm_s * speed
                    for t, w, speed in zip(net, body.wheels, relative)
                )
            else:
                allocation = allocate_magnetic_torque(
                    requested_control, field, body.magnetorquer
                )
                moment = allocation.dipole_body_am2
                magnetic_allocation = asdict(allocation)
                controller_dipole_saturated = allocation.dipole_saturated
        elif request.controller == "magnetic_bdot":
            # Exact rotating-frame derivative for the stated constant inertial B.
            field_derivative = scale(cross(state.omega_body_rad_s, field), -1)
            moment, controller_dipole_saturated = bdot_dipole(
                field_derivative, request.bdot_gain_am2_s_t, body.magnetorquer
            )
        forcing = AttitudeForcing(
            motors,
            moment,
            request.magnetic_field_inertial_t,
            request.disturbance_torque_body_nm,
        )

    def sample():
        report = derivative(body, state, forcing)
        mechanical = mechanical_invariants(body, state)
        bore = rotate(
            conjugate(state.q_body_from_inertial_wxyz), request.body_boresight
        )
        pointing = math.acos(
            max(-1.0, min(1.0, dot(bore, request.target_direction_inertial)))
        )
        achieved = report.magnetic_torque_body_nm
        for wheel, output in zip(body.wheels, report.wheels):
            achieved = add(achieved, scale(wheel.axis_body, -output.net_spin_torque_nm))
        return dict(
            state=asdict(state),
            reference=asdict(reference),
            pointing_error_rad=pointing,
            mechanics=asdict(mechanical),
            actuators=asdict(report),
            requested_body_control_torque_nm=requested_control,
            magnetic_control_allocation=magnetic_allocation,
            controller_dipole_saturated=controller_dipole_saturated,
            achieved_body_control_torque_nm=achieved,
            control_allocation_residual_nm=(
                add(requested_control, scale(achieved, -1))
                if requested_control is not None
                else None
            ),
            cumulative_wheel_bus_energy_j=cumulative_bus,
            cumulative_wheel_heat_j=cumulative_heat,
            cumulative_external_work_j=cumulative_work,
            energy_balance_residual_j=mechanical.rotational_energy_j
            - initial_mechanics.rotational_energy_j
            - (cumulative_work + cumulative_bus - cumulative_heat),
        )

    control_update()
    rows.append(sample())
    initial_report = derivative(body, state, forcing)
    any_overspeed = any(w.overspeed for w in initial_report.wheels)
    any_torque_saturation = any(w.torque_saturated for w in initial_report.wheels)
    any_power_saturation = any(w.power_saturated for w in initial_report.wheels)
    any_dipole_saturation = (
        initial_report.dipole_saturated or controller_dipole_saturated
    )
    for tick in range(count):
        if cancelled is not None and tick % 32 == 0 and cancelled():
            raise InterruptedError("Attitude study cancelled")
        if tick and tick % control_stride == 0:
            control_update()
        result = step(body, state, forcing, request.physics_step_s)
        state = replace(
            result.state,
            time_s=request.initial.time_s + (tick + 1) * request.physics_step_s,
        )
        cumulative_bus += result.wheel_bus_energy_j
        cumulative_heat += result.wheel_heat_j
        cumulative_work += result.external_mechanical_work_j
        any_overspeed |= any(w.overspeed for w in result.derivative.wheels)
        any_torque_saturation |= any(
            w.torque_saturated for w in result.derivative.wheels
        )
        any_power_saturation |= any(w.power_saturated for w in result.derivative.wheels)
        any_dipole_saturation |= (
            result.derivative.dipole_saturated or controller_dipole_saturated
        )
        maximum_quaternion_norm_error = max(
            maximum_quaternion_norm_error,
            result.quaternion_norm_error_before_projection,
        )
        if (tick + 1) % output_stride == 0:
            rows.append(sample())
    result = dict(
        model_version=MODEL_VERSION,
        input=asdict(request),
        samples=rows,
        summary=dict(
            physics_steps=count,
            controller_updates=1 + (count - 1) // control_stride if count else 1,
            wheel_overspeed=any_overspeed,
            wheel_torque_saturation=any_torque_saturation,
            wheel_power_saturation=any_power_saturation,
            dipole_saturation=any_dipole_saturation,
            maximum_quaternion_norm_error_before_projection=maximum_quaternion_norm_error,
            wheel_bus_energy_j=cumulative_bus,
            wheel_heat_j=cumulative_heat,
            external_mechanical_work_j=cumulative_work,
        ),
        limits=[
            "Constant supplied inertial magnetic field; not IGRF or an orbital field prediction.",
            "Rigid body with balanced fixed-axis wheels; no sensor/estimator, flexible modes, jitter, deployment or hardware calibration.",
            "Piecewise linear motoring torque-speed assumption; explicit braking, efficiency, resistance, idle and regeneration parameters.",
            "Magnetorquer electrical power and heat unresolved without a coil/driver model.",
            "Speed limit inhibits outward drive; externally forced or numerical overspeed is reported without momentum clipping.",
            "Magnetic unloading removes only the instantaneous field-perpendicular momentum component; no bounded optimal allocation or LQR.",
        ],
    )
    return json.loads(json.dumps(result, allow_nan=False))


def default_attitude_study():
    """Explicit illustrative bench model, not selected wheel/coil hardware."""
    wheels = tuple(
        WheelSpec(axis, 5e-7, 6000, 5e-5, 0.005, 8, 0.8, 0.01, max_bus_power_w=0.05)
        for axis in ((1, 0, 0), (0, 1, 0), (0, 0, 1))
    )
    body = RigidBody(
        ((0.002, 0, 0), (0, 0.002, 0), (0, 0, 0.002)), wheels, MagnetorquerSpec(0.2)
    )
    initial = state_from_relative_wheel_speeds(
        body,
        q_body_from_inertial_wxyz=(math.cos(0.2), 0, 0, -math.sin(0.2)),
        wheel_relative_speed_rad_s=(0, 0, 0),
    )
    return AttitudeStudyInput(
        body,
        initial,
        50,
        0.02,
        0.1,
        0.2,
        "quaternion_pd",
        PDConfig((0.0001,) * 3, (0.0008,) * 3),
        free_roll=True,
        magnetic_field_inertial_t=(0, 0, 40e-6),
        bdot_gain_am2_s_t=1e5,
    )

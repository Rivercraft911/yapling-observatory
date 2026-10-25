"""Strict transport adapter for independent orbit/actuator reference studies.

The equations/default constructions remain in the named numerical modules.
No Scenario, current pass, mission hardware or scene state is modified here.
"""

from dataclasses import asdict
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    model_validator,
)

from .attitude.actuators import MagnetorquerSpec, WheelSpec
from .attitude.control import PDConfig
from .attitude.dynamics import (
    RigidBody,
    mechanical_invariants,
    state_from_relative_wheel_speeds,
)
from .attitude.study import (
    AttitudeStudyInput,
    default_attitude_study,
    run_attitude_study,
)
from .orbit.study import OrbitStudyInput, default_orbit_study, run_orbit_study
from .orbit.two_body import CartesianState, TwoBodyConfig

Vector = tuple[StrictFloat, StrictFloat, StrictFloat]
Quaternion = tuple[StrictFloat, StrictFloat, StrictFloat, StrictFloat]
Matrix = tuple[Vector, Vector, Vector]
Positive = Annotated[StrictFloat, Field(gt=0)]
Nonnegative = Annotated[StrictFloat, Field(ge=0)]


class LabInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, frozen=True)


class WheelInput(LabInput):
    axis_body: Vector
    spin_inertia_kg_m2: Positive
    max_speed_rpm: Positive
    max_motor_torque_nm: Nonnegative
    motor_torque_constant_nm_a: Positive
    winding_resistance_ohm: Nonnegative
    non_ohmic_drive_efficiency: Annotated[StrictFloat, Field(gt=0, le=1)]
    idle_power_w: Nonnegative
    constant_torque_until_rpm: Nonnegative = 0.0
    regenerative_efficiency: Annotated[StrictFloat, Field(ge=0, le=1)] = 0.0
    viscous_friction_nm_s: Nonnegative = 0.0
    max_bus_power_w: Nonnegative | None = None

    def to_spec(self):
        return WheelSpec(**self.model_dump())


class MagnetorquerInput(LabInput):
    max_dipole_am2: Nonnegative


class BodyInput(LabInput):
    locked_inertia_kg_m2: Matrix
    wheels: tuple[WheelInput, ...] = Field(default=(), max_length=16)
    magnetorquer: MagnetorquerInput | None = None

    def to_body(self):
        return RigidBody(
            self.locked_inertia_kg_m2,
            tuple(w.to_spec() for w in self.wheels),
            (
                MagnetorquerSpec(**self.magnetorquer.model_dump())
                if self.magnetorquer
                else None
            ),
        )


class InitialAttitudeInput(LabInput):
    time_s: StrictFloat = 0.0
    q_body_from_inertial_wxyz: Quaternion
    omega_body_rad_s: Vector
    wheel_relative_speed_rad_s: tuple[StrictFloat, ...] = Field(
        default=(), max_length=16
    )


class PDInput(LabInput):
    proportional_nm_per_rad: Vector
    derivative_nm_s_per_rad: Vector
    gyroscopic_compensation: StrictBool = True


class AttitudeStudyRequest(LabInput):
    body: BodyInput
    initial: InitialAttitudeInput
    duration_s: Annotated[StrictFloat, Field(ge=0, le=7200)]
    physics_step_s: Annotated[StrictFloat, Field(gt=0, le=10)]
    controller_period_s: Positive
    output_step_s: Positive
    controller: Literal["coast", "quaternion_pd", "magnetic_bdot"]
    pd_gains: PDInput | None = None
    body_boresight: Vector = (0.0, 1.0, 0.0)
    target_direction_inertial: Vector = (0.0, 1.0, 0.0)
    free_roll: StrictBool = True
    magnetic_field_inertial_t: Vector = (0.0, 0.0, 0.0)
    disturbance_torque_body_nm: Vector = (0.0, 0.0, 0.0)
    unloading_gain_s_inv: Nonnegative = 0.0
    wheel_momentum_bias_body_nms: Vector = (0.0, 0.0, 0.0)
    bdot_gain_am2_s_t: Nonnegative = 0.0

    def to_input(self):
        body = self.body.to_body()
        initial = state_from_relative_wheel_speeds(body, **self.initial.model_dump())
        values = self.model_dump(exclude={"body", "initial", "pd_gains"})
        return AttitudeStudyInput(
            body=body,
            initial=initial,
            pd_gains=PDConfig(**self.pd_gains.model_dump()) if self.pd_gains else None,
            **values,
        )

    @model_validator(mode="after")
    def valid_study(self):
        study = self.to_input()
        if (
            study.duration_s / study.physics_step_s > 50_000
            or study.duration_s / study.output_step_s > 5000
        ):
            raise ValueError(
                "HTTP study is bounded to 50,000 physics steps and 5000 output intervals"
            )
        return self

    @classmethod
    def default(cls):
        study = default_attitude_study()
        values = asdict(study)
        values["initial"] = dict(
            time_s=study.initial.time_s,
            q_body_from_inertial_wxyz=study.initial.q_body_from_inertial_wxyz,
            omega_body_rad_s=study.initial.omega_body_rad_s,
            wheel_relative_speed_rad_s=mechanical_invariants(
                study.body, study.initial
            ).wheel_relative_speed_rad_s,
        )
        return cls.model_validate(values)


class CartesianInput(LabInput):
    time_s: StrictFloat = 0.0
    position_m: Vector
    velocity_m_s: Vector


class TwoBodyInput(LabInput):
    mu_m3_s2: Positive
    step_s: Positive
    method: Literal["rk4", "velocity_verlet"]
    minimum_radius_m: Positive = 1.0


class OrbitStudyRequest(LabInput):
    initial: CartesianInput
    config: TwoBodyInput
    duration_s: Annotated[StrictFloat, Field(ge=0, le=2_592_000)]
    output_step_s: Positive

    def to_input(self):
        return OrbitStudyInput(
            CartesianState(**self.initial.model_dump()),
            TwoBodyConfig(**self.config.model_dump()),
            self.duration_s,
            self.output_step_s,
        )

    @model_validator(mode="after")
    def valid_study(self):
        study = self.to_input()
        if (
            study.duration_s / study.config.step_s > 200_000
            or study.duration_s / study.output_step_s > 10_000
        ):
            raise ValueError(
                "HTTP study is bounded to 200,000 physics steps and 10,000 output intervals"
            )
        return self

    @classmethod
    def default(cls):
        return cls.model_validate(asdict(default_orbit_study()))


router = APIRouter(prefix="/api/dynamics-lab", tags=["independent dynamics studies"])


@router.get("/defaults")
def defaults():
    return dict(
        scope="Illustrative independent studies; no selected hardware or current-pass replacement.",
        orbit=OrbitStudyRequest.default().model_dump(mode="json"),
        attitude=AttitudeStudyRequest.default().model_dump(mode="json"),
        orbit_methods=["rk4", "velocity_verlet"],
        controllers=["coast", "quaternion_pd", "magnetic_bdot"],
        evidence="Editable example inertia, wheel drive/loss parameters and constant inertial magnetic vector; not manufacturer profiles.",
    )


@router.post("/orbit")
def orbit(request: OrbitStudyRequest):
    try:
        return run_orbit_study(request.to_input()) | {
            "request": request.model_dump(mode="json")
        }
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/attitude")
def attitude(request: AttitudeStudyRequest):
    try:
        return run_attitude_study(request.to_input()) | {
            "request": request.model_dump(mode="json")
        }
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

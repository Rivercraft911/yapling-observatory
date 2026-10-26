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
from .orbit.gravity import (
    GravityPotential,
    EGM2008_REFERENCE_RADIUS_M,
    EGM2008_J2,
    EGM2008_MU_M3_S2,
)
from .orbit.elements import (
    OrbitElements,
    elements_to_cartesian,
    osculating_elements,
    first_order_sso_inclination_deg,
    raan_from_ltan_deg,
    ltan_from_raan_hours,
)
from .mission.ephemeris import mean_sun_ra_deg, MODEL_VERSION as SOLAR_MODEL_VERSION

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
    damp_free_roll_rate: StrictBool = False
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
    force_model: Literal["central", "j2"] = "central"
    reference_radius_m: Positive = EGM2008_REFERENCE_RADIUS_M
    j2: Annotated[StrictFloat, Field(ge=-0.1, le=0.1)] = EGM2008_J2


class OrbitElementsInput(LabInput):
    semi_major_axis_m: Positive
    eccentricity: Annotated[StrictFloat, Field(ge=0, lt=1)]
    inclination_deg: Annotated[StrictFloat, Field(ge=0, le=180)]
    raan_deg: StrictFloat
    argument_of_periapsis_deg: StrictFloat
    true_anomaly_deg: StrictFloat
    epoch_utc: str = Field(max_length=40)

    def to_elements(self):
        return OrbitElements(**self.model_dump())

    @model_validator(mode="after")
    def valid_elements(self):
        self.to_elements()
        return self


class OrbitStudyRequest(LabInput):
    initial: CartesianInput
    config: TwoBodyInput
    duration_s: Annotated[StrictFloat, Field(ge=0, le=2_592_000)]
    output_step_s: Positive
    initialization: Literal["cartesian", "elements"] = "cartesian"
    elements: OrbitElementsInput | None = None
    node_definition: Literal["raan", "ltan"] = "raan"
    local_mean_solar_time_hours: Annotated[StrictFloat, Field(ge=0, lt=24)] = 18.0

    def resolved_elements(self):
        if self.elements is None:
            return None
        values = self.elements.model_dump()
        if self.node_definition == "ltan":
            values["raan_deg"] = raan_from_ltan_deg(
                self.local_mean_solar_time_hours,
                mean_sun_ra_deg(self.elements.epoch_utc),
            )
        return OrbitElements(**values)

    def to_input(self):
        initial = CartesianState(**self.initial.model_dump())
        if self.initialization == "elements":
            if self.elements is None:
                raise ValueError(
                    "Element initialization requires explicit osculating elements and UTC epoch"
                )
            cartesian = elements_to_cartesian(
                self.resolved_elements(), self.config.mu_m3_s2
            )
            initial = CartesianState(
                self.initial.time_s, cartesian.position_m, cartesian.velocity_m_s
            )
        elif self.node_definition == "ltan":
            raise ValueError("Linked LTAN initialization requires orbital elements")
        return OrbitStudyInput(
            initial,
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
        study = default_orbit_study()
        elements = osculating_elements(
            study.initial.position_m, study.initial.velocity_m_s, study.config.mu_m3_s2
        )
        value = asdict(study)
        value["elements"] = dict(
            semi_major_axis_m=elements.semi_major_axis_m,
            eccentricity=elements.eccentricity,
            inclination_deg=elements.inclination_deg,
            raan_deg=elements.raan_deg or 0,
            argument_of_periapsis_deg=elements.argument_of_periapsis_deg or 0,
            true_anomaly_deg=elements.true_anomaly_deg
            or elements.true_longitude_deg
            or 0,
            epoch_utc="2026-10-25T00:00:00Z",
        )
        return cls.model_validate(value)


class SSOReferenceRequest(LabInput):
    semi_major_axis_m: Positive
    eccentricity: Annotated[StrictFloat, Field(ge=0, lt=1)] = 0.0
    desired_nodal_rate_deg_day: StrictFloat = 360 / 365.2422
    mu_m3_s2: Positive = EGM2008_MU_M3_S2
    reference_radius_m: Positive = EGM2008_REFERENCE_RADIUS_M
    j2: Annotated[StrictFloat, Field(ge=-0.1, le=0.1)] = EGM2008_J2


class SolarNodeRequest(LabInput):
    node_definition: Literal["raan", "ltan"] = "ltan"
    local_mean_solar_time_hours: Annotated[StrictFloat, Field(ge=0, lt=24)] = 18.0
    raan_deg: StrictFloat | None = None
    mean_sun_ra_deg: StrictFloat | None = None
    epoch_utc: str = Field(max_length=40)

    @model_validator(mode="after")
    def valid_epoch(self):
        OrbitElements(1, 0, 0, 0, 0, 0, self.epoch_utc)
        if self.node_definition == "raan" and self.raan_deg is None:
            raise ValueError("RAAN node definition requires explicit RAAN")
        return self


router = APIRouter(prefix="/api/dynamics-lab", tags=["independent dynamics studies"])


@router.get("/defaults")
def defaults():
    return dict(
        scope="Illustrative independent studies; no selected hardware or current-pass replacement.",
        orbit=OrbitStudyRequest.default().model_dump(mode="json"),
        attitude=AttitudeStudyRequest.default().model_dump(mode="json"),
        orbit_methods=["rk4", "velocity_verlet"],
        force_models=["central", "j2"],
        controllers=["coast", "quaternion_pd", "magnetic_bdot"],
        evidence="Editable example inertia, wheel drive/loss parameters and constant inertial magnetic vector; not manufacturer profiles.",
    )


@router.post("/orbit")
def orbit(request: OrbitStudyRequest):
    try:
        return run_orbit_study(request.to_input()) | {
            "request": request.model_dump(mode="json"),
            "resolved_initial_elements": (
                asdict(request.resolved_elements())
                if request.initialization == "elements"
                else None
            ),
            "solar_time_convention": "Local mean solar time at ascending node; epoch mean-Sun RA, not UTC; "
            + SOLAR_MODEL_VERSION,
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


@router.post("/orbit/sso-reference")
def sso_reference(request: SSOReferenceRequest):
    gravity = GravityPotential(request.mu_m3_s2, request.reference_radius_m, request.j2)
    inclination = first_order_sso_inclination_deg(
        request.semi_major_axis_m,
        request.eccentricity,
        request.desired_nodal_rate_deg_day,
        gravity,
    )
    return dict(
        inclination_deg=inclination,
        available=inclination is not None,
        request=request.model_dump(mode="json"),
        convention="First-order secular mean-element reference. Initial Cartesian elements are osculating; not an exact SSO guarantee or adopted mission orbit.",
    )


@router.post("/orbit/solar-node")
def solar_node(request: SolarNodeRequest):
    try:
        solar_ra = (
            request.mean_sun_ra_deg
            if request.mean_sun_ra_deg is not None
            else mean_sun_ra_deg(request.epoch_utc)
        )
        raan = (
            raan_from_ltan_deg(request.local_mean_solar_time_hours, solar_ra)
            if request.node_definition == "ltan"
            else request.raan_deg % 360
        )
        return dict(
            raan_deg=raan,
            local_mean_solar_time_hours=ltan_from_raan_hours(raan, solar_ra),
            epoch_utc=request.epoch_utc,
            mean_sun_ra_deg=solar_ra,
            solar_model_version=SOLAR_MODEL_VERSION,
            convention="Local MEAN solar time at ascending node, not UTC. Mean-Sun RA is at this epoch in the same declared equatorial frame.",
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

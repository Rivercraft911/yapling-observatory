"""Immutable coupled-mission inputs. Example hardware is not a flight selection."""

from datetime import datetime, timezone, timedelta
import hashlib
import json
import math
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator, model_serializer
from .models import Station, Link, Schedule
from .operations.radio_delivery_models import RadioDeliveryConfig
from .orbit.elements import OrbitElements
from .orbit.gravity import EGM2008_MU_M3_S2, EGM2008_REFERENCE_RADIUS_M, EGM2008_J2
from .attitude.actuators import WheelSpec, MagnetorquerSpec
from .attitude.dynamics import RigidBody
from .attitude.control import PDConfig
from .attitude.kinematics import normalize_quaternion, unit_vector
from .power.models import (
    PVPanel,
    BatterySpec,
    ComponentLoad,
    unit_vector as validate_unit_vector,
)
from .thermal.models import ThermalNetwork
from .mission.ephemeris import utc_datetime


class MissionModel(BaseModel):
    model_config = ConfigDict(
        frozen=True, extra="forbid", allow_inf_nan=False, validate_default=True
    )


class MissionOrbit(MissionModel):
    elements: OrbitElements
    force_model: Literal["central", "j2"] = "j2"
    method: Literal["rk4", "velocity_verlet"] = "rk4"
    mu_m3_s2: float = Field(default=EGM2008_MU_M3_S2, gt=0)
    reference_radius_m: float = Field(default=EGM2008_REFERENCE_RADIUS_M, gt=0)
    j2: float = Field(default=EGM2008_J2, ge=-0.1, le=0.1)
    preset: str | None = None
    ltan_hours_at_epoch: float | None = Field(default=None, ge=0, lt=24)
    element_kind: Literal["osculating_initial"] = "osculating_initial"

    @model_validator(mode="after")
    def exterior_orbit(self):
        if (
            self.elements.semi_major_axis_m * (1 - self.elements.eccentricity)
            <= self.reference_radius_m + 100000
        ):
            raise ValueError(
                "Initial osculating perigee must exceed reference radius by100km"
            )
        return self


class MissionClocks(MissionModel):
    dynamics_step_s: float = Field(default=1, gt=0, le=10)
    orbit_substeps: int = Field(default=1, ge=1, le=100, strict=True)
    controller_period_s: float = Field(default=2, gt=0)
    thermal_step_s: float = Field(default=10, gt=0, le=60)
    output_step_s: float = Field(default=30, gt=0)
    fidelity: str = "explicit_fixed_clocks"


class MissionWheel(MissionModel):
    enabled: bool = True
    spec: WheelSpec
    initial_speed_rpm: float = 0.0

    @model_validator(mode="after")
    def initial_speed_limit(self):
        if abs(self.initial_speed_rpm) > self.spec.max_speed_rpm:
            raise ValueError(
                "Initial wheel speed must lie within the specified RPM limit"
            )
        return self


class MissionMagnetorquer(MissionModel):
    enabled: bool = True
    spec: MagnetorquerSpec = MagnetorquerSpec(0.2)
    full_axis_power_w: tuple[float, float, float] | None = (0.75, 0.75, 0.75)
    power_model: Literal["quadratic_dipole_example", "unresolved"] = (
        "quadratic_dipole_example"
    )
    thermal_node_id: str = "bus"

    @model_validator(mode="after")
    def valid_power(self):
        if (self.power_model == "unresolved") != (self.full_axis_power_w is None):
            raise ValueError(
                "Unresolved MTQ watts must be null; example model requires explicit axis watts"
            )
        if self.full_axis_power_w is not None and any(
            v < 0 or not math.isfinite(v) for v in self.full_axis_power_w
        ):
            raise ValueError("MTQ example axis powers must be nonnegative finite")
        return self


class MissionSpacecraft(MissionModel):
    mass_kg: float = Field(default=1.5, gt=0)
    locked_inertia_kg_m2: tuple[
        tuple[float, float, float],
        tuple[float, float, float],
        tuple[float, float, float],
    ] = ((0.002, 0, 0), (0, 0.002, 0), (0, 0, 0.002))
    initial_q_body_from_inertial_wxyz: tuple[float, float, float, float] = (1, 0, 0, 0)
    initial_omega_body_rad_s: tuple[float, float, float] = (0, 0, 0)
    wheels: tuple[MissionWheel, ...] = Field(default=(), max_length=16)
    magnetorquer: MissionMagnetorquer | None = MissionMagnetorquer()
    controller: Literal["coast", "quaternion_pd"] = "quaternion_pd"
    proportional_nm_per_rad: tuple[float, float, float] = (1e-5, 1e-5, 1e-5)
    derivative_nm_s_per_rad: tuple[float, float, float] = (3e-4, 3e-4, 3e-4)
    body_boresight: tuple[float, float, float] = (0, 1, 0)
    free_roll: bool = True
    pointing_reference: (
        Literal["instantaneous_zero_rate", "moving_boresight"] | None
    ) = None
    roll_rate_damping: bool = True
    bdot_gain_am2_s_t: float = Field(default=20000, ge=0)
    magnetic_unloading_enabled: bool = False
    magnetic_unloading_time_constant_s: float = Field(default=600, ge=1, le=1e7)
    actuator_heat_node_id: str = "bus"

    def rigid_body(self):
        return RigidBody(
            self.locked_inertia_kg_m2,
            tuple(w.spec for w in self.wheels if w.enabled),
            (
                self.magnetorquer.spec
                if self.magnetorquer and self.magnetorquer.enabled
                else None
            ),
        )

    @model_validator(mode="after")
    def physical_state(self):
        self.rigid_body()
        normalize_quaternion(self.initial_q_body_from_inertial_wxyz)
        validate_unit_vector(self.body_boresight)
        if self.pointing_reference == "moving_boresight" and not self.free_roll:
            raise ValueError("Moving boresight reference requires free_roll")
        PDConfig(self.proportional_nm_per_rad, self.derivative_nm_s_per_rad)
        if any(not math.isfinite(v) for v in self.initial_omega_body_rad_s):
            raise ValueError("Finite initial rates required")
        return self


class MissionWindow(MissionModel):
    window_id: str
    start_s: float = Field(ge=0)
    end_s: float = Field(gt=0)
    mode: Literal["sun_pointing", "ground_tracking", "imaging", "detumble"]
    target_latitude_deg: float | None = Field(default=None, ge=-90, le=90)
    target_longitude_deg: float | None = Field(default=None, ge=-180, le=180)

    @model_validator(mode="after")
    def interval(self):
        if self.end_s <= self.start_s:
            raise ValueError("Window must have positive duration")
        if (self.target_latitude_deg is None) != (self.target_longitude_deg is None):
            raise ValueError("Target latitude and longitude must be supplied together")
        return self


class MissionConops(MissionModel):
    auto_ground_tracking: bool = True
    ground_tracking_min_elevation_deg: float | None = Field(default=None, ge=0, le=89)
    default_mode: Literal["sun_pointing", "detumble"] = "sun_pointing"
    windows: tuple[MissionWindow, ...] = Field(default=(), max_length=256)


class PointingIntent(MissionModel):
    command_id: str = Field(min_length=1, max_length=128, strict=True)
    mode: Literal["auto", "sun_pointing", "ground_tracking", "imaging"]
    target_latitude_deg: float | None = Field(default=None, ge=-90, le=90, strict=True)
    target_longitude_deg: float | None = Field(default=None, ge=-180, le=180, strict=True)

    @model_validator(mode="after")
    def target_coordinates(self):
        if (self.target_latitude_deg is None) != (self.target_longitude_deg is None):
            raise ValueError("Pointing target latitude and longitude must be supplied together")
        if self.mode != "imaging" and self.target_latitude_deg is not None:
            raise ValueError("Only imaging commands accept target latitude and longitude")
        return self


class PointingCommand(PointingIntent):
    effective_time_s: float = Field(ge=0, strict=True)


class MissionSurface(MissionModel):
    surface_id: str
    thermal_node_id: str
    area_m2: float = Field(ge=0)
    normal_body: tuple[float, float, float]

    @model_validator(mode="after")
    def valid_normal(self):
        validate_unit_vector(self.normal_body)
        return self


class MissionModeLoads(MissionModel):
    mode: Literal["sun_pointing", "ground_tracking", "imaging", "detumble"]
    loads: tuple[ComponentLoad, ...] = Field(max_length=128)

    @model_validator(mode="after")
    def no_implicit_radio_actuators(self):
        ids = [load.component_id for load in self.loads]
        if len(set(ids)) != len(ids) or set(ids) & {"radio", "wheels", "magnetorquers"}:
            raise ValueError(
                "Unique mode loads required; radio and actuators are evaluated by mission"
            )
        return self


class MissionPower(MissionModel):
    panels: tuple[PVPanel, ...] = Field(max_length=128)
    battery: BatterySpec
    thermal: ThermalNetwork
    surfaces: tuple[MissionSurface, ...] = Field(max_length=256)
    mode_loads: tuple[MissionModeLoads, ...] = Field(min_length=4, max_length=4)
    regulator_efficiency: float = Field(default=0.92, gt=0, le=1)
    regulator_heat_node_id: str = "bus"
    storage_loss_heat_node_id: str = "bus"
    radio_heat_node_id: str = "radio"
    spacecraft_tx_electrical_w: float = Field(default=10, ge=0)
    spacecraft_receive_w: float = Field(default=1.5, ge=0)
    radio_idle_w: float = Field(default=0.5, ge=0)
    transmit_radiation_efficiency: float = Field(default=1, ge=0, le=1)
    analytical_efficiency_semantics: Literal["pattern_times_additional_v1"] | None = (
        None
    )
    solar_irradiance_w_m2: float = Field(default=1361, ge=0)
    earth_radius_m: float = Field(default=6371000, gt=0)
    earth_albedo: float = Field(default=0.3, ge=0, le=1)
    earth_outgoing_ir_w_m2: float = Field(default=237, ge=0)
    earth_quadrature_rings: int = Field(default=4, ge=2, le=16, strict=True)
    earth_quadrature_azimuths: int = Field(default=12, ge=4, le=64, strict=True)

    @model_serializer(mode="wrap")
    def preserve_legacy_efficiency_shape(self, handler):
        values = handler(self)
        if self.analytical_efficiency_semantics is None:
            values.pop("analytical_efficiency_semantics", None)
        return values

    @model_validator(mode="after")
    def topology(self):
        nodes = {node.node_id: node for node in self.thermal.nodes}
        if (
            self.battery.electrical is not None
            and self.battery.electrical.heat_node_id not in nodes
        ):
            raise ValueError(
                "Battery electrical heat destination must be an existing thermal node"
            )
        refs = {
            self.regulator_heat_node_id,
            self.storage_loss_heat_node_id,
            self.radio_heat_node_id,
            *[p.thermal_node_id for p in self.panels],
            *[s.thermal_node_id for s in self.surfaces],
            *[l.thermal_node_id for p in self.mode_loads for l in p.loads],
        }
        if not refs <= nodes.keys():
            raise ValueError("Power/surface heat nodes must exist")
        if {p.mode for p in self.mode_loads} != {
            "sun_pointing",
            "ground_tracking",
            "imaging",
            "detumble",
        } or len(self.mode_loads) != 4:
            raise ValueError("Exactly one load profile per implemented mode required")
        if len({p.panel_id for p in self.panels}) != len(self.panels):
            raise ValueError("PV IDs must be unique")
        for node_id, node in nodes.items():
            area = sum(s.area_m2 for s in self.surfaces if s.thermal_node_id == node_id)
            if abs(area - node.radiating_area_m2) > 1e-10:
                raise ValueError(
                    "Exterior surface areas must equal thermal radiating area for each node"
                )
        for panel in self.panels:
            if panel.self_visibility != 1:
                raise ValueError(
                    "Mission self-shadow fractions are unsupported; fixed unoccluded surfaces must have self_visibility=1"
                )
            aggregate = sum(
                p.active_area_m2
                for p in self.panels
                if p.thermal_node_id == panel.thermal_node_id
                and sum((a - b) ** 2 for a, b in zip(p.normal_body, panel.normal_body))
                < 1e-12
            )
            matching = sum(
                s.area_m2
                for s in self.surfaces
                if s.thermal_node_id == panel.thermal_node_id
                and sum((a - b) ** 2 for a, b in zip(s.normal_body, panel.normal_body))
                < 1e-12
            )
            if aggregate > matching + 1e-10:
                raise ValueError(
                    "PV footprint needs a corresponding exterior thermal surface"
                )
            if (
                abs(
                    panel.solar_absorptivity
                    - nodes[panel.thermal_node_id].solar_absorptivity
                )
                > 1e-10
            ):
                raise ValueError("PV and thermal-node solar absorptivity must agree")
        return self


class MissionScenario(MissionModel):
    schema_version: Literal["0.1.0"] = "0.1.0"
    name: str = "Provisional terminator mission"
    run_kind: Literal["single_pass", "targeted", "long_mission"] = "long_mission"
    duration_s: float = Field(default=86400, gt=0, le=2592000)
    orbit: MissionOrbit
    clocks: MissionClocks = MissionClocks()
    station: Station = Station()
    antenna_variant: Literal["dipole", "turnstile", "v45"] = "dipole"
    uplink: Link
    downlink: Link
    schedule: Schedule = Schedule()
    radio_delivery: RadioDeliveryConfig | None = None
    magnetic_model: Literal["igrf14_degree1", "igrf14_degree13"] | None = None
    spacecraft: MissionSpacecraft = MissionSpacecraft()
    conops: MissionConops = MissionConops()
    pointing_commands: tuple[PointingCommand, ...] | None = Field(default=None, max_length=128)
    stop_time_s: float | None = Field(default=None, ge=0, strict=True)
    power: MissionPower
    provenance: tuple[str, ...] = ()

    @property
    def epoch_utc(self):
        return self.orbit.elements.epoch_utc

    def identity(self):
        values = self.model_dump(mode="json")
        if self.pointing_commands is None:
            values.pop("pointing_commands", None)
        if self.stop_time_s is None:
            values.pop("stop_time_s", None)
        if self.conops.ground_tracking_min_elevation_deg is None:
            values["conops"].pop("ground_tracking_min_elevation_deg", None)
        if self.spacecraft.pointing_reference is None:
            values["spacecraft"].pop("pointing_reference", None)
        if self.radio_delivery is None:
            values.pop("radio_delivery", None)
        if self.magnetic_model is None:
            values.pop("magnetic_model", None)
        encoded = json.dumps(
            values,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
        digest = hashlib.sha256(encoded).hexdigest()
        return "mission-" + digest[:16], digest

    @model_validator(mode="after")
    def clock_boundaries(self):
        if self.power.analytical_efficiency_semantics is not None:
            from .rf.mission_efficiency import mission_downlink_efficiency

            mission_downlink_efficiency(self)
        if utc_datetime(self.epoch_utc) + timedelta(seconds=self.duration_s) > datetime(
            2030, 1, 1, tzinfo=timezone.utc
        ):
            raise ValueError(
                "Mission exceeds2030 endpoint of the magnetic reference forecast"
            )
        if any(
            w.enabled and w.spec.regenerative_efficiency > 0
            for w in self.spacecraft.wheels
        ):
            raise ValueError("Regenerative wheel storage coupling is not implemented")
        if self.orbit.ltan_hours_at_epoch is not None:
            from .orbit.elements import ltan_from_raan_hours
            from .mission.ephemeris import mean_sun_ra_deg

            expected = ltan_from_raan_hours(
                self.orbit.elements.raan_deg, mean_sun_ra_deg(self.epoch_utc)
            )
            error = ((self.orbit.ltan_hours_at_epoch - expected + 12) % 24) - 12
            if abs(error) > 1e-7:
                raise ValueError(
                    "LTAN metadata must match authoritative RAAN and UTC epoch; resolve orbit metadata before running"
                )
        dt = self.clocks.dynamics_step_s

        def ticks(value):
            count = value / dt
            if abs(count - round(count)) > 1e-8:
                raise ValueError(
                    "All clocks, slots, duration and window edges must be integer dynamics ticks"
                )
            return round(count)

        if dt * math.hypot(*self.spacecraft.initial_omega_body_rad_s) > 0.1:
            raise ValueError(
                "Initial angular displacement exceeds0.1rad per dynamics step; choose an explicit finer dynamics timestep"
            )
        count = ticks(self.duration_s)
        slot_durations = (
            (self.schedule.slot_duration_s,)
            if self.schedule.uplink_duration_s is None
            else (self.schedule.uplink_duration_s, self.schedule.downlink_duration_s)
        )
        strides = [
            ticks(v)
            for v in (
                self.clocks.controller_period_s,
                self.clocks.thermal_step_s,
                self.clocks.output_step_s,
                *slot_durations,
            )
        ]
        commands = self.pointing_commands or ()
        if len({command.command_id for command in commands}) != len(commands):
            raise ValueError("Pointing command IDs must be unique")
        previous_command_tick = -1
        canonical_commands = []
        for command in commands:
            command_tick = ticks(command.effective_time_s)
            if (command_tick > count or command_tick < previous_command_tick
                    or command_tick % strides[0]):
                raise ValueError("Pointing commands must be ordered within the mission on controller boundaries")
            canonical_commands.append(command.model_copy(update=dict(effective_time_s=command_tick * dt)))
            previous_command_tick = command_tick
        if self.pointing_commands is not None:
            object.__setattr__(self, "pointing_commands", tuple(canonical_commands))
        if self.stop_time_s is not None:
            stop_tick = ticks(self.stop_time_s)
            if stop_tick >= count:
                raise ValueError("Stop time must precede the requested mission horizon")
            object.__setattr__(self, "stop_time_s", stop_tick * dt)
        extended = self.duration_s > 604800
        if extended and self.run_kind != "long_mission":
            raise ValueError("Requests longer than seven days require long_mission")
        max_ticks = 3_000_000 if extended else 1_000_000
        if min(strides) < 1 or count > max_ticks or count // strides[2] > 20000:
            raise ValueError(
                f"Mission exceeds {max_ticks} dynamics ticks or 20000 output intervals; choose an explicit valid output clock without silently changing physics clocks"
            )
        if count % strides[2] or strides[2] % strides[1]:
            raise ValueError(
                "Output must divide duration and be a multiple of thermal step"
            )
        max_orbit_ticks = 6_000_000 if extended else 2_000_000
        if self.duration_s / (dt / self.clocks.orbit_substeps) > max_orbit_ticks:
            raise ValueError(f"Orbit exceeds {max_orbit_ticks} fixed substeps")
        windows = sorted(self.conops.windows, key=lambda w: w.start_s)
        for i, w in enumerate(windows):
            ticks(w.start_s)
            ticks(w.end_s)
            if w.end_s > self.duration_s or (i and w.start_s < windows[i - 1].end_s):
                raise ValueError("CONOPS windows must not overlap or exceed mission")
        nodes = {n.node_id for n in self.power.thermal.nodes}
        if self.spacecraft.actuator_heat_node_id not in nodes or (
            self.spacecraft.magnetorquer
            and self.spacecraft.magnetorquer.thermal_node_id not in nodes
        ):
            raise ValueError("Actuator heat destination must exist")
        mtq = self.spacecraft.magnetorquer
        if mtq and mtq.enabled and mtq.power_model == "unresolved":
            raise ValueError(
                "Coupled run requires explicit MTQ electrical-power model; disable MTQ or supply labeled example watts"
            )
        if self.power.spacecraft_tx_electrical_w + 1e-12 < self.downlink.tx_power_w:
            raise ValueError(
                "Onboard transmitter electrical input cannot be less than exported downlink RF"
            )
        return self


def mission_execution_limits(config):
    """Resource policy, not a numerical fidelity preset or completion estimate."""
    ticks = round(config.duration_s / config.clocks.dynamics_step_s)
    environments = config.duration_s / config.clocks.thermal_step_s
    work = (
        ticks * (1 + len(config.spacecraft.wheels) + config.clocks.orbit_substeps)
        + environments
        * len(config.power.surfaces)
        * config.power.earth_quadrature_rings
        * config.power.earth_quadrature_azimuths
    )
    extended = config.duration_s > 604800
    work_limit = 300_000_000 if extended else 100_000_000
    wall = (
        min(3600, max(180, math.ceil(ticks * 0.001 + work * 0.000001)))
        if config.duration_s > 86400
        else 180
    )
    return dict(
        policy="bounded_long_mission_v1",
        estimated_work_units=work,
        maximum_work_units=work_limit,
        worker_wall_limit_s=wall,
        maximum_dynamics_ticks=3_000_000 if extended else 1_000_000,
        maximum_orbit_substeps=6_000_000 if extended else 2_000_000,
        maximum_output_intervals=20000,
        live_output="bounded UTC day summaries; no sample streaming or resume",
    )

"""Validated power/CONOPS inputs; nominal energy is not a voltage or cell-life model."""

import math
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator, model_serializer
from ..thermal.models import ThermalNetwork


class PowerModel(BaseModel):
    model_config = ConfigDict(
        frozen=True, extra="forbid", allow_inf_nan=False, validate_default=True
    )


def unit_vector(value):
    if (
        len(value) != 3
        or any(not math.isfinite(v) for v in value)
        or abs(math.hypot(*value) - 1) > 1e-8
    ):
        raise ValueError("Direction/normal must have unit length within1e-8")
    return value


class PVPanel(PowerModel):
    panel_id: str = Field(min_length=1)
    thermal_node_id: str
    active_area_m2: float = Field(ge=0)
    normal_body: tuple[float, float, float]
    solar_absorptivity: float = Field(ge=0, le=1)
    efficiency: float = Field(default=0.29, ge=0, le=1)
    electrical_derate: float = Field(default=1, ge=0, le=1)
    self_visibility: float = Field(default=1, ge=0, le=1)
    enabled: bool = True

    @model_validator(mode="after")
    def physical_projection(self):
        unit_vector(self.normal_body)
        if self.efficiency * self.electrical_derate > self.solar_absorptivity:
            raise ValueError("PV extraction potential cannot exceed absorbed sunlight")
        return self


class CellConfiguration(PowerModel):
    cell_capacity_mah: float = Field(gt=0)
    cell_nominal_voltage_v: float = Field(gt=0)
    series_count: int = Field(gt=0, le=1000, strict=True)
    parallel_count: int = Field(gt=0, le=1000, strict=True)
    cell_model: str | None = None
    capacity_basis: str = (
        "nominal-voltage-times-charge estimate, not guaranteed usable energy"
    )


class BatteryElectricalSpec(PowerModel):
    model: Literal["ncr18650ga_linghu2019_rint"] = "ncr18650ga_linghu2019_rint"
    initial_soc: float = Field(default=0.5, ge=0, le=1)
    resistance_scale: float = Field(default=1, ge=0.1, le=100)
    cell_min_voltage_v: float = Field(default=2.5, ge=2.5, lt=4.179)
    cell_max_voltage_v: float = Field(default=4.2, gt=2.999, le=4.2)
    cell_max_charge_current_a: float = Field(default=1.475, ge=0, le=1.675)
    cell_max_discharge_current_a: float = Field(default=10, ge=0, le=10)
    charge_temperature_min_k: float = Field(default=283.15, ge=283.15, le=318.15)
    charge_temperature_max_k: float = Field(default=318.15, ge=283.15, le=318.15)
    discharge_temperature_min_k: float = Field(default=253.15, ge=253.15, le=333.15)
    discharge_temperature_max_k: float = Field(default=333.15, ge=253.15, le=333.15)
    heat_node_id: str = Field(default="battery", min_length=1)

    @model_validator(mode="after")
    def ordered_limits(self):
        if (
            self.cell_min_voltage_v >= self.cell_max_voltage_v
            or self.charge_temperature_min_k > self.charge_temperature_max_k
            or self.discharge_temperature_min_k > self.discharge_temperature_max_k
        ):
            raise ValueError("Battery voltage and temperature limits must be ordered")
        return self


class BatterySpec(PowerModel):
    electrical: BatteryElectricalSpec | None = None
    total_capacity_wh: float | None = Field(default=None, gt=0)
    cells: CellConfiguration | None = None
    initial_energy_fraction: float = Field(default=0.5, ge=0, le=1)
    charge_efficiency: float = Field(default=0.95, gt=0, le=1)
    discharge_efficiency: float = Field(default=0.9, gt=0, le=1)
    max_charge_bus_w: float = Field(default=10, ge=0)
    max_discharge_bus_w: float = Field(default=30, ge=0)

    @model_serializer(mode="wrap")
    def preserve_legacy_snapshot(self, handler):
        result = handler(self)
        if self.electrical is None:
            result.pop("electrical", None)
        return result

    @model_validator(mode="after")
    def one_capacity_basis(self):
        if (self.total_capacity_wh is None) == (self.cells is None):
            raise ValueError(
                "Specify exactly one of total_capacity_wh or explicit cell configuration"
            )
        if self.electrical is not None and (
            self.cells is None or self.cells.cell_model != "NCR18650GA"
        ):
            raise ValueError(
                "NCR18650GA electrical model requires explicit NCR18650GA cells"
            )
        estimate = (
            self.total_capacity_wh
            if self.total_capacity_wh is not None
            else self.cells.cell_capacity_mah
            / 1000
            * self.cells.cell_nominal_voltage_v
            * self.cells.series_count
            * self.cells.parallel_count
        )
        if not math.isfinite(estimate * 3600):
            raise ValueError("Battery capacity overflows finite joules")
        return self


class ComponentLoad(PowerModel):
    component_id: str = Field(min_length=1)
    thermal_node_id: str
    electrical_w: float = Field(ge=0)
    escaped_rf_w: float = Field(default=0, ge=0)
    other_export_w: float = Field(default=0, ge=0)
    stored_mechanical_w: float = Field(default=0, ge=0)

    @model_validator(mode="after")
    def energy_partition(self):
        if (
            self.escaped_rf_w + self.other_export_w + self.stored_mechanical_w
            > self.electrical_w + 1e-12
        ):
            raise ValueError("Load exports and storage cannot exceed electrical input")
        return self


class Stage(PowerModel):
    stage_id: str = Field(min_length=1)
    mode: Literal["sun_pointing", "ground_tracking", "imaging", "detumble"]
    start_s: float = Field(ge=0)
    end_s: float = Field(gt=0)
    sun_direction_body: tuple[float, float, float]
    loads: tuple[ComponentLoad, ...] = Field(default=(), max_length=128)

    @model_validator(mode="after")
    def valid_interval(self):
        if self.end_s <= self.start_s:
            raise ValueError("Stage end must follow start")
        unit_vector(self.sun_direction_body)
        if len({load.component_id for load in self.loads}) != len(self.loads):
            raise ValueError("Component IDs must be unique within each stage")
        return self


class EclipseWindow(PowerModel):
    start_s: float = Field(ge=0)
    end_s: float = Field(gt=0)
    sun_visibility: float = Field(default=0, ge=0, le=1)

    @model_validator(mode="after")
    def valid_interval(self):
        if self.end_s <= self.start_s:
            raise ValueError("Eclipse interval must have positive duration")
        return self


class NodeEnvironment(PowerModel):
    node_id: str
    solar_irradiance_w_m2: float = Field(default=0, ge=0)
    albedo_irradiance_w_m2: float = Field(default=0, ge=0)
    earth_ir_irradiance_w_m2: float = Field(
        default=0,
        ge=0,
        description="At-surface irradiance including geometry/view factor; not Earth OLR",
    )


class StudyConfig(PowerModel):
    schema_version: Literal["0.1.0"] = "0.1.0"
    name: str
    output_step_s: float = Field(default=5, gt=0)
    integration_step_s: float = Field(default=1, gt=0)
    solar_irradiance_w_m2: float = Field(default=1361, ge=0)
    panels: tuple[PVPanel, ...] = Field(max_length=128)
    battery: BatterySpec
    thermal: ThermalNetwork
    stages: tuple[Stage, ...] = Field(min_length=1, max_length=256)
    imaging_windows: tuple[Stage, ...] = Field(default=(), max_length=128)
    eclipse_windows: tuple[EclipseWindow, ...] = Field(default=(), max_length=256)
    environment: tuple[NodeEnvironment, ...] = Field(default=(), max_length=32)
    regulator_efficiency: float = Field(default=0.92, gt=0, le=1)
    regulator_heat_node_id: str
    storage_loss_heat_node_id: str
    provenance: tuple[str, ...] = ()

    @model_validator(mode="after")
    def complete_contract(self):
        if self.battery.electrical is not None:
            raise ValueError(
                "The electrical battery model is available in the coupled mission; standalone CONOPS study retains its energy-only model"
            )
        if self.stages[0].start_s != 0 or any(
            a.end_s != b.start_s for a, b in zip(self.stages, self.stages[1:])
        ):
            raise ValueError(
                "Base stages must cover one contiguous timeline beginning at0"
            )
        duration = self.stages[-1].end_s
        if (
            duration > 86400
            or math.ceil(duration / self.integration_step_s) > 100000
            or math.ceil(duration / self.output_step_s) > 7200
        ):
            raise ValueError(
                "Study exceeds86400s,100000 integration steps or7201 output samples"
            )
        nodes = {node.node_id: node for node in self.thermal.nodes}
        if (
            self.battery.electrical is not None
            and self.battery.electrical.heat_node_id not in nodes
        ):
            raise ValueError(
                "Battery electrical heat destination must be an existing thermal node"
            )
        if len(
            {stage.stage_id for stage in (*self.stages, *self.imaging_windows)}
        ) != len(self.stages) + len(self.imaging_windows):
            raise ValueError("Stage/window IDs must be unique")
        if len({panel.panel_id for panel in self.panels}) != len(self.panels):
            raise ValueError("PV panel IDs must be unique")
        if (
            self.regulator_heat_node_id not in nodes
            or self.storage_loss_heat_node_id not in nodes
        ):
            raise ValueError(
                "Converter/storage heat destinations must be existing thermal nodes"
            )
        for panel in self.panels:
            if (
                panel.thermal_node_id not in nodes
                or panel.solar_absorptivity
                != nodes[panel.thermal_node_id].solar_absorptivity
            ):
                raise ValueError(
                    "PV panel thermal node/solar absorptivity must match the thermal material"
                )
        component_nodes = {}
        for stage in (*self.stages, *self.imaging_windows):
            if stage.end_s > duration:
                raise ValueError("Manual window exceeds the base timeline")
            for load in stage.loads:
                if (
                    load.thermal_node_id not in nodes
                    or component_nodes.setdefault(
                        load.component_id, load.thermal_node_id
                    )
                    != load.thermal_node_id
                ):
                    raise ValueError(
                        "Load heat destinations must be existing and consistent per component"
                    )
        for windows in (self.imaging_windows, self.eclipse_windows):
            ordered = sorted(windows, key=lambda window: window.start_s)
            if any(a.end_s > b.start_s for a, b in zip(ordered, ordered[1:])) or any(
                window.end_s > duration for window in ordered
            ):
                raise ValueError(
                    "Manual windows may not overlap each other or exceed duration"
                )
        if any(stage.mode != "imaging" for stage in self.imaging_windows):
            raise ValueError("Imaging windows must use imaging mode")
        if len({env.node_id for env in self.environment}) != len(
            self.environment
        ) or any(env.node_id not in nodes for env in self.environment):
            raise ValueError("Environment records require unique existing node IDs")
        pv_nodes = {panel.thermal_node_id for panel in self.panels}
        if any(
            env.node_id in pv_nodes and env.solar_irradiance_w_m2 > 0
            for env in self.environment
        ):
            raise ValueError(
                "PV-node direct sunlight comes from panel geometry; put additional nonPV sunlight on a separate node"
            )
        return self

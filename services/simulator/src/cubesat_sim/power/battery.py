"""Nominal storage-energy ledger. No OCV, current, SoC, aging or cell-heat model."""

from dataclasses import dataclass
import math
from .models import BatterySpec, CellConfiguration


def nominal_pack_energy_wh(cells: CellConfiguration) -> float:
    return (
        cells.cell_capacity_mah
        / 1000
        * cells.cell_nominal_voltage_v
        * cells.series_count
        * cells.parallel_count
    )


def capacity_wh(spec: BatterySpec) -> float:
    return (
        spec.total_capacity_wh
        if spec.total_capacity_wh is not None
        else nominal_pack_energy_wh(spec.cells)
    )


def nominal_pack_voltage_v(spec: BatterySpec) -> float | None:
    return (
        spec.cells.cell_nominal_voltage_v * spec.cells.series_count
        if spec.cells
        else None
    )


@dataclass(frozen=True)
class BatteryStep:
    stored_energy_j: float
    generated_bus_used_w: float
    served_load_w: float
    unserved_load_w: float
    curtailed_bus_w: float
    charge_bus_w: float
    discharge_bus_w: float
    storage_loss_w: float
    chemical_energy_change_j: float
    closure_residual_j: float
    events: tuple[str, ...]


def advance_battery(
    spec: BatterySpec,
    stored_energy_j: float,
    generated_bus_w: float,
    requested_load_w: float,
    duration_s: float,
) -> BatteryStep:
    capacity = capacity_wh(spec) * 3600
    if (
        not all(
            math.isfinite(v)
            for v in (stored_energy_j, generated_bus_w, requested_load_w, duration_s)
        )
        or not 0 <= stored_energy_j <= capacity
        or min(generated_bus_w, requested_load_w) < 0
        or duration_s <= 0
    ):
        raise ValueError(
            "Valid stored energy, nonnegative powers and positive duration required"
        )
    net = generated_bus_w - requested_load_w
    charge = discharge = 0.0
    if net >= 0:
        charge = min(
            net,
            spec.max_charge_bus_w,
            (capacity - stored_energy_j) / (duration_s * spec.charge_efficiency),
        )
        served = requested_load_w
        used = served + charge
    else:
        discharge = min(
            -net,
            spec.max_discharge_bus_w,
            stored_energy_j * spec.discharge_efficiency / duration_s,
        )
        served = generated_bus_w + discharge
        used = generated_bus_w
    loss = charge * (1 - spec.charge_efficiency) + discharge * (
        1 / spec.discharge_efficiency - 1
    )
    change = duration_s * (
        charge * spec.charge_efficiency - discharge / spec.discharge_efficiency
    )
    energy = max(0.0, min(capacity, stored_energy_j + change))
    change = energy - stored_energy_j
    unserved, curtailed = max(0.0, requested_load_w - served), max(
        0.0, generated_bus_w - used
    )
    events = []
    if energy <= 1e-9:
        events.append("empty")
    if capacity - energy <= 1e-9:
        events.append("full")
    if unserved > 1e-12:
        events.append("unserved_load")
    if curtailed > 1e-12:
        events.append("curtailed_generation")
    residual = (used - served - loss) * duration_s - change
    return BatteryStep(
        energy,
        used,
        served,
        unserved,
        curtailed,
        charge,
        discharge,
        loss,
        change,
        residual,
        tuple(events),
    )

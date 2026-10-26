"""Resolve load edges inside one held-geometry mission dynamics interval.

Each segment advances the existing storage model before any time averaging.
This retains current-dependent resistive heat and cutoff checks. It introduces
no electrical bandwidth, converter, RC, thermal or mechanical substep model.
A rejected interval returns no state or ledger for a caller to commit.
"""

from collections.abc import Sequence
from dataclasses import dataclass, replace
import math

from .battery import BatteryStep, advance_battery
from .battery_electrical import (
    ElectricalBatteryStep,
    advance_electrical_battery,
    electrical_energy_j,
)
from .models import BatterySpec


@dataclass(frozen=True)
class BatteryLoadSegment:
    duration_s: float
    requested_load_w: float

    def __post_init__(self):
        if (
            any(
                type(value) not in (int, float) or not math.isfinite(value)
                for value in (self.duration_s, self.requested_load_w)
            )
            or self.duration_s <= 0
            or self.requested_load_w < 0
        ):
            raise ValueError(
                "Segments require positive finite duration and nonnegative load"
            )


@dataclass(frozen=True)
class SegmentedBatteryResult:
    accepted: bool
    battery: BatteryStep | ElectricalBatteryStep | None
    final_step: BatteryStep | ElectricalBatteryStep | None
    requested_load_w: float
    duration_s: float
    peak_unserved_load_w: float
    failed_segment_index: int | None


def advance_segmented_battery(
    spec: BatterySpec,
    *,
    stored_energy_j: float,
    soc: float | None,
    generated_bus_w: float,
    temperature_k: float,
    segments: Sequence[BatteryLoadSegment],
    duration_s: float | None = None,
) -> SegmentedBatteryResult:
    """Advance exact load segments with held PV potential and pack temperature.

    ``battery`` contains final stored energy/SOC and time-weighted interval
    flows. Electrical voltage, current and resistance are separate means;
    terminal power and ohmic heat are averaged directly from segment energies.
    ``final_step`` retains the actual last segment's means and endpoint state.
    Closure is summed in joules and chemical change is the endpoint difference.

    Any segment above the mission's existing 1e-9 W unserved-load tolerance
    rejects the entire interval. Peak unserved power covers attempted segments;
    no partial state, heat or energy ledger is returned on rejection.
    """
    segments = tuple(segments)
    if not segments or any(
        not isinstance(item, BatteryLoadSegment) for item in segments
    ):
        raise ValueError("At least one validated BatteryLoadSegment is required")
    total_duration = math.fsum(item.duration_s for item in segments)
    if not math.isfinite(total_duration):
        raise ValueError("Total segment duration must be finite")
    if duration_s is not None and (
        not math.isfinite(duration_s)
        or duration_s <= 0
        or not math.isclose(total_duration, duration_s, rel_tol=1e-12, abs_tol=1e-12)
    ):
        raise ValueError("Segments must cover the complete requested dynamics interval")
    if not math.isfinite(temperature_k) or temperature_k <= 0:
        raise ValueError("Held battery temperature must be positive and finite")
    if spec.electrical is not None:
        if soc is None:
            raise ValueError("Electrical segmentation requires initial SOC")
        expected_energy = electrical_energy_j(spec, soc)
        if not math.isfinite(stored_energy_j) or not math.isclose(
            stored_energy_j, expected_energy, rel_tol=1e-12, abs_tol=1e-8
        ):
            raise ValueError("Electrical stored energy must agree with initial SOC")
    requested = math.fsum(
        item.requested_load_w * (item.duration_s / total_duration) for item in segments
    )
    if not math.isfinite(requested):
        raise ValueError("Mean segment load must be finite")
    steps = []
    energy = stored_energy_j
    charge = soc
    peak_unserved = 0.0
    for index, item in enumerate(segments):
        step = (
            advance_electrical_battery(
                spec,
                charge,
                generated_bus_w,
                item.requested_load_w,
                item.duration_s,
                temperature_k,
            )
            if spec.electrical is not None
            else advance_battery(
                spec, energy, generated_bus_w, item.requested_load_w, item.duration_s
            )
        )
        peak_unserved = max(peak_unserved, step.unserved_load_w)
        if step.unserved_load_w > 1e-9:
            return SegmentedBatteryResult(
                False, None, None, requested, total_duration, peak_unserved, index
            )
        steps.append(step)
        energy = step.stored_energy_j
        if spec.electrical is not None:
            charge = step.soc
    final = steps[-1]
    if len(steps) == 1:
        return SegmentedBatteryResult(
            True,
            final,
            final,
            segments[0].requested_load_w,
            total_duration,
            peak_unserved,
            None,
        )

    def mean(field):
        return math.fsum(
            getattr(step, field) * (item.duration_s / total_duration)
            for item, step in zip(segments, steps)
        )

    averaged = {
        field: mean(field)
        for field in (
            "generated_bus_used_w",
            "served_load_w",
            "unserved_load_w",
            "curtailed_bus_w",
            "charge_bus_w",
            "discharge_bus_w",
            "storage_loss_w",
        )
    }
    if spec.electrical is not None:
        averaged.update(
            {
                field: mean(field)
                for field in (
                    "voltage_v",
                    "current_a",
                    "terminal_power_w",
                    "ohmic_heat_w",
                    "mean_resistance_ohm",
                )
            }
        )
        averaged["temperature_outside_reference"] = any(
            step.temperature_outside_reference for step in steps
        )
    battery = replace(
        final,
        **averaged,
        chemical_energy_change_j=energy - stored_energy_j,
        closure_residual_j=math.fsum(step.closure_residual_j for step in steps),
        events=tuple(dict.fromkeys(event for step in steps for event in step.events)),
    )
    return SegmentedBatteryResult(
        True, battery, final, requested, total_duration, peak_unserved, None
    )

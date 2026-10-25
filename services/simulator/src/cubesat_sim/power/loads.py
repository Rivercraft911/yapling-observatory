"""Explicit electrical input, escaped exports and local heat per component."""

from dataclasses import dataclass
from .models import ComponentLoad, StudyConfig


@dataclass(frozen=True)
class LoadLedger:
    electrical_w: float
    escaped_rf_w: float
    other_export_w: float
    stored_mechanical_w: float
    heat_w: float


def load_ledger(load: ComponentLoad, served_fraction: float = 1) -> LoadLedger:
    if not 0 <= served_fraction <= 1:
        raise ValueError("Served fraction must be within[0,1]")
    values = [
        load.electrical_w,
        load.escaped_rf_w,
        load.other_export_w,
        load.stored_mechanical_w,
    ]
    electrical, rf, exported, stored = (value * served_fraction for value in values)
    return LoadLedger(
        electrical, rf, exported, stored, electrical - rf - exported - stored
    )


def resolved_stage(config: StudyConfig, time_s: float):
    duration = config.stages[-1].end_s
    if not 0 <= time_s <= duration:
        raise ValueError("Time is outside the CONOPS timeline")
    stage = next(
        (stage for stage in config.stages if stage.start_s <= time_s < stage.end_s),
        config.stages[-1],
    )
    imaging = next(
        (
            window
            for window in config.imaging_windows
            if window.start_s <= time_s < window.end_s
        ),
        None,
    )
    loads = {load.component_id: load for load in stage.loads}
    if imaging:
        loads.update((load.component_id, load) for load in imaging.loads)
    return imaging or stage, tuple(loads.values())


def solar_visibility(config: StudyConfig, time_s: float):
    return next(
        (
            window.sun_visibility
            for window in config.eclipse_windows
            if window.start_s <= time_s < window.end_s
        ),
        1.0,
    )

"""Balanced identical-cell, fixed-25degC OCV + steady-resistance reference.

Positive current leaves the pack. The source's two polarization branches are
replaced by their DC resistances, so this model has no relaxation state. All
resistive loss is assigned immediately as heat; no RC or entropic heat is claimed.
"""

from bisect import bisect_right
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path

from .battery import BatteryStep
from .models import BatteryElectricalSpec, BatterySpec

MODEL_VERSION = "ncr18650ga-linghu2019-steady-rint-0.1.0"
DATA_PATH = Path(__file__).with_name("ncr18650ga_linghu2019.json")
DATA = json.loads(DATA_PATH.read_text())
_ROWS = tuple(reversed(DATA["rows"]))
_SOC = tuple(row[0] / 100 for row in _ROWS)
_OCV = tuple(row[1] for row in _ROWS)
_RESISTANCE = tuple((row[2] + row[3] + row[5]) / 1000 for row in _ROWS)
if (
    DATA["cell_model"] != "NCR18650GA"
    or len(_SOC) != 21
    or _SOC[0] != 0
    or _SOC[-1] != 1
    or any(a >= b for a, b in zip(_SOC, _SOC[1:]))
    or any(a >= b for a, b in zip(_OCV, _OCV[1:]))
    or any(not math.isfinite(v) or v <= 0 for v in (*_OCV, *_RESISTANCE))
):
    raise ValueError("Invalid bundled NCR18650GA parameter table")


def electrical_defaults():
    return BatteryElectricalSpec().model_dump(mode="json")


def electrical_model_metadata():
    return dict(
        model_version=MODEL_VERSION,
        label="NCR18650GA 25°C steady DC reference",
        profile_id=DATA["profile_id"],
        profile_sha256=hashlib.sha256(DATA_PATH.read_bytes()).hexdigest(),
        reference_temperature_k=DATA["reference_temperature_k"],
        reference_temperature_tolerance_k=DATA["reference_temperature_tolerance_k"],
        reference_capacity_ah=DATA["reference_capacity_ah"],
        sources=DATA["sources"],
        limits=[
            "Published exact-cell reference at 25±1°C, not a calibrated spacecraft pack. No statistical uncertainty bound is available.",
            "OCV is linearly interpolated from Table 1: average charge/discharge relaxed potentials, 30min rest; endpoints 5h. It omits hysteresis.",
            "R=R0+Rp1+Rp2 is the published ECM steady DC sum, multiplied by the explicit resistance_scale assumption. No RC memory, pulse relaxation or transient accuracy is represented.",
            "OCV/resistance/capacity remain fixed at the 25°C reference outside its test interval. Temperature telemetry and operating gates do not validate cold/hot electrical predictions.",
            "Identical balanced cells share current equally. Wiring, protection, converters between battery and common bus, aging, self-discharge and reversible entropic heat are omitted.",
            "Bus and battery terminals share an ideal reference plane. Existing charge/discharge efficiencies are ignored here; resistance supplies the complete modeled storage loss.",
            "Default 1.475A/cell charge cap is the manufacturer standard procedure, not a maximum rating; the allowed upper edit 1.675A matches the paper's 0.5C characterization procedure. User limits may be tightened within the checked voltage/temperature/current envelope.",
            "Editing cell charge capacity uniformly rescales the published 3.35Ah SOC axis; it does not identify an aged or cold OCV/resistance surface or validate that capacity at the requested current.",
            "Stored energy is Qpack times the OCV integral above SOC0, distinct from nominal-voltage energy and from terminal energy available before a load-dependent cutoff.",
        ],
        equations=dict(
            scaling="Qpack=Np*Qcell; Uoc_pack=Ns*Uoc_cell; Rpack=Ns/Np*Rcell",
            state="dz/dt=-I/Qpack; positive I discharges",
            energy="E(z)=Ns*Np*Qcell*integral_0^z Uoc_cell(s) ds",
            terminal="V=Uoc-I*R; Pterminal=I*V; Qheat=I^2*R",
            integration="I held over each dynamics interval; exact piecewise-linear means of Uoc and R over traversed SOC; terminal voltage limits checked at both endpoints and every crossed knot",
        ),
    )


def _check_soc(soc):
    if not math.isfinite(soc) or not 0 <= soc <= 1:
        raise ValueError("SOC must be finite and within [0,1]")


def _interpolate(values, soc):
    index = max(0, min(len(_SOC) - 2, bisect_right(_SOC, soc) - 1))
    fraction = (soc - _SOC[index]) / (_SOC[index + 1] - _SOC[index])
    return values[index] + fraction * (values[index + 1] - values[index])


def _integral(values, start, end):
    if start == end:
        return 0.0
    if start > end:
        return -_integral(values, end, start)
    cuts = [start, *[s for s in _SOC if start < s < end], end]
    return math.fsum(
        (b - a) * (_interpolate(values, a) + _interpolate(values, b)) / 2
        for a, b in zip(cuts, cuts[1:])
    )


def _mean(values, start, end):
    return (
        _integral(values, start, end) / (end - start)
        if start != end
        else _interpolate(values, start)
    )


def _configuration(spec):
    if spec.electrical is None or spec.cells is None:
        raise ValueError("Enabled electrical model and explicit cells are required")
    return spec.cells, spec.electrical


def pack_charge_capacity_c(spec):
    cells, _ = _configuration(spec)
    return cells.parallel_count * cells.cell_capacity_mah * 3.6


def electrical_energy_j(spec, soc):
    _check_soc(soc)
    cells, _ = _configuration(spec)
    return cells.series_count * pack_charge_capacity_c(spec) * _integral(_OCV, 0, soc)


def electrical_state(spec, soc):
    _check_soc(soc)
    cells, model = _configuration(spec)
    return dict(
        battery_soc=soc,
        battery_remaining_charge_ah=pack_charge_capacity_c(spec) * soc / 3600,
        battery_open_circuit_voltage_v=cells.series_count * _interpolate(_OCV, soc),
        battery_resistance_ohm=cells.series_count
        / cells.parallel_count
        * model.resistance_scale
        * _interpolate(_RESISTANCE, soc),
    )


@dataclass(frozen=True)
class ElectricalBatteryStep(BatteryStep):
    soc: float
    voltage_v: float
    current_a: float
    terminal_power_w: float
    ohmic_heat_w: float
    mean_resistance_ohm: float
    temperature_outside_reference: bool


def advance_electrical_battery(
    spec: BatterySpec, soc, generated_bus_w, requested_load_w, duration_s, temperature_k
):
    cells, model = _configuration(spec)
    _check_soc(soc)
    if (
        not all(
            math.isfinite(v)
            for v in (generated_bus_w, requested_load_w, duration_s, temperature_k)
        )
        or min(generated_bus_w, requested_load_w) < 0
        or duration_s <= 0
        or temperature_k <= 0
    ):
        raise ValueError(
            "Finite nonnegative powers, positive duration and temperature required"
        )
    charge_capacity = pack_charge_capacity_c(spec)
    scale_r = cells.series_count / cells.parallel_count * model.resistance_scale
    net = requested_load_w - generated_bus_w
    discharge = net > 0
    sign = 1 if discharge else -1
    allowed_temperature = (
        model.discharge_temperature_min_k
        <= temperature_k
        <= model.discharge_temperature_max_k
        if discharge
        else model.charge_temperature_min_k
        <= temperature_k
        <= model.charge_temperature_max_k
    )
    current_limit = (
        min(
            cells.parallel_count
            * (
                model.cell_max_discharge_current_a
                if discharge
                else model.cell_max_charge_current_a
            ),
            charge_capacity * (soc if discharge else 1 - soc) / duration_s,
        )
        if allowed_temperature
        else 0.0
    )

    def interval(current):
        final_soc = max(0.0, min(1.0, soc - current * duration_s / charge_capacity))
        mean_ocv = cells.series_count * _mean(_OCV, soc, final_soc)
        mean_r = scale_r * _mean(_RESISTANCE, soc, final_soc)
        mean_v = mean_ocv - current * mean_r
        return final_soc, mean_v, mean_r

    def voltage_feasible(magnitude):
        current = sign * magnitude
        final_soc = max(0.0, min(1.0, soc - current * duration_s / charge_capacity))
        lo, hi = sorted((soc, final_soc))
        checks = (soc, final_soc, *[s for s in _SOC if lo < s < hi])
        for point in checks:
            voltage = cells.series_count * _interpolate(
                _OCV, point
            ) - current * scale_r * _interpolate(_RESISTANCE, point)
            if discharge and voltage < cells.series_count * model.cell_min_voltage_v:
                return False
            if (
                not discharge
                and voltage > cells.series_count * model.cell_max_voltage_v
            ):
                return False
        return True

    if not voltage_feasible(0):
        current_limit = 0.0
    elif not voltage_feasible(current_limit):
        low, high = 0.0, current_limit
        for _ in range(48):
            middle = (low + high) / 2
            if voltage_feasible(middle):
                low = middle
            else:
                high = middle
        current_limit = low

    def magnitude_power(magnitude):
        _, voltage, _ = interval(sign * magnitude)
        return magnitude * voltage

    power_limit = min(
        abs(net), spec.max_discharge_bus_w if discharge else spec.max_charge_bus_w
    )
    available_power = magnitude_power(current_limit)
    if available_power > power_limit:
        low, high = 0.0, current_limit
        # Valid discharge voltages exceed half the maximum tabulated OCV. This
        # makes interval-mean terminal power strictly increasing on this branch.
        for _ in range(48):
            middle = (low + high) / 2
            if magnitude_power(middle) <= power_limit:
                low = middle
            else:
                high = middle
        current_limit = (low + high) / 2
    current = sign * current_limit if net != 0 else 0.0
    final_soc, voltage, mean_r = interval(current)
    terminal = current * voltage
    ohmic = current * current * mean_r
    charge = max(0.0, -terminal)
    discharge_w = max(0.0, terminal)
    served = (
        requested_load_w
        if net <= 0
        else min(requested_load_w, generated_bus_w + discharge_w)
    )
    used = min(generated_bus_w, served + charge)
    unserved = max(0.0, requested_load_w - served)
    curtailed = max(0.0, generated_bus_w - used)
    energy0 = electrical_energy_j(spec, soc)
    energy = electrical_energy_j(spec, final_soc)
    change = energy - energy0
    events = []
    if final_soc == 0:
        events.append("empty")
    if final_soc == 1:
        events.append("full")
    if not allowed_temperature and net != 0:
        events.append(
            "discharge_temperature_limit" if net > 0 else "charge_temperature_limit"
        )
    if unserved > 1e-9:
        events.append("unserved_load")
    if curtailed > 1e-9:
        events.append("curtailed_generation")
    return ElectricalBatteryStep(
        stored_energy_j=energy,
        generated_bus_used_w=used,
        served_load_w=served,
        unserved_load_w=unserved,
        curtailed_bus_w=curtailed,
        charge_bus_w=charge,
        discharge_bus_w=discharge_w,
        storage_loss_w=ohmic,
        chemical_energy_change_j=change,
        closure_residual_j=(used - served - ohmic) * duration_s - change,
        events=tuple(events),
        soc=final_soc,
        voltage_v=voltage,
        current_a=current,
        terminal_power_w=terminal,
        ohmic_heat_w=ohmic,
        mean_resistance_ohm=mean_r,
        temperature_outside_reference=abs(
            temperature_k - DATA["reference_temperature_k"]
        )
        > DATA["reference_temperature_tolerance_k"],
    )

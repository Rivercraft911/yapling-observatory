"""Burst energy/current invariants and atomic common-interval brownout policy."""

import math

import pytest

from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.power.battery import advance_battery
from cubesat_sim.power.battery_electrical import (
    advance_electrical_battery,
    electrical_energy_j,
)
from cubesat_sim.power.models import BatterySpec
from cubesat_sim.power.segmented import BatteryLoadSegment, advance_segmented_battery


def setup(electrical=True, **changes):
    values = default_mission_scenario().power.battery.model_dump(mode="json") | changes
    if not electrical:
        values.pop("electrical", None)
    spec = BatterySpec.model_validate(values)
    soc = 0.5 if electrical else None
    energy = electrical_energy_j(spec, soc) if electrical else 100000.0
    return spec, soc, energy


def run(spec, soc, energy, segments, generated=0, temperature=298.15, **kwargs):
    return advance_segmented_battery(
        spec,
        stored_energy_j=energy,
        soc=soc,
        generated_bus_w=generated,
        temperature_k=temperature,
        segments=segments,
        **kwargs,
    )


@pytest.mark.parametrize("electrical", [False, True])
def test_single_segment_preserves_original_step_exactly(electrical):
    spec, soc, energy = setup(electrical)
    actual = run(
        spec, soc, energy, [BatteryLoadSegment(0.8, 13)], generated=4, duration_s=0.8
    )
    expected = (
        advance_electrical_battery(spec, soc, 4, 13, 0.8, 298.15)
        if electrical
        else advance_battery(spec, energy, 4, 13, 0.8)
    )
    assert actual.accepted
    assert actual.battery == actual.final_step == expected
    assert actual.duration_s == 0.8 and actual.requested_load_w == 13
    assert actual.failed_segment_index is None


def test_exact_burst_heat_exceeds_mean_load_prediction_and_preserves_charge_energy():
    spec, soc, energy = setup()
    segments = [BatteryLoadSegment(0.9, 1), BatteryLoadSegment(0.1, 25)]
    result = run(spec, soc, energy, segments, generated=2, duration_s=1)
    a = advance_electrical_battery(spec, soc, 2, 1, 0.9, 298.15)
    b = advance_electrical_battery(spec, a.soc, 2, 25, 0.1, 298.15)
    mean_load = advance_electrical_battery(spec, soc, 2, 3.4, 1, 298.15)
    step = result.battery
    assert result.accepted and result.final_step == b
    assert step.stored_energy_j == b.stored_energy_j and step.soc == b.soc
    assert step.chemical_energy_change_j == b.stored_energy_j - energy
    assert step.voltage_v == pytest.approx(0.9 * a.voltage_v + 0.1 * b.voltage_v)
    assert step.current_a == pytest.approx(0.9 * a.current_a + 0.1 * b.current_a)
    assert step.mean_resistance_ohm == pytest.approx(
        0.9 * a.mean_resistance_ohm + 0.1 * b.mean_resistance_ohm
    )
    assert step.terminal_power_w == pytest.approx(
        0.9 * a.terminal_power_w + 0.1 * b.terminal_power_w
    )
    assert step.ohmic_heat_w == pytest.approx(
        0.9 * a.ohmic_heat_w + 0.1 * b.ohmic_heat_w
    )
    assert step.ohmic_heat_w > 10 * mean_load.ohmic_heat_w
    assert abs(step.ohmic_heat_w - step.current_a**2 * step.mean_resistance_ohm) > 0.01
    assert step.storage_loss_w == step.ohmic_heat_w
    assert step.charge_bus_w > 0 and step.discharge_bus_w > 0
    assert step.closure_residual_j == math.fsum(
        [a.closure_residual_j, b.closure_residual_j]
    )
    assert (
        abs(
            (step.generated_bus_used_w - step.served_load_w - step.storage_loss_w)
            - step.chemical_energy_change_j
        )
        < 1e-8
    )
    # Coulomb counting uses mean current, even when the interval changes current sign.
    charge_c = spec.cells.cell_capacity_mah * 3.6 * spec.cells.parallel_count
    assert (soc - step.soc) * charge_c == pytest.approx(step.current_a, abs=1e-11)


@pytest.mark.parametrize("electrical", [False, True])
def test_short_unserved_peak_rejects_whole_interval_even_when_mean_power_is_feasible(
    electrical,
):
    spec, soc, energy = setup(electrical, max_discharge_bus_w=5)
    segments = [BatteryLoadSegment(0.9999, 4), BatteryLoadSegment(0.0001, 6)]
    result = run(spec, soc, energy, segments)
    assert not result.accepted
    assert result.failed_segment_index == 1
    assert result.peak_unserved_load_w == pytest.approx(1, abs=1e-11)
    assert result.battery is None and result.final_step is None
    assert result.requested_load_w < 5
    mean_step = (
        advance_electrical_battery(spec, soc, 0, result.requested_load_w, 1, 298.15)
        if electrical
        else advance_battery(spec, energy, 0, result.requested_load_w, 1)
    )
    assert mean_step.unserved_load_w < 1e-9
    # No state object can be committed from the preceding successful substep.
    assert energy == (electrical_energy_j(spec, soc) if electrical else 100000.0)


def test_held_cold_charge_gate_curtailed_first_segment_does_not_block_later_discharge():
    spec, soc, energy = setup()
    result = run(
        spec,
        soc,
        energy,
        [BatteryLoadSegment(0.6, 1), BatteryLoadSegment(0.4, 12)],
        generated=5,
        temperature=280,
    )
    assert result.accepted
    assert result.battery.soc < soc
    assert result.battery.curtailed_bus_w == pytest.approx(4 * 0.6)
    assert result.battery.charge_bus_w == 0
    assert result.battery.discharge_bus_w == pytest.approx(7 * 0.4)
    assert "charge_temperature_limit" in result.battery.events
    assert result.battery.temperature_outside_reference
    residual = (
        result.battery.generated_bus_used_w
        - result.battery.served_load_w
        - result.battery.storage_loss_w
    ) - result.battery.chemical_energy_change_j
    assert abs(residual) < 1e-8


def test_multiple_legacy_segments_preserve_energy_ledger_and_final_step():
    spec, soc, energy = setup(False)
    a = advance_battery(spec, energy, 8, 2, 0.3)
    b = advance_battery(spec, a.stored_energy_j, 8, 12, 0.7)
    result = run(
        spec,
        soc,
        energy,
        [BatteryLoadSegment(0.3, 2), BatteryLoadSegment(0.7, 12)],
        generated=8,
    )
    assert result.accepted and result.final_step == b
    assert result.battery.stored_energy_j == b.stored_energy_j
    assert result.battery.chemical_energy_change_j == b.stored_energy_j - energy
    assert result.battery.storage_loss_w == pytest.approx(
        a.storage_loss_w * 0.3 + b.storage_loss_w * 0.7
    )
    assert abs(result.battery.closure_residual_j) < 1e-8


@pytest.mark.parametrize(
    "duration,load",
    [
        (0, 1),
        (-1, 1),
        (float("nan"), 1),
        (float("inf"), 1),
        (1, -1),
        (1, float("inf")),
        (True, 1),
    ],
)
def test_segment_validation(duration, load):
    with pytest.raises(ValueError):
        BatteryLoadSegment(duration, load)


def test_empty_incomplete_interval_and_inconsistent_electrical_state_are_rejected():
    spec, soc, energy = setup()
    with pytest.raises(ValueError, match="At least one"):
        run(spec, soc, energy, [])
    with pytest.raises(ValueError, match="complete requested"):
        run(spec, soc, energy, [BatteryLoadSegment(0.5, 1)], duration_s=1)
    with pytest.raises(ValueError, match="agree with initial SOC"):
        run(spec, soc, energy + 1, [BatteryLoadSegment(1, 1)])
    with pytest.raises(ValueError, match="initial SOC"):
        run(spec, None, energy, [BatteryLoadSegment(1, 1)])

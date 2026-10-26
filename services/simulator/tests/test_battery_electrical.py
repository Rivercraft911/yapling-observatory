from copy import deepcopy
import math

import pytest
from pydantic import ValidationError

from cubesat_sim.power.models import BatterySpec, BatteryElectricalSpec, StudyConfig
from cubesat_sim.power.battery import advance_battery
from cubesat_sim.power import battery_electrical as model
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.mission.driver import run_mission


def spec(**electrical):
    return BatterySpec.model_validate(
        dict(
            cells=dict(
                cell_capacity_mah=3350,
                cell_nominal_voltage_v=3.6,
                series_count=2,
                parallel_count=2,
                cell_model="NCR18650GA",
            ),
            max_charge_bus_w=1000,
            max_discharge_bus_w=1000,
            electrical=model.electrical_defaults() | electrical,
        )
    )


def test_exact_published_table_points_pack_scaling_and_reference_integral():
    b = spec()
    state = model.electrical_state(b, 0.5082)
    assert state["battery_open_circuit_voltage_v"] == pytest.approx(2 * 3.736)
    assert state["battery_resistance_ohm"] == pytest.approx(
        (31.87 + 21.59 + 4.51) / 1000
    )
    assert state["battery_remaining_charge_ah"] == pytest.approx(6.7 * 0.5082)
    assert len(model.DATA["rows"]) == 21
    rows = list(reversed(model.DATA["rows"]))
    expected = (
        sum((b[0] - a[0]) / 100 * (a[1] + b[1]) / 2 for a, b in zip(rows, rows[1:]))
        * 4
        * 3.35
        * 3600
    )
    assert model.electrical_energy_j(b, 1) == pytest.approx(expected)
    assert expected / 3600 == pytest.approx(49.88826767)
    one = spec().model_dump(mode="json")
    one["cells"]["series_count"] = 1
    one["cells"]["parallel_count"] = 1
    one = BatterySpec.model_validate(one)
    single = model.electrical_state(one, 0.5082)
    assert (
        state["battery_open_circuit_voltage_v"]
        == 2 * single["battery_open_circuit_voltage_v"]
    )
    assert state["battery_resistance_ohm"] == single["battery_resistance_ohm"]
    assert model.electrical_energy_j(b, 1) == 4 * model.electrical_energy_j(one, 1)


@pytest.mark.parametrize("generation,load,sign", [(0, 10, 1), (10, 0, -1)])
def test_constant_ocv_thevenin_reference_quadratic_and_energy(
    monkeypatch, generation, load, sign
):
    monkeypatch.setattr(model, "_OCV", (3.6,) * 21)
    monkeypatch.setattr(model, "_RESISTANCE", (0.05,) * 21)
    b = spec()
    result = model.advance_electrical_battery(b, 0.5, generation, load, 10, 298.15)
    # Independent small-current root of P=I(U-IR), with positive discharge.
    signed_power = sign * 10
    expected = (2 * signed_power) / (7.2 + math.sqrt(7.2**2 - 4 * 0.05 * signed_power))
    assert result.current_a == pytest.approx(expected, abs=1e-12)
    assert result.voltage_v == pytest.approx(7.2 - expected * 0.05)
    assert result.soc == pytest.approx(0.5 - expected * 10 / (6.7 * 3600))
    assert result.ohmic_heat_w == pytest.approx(expected**2 * 0.05)
    assert result.chemical_energy_change_j == pytest.approx(
        -expected * 7.2 * 10, abs=3e-11
    )
    assert abs(result.closure_residual_j) < 5e-11
    assert result.current_a * result.voltage_v == pytest.approx(signed_power)


@pytest.mark.parametrize(
    "soc,generation,load",
    [(0.01, 0, 1000), (0.99, 1000, 0), (0.5, 0, 1000), (0.5, 1000, 0)],
)
def test_voltage_current_charge_bounds_and_limited_power(soc, generation, load):
    b = spec(resistance_scale=3)
    result = model.advance_electrical_battery(b, soc, generation, load, 600, 298.15)
    assert 0 <= result.soc <= 1
    assert abs(result.current_a) <= 2 * (10 if load else 1.475) + 1e-10
    low, high = sorted((soc, result.soc))
    points = [
        soc,
        result.soc,
        *[row[0] / 100 for row in model.DATA["rows"] if low < row[0] / 100 < high],
    ]
    for z in points:
        state = model.electrical_state(b, z)
        voltage = (
            state["battery_open_circuit_voltage_v"]
            - result.current_a * state["battery_resistance_ohm"]
        )
        assert voltage >= 5 - 1e-10 if load else voltage <= 8.4 + 1e-10
    assert abs(result.closure_residual_j) < 1e-8
    assert result.unserved_load_w > 0 if load else result.curtailed_bus_w > 0
    assert result.ohmic_heat_w >= 0


def test_empty_full_coulomb_exhaustion_and_temperature_gates():
    b = spec()
    empty = model.advance_electrical_battery(b, 0, 0, 1, 10, 298.15)
    full = model.advance_electrical_battery(b, 1, 1, 0, 10, 298.15)
    assert empty.current_a == full.current_a == 0
    assert empty.soc == 0 and full.soc == 1
    # Warm 25degC source parameters stay fixed; temperature only gates operation.
    warm = model.advance_electrical_battery(b, 0.5, 0, 1, 10, 303.15)
    ref = model.advance_electrical_battery(b, 0.5, 0, 1, 10, 298.15)
    assert warm.temperature_outside_reference
    assert warm.current_a == ref.current_a
    assert warm.ohmic_heat_w == ref.ohmic_heat_w
    cold_charge = model.advance_electrical_battery(b, 0.5, 10, 0, 10, 278.15)
    cold_discharge = model.advance_electrical_battery(b, 0.5, 0, 10, 10, 250)
    assert cold_charge.current_a == cold_discharge.current_a == 0
    assert "charge_temperature_limit" in cold_charge.events
    assert "discharge_temperature_limit" in cold_discharge.events
    exhausted = model.advance_electrical_battery(b, 0.00001, 0, 1, 1000, 298.15)
    assert exhausted.soc == 0
    assert exhausted.current_a * 1000 == pytest.approx(0.00001 * 6.7 * 3600)
    assert exhausted.unserved_load_w > 0


def test_efficiencies_are_ignored_only_when_reference_enabled_and_off_snapshot_unchanged():
    b = spec()
    data = b.model_dump(mode="json")
    data["charge_efficiency"] = 0.2
    data["discharge_efficiency"] = 0.3
    changed = BatterySpec.model_validate(data)
    assert model.advance_electrical_battery(
        b, 0.5, 0, 10, 10, 298.15
    ) == model.advance_electrical_battery(changed, 0.5, 0, 10, 10, 298.15)
    del data["electrical"]
    legacy = BatterySpec.model_validate(data)
    assert "electrical" not in legacy.model_dump(mode="json")
    assert legacy.model_dump(mode="json") == data
    step = advance_battery(legacy, 10000, 0, 10, 10)
    assert step.stored_energy_j == 10000 - 100 / 0.3
    assert step.storage_loss_w == 10 * (1 / 0.3 - 1)


def test_limits_cell_identity_and_standalone_study_guard():
    for update in [
        dict(cell_min_voltage_v=2),
        dict(cell_max_voltage_v=4.3),
        dict(cell_max_discharge_current_a=10.1),
        dict(charge_temperature_min_k=270),
        dict(charge_temperature_min_k=318, charge_temperature_max_k=300),
    ]:
        with pytest.raises(ValidationError):
            spec(**update)
    data = spec().model_dump(mode="json")
    data["cells"]["cell_model"] = "NCR18650B"
    with pytest.raises(ValidationError):
        BatterySpec.model_validate(data)
    from cubesat_sim.power.study import default_study_config

    study = default_study_config().model_dump(mode="json")
    study["battery"]["electrical"] = model.electrical_defaults()
    with pytest.raises(ValidationError, match="coupled mission"):
        StudyConfig.model_validate(study)


def isolated_mission(duration=60):
    data = default_mission_scenario().model_dump(mode="json")
    data["duration_s"] = duration
    data["power"]["battery"]["electrical"] = model.electrical_defaults()
    data["spacecraft"]["wheels"] = []
    data["spacecraft"]["magnetorquer"] = None
    data["spacecraft"]["controller"] = "coast"
    data["power"]["panels"] = []
    data["power"]["surfaces"] = []
    data["power"]["radio_idle_w"] = 0
    data["power"]["thermal"]["conductive_links"] = []
    data["power"]["thermal"]["radiative_links"] = []
    for node in data["power"]["thermal"]["nodes"]:
        node["radiating_area_m2"] = 0
        node["initial_temperature_k"] = 298.15
    for profile in data["power"]["mode_loads"]:
        profile["loads"] = [
            dict(component_id="test", thermal_node_id="bus", electrical_w=10)
        ]
    data["conops"]["auto_ground_tracking"] = False
    return data


def test_mission_routes_ohmic_heat_to_battery_and_conserves_total_energy():
    data = isolated_mission()
    result = run_mission(MissionScenario.model_validate(data))
    samples = result["samples"]
    battery_node = next(
        node
        for node in data["power"]["thermal"]["nodes"]
        if node["node_id"] == "battery"
    )
    delta_temperature = samples["thermal"]["node_temperature_k"]["battery"][-1] - 298.15
    assert battery_node["heat_capacity_j_k"] * delta_temperature == pytest.approx(
        result["summary"]["energy_j"]["storage_loss_j"], abs=1e-9
    )
    assert result["summary"]["computed_duration_s"] == 60
    assert abs(result["summary"]["energy_j"]["closure_residual_j"]) < 1e-8
    assert all(i > 0 for i in samples["power"]["battery_current_a"])
    assert samples["power"]["battery_soc"][-1] < 0.5
    assert samples["power"]["energy_fraction"][0] != 0.5
    assert (
        result["manifest"]["battery_electrical"]["profile_id"]
        == model.DATA["profile_id"]
    )
    assert not any(
        "No cellOCV" in warning for warning in result["manifest"]["warnings"]
    )
    changed = deepcopy(data)
    changed["power"]["battery"]["charge_efficiency"] = 0.1
    changed["power"]["battery"]["discharge_efficiency"] = 0.1
    another = run_mission(MissionScenario.model_validate(changed))
    assert samples == another["samples"]


def test_constant_power_interval_refinement_converges():
    b = spec()
    values = []
    for dt in [20, 10, 5]:
        z = 0.5
        heat = 0.0
        residual = 0.0
        for _ in range(round(600 / dt)):
            result = model.advance_electrical_battery(b, z, 0, 10, dt, 298.15)
            z = result.soc
            heat += result.ohmic_heat_w * dt
            residual += result.closure_residual_j
        values.append((z, heat))
        assert abs(residual) < 2e-8
    assert abs(values[0][0] - values[1][0]) > 3.8 * abs(values[1][0] - values[2][0])
    assert abs(values[0][1] - values[1][1]) > 3.8 * abs(values[1][1] - values[2][1])
    assert abs(values[1][0] - values[2][0]) < 1e-8

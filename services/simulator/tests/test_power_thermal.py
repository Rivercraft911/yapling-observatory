import json
import math
import pytest
from pydantic import ValidationError

from cubesat_sim.power.models import (
    BatterySpec,
    CellConfiguration,
    ComponentLoad,
    PVPanel,
    StudyConfig,
)
from cubesat_sim.power.solar import pv_generation, cylindrical_sun_visibility
from cubesat_sim.power.battery import (
    advance_battery,
    capacity_wh,
    nominal_pack_energy_wh,
    nominal_pack_voltage_v,
)
from cubesat_sim.power.loads import load_ledger, resolved_stage
from cubesat_sim.power.study import default_study_config, run_study, stage_templates
from cubesat_sim.thermal.models import ThermalNetwork, NodeForcing
from cubesat_sim.thermal.network import SIGMA_W_M2_K4, advance_thermal, thermal_rates


def panel(**updates):
    return PVPanel.model_validate(
        dict(
            panel_id="pv",
            thermal_node_id="panel",
            active_area_m2=0.03,
            normal_body=[0, 1, 0],
            solar_absorptivity=0.9,
            **updates
        )
    )


def network(nodes, links=(), radiation=(), space=0):
    return ThermalNetwork.model_validate(
        dict(
            nodes=nodes,
            conductive_links=links,
            radiative_links=radiation,
            space_temperature_k=space,
        )
    )


def node(name="a", capacity=20, temperature=300, area=0, alpha=0, epsilon=0):
    return dict(
        node_id=name,
        heat_capacity_j_k=capacity,
        initial_temperature_k=temperature,
        radiating_area_m2=area,
        solar_absorptivity=alpha,
        infrared_emissivity=epsilon,
    )


def changed(config, **updates):
    return StudyConfig.model_validate(config.model_dump(mode="json") | updates)


def test_pv_projection_eclipse_and_array_curtailment_first_law():
    p = panel()
    face = pv_generation(p, [0, 1, 0])
    sixty = pv_generation(p, [math.sqrt(0.75), 0.5, 0])
    assert face.terminal_w == pytest.approx(0.03 * 1361 * 0.29)
    assert sixty.terminal_w == pytest.approx(face.terminal_w / 2)
    assert pv_generation(p, [1, 0, 0]).terminal_w == 0
    assert pv_generation(p, [0, -1, 0]).terminal_w == 0
    assert pv_generation(p, [0, 1, 0], sun_visibility=0).terminal_w == 0
    partial = pv_generation(
        p,
        [0, 1, 0],
        sun_visibility=0.3,
        extraction_fraction=0.4,
        regulator_efficiency=0.8,
    )
    assert partial.terminal_w == pytest.approx(face.terminal_w * 0.3 * 0.4)
    assert partial.absorbed_solar_w == pytest.approx(
        partial.panel_heat_w + partial.regulator_heat_w + partial.bus_w
    )
    open_circuit = pv_generation(p, [0, 1, 0], extraction_fraction=0)
    assert open_circuit.panel_heat_w == open_circuit.absorbed_solar_w
    assert open_circuit.regulator_heat_w == 0
    disconnected = pv_generation(panel(enabled=False), [0, 1, 0])
    assert disconnected.terminal_w == 0
    assert disconnected.absorbed_solar_w == face.absorbed_solar_w
    assert disconnected.panel_heat_w == disconnected.absorbed_solar_w
    assert partial.closure_residual_w == pytest.approx(0, abs=1e-14)
    assert cylindrical_sun_visibility([7e6, 0, 0], [1, 0, 0]) == 1
    assert cylindrical_sun_visibility([-7e6, 0, 0], [1, 0, 0]) == 0
    assert cylindrical_sun_visibility([-7e6, 7e6, 0], [1, 0, 0]) == 1
    with pytest.raises(ValueError):
        cylindrical_sun_visibility([0, 0, 0], [1, 0, 0])
    with pytest.raises(ValueError):
        pv_generation(p, [float("nan"), 0, 1])
    with pytest.raises(ValidationError):
        panel(efficiency=0.95)


def test_ncr18650ga_pack_conversion_and_wh_only_has_no_voltage():
    minimum = CellConfiguration(
        cell_capacity_mah=3350,
        cell_nominal_voltage_v=3.6,
        series_count=2,
        parallel_count=2,
    )
    typical = minimum.model_copy(update={"cell_capacity_mah": 3450})
    assert nominal_pack_energy_wh(minimum) == pytest.approx(48.24)
    assert nominal_pack_energy_wh(typical) == pytest.approx(49.68)
    assert nominal_pack_voltage_v(BatterySpec(cells=minimum)) == 7.2
    wh = BatterySpec(total_capacity_wh=20)
    assert nominal_pack_voltage_v(wh) is None
    assert capacity_wh(wh) == 20
    with pytest.raises(ValidationError):
        BatterySpec()
    with pytest.raises(ValidationError):
        BatterySpec(total_capacity_wh=20, cells=minimum)
    with pytest.raises(ValidationError):
        CellConfiguration(
            cell_capacity_mah=3350,
            cell_nominal_voltage_v=3.6,
            series_count=True,
            parallel_count=2,
        )


def test_battery_hand_cases_clipping_power_limits_and_energy_conservation():
    spec = BatterySpec(
        total_capacity_wh=1,
        charge_efficiency=0.8,
        discharge_efficiency=0.5,
        max_charge_bus_w=100,
        max_discharge_bus_w=100,
    )
    charge = advance_battery(spec, 1000, 5, 1, 10)
    assert charge.stored_energy_j == pytest.approx(1032)
    assert charge.storage_loss_w == pytest.approx(0.8)
    discharge = advance_battery(spec, 1000, 1, 5, 10)
    assert discharge.stored_energy_j == pytest.approx(920)
    assert discharge.storage_loss_w == pytest.approx(4)
    full = advance_battery(spec, 3599, 10, 0, 10)
    assert full.stored_energy_j == 3600
    assert full.charge_bus_w == pytest.approx(0.125)
    assert full.curtailed_bus_w == pytest.approx(9.875)
    empty = advance_battery(spec, 1, 0, 10, 10)
    assert empty.stored_energy_j == 0
    assert empty.served_load_w == pytest.approx(0.05)
    assert empty.unserved_load_w == pytest.approx(9.95)
    limited = spec.model_copy(update={"max_discharge_bus_w": 2})
    assert advance_battery(limited, 1000, 0, 10, 1).unserved_load_w == 8
    for flow in (charge, discharge, full, empty):
        assert flow.closure_residual_j == pytest.approx(0, abs=1e-10)
        assert not (flow.charge_bus_w > 0 and flow.discharge_bus_w > 0)
    with pytest.raises(ValueError):
        advance_battery(spec, -1, 0, 1, 1)
    with pytest.raises(ValueError):
        advance_battery(spec, 1, 0, 1, 0)


def test_rf_export_heat_is_not_antenna_gain_or_all_electrical_input():
    load = ComponentLoad(
        component_id="tx", thermal_node_id="radio", electrical_w=10.8, escaped_rf_w=3
    )
    assert load_ledger(load).heat_w == pytest.approx(7.8)
    partial = load_ledger(load, 0.5)
    assert partial.electrical_w == pytest.approx(partial.heat_w + partial.escaped_rf_w)
    with pytest.raises(ValidationError):
        ComponentLoad(
            component_id="bad", thermal_node_id="x", electrical_w=2, escaped_rf_w=3
        )


def test_thermal_isolated_and_constant_heat_exact_cases():
    net = network([node(capacity=10, temperature=300)])
    isolated = advance_thermal(
        net, [300], [NodeForcing(node_id="a")], 100, max_step_s=100
    )
    assert isolated.temperatures_k == (300,)
    heated = advance_thermal(
        net, [300], [NodeForcing(node_id="a", internal_heat_w=2)], 100, max_step_s=10
    )
    assert heated.temperatures_k[0] == pytest.approx(320)
    assert heated.thermal_storage_delta_j == pytest.approx(200)
    assert heated.energy_residual_j == pytest.approx(0, abs=1e-10)


def test_thermal_two_node_conduction_matches_analytic_and_is_stiff_stable():
    c1, c2, g, t = 80, 120, 0.2, 600
    net = network(
        [node("a", c1, 330), node("b", c2, 270)],
        links=[dict(first="a", second="b", conductance_w_k=g)],
    )
    forces = [NodeForcing(node_id="a"), NodeForcing(node_id="b")]
    mean = (c1 * 330 + c2 * 270) / (c1 + c2)
    difference = 60 * math.exp(-g * (1 / c1 + 1 / c2) * t)
    exact = [mean + c2 / (c1 + c2) * difference, mean - c1 / (c1 + c2) * difference]
    errors = []
    for step in (2, 1, 0.5):
        result = advance_thermal(net, [330, 270], forces, t, max_step_s=step)
        errors.append(max(abs(a - b) for a, b in zip(result.temperatures_k, exact)))
        assert result.energy_residual_j == pytest.approx(0, abs=1e-7)
        assert 270 <= min(result.temperatures_k) <= max(result.temperatures_k) <= 330
    assert errors[0] / errors[1] > 1.9 and errors[1] / errors[2] > 1.9
    stiff = network(
        [node("a", 0.01, 400), node("b", 0.02, 200)],
        links=[dict(first="a", second="b", conductance_w_k=100)],
    )
    result = advance_thermal(stiff, [400, 200], forces, 100, max_step_s=100)
    assert 200 <= min(result.temperatures_k) <= max(result.temperatures_k) <= 400
    assert sum(
        c * t for c, t in zip((0.01, 0.02), result.temperatures_k)
    ) == pytest.approx(8, abs=1e-8)


def test_thermal_radiation_equilibrium_and_separate_optical_bands():
    q = (0.9 - 0.29) * 1361 * 0.01
    coefficient = 0.8 * SIGMA_W_M2_K4 * 0.02
    equilibrium = (q / coefficient + 3**4) ** 0.25
    assert equilibrium == pytest.approx(309.289, abs=0.001)
    net = network([node(area=0.02, alpha=0.9, epsilon=0.8)], space=3)
    force = [
        NodeForcing(node_id="a", solar_incident_w=13.61, internal_heat_w=-0.29 * 13.61)
    ]
    result = advance_thermal(net, [250], force, 5000, max_step_s=10)
    assert result.temperatures_k[0] == pytest.approx(equilibrium, abs=1e-5)
    assert abs(result.energy_residual_j) < 1e-5
    bands = network([node(area=1, alpha=0.1, epsilon=0.9)], space=0)
    rate = thermal_rates(
        bands,
        [300],
        [NodeForcing(node_id="a", solar_incident_w=10, earth_ir_incident_w=2)],
    )
    assert rate.absorbed_environment_w[0] == pytest.approx(2.8)
    assert rate.emitted_ir_w[0] == pytest.approx(0.9 * SIGMA_W_M2_K4 * 300**4)


def test_radiative_cooling_solution_converges_and_pair_exchange_cancels():
    net = network([node(capacity=20, area=0.02, epsilon=0.8)])
    exact = (300**-3 + 3 * 0.8 * SIGMA_W_M2_K4 * 0.02 / 20 * 100) ** (-1 / 3)
    errors = []
    for step in (2, 1, 0.5):
        result = advance_thermal(
            net, [300], [NodeForcing(node_id="a")], 100, max_step_s=step
        )
        errors.append(abs(result.temperatures_k[0] - exact))
    assert errors[0] > errors[1] > errors[2]
    assert errors[1] / errors[2] > 1.8
    pair = network(
        [node("a", 10), node("b", 30)],
        radiation=[dict(first="a", second="b", exchange_coefficient_w_k4=1e-9)],
    )
    rate = thermal_rates(
        pair, [350, 250], [NodeForcing(node_id="a"), NodeForcing(node_id="b")]
    )
    assert sum(rate.mutual_radiation_net_w) == 0
    result = advance_thermal(
        pair,
        [350, 250],
        [NodeForcing(node_id="a"), NodeForcing(node_id="b")],
        100,
        max_step_s=5,
    )
    assert abs(result.thermal_storage_delta_j) < 1e-7
    with pytest.raises(ValidationError):
        network([node(), node()])
    with pytest.raises(ValueError):
        advance_thermal(net, [0], [NodeForcing(node_id="a")], 1)
    with pytest.raises(ValueError):
        thermal_rates(net, [300], [])


def test_study_default_reproducibility_conservation_and_distinct_nodes():
    config = default_study_config()
    before = config.model_dump_json()
    result = run_study(config)
    assert result == run_study(config)
    assert config.model_dump_json() == before
    json.dumps(result, allow_nan=False)
    assert result["manifest"]["battery_capacity_wh"] == pytest.approx(48.24)
    assert result["manifest"]["voltage_history_model"] is None
    assert result["summary"]["first_law_residual_j"] == pytest.approx(0, abs=1e-5)
    assert sum(stage["duration_s"] for stage in result["stages"]) == 1200
    assert result["samples"]["time_s"][-1] == 1200
    assert set(result["samples"]["node_temperature_k"]) == {
        "panel",
        "bus",
        "battery",
        "obc",
        "radio",
        "camera",
    }
    assert result["summary"]["requested_load_j"] == pytest.approx(600 * 3 + 600 * 12.5)
    assert result["summary"]["escaped_rf_j"] == pytest.approx(600 * 4 * 10 ** (-1 / 10))
    for values in result["samples"]["node_temperature_k"].values():
        assert all(t > 0 for t in values)
    assert config.panels[0].normal_body == (0, 1, 0)


def test_study_full_empty_and_manual_imaging_eclipse_event_cuts():
    config = default_study_config()
    data = config.model_dump(mode="json")
    data["battery"]["initial_energy_fraction"] = 1
    data["battery"]["max_charge_bus_w"] = 0
    for stage in data["stages"]:
        stage["loads"] = []
    full = run_study(StudyConfig.model_validate(data))
    assert max(full["samples"]["pv_terminal_w"]) == 0
    assert full["summary"]["curtailed_bus_j"] > 0
    assert full["summary"]["regulator_loss_j"] == 0
    assert abs(full["summary"]["first_law_residual_j"]) < 1e-5
    data = config.model_dump(mode="json")
    data["solar_irradiance_w_m2"] = 0
    data["battery"]["initial_energy_fraction"] = 0
    empty = run_study(StudyConfig.model_validate(data))
    assert max(empty["samples"]["stored_energy_j"]) == 0
    assert empty["summary"]["served_load_j"] == 0
    assert empty["summary"]["escaped_rf_j"] == 0
    assert empty["summary"]["unserved_load_j"] > 0
    data = config.model_dump(mode="json")
    data["imaging_windows"] = [
        dict(
            stage_id="manual_photo",
            mode="imaging",
            start_s=299.7,
            end_s=300.3,
            sun_direction_body=[1, 0, 0],
            loads=[
                dict(component_id="camera", thermal_node_id="camera", electrical_w=3)
            ],
        )
    ]
    data["eclipse_windows"] = [dict(start_s=599.3, end_s=600.7, sun_visibility=0)]
    manual = StudyConfig.model_validate(data)
    assert resolved_stage(manual, 300)[0].mode == "imaging"
    result = run_study(manual)
    photo = next(
        stage for stage in result["stages"] if stage["stage_id"] == "manual_photo"
    )
    assert photo["duration_s"] == pytest.approx(0.6)
    at600 = result["samples"]["time_s"].index(600)
    assert result["samples"]["pv_terminal_w"][at600] == 0
    assert abs(result["summary"]["first_law_residual_j"]) < 1e-5
    assert sum(stage["duration_s"] for stage in result["stages"]) == pytest.approx(1200)


def test_study_step_refinement_and_config_rejects_ambiguous_topology():
    config = default_study_config()
    finals = []
    for step in (2, 1, 0.5):
        result = run_study(changed(config, integration_step_s=step, output_step_s=10))
        finals.append(
            [values[-1] for values in result["samples"]["node_temperature_k"].values()]
        )
    first = max(abs(a - b) for a, b in zip(finals[0], finals[1]))
    second = max(abs(a - b) for a, b in zip(finals[1], finals[2]))
    assert first > second and first / second > 1.8
    data = config.model_dump(mode="json")
    data["stages"][1]["start_s"] = 299
    with pytest.raises(ValidationError):
        StudyConfig.model_validate(data)
    data = config.model_dump(mode="json")
    data["regulator_heat_node_id"] = "missing"
    with pytest.raises(ValidationError):
        StudyConfig.model_validate(data)


def test_stage_templates_change_inputs_without_claiming_dynamics():
    templates = stage_templates()
    assert set(templates) == {"sun_pointing", "ground_tracking", "imaging", "detumble"}
    assert templates["sun_pointing"]["sun_direction_body"] == [0, 1, 0]
    assert (
        templates["ground_tracking"]["sun_direction_body"]
        != templates["sun_pointing"]["sun_direction_body"]
    )
    assert sum(load["electrical_w"] for load in templates["imaging"]["loads"]) > sum(
        load["electrical_w"] for load in templates["sun_pointing"]["loads"]
    )
    assert any(
        load["component_id"] == "magnetorquers"
        for load in templates["detumble"]["loads"]
    )
    from cubesat_sim.power.models import Stage

    for mode, values in templates.items():
        stage = Stage.model_validate(dict(stage_id=mode, start_s=0, end_s=5, **values))
        assert stage.end_s == 5


def test_small_thermal_step_respects_kelvin_roundoff_without_stalling():
    net = network([node(capacity=100, temperature=300)])
    result = advance_thermal(
        net, [300], [NodeForcing(node_id="a", internal_heat_w=1)], 1e-5, max_step_s=1e-5
    )
    assert result.temperatures_k[0] > 300
    assert result.temperatures_k[0] == pytest.approx(300 + 1e-7, abs=1e-12)
    assert abs(result.energy_residual_j) < 8 * math.ulp(300) * 100

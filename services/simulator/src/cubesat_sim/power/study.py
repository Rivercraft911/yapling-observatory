"""Standalone prescribed-CONOPS study, not a flight orbit/thermal prediction."""

import hashlib
import json
import math
import platform
from importlib.metadata import version
from pathlib import Path
from .models import StudyConfig, Stage
from .solar import pv_generation
from .battery import advance_battery, capacity_wh, nominal_pack_voltage_v
from .loads import load_ledger, resolved_stage, solar_visibility
from .profiles import (
    PLANNING_ACTIVE_CAMERAS_W,
    PLANNING_ACTIVE_OBC_W,
    PLANNING_ACTIVITY_LOAD_SOURCE,
    PLANNING_TRANSMITTER,
)
from .radio import transmit_power
from ..thermal.models import NodeForcing
from ..thermal.network import advance_thermal, thermal_rates

MODEL_VERSION = "power-thermal-prescribed-conops-0.1.0"


def default_study_config() -> StudyConfig:
    nodes = [
        dict(
            node_id="panel",
            heat_capacity_j_k=150,
            initial_temperature_k=290,
            radiating_area_m2=0.06,
            solar_absorptivity=0.9,
            infrared_emissivity=0.85,
            space_view_factor=0.7,
        ),
        dict(
            node_id="bus",
            heat_capacity_j_k=300,
            initial_temperature_k=290,
            radiating_area_m2=0.04,
            solar_absorptivity=0.3,
            infrared_emissivity=0.75,
            space_view_factor=0.8,
        ),
        *[
            dict(
                node_id=name,
                heat_capacity_j_k=capacity,
                initial_temperature_k=290,
                radiating_area_m2=0,
                solar_absorptivity=0,
                infrared_emissivity=0,
            )
            for name, capacity in (
                ("battery", 180),
                ("obc", 60),
                ("radio", 60),
                ("camera", 30),
            )
        ],
    ]

    tx = PLANNING_TRANSMITTER
    transmitter = transmit_power(
        tx.electrical_w, tx.pa_output_w, tx.feed_loss_db, tx.radiation_efficiency
    )

    def loads(transmit=False):
        return [
            dict(
                component_id="obc",
                thermal_node_id="obc",
                electrical_w=PLANNING_ACTIVE_OBC_W if transmit else 2,
            ),
            dict(component_id="eps", thermal_node_id="bus", electrical_w=0.5),
            dict(
                component_id="radio",
                thermal_node_id="radio",
                electrical_w=tx.electrical_w if transmit else 0.5,
                escaped_rf_w=transmitter.escaped_rf_w if transmit else 0,
            ),
            dict(
                component_id="camera",
                thermal_node_id="camera",
                electrical_w=PLANNING_ACTIVE_CAMERAS_W if transmit else 0,
            ),
        ]

    return StudyConfig.model_validate(
        dict(
            name="Provisional NCR18650GA power/thermal study",
            panels=[
                dict(
                    panel_id="example_array",
                    thermal_node_id="panel",
                    active_area_m2=0.03,
                    normal_body=[0, 1, 0],
                    solar_absorptivity=0.9,
                    efficiency=0.29,
                )
            ],
            battery=dict(
                cells=dict(
                    cell_model="NCR18650GA",
                    cell_capacity_mah=3350,
                    cell_nominal_voltage_v=3.6,
                    series_count=2,
                    parallel_count=2,
                    capacity_basis="Manufacturer minimum charge capacity at25C x nominal voltage;2S2P user-proposed,not usable-energy guarantee",
                )
            ),
            thermal=dict(
                nodes=nodes,
                conductive_links=[
                    dict(first="bus", second=name, conductance_w_k=value)
                    for name, value in (
                        ("panel", 0.2),
                        ("battery", 0.2),
                        ("obc", 0.25),
                        ("radio", 0.15),
                        ("camera", 0.1),
                    )
                ],
            ),
            stages=[
                dict(
                    stage_id="sun_before",
                    mode="sun_pointing",
                    start_s=0,
                    end_s=300,
                    sun_direction_body=[0, 1, 0],
                    loads=loads(),
                ),
                dict(
                    stage_id="ground_pass",
                    mode="ground_tracking",
                    start_s=300,
                    end_s=900,
                    sun_direction_body=[math.sqrt(0.75), 0.5, 0],
                    loads=loads(True),
                ),
                dict(
                    stage_id="sun_after",
                    mode="sun_pointing",
                    start_s=900,
                    end_s=1200,
                    sun_direction_body=[0, 1, 0],
                    loads=loads(),
                ),
            ],
            environment=[
                dict(
                    node_id="panel",
                    albedo_irradiance_w_m2=100,
                    earth_ir_irradiance_w_m2=75,
                ),
                dict(
                    node_id="bus",
                    albedo_irradiance_w_m2=20,
                    earth_ir_irradiance_w_m2=50,
                ),
            ],
            regulator_heat_node_id="bus",
            storage_loss_heat_node_id="bus",
            provenance=[
                "NCR18650GA cell identity:user-specified. Panasonic current product table checked2026-10-25:3350mAh minimum,3450mAh typical,3.6V nominal. https://industry.panasonic.eu/pd-130926/batteries/secondary-batteries/lithium-ion-batteries-for-europe/cylindrical-type/ncr-18650ga",
                "2S2P is user-proposed.48.24Wh is nominal-voltage x minimum charge-capacity arithmetic,not guaranteed usable energy.",
                "PV29% is user-proposed. Area.03m2,normals,60deg ground-phase incidence,thermal capacities,optical properties,contacts,EPS efficiencies/power limits,initial state and loads are provisional examples,not flight or model-metadata values.",
                tx.source
                + " Standalone study deposits transmitter/feed/antenna heat at the radio node and counts only radiation crossing the vehicle boundary as escaped RF.",
                PLANNING_ACTIVITY_LOAD_SOURCE,
                "Storage-chain losses are assigned to bus,not fabricated cellI2R/entropic heat. Battery-node temperature is a lumped conduction prediction with missing cell-loss/temperature-dependent capacity physics.",
                "Albedo/EarthIR entries are prescribed incident irradiances at surfaces,not Earth OLR. No atmosphere,cloud shader,orbit ephemeris or geographic illumination is sampled.",
            ],
        )
    )


def stage_templates() -> dict[str, dict]:
    """Validated provisional load/illumination presets; no attitude/controller solve."""
    config = default_study_config()
    sun = config.stages[0]
    ground = config.stages[1]
    imaging_loads = [load.model_dump(mode="json") for load in sun.loads]
    for load in imaging_loads:
        if load["component_id"] == "camera":
            load["electrical_w"] = PLANNING_ACTIVE_CAMERAS_W
        if load["component_id"] == "obc":
            load["electrical_w"] = PLANNING_ACTIVE_OBC_W
    detumble_loads = [load.model_dump(mode="json") for load in sun.loads]
    detumble_loads.append(
        dict(component_id="magnetorquers", thermal_node_id="bus", electrical_w=0.75)
    )
    stages = [
        sun,
        ground,
        Stage(
            stage_id="imaging",
            mode="imaging",
            start_s=0,
            end_s=1,
            sun_direction_body=(1, 0, 0),
            loads=imaging_loads,
        ),
        Stage(
            stage_id="detumble",
            mode="detumble",
            start_s=0,
            end_s=1,
            sun_direction_body=(0.5, 0.5, math.sqrt(0.5)),
            loads=detumble_loads,
        ),
    ]
    return {
        stage.mode: stage.model_dump(
            mode="json", include={"mode", "sun_direction_body", "loads"}
        )
        for stage in stages
    }


def _electrical(config, time_s, duration_s, energy_j):
    stage, loads = resolved_stage(config, time_s)
    visibility = solar_visibility(config, time_s)
    potential = [
        pv_generation(
            panel,
            stage.sun_direction_body,
            config.solar_irradiance_w_m2,
            visibility,
            regulator_efficiency=config.regulator_efficiency,
        )
        for panel in config.panels
    ]
    potential_bus = sum(flow.bus_w for flow in potential)
    requested = sum(load.electrical_w for load in loads)
    battery = advance_battery(
        config.battery, energy_j, potential_bus, requested, duration_s
    )
    extraction = (
        battery.generated_bus_used_w / potential_bus if potential_bus > 0 else 0.0
    )
    panels = [
        pv_generation(
            panel,
            stage.sun_direction_body,
            config.solar_irradiance_w_m2,
            visibility,
            extraction_fraction=extraction,
            regulator_efficiency=config.regulator_efficiency,
        )
        for panel in config.panels
    ]
    fraction = battery.served_load_w / requested if requested > 0 else 1.0
    ledgers = tuple(load_ledger(load, fraction) for load in loads)
    return stage, loads, visibility, panels, battery, ledgers, potential_bus


def _forcing(config, panels, loads, ledgers, battery, visibility):
    solar = {node.node_id: 0.0 for node in config.thermal.nodes}
    heat = dict(solar)
    for panel, flow in zip(config.panels, panels):
        solar[panel.thermal_node_id] += flow.incident_solar_w
        heat[panel.thermal_node_id] -= flow.terminal_w
    heat[config.regulator_heat_node_id] += sum(flow.regulator_heat_w for flow in panels)
    heat[config.storage_loss_heat_node_id] += battery.storage_loss_w
    for load, ledger in zip(loads, ledgers):
        heat[load.thermal_node_id] += ledger.heat_w
    environment = {record.node_id: record for record in config.environment}
    result = []
    for node in config.thermal.nodes:
        env = environment.get(node.node_id)
        area = node.radiating_area_m2
        result.append(
            NodeForcing(
                node_id=node.node_id,
                internal_heat_w=heat[node.node_id],
                solar_incident_w=solar[node.node_id]
                + (env.solar_irradiance_w_m2 * area * visibility if env else 0),
                albedo_incident_w=env.albedo_irradiance_w_m2 * area if env else 0,
                earth_ir_incident_w=env.earth_ir_irradiance_w_m2 * area if env else 0,
            )
        )
    return tuple(result)


def _source_hashes():
    package = Path(__file__).parent.parent
    return {
        "cubesat_sim/"
        + path.relative_to(package)
        .as_posix(): hashlib.sha256(path.read_bytes())
        .hexdigest()
        for domain in ("power", "thermal")
        for path in sorted((package / domain).glob("*.py"))
    }


def run_study(config: StudyConfig) -> dict:
    duration = config.stages[-1].end_s
    output = sorted(
        {
            0.0,
            duration,
            *[
                min(i * config.output_step_s, duration)
                for i in range(math.ceil(duration / config.output_step_s) + 1)
            ],
        }
    )
    cuts = sorted(
        {
            *output,
            *[
                value
                for interval in (
                    *config.stages,
                    *config.imaging_windows,
                    *config.eclipse_windows,
                )
                for value in (interval.start_s, interval.end_s)
            ],
        }
    )
    temperatures = tuple(node.initial_temperature_k for node in config.thermal.nodes)
    initial_temperatures = temperatures
    energy = initial_energy = (
        capacity_wh(config.battery) * 3600 * config.battery.initial_energy_fraction
    )
    node_ids = tuple(node.node_id for node in config.thermal.nodes)
    component_ids = sorted(
        {
            load.component_id
            for stage in (*config.stages, *config.imaging_windows)
            for load in stage.loads
        }
    )
    numeric_keys = (
        "pv_incident_w",
        "pv_absorbed_w",
        "pv_available_mpp_w",
        "pv_terminal_w",
        "potential_bus_w",
        "generated_bus_w",
        "net_bus_w",
        "requested_load_w",
        "served_load_w",
        "unserved_load_w",
        "curtailed_bus_w",
        "charge_bus_w",
        "discharge_bus_w",
        "regulator_heat_w",
        "storage_loss_w",
        "escaped_rf_w",
        "stored_energy_j",
        "stored_energy_wh",
        "energy_fraction",
        "sun_visibility",
    )
    samples = {key: [] for key in ("time_s", "stage_id", "mode", *numeric_keys)}
    samples["node_temperature_k"] = {key: [] for key in node_ids}
    samples["component_electrical_w"] = {key: [] for key in component_ids}
    samples["component_heat_w"] = {key: [] for key in component_ids}
    energy_keys = (
        "absorbed_environment_j",
        "emitted_ir_j",
        "generated_bus_j",
        "requested_load_j",
        "served_load_j",
        "unserved_load_j",
        "curtailed_bus_j",
        "escaped_rf_j",
        "other_export_j",
        "mechanical_storage_j",
        "regulator_loss_j",
        "storage_loss_j",
        "chemical_storage_delta_j",
        "thermal_storage_delta_j",
    )
    samples["cumulative_energy_j"] = {key: [] for key in energy_keys}
    for key in (
        "node_net_heat_w",
        "node_absorbed_environment_w",
        "node_emitted_ir_w",
        "node_internal_heat_w",
    ):
        samples[key] = {node: [] for node in node_ids}
    totals = dict.fromkeys(energy_keys, 0.0)
    stage_totals = {}
    events = []
    previous_events = set()
    minimum_energy = energy
    temperature_min = list(temperatures)
    temperature_max = list(temperatures)
    substeps = newton_iterations = 0

    def append_sample(time_s):
        stage, loads, visibility, panels, battery, ledgers, potential_bus = _electrical(
            config, time_s, config.integration_step_s, energy
        )
        values = dict(
            pv_incident_w=sum(flow.incident_solar_w for flow in panels),
            pv_absorbed_w=sum(flow.absorbed_solar_w for flow in panels),
            pv_available_mpp_w=sum(flow.available_mpp_w for flow in panels),
            pv_terminal_w=sum(flow.terminal_w for flow in panels),
            potential_bus_w=potential_bus,
            generated_bus_w=battery.generated_bus_used_w,
            net_bus_w=potential_bus - sum(load.electrical_w for load in loads),
            requested_load_w=sum(load.electrical_w for load in loads),
            served_load_w=battery.served_load_w,
            unserved_load_w=battery.unserved_load_w,
            curtailed_bus_w=battery.curtailed_bus_w,
            charge_bus_w=battery.charge_bus_w,
            discharge_bus_w=battery.discharge_bus_w,
            regulator_heat_w=sum(flow.regulator_heat_w for flow in panels),
            storage_loss_w=battery.storage_loss_w,
            escaped_rf_w=sum(ledger.escaped_rf_w for ledger in ledgers),
            stored_energy_j=energy,
            stored_energy_wh=energy / 3600,
            energy_fraction=energy / (capacity_wh(config.battery) * 3600),
            sun_visibility=visibility,
        )
        for key, value in dict(
            time_s=time_s, stage_id=stage.stage_id, mode=stage.mode, **values
        ).items():
            samples[key].append(value)
        for key, value in zip(node_ids, temperatures):
            samples["node_temperature_k"][key].append(value)
        rates = thermal_rates(
            config.thermal,
            temperatures,
            _forcing(config, panels, loads, ledgers, battery, visibility),
        )
        for key, values in (
            ("node_net_heat_w", rates.net_heat_w),
            ("node_absorbed_environment_w", rates.absorbed_environment_w),
            ("node_emitted_ir_w", rates.emitted_ir_w),
            ("node_internal_heat_w", rates.internal_heat_w),
        ):
            for node, value in zip(node_ids, values):
                samples[key][node].append(value)
        for key, value in totals.items():
            samples["cumulative_energy_j"][key].append(value)
        by_id = {load.component_id: ledger for load, ledger in zip(loads, ledgers)}
        for key in component_ids:
            ledger = by_id.get(key)
            samples["component_electrical_w"][key].append(
                ledger.electrical_w if ledger else 0.0
            )
            samples["component_heat_w"][key].append(ledger.heat_w if ledger else 0.0)

    append_sample(0.0)
    output_set = set(output)
    for start, end in zip(cuts, cuts[1:]):
        steps = math.ceil((end - start) / config.integration_step_s)
        dt = (end - start) / steps
        for k in range(steps):
            t0 = start + k * dt
            stage, loads, visibility, panels, battery, ledgers, _ = _electrical(
                config, t0 + dt / 2, dt, energy
            )
            forcing = _forcing(config, panels, loads, ledgers, battery, visibility)
            thermal = advance_thermal(
                config.thermal, temperatures, forcing, dt, max_step_s=dt
            )
            increments = dict(
                absorbed_environment_j=thermal.absorbed_environment_j,
                emitted_ir_j=thermal.emitted_ir_j,
                generated_bus_j=battery.generated_bus_used_w * dt,
                requested_load_j=sum(load.electrical_w for load in loads) * dt,
                served_load_j=battery.served_load_w * dt,
                unserved_load_j=battery.unserved_load_w * dt,
                curtailed_bus_j=battery.curtailed_bus_w * dt,
                escaped_rf_j=sum(ledger.escaped_rf_w for ledger in ledgers) * dt,
                other_export_j=sum(ledger.other_export_w for ledger in ledgers) * dt,
                mechanical_storage_j=sum(
                    ledger.stored_mechanical_w for ledger in ledgers
                )
                * dt,
                regulator_loss_j=sum(flow.regulator_heat_w for flow in panels) * dt,
                storage_loss_j=battery.storage_loss_w * dt,
                chemical_storage_delta_j=battery.chemical_energy_change_j,
                thermal_storage_delta_j=thermal.thermal_storage_delta_j,
            )
            summary = stage_totals.setdefault(
                stage.stage_id,
                dict(
                    stage_id=stage.stage_id,
                    mode=stage.mode,
                    duration_s=0.0,
                    **dict.fromkeys(energy_keys, 0.0)
                ),
            )
            summary["duration_s"] += dt
            for key, value in increments.items():
                totals[key] += value
                summary[key] += value
            new_events = set(battery.events)
            for kind in sorted(new_events - previous_events):
                events.append(
                    dict(
                        time_s=t0 + dt,
                        kind=kind,
                        timing="prior integration interval resolved;not a receiver/power-controller event",
                    )
                )
            previous_events = new_events
            energy = battery.stored_energy_j
            temperatures = thermal.temperatures_k
            minimum_energy = min(minimum_energy, energy)
            temperature_min = [min(a, b) for a, b in zip(temperature_min, temperatures)]
            temperature_max = [max(a, b) for a, b in zip(temperature_max, temperatures)]
            substeps += thermal.substeps
            newton_iterations += thermal.newton_iterations
        if end in output_set:
            append_sample(end)
    thermal_change = sum(
        node.heat_capacity_j_k * (new - old)
        for node, new, old in zip(
            config.thermal.nodes, temperatures, initial_temperatures
        )
    )
    chemical_change = energy - initial_energy
    residual = (
        totals["absorbed_environment_j"]
        - totals["emitted_ir_j"]
        - totals["escaped_rf_j"]
        - totals["other_export_j"]
        - totals["mechanical_storage_j"]
        - thermal_change
        - chemical_change
    )
    dumped = config.model_dump(mode="json")
    identity = hashlib.sha256(
        json.dumps(
            dumped, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()
    for stage in stage_totals.values():
        stage["mean_generated_bus_w"] = stage["generated_bus_j"] / stage["duration_s"]
        stage["mean_requested_load_w"] = stage["requested_load_j"] / stage["duration_s"]
        stage["mean_net_bus_w"] = (
            stage["generated_bus_j"]
            + stage["curtailed_bus_j"]
            - stage["requested_load_j"]
        ) / stage["duration_s"]
    result = dict(
        manifest=dict(
            model_version=MODEL_VERSION,
            versions=dict(
                python=platform.python_version(), pydantic=version("pydantic")
            ),
            config_hash=identity,
            config=dumped,
            numerical_source_hashes=_source_hashes(),
            fidelity="prescribed-CONOPS flat-PV nominal-energy lumped-thermal example",
            battery_capacity_wh=capacity_wh(config.battery),
            nominal_pack_voltage_v=nominal_pack_voltage_v(config.battery),
            voltage_history_model=None,
            battery_state_kind="stored-energy fraction,not coulomb-countedSoC",
            solver=dict(
                method="implicit Euler,damped Newton",
                integration_step_s=config.integration_step_s,
                output_step_s=config.output_step_s,
                actual_substeps=substeps,
                newton_iterations=newton_iterations,
                thermal_residual_tolerance_w=1e-9,
                thermal_roundoff_floor="8 ulp(T) C/dt per node; actual energy residual remains reported",
                events="exact configured stage/window cuts;storage clipping interval-average",
            ),
            limits=[
                "All geometric areas,thermal properties,contacts,loads,EPS efficiencies,temperature initial states and environment values are explicit provisional inputs unless evidence says otherwise.",
                "No propagator,physical attitude controller,IV/string mismatch,OCV/current/aging model,battery temperature trips,cellI2R/entropic heating or autonomousloadshedding.",
                "Unserved load is allocated proportionally as energy bookkeeping;scaledRF is not proof of radio operation or delivered data.",
                "UnusedMPP potential is curtailed at array terminals;no equal fictitious EPS shunt heat is added.",
                "Albedo electrical generation is omitted;absorbedalbedo enters thermalnodes. EarthIR inputs are at-surface irradiance,not OLR.",
            ],
        ),
        summary=dict(
            duration_s=duration,
            sample_count=len(samples["time_s"]),
            final_energy_fraction=energy / (capacity_wh(config.battery) * 3600),
            minimum_energy_fraction=minimum_energy
            / (capacity_wh(config.battery) * 3600),
            node_minimum_k=dict(zip(node_ids, temperature_min)),
            node_maximum_k=dict(zip(node_ids, temperature_max)),
            first_law_residual_j=residual,
            **totals
        ),
        stages=list(stage_totals.values()),
        samples=samples,
        events=events,
    )
    json.dumps(result, allow_nan=False)
    return result

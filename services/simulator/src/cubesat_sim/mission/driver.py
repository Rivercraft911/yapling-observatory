"""Fixed-clock mission coupling with one authoritative Cartesian/attitude state.

Loads and geometry are held over each dynamics interval. RF capacity uses that
same grid; it is an ideal threshold integral, never delivered packets. Thermal
forcing is interval-averaged before the separate implicit thermal update.
"""

from dataclasses import replace
import hashlib
import math
from pathlib import Path
import platform
from ..mission_models import MissionScenario
from ..orbit.elements import elements_to_cartesian
from ..orbit.two_body import CartesianState, TwoBodyConfig, step as orbit_step
from ..attitude.dynamics import (
    state_from_relative_wheel_speeds,
    AttitudeForcing,
    step as attitude_step,
    derivative,
    mechanical_invariants,
)
from ..attitude.control import (
    PDConfig,
    AttitudeReference,
    minimum_rotation_reference,
    quaternion_pd,
)
from ..attitude.actuators import (
    allocate_magnetic_torque,
    allocate_wheel_net_torques,
    bdot_dipole,
)
from ..attitude.kinematics import rotate, conjugate, boresight_reference
from ..geometry.vectors import add, cross, dot, scale, norm
from ..operations.schedule import active_direction
from ..rf.link_budget import evaluate_link_budget
from ..rf.pattern_provenance import harmonic_pattern_records
from ..power.solar import pv_generation
from ..power.battery import advance_battery, capacity_wh
from ..power.loads import load_ledger
from ..power.models import ComponentLoad
from ..thermal.models import NodeForcing
from ..thermal.network import advance_thermal, thermal_rates
from .ephemeris import (
    sun_direction_inertial,
    inertial_to_ecef,
    ecef_to_inertial,
    MODEL_VERSION as FRAME_VERSION,
)
from .environment import (
    magnetic_field_ecef_t,
    sun_visibility,
    earth_disk_irradiance,
    MAGNETIC_MODEL,
    IGRF_URL,
)
from .geometry import geometry_at, operation_at, target_direction
from .defaults import orbit_metadata

MODEL_VERSION = "coupled-reference-mission-0.1.0"


def _append(columns, row):
    for key, value in row.items():
        if isinstance(value, dict):
            _append(columns.setdefault(key, {}), value)
        else:
            columns.setdefault(key, []).append(value)


def _source_hashes():
    package = Path(__file__).parents[1]
    paths = {package / "mission_models.py", package / "models.py"}
    for domain in (
        "mission",
        "orbit",
        "attitude",
        "geometry",
        "rf",
        "operations",
        "power",
        "thermal",
    ):
        paths.update((package / domain).rglob("*.py"))
        paths.update((package / domain).rglob("*.json"))
    return {
        "cubesat_sim/"
        + p.relative_to(package).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(paths)
    }


def run_mission(config: MissionScenario, cancelled=None, progress=None):
    if not isinstance(config, MissionScenario):
        raise TypeError("Validated MissionScenario required")
    source_hashes_at_start = _source_hashes()
    dt = config.clocks.dynamics_step_s
    count = round(config.duration_s / dt)
    control_stride = round(config.clocks.controller_period_s / dt)
    thermal_stride = round(config.clocks.thermal_step_s / dt)
    output_stride = round(config.clocks.output_step_s / dt)
    orbit_config = TwoBodyConfig(
        config.orbit.mu_m3_s2,
        dt / config.clocks.orbit_substeps,
        config.orbit.method,
        config.orbit.reference_radius_m,
        config.orbit.force_model,
        config.orbit.reference_radius_m,
        config.orbit.j2,
    )
    initial = elements_to_cartesian(config.orbit.elements, config.orbit.mu_m3_s2)
    orbit = CartesianState(0.0, initial.position_m, initial.velocity_m_s)
    body = config.spacecraft.rigid_body()
    attitude = state_from_relative_wheel_speeds(
        body,
        q_body_from_inertial_wxyz=config.spacecraft.initial_q_body_from_inertial_wxyz,
        omega_body_rad_s=config.spacecraft.initial_omega_body_rad_s,
        wheel_relative_speed_rad_s=(0.0,) * len(body.wheels),
    )
    mechanics0 = mechanical_invariants(body, attitude)
    power = config.power
    transmit_efficiency = (
        config.downlink.spherical_harmonic_profile.radiation_efficiency
        if config.downlink.spacecraft_antenna == "spherical_harmonic"
        else power.transmit_radiation_efficiency
    )
    temperatures = tuple(n.initial_temperature_k for n in power.thermal.nodes)
    temperatures0 = temperatures
    energy0 = energy = (
        capacity_wh(power.battery) * 3600 * power.battery.initial_energy_fraction
    )
    nodes = tuple(n.node_id for n in power.thermal.nodes)
    accumulated = {n: [0.0, 0.0, 0.0, 0.0] for n in nodes}
    thermal_elapsed = 0.0
    last_forces = tuple(NodeForcing(node_id=node) for node in nodes)
    earth_flux = ()
    field_previous = None
    field_previous_time = None
    forcing = AttitudeForcing(wheel_motor_torques_nm=(0.0,) * len(body.wheels))
    gains = PDConfig(
        config.spacecraft.proportional_nm_per_rad,
        config.spacecraft.derivative_nm_s_per_rad,
    )
    requested = (0.0, 0.0, 0.0)
    allocation_residual = (0.0, 0.0, 0.0)
    mtq_saturated = False
    control_status = "coast"
    capacity = {d: 0.0 for d in ("uplink", "downlink")}
    capacity_available = {d: True for d in capacity}
    samples = {}
    stage_energy = {}
    events = []
    previous_operation = None
    totals = {
        key: 0.0
        for key in (
            "generated_bus_j",
            "requested_load_j",
            "served_load_j",
            "pv_terminal_j",
            "regulator_loss_j",
            "storage_loss_j",
            "escaped_rf_j",
            "other_export_j",
            "wheel_bus_j",
            "wheel_heat_j",
            "magnetorquer_bus_j",
            "external_mechanical_work_j",
            "absorbed_environment_j",
            "emitted_ir_j",
            "thermal_residual_j",
            "battery_residual_j",
            "mechanical_residual_j",
        )
    }
    maximum_pointing = maximum_rate = 0.0
    maximum_elevation = -90.0
    maximum_quaternion_norm_error = 0.0
    completed_ticks = 0
    end_reason = "requested_duration"
    last_power = {
        key: 0.0
        for key in (
            "pv_available_mpp_w",
            "pv_terminal_w",
            "potential_bus_w",
            "generated_bus_w",
            "requested_load_w",
            "served_load_w",
            "unserved_load_w",
            "curtailed_bus_w",
            "charge_bus_w",
            "discharge_bus_w",
            "storage_loss_w",
            "regulator_heat_w",
            "escaped_rf_w",
            "actuator_bus_w",
            "actuator_heat_w",
        )
    }
    last_components = {}

    def state_geometry():
        geo = geometry_at(config, orbit, attitude)
        sun = sun_direction_inertial(config.epoch_utc, orbit.time_s)
        mode, stage_id, window = operation_at(config, orbit.time_s, geo["visible"])
        target = target_direction(config, geo, sun, mode, window, orbit)
        visibility = sun_visibility(orbit.position_m, sun, power.earth_radius_m)
        field_ecef = magnetic_field_ecef_t(
            geo["satellite_position_ecef_m"], config.epoch_utc, orbit.time_s
        )
        field = ecef_to_inertial(field_ecef, config.epoch_utc, orbit.time_s)
        return geo, sun, mode, stage_id, target, visibility, field

    def update_control(geo, sun, mode, target, field):
        nonlocal forcing, requested, allocation_residual, field_previous, field_previous_time, mtq_saturated, control_status
        field_body = rotate(attitude.q_body_from_inertial_wxyz, field)
        motors = (0.0,) * len(body.wheels)
        dipole = (0.0, 0.0, 0.0)
        requested = (0.0, 0.0, 0.0)
        allocation_residual = (0.0, 0.0, 0.0)
        mtq_saturated = False
        control_status = "coast"
        if mode == "detumble" and body.magnetorquer is not None:
            rate = (
                scale(
                    add(field_body, scale(field_previous, -1)),
                    1 / (orbit.time_s - field_previous_time),
                )
                if field_previous is not None and orbit.time_s > field_previous_time
                else scale(cross(attitude.omega_body_rad_s, field_body), -1)
            )
            dipole, mtq_saturated = bdot_dipole(
                rate, config.spacecraft.bdot_gain_am2_s_t, body.magnetorquer
            )
            control_status = "magnetic_bdot_reference"
        elif config.spacecraft.controller == "quaternion_pd" and mode != "detumble":
            reference = (
                minimum_rotation_reference(
                    attitude, config.spacecraft.body_boresight, target
                )
                if config.spacecraft.free_roll
                else AttitudeReference(
                    boresight_reference(
                        config.spacecraft.initial_q_body_from_inertial_wxyz,
                        config.spacecraft.body_boresight,
                        target,
                    )
                )
            )
            output = quaternion_pd(
                body,
                attitude,
                reference,
                gains,
                (
                    config.spacecraft.body_boresight
                    if config.spacecraft.free_roll
                    else None
                ),
                damp_free_roll_rate=config.spacecraft.free_roll
                and config.spacecraft.roll_rate_damping,
            )
            requested = output.requested_body_control_torque_nm
            if body.wheels:
                net = allocate_wheel_net_torques(body.wheels, requested)
                relative = mechanical_invariants(
                    body, attitude
                ).wheel_relative_speed_rad_s
                motors = tuple(
                    t + w.viscous_friction_nm_s * s
                    for t, w, s in zip(net, body.wheels, relative)
                )
                control_status = "wheel_pd"
            elif body.magnetorquer is not None:
                allocation = allocate_magnetic_torque(
                    requested, field_body, body.magnetorquer
                )
                dipole = allocation.dipole_body_am2
                allocation_residual = allocation.residual_torque_body_nm
                mtq_saturated = allocation.dipole_saturated
                control_status = "magnetic_projected_pd"
            else:
                allocation_residual = requested
                control_status = "no_actuator_coast"
        field_previous = field_body
        field_previous_time = orbit.time_s
        forcing = AttitudeForcing(motors, dipole, field)

    def flush_thermal():
        nonlocal temperatures, thermal_elapsed, last_forces
        if thermal_elapsed == 0:
            return
        forces = tuple(
            NodeForcing(
                node_id=node,
                solar_incident_w=values[0] / thermal_elapsed,
                albedo_incident_w=values[1] / thermal_elapsed,
                earth_ir_incident_w=values[2] / thermal_elapsed,
                internal_heat_w=values[3] / thermal_elapsed,
            )
            for node, values in accumulated.items()
        )
        last_forces = forces
        thermal = advance_thermal(
            power.thermal,
            temperatures,
            forces,
            thermal_elapsed,
            max_step_s=thermal_elapsed,
        )
        temperatures = thermal.temperatures_k
        totals["absorbed_environment_j"] += thermal.absorbed_environment_j
        totals["emitted_ir_j"] += thermal.emitted_ir_j
        totals["thermal_residual_j"] += thermal.energy_residual_j
        for values in accumulated.values():
            values[:] = [0.0, 0.0, 0.0, 0.0]
        thermal_elapsed = 0.0

    def append_sample():
        nonlocal maximum_pointing, maximum_rate, maximum_elevation
        geo, sun, mode, stage_id, target, visibility, field = state_geometry()
        pointing = math.degrees(
            math.acos(
                max(
                    -1.0,
                    min(
                        1.0,
                        dot(
                            rotate(attitude.q_body_from_inertial_wxyz, target),
                            config.spacecraft.body_boresight,
                        ),
                    ),
                )
            )
        )
        maximum_elevation = max(maximum_elevation, geo["elevation_deg"])
        maximum_pointing = max(maximum_pointing, pointing)
        maximum_rate = max(maximum_rate, norm(attitude.omega_body_rad_s))
        direction = active_direction(config, orbit.time_s)
        radio_active = mode == "ground_tracking" and geo["visible"]
        links = {
            d: evaluate_link_budget(config, d, geo, radio_active and direction == d)
            for d in capacity
        }
        for d, link in links.items():
            if link["ideal_rate_bps"] is None:
                capacity_available[d] = False
            link["cumulative_ideal_bits"] = (
                capacity[d] if capacity_available[d] else None
            )
        report = derivative(
            body,
            attitude,
            AttitudeForcing(
                forcing.wheel_motor_torques_nm, forcing.magnetic_dipole_body_am2, field
            ),
        )
        rates = thermal_rates(power.thermal, temperatures, last_forces)
        actual = add(
            report.total_external_torque_body_nm,
            scale(
                sum_vectors(
                    tuple(
                        scale(w.axis_body, t)
                        for w, t in zip(
                            body.wheels, report.wheel_absolute_axial_momentum_rate_nm
                        )
                    )
                ),
                -1,
            ),
        )
        residual = add(requested, scale(actual, -1))
        row = dict(
            time_s=orbit.time_s,
            elapsed_ns=str(round(orbit.time_s * 1e9)),
            satellite_position_m=orbit.position_m,
            satellite_velocity_m_s=orbit.velocity_m_s,
            station_position_m=geo["station_position_m"],
            station_position_ecef_m=geo["station_position_ecef_m"],
            satellite_position_ecef_m=geo["satellite_position_ecef_m"],
            q_body_from_inertial_wxyz=attitude.q_body_from_inertial_wxyz,
            sun_direction_ecef=inertial_to_ecef(sun, config.epoch_utc, orbit.time_s),
            sun_direction_inertial=sun,
            ecef_from_inertial_angle_rad=geo["ecef_from_inertial_angle_rad"],
            range_m=geo["range_m"],
            range_rate_m_s=geo["range_rate_m_s"],
            elevation_deg=geo["elevation_deg"],
            azimuth_deg=geo["azimuth_deg"],
            visible=geo["visible"],
            active_direction=direction,
            radio_active=radio_active,
            attitude_angle_deg=pointing,
            mode=mode,
            stage_id=stage_id,
            uplink=links["uplink"],
            downlink=links["downlink"],
            gnc=dict(
                omega_body_rad_s=attitude.omega_body_rad_s,
                requested_torque_body_nm=requested,
                actual_torque_body_nm=actual,
                residual_torque_body_nm=residual,
                magnetic_field_body_t=report.magnetic_field_body_t,
                magnetic_dipole_body_am2=report.magnetic_dipole_body_am2,
                wheel_relative_speed_rad_s=mechanical_invariants(
                    body, attitude
                ).wheel_relative_speed_rad_s,
                wheel_absolute_axial_momentum_nms=attitude.wheel_absolute_axial_momentum_nms,
                wheel_speed_utilization=tuple(
                    abs(speed) / wheel.max_relative_speed_rad_s
                    for speed, wheel in zip(
                        mechanical_invariants(
                            body, attitude
                        ).wheel_relative_speed_rad_s,
                        body.wheels,
                    )
                ),
                controller_status=control_status,
                magnetic_saturated=mtq_saturated,
                wheel_saturated=any(
                    w.torque_saturated or w.at_speed_limit or w.power_saturated
                    for w in report.wheels
                ),
            ),
            power=dict(
                **last_power,
                net_bus_w=last_power["potential_bus_w"]
                - last_power["requested_load_w"],
                stored_energy_j=energy,
                stored_energy_wh=energy / 3600,
                energy_fraction=energy / (capacity_wh(power.battery) * 3600),
                sun_visibility=visibility,
                battery_voltage_v=None,
                battery_current_a=None,
                battery_electrical_reason="capacity_only_energy_model",
                component_electrical_w={
                    key: last_components.get(key, 0.0) for key in sorted(component_ids)
                }
            ),
            thermal=dict(
                node_temperature_k=dict(zip(nodes, temperatures)),
                node_internal_heat_w=dict(zip(nodes, rates.internal_heat_w)),
                node_net_heat_w=dict(zip(nodes, rates.net_heat_w)),
                node_absorbed_environment_w=dict(
                    zip(nodes, rates.absorbed_environment_w)
                ),
                node_emitted_ir_w=dict(zip(nodes, rates.emitted_ir_w)),
            ),
        )
        _append(samples, row)

    component_ids = {
        "radio",
        "wheels",
        "magnetorquers",
        *[load.component_id for profile in power.mode_loads for load in profile.loads],
    }
    for tick in range(count):
        if tick % 16 == 0 and cancelled and cancelled():
            raise InterruptedError("Mission cancelled")
        geo, sun, mode, stage_id, target, visibility, field = state_geometry()
        maximum_elevation = max(maximum_elevation, geo["elevation_deg"])
        maximum_rate = max(maximum_rate, norm(attitude.omega_body_rad_s))
        maximum_pointing = max(
            maximum_pointing,
            math.degrees(
                math.acos(
                    max(
                        -1.0,
                        min(
                            1.0,
                            dot(
                                rotate(attitude.q_body_from_inertial_wxyz, target),
                                config.spacecraft.body_boresight,
                            ),
                        ),
                    )
                )
            ),
        )
        operation = (mode, stage_id, geo["visible"], visibility)
        if operation != previous_operation:
            events.append(
                dict(
                    time_s=orbit.time_s,
                    type="state",
                    mode=mode,
                    stage_id=stage_id,
                    visible=geo["visible"],
                    sun_visibility=visibility,
                )
            )
            previous_operation = operation
        if tick % control_stride == 0 or (
            events and events[-1]["time_s"] == orbit.time_s
        ):
            update_control(geo, sun, mode, target, field)
        # The inertial field follows the common orbit clock even between controller updates.
        forcing = AttitudeForcing(
            forcing.wheel_motor_torques_nm, forcing.magnetic_dipole_body_am2, field
        )
        if tick % thermal_stride == 0:
            normals = tuple(
                rotate(conjugate(attitude.q_body_from_inertial_wxyz), s.normal_body)
                for s in power.surfaces
            )
            earth_flux = earth_disk_irradiance(
                orbit.position_m,
                sun,
                normals,
                power.earth_radius_m,
                power.solar_irradiance_w_m2,
                power.earth_albedo,
                power.earth_outgoing_ir_w_m2,
                power.earth_quadrature_rings,
                power.earth_quadrature_azimuths,
            )
        direction = active_direction(config, orbit.time_s)
        radio_active = mode == "ground_tracking" and geo["visible"]
        transmit = radio_active and direction == "downlink"
        radio_electrical = (
            power.spacecraft_tx_electrical_w
            if transmit
            else power.spacecraft_receive_w if radio_active else power.radio_idle_w
        )
        escaped_rf = (
            config.downlink.tx_power_w
            * 10 ** (-config.downlink.tx_feed_loss_db / 10)
            * transmit_efficiency
            if transmit
            else 0.0
        )
        loads = next(
            profile.loads for profile in power.mode_loads if profile.mode == mode
        ) + (
            ComponentLoad(
                component_id="radio",
                thermal_node_id=power.radio_heat_node_id,
                electrical_w=radio_electrical,
                escaped_rf_w=escaped_rf,
            ),
        )
        ledgers = tuple(load_ledger(load) for load in loads)
        current_derivative = derivative(body, attitude, forcing)
        if (
            dt
            * (
                norm(attitude.omega_body_rad_s)
                + dt * norm(current_derivative.omega_dot_body_rad_s2)
            )
            > 0.1
        ):
            end_reason = "dynamics_step_too_large"
            events.append(
                dict(
                    time_s=orbit.time_s,
                    type="terminated",
                    reason=end_reason,
                    required_action="Choose an explicit finer dynamics timestep",
                )
            )
            break
        trial = attitude_step(body, attitude, forcing, dt)
        if trial.quaternion_norm_error_before_projection > 1e-6:
            end_reason = "quaternion_integration_accuracy_guard"
            events.append(
                dict(
                    time_s=orbit.time_s,
                    type="terminated",
                    reason=end_reason,
                    projection_error=trial.quaternion_norm_error_before_projection,
                )
            )
            break
        mtq = config.spacecraft.magnetorquer
        mtq_w = (
            sum(
                w * (m / body.magnetorquer.max_dipole_am2) ** 2
                for w, m in zip(mtq.full_axis_power_w, forcing.magnetic_dipole_body_am2)
            )
            if body.magnetorquer and body.magnetorquer.max_dipole_am2 > 0
            else 0.0
        )
        wheel_w = trial.wheel_bus_energy_j / dt
        if wheel_w < -1e-12:
            raise ValueError(
                "Regenerative wheel bus not yet supported by mission storage adapter"
            )
        requested_w = (
            sum(load.electrical_w for load in loads) + max(0.0, wheel_w) + mtq_w
        )
        sun_body = rotate(attitude.q_body_from_inertial_wxyz, sun)
        potential = tuple(
            pv_generation(
                panel,
                sun_body,
                power.solar_irradiance_w_m2,
                visibility,
                regulator_efficiency=power.regulator_efficiency,
            )
            for panel in power.panels
        )
        potential_bus = sum(flow.bus_w for flow in potential)
        battery = advance_battery(power.battery, energy, potential_bus, requested_w, dt)
        if battery.unserved_load_w > 1e-9:
            end_reason = "power_unserved"
            events.append(
                dict(
                    time_s=orbit.time_s,
                    type="terminated",
                    reason=end_reason,
                    attempted_interval_s=dt,
                    unserved_load_w=battery.unserved_load_w,
                )
            )
            break
        extraction = (
            min(1.0, max(0.0, battery.generated_bus_used_w / potential_bus))
            if potential_bus > 0
            else 0.0
        )
        pv = tuple(
            pv_generation(
                panel,
                sun_body,
                power.solar_irradiance_w_m2,
                visibility,
                extraction,
                power.regulator_efficiency,
            )
            for panel in power.panels
        )
        heat = {node: 0.0 for node in nodes}
        for panel, flow in zip(power.panels, pv):
            heat[panel.thermal_node_id] -= flow.terminal_w
        regulator = sum(flow.regulator_heat_w for flow in pv)
        heat[power.regulator_heat_node_id] += regulator
        heat[power.storage_loss_heat_node_id] += battery.storage_loss_w
        for load, ledger in zip(loads, ledgers):
            heat[load.thermal_node_id] += ledger.heat_w
        heat[config.spacecraft.actuator_heat_node_id] += trial.wheel_heat_j / dt
        if mtq and mtq.enabled:
            heat[mtq.thermal_node_id] += mtq_w
        for surface, (albedo, ir) in zip(power.surfaces, earth_flux):
            values = accumulated[surface.thermal_node_id]
            values[0] += (
                power.solar_irradiance_w_m2
                * visibility
                * surface.area_m2
                * max(0.0, dot(surface.normal_body, sun_body))
                * dt
            )
            values[1] += albedo * surface.area_m2 * dt
            values[2] += ir * surface.area_m2 * dt
        for node, value in heat.items():
            accumulated[node][3] += value * dt
        thermal_elapsed += dt
        increments = dict(
            generated_bus_j=battery.generated_bus_used_w * dt,
            requested_load_j=requested_w * dt,
            served_load_j=battery.served_load_w * dt,
            pv_terminal_j=sum(flow.terminal_w for flow in pv) * dt,
            regulator_loss_j=regulator * dt,
            storage_loss_j=battery.storage_loss_w * dt,
            escaped_rf_j=escaped_rf * dt,
            other_export_j=sum(
                ledger.other_export_w + ledger.stored_mechanical_w for ledger in ledgers
            )
            * dt,
            wheel_bus_j=trial.wheel_bus_energy_j,
            wheel_heat_j=trial.wheel_heat_j,
            magnetorquer_bus_j=mtq_w * dt,
            external_mechanical_work_j=trial.external_mechanical_work_j,
            battery_residual_j=battery.closure_residual_j,
            mechanical_residual_j=trial.energy_balance_residual_j,
        )
        for key, value in increments.items():
            totals[key] += value
        stage = stage_energy.setdefault(
            stage_id,
            dict(
                stage_id=stage_id,
                mode=mode,
                duration_s=0.0,
                generated_bus_j=0.0,
                requested_load_j=0.0,
                escaped_rf_j=0.0,
                actuator_bus_j=0.0,
            ),
        )
        stage["duration_s"] += dt
        for key in ("generated_bus_j", "requested_load_j", "escaped_rf_j"):
            stage[key] += increments[key]
        stage["actuator_bus_j"] += max(0.0, trial.wheel_bus_energy_j) + mtq_w * dt
        last_power = dict(
            pv_available_mpp_w=sum(f.available_mpp_w for f in pv),
            pv_terminal_w=sum(f.terminal_w for f in pv),
            potential_bus_w=potential_bus,
            generated_bus_w=battery.generated_bus_used_w,
            requested_load_w=requested_w,
            served_load_w=battery.served_load_w,
            unserved_load_w=battery.unserved_load_w,
            curtailed_bus_w=battery.curtailed_bus_w,
            charge_bus_w=battery.charge_bus_w,
            discharge_bus_w=battery.discharge_bus_w,
            storage_loss_w=battery.storage_loss_w,
            regulator_heat_w=regulator,
            escaped_rf_w=escaped_rf,
            actuator_bus_w=max(0.0, wheel_w) + mtq_w,
            actuator_heat_w=trial.wheel_heat_j / dt + mtq_w,
        )
        last_components = {
            load.component_id: load.electrical_w for load in loads
        } | dict(wheels=max(0.0, wheel_w), magnetorquers=mtq_w)
        if tick == 0:
            append_sample()
        for d in capacity:
            rate = evaluate_link_budget(
                config, d, geo, radio_active and direction == d
            )["ideal_rate_bps"]
            if rate is None:
                capacity_available[d] = False
            elif capacity_available[d]:
                capacity[d] += rate * dt
        energy = battery.stored_energy_j
        attitude = replace(trial.state, time_s=(tick + 1) * dt)
        for _ in range(config.clocks.orbit_substeps):
            orbit = orbit_step(orbit, orbit_config)
        orbit = replace(orbit, time_s=(tick + 1) * dt)
        completed_ticks = tick + 1
        maximum_quaternion_norm_error = max(
            maximum_quaternion_norm_error, trial.quaternion_norm_error_before_projection
        )
        if completed_ticks % thermal_stride == 0:
            flush_thermal()
        if completed_ticks % output_stride == 0:
            append_sample()
        if progress and (
            completed_ticks % max(1, round(10 / dt)) == 0 or completed_ticks == count
        ):
            progress(
                dict(
                    completed_time_s=orbit.time_s,
                    requested_duration_s=config.duration_s,
                    fraction=completed_ticks / count,
                    output_samples=len(samples.get("time_s", [])),
                    state="running",
                )
            )
    flush_thermal()
    if not samples or samples["time_s"][-1] != orbit.time_s:
        append_sample()
    identity, digest = config.identity()
    thermal_delta = sum(
        n.heat_capacity_j_k * (new - old)
        for n, new, old in zip(power.thermal.nodes, temperatures, temperatures0)
    )
    rotational_delta = (
        mechanical_invariants(body, attitude).rotational_energy_j
        - mechanics0.rotational_energy_j
    )
    storage_delta = energy - energy0
    closure = (
        totals["absorbed_environment_j"]
        - totals["emitted_ir_j"]
        - totals["escaped_rf_j"]
        - totals["other_export_j"]
        + totals["external_mechanical_work_j"]
        - thermal_delta
        - storage_delta
        - rotational_delta
    )
    manifest = dict(
        schema_version="0.1.0",
        model_version=MODEL_VERSION,
        scenario_id=identity,
        scenario_hash=digest,
        scenario=config.model_dump(mode="json"),
        model_fidelity="coupled_reference_dynamics_provisional_hardware",
        frames=dict(
            inertial="FIXED_EPOCH_MEAN_EQUATOR_EQUINOX_APPROX",
            earth_fixed="GMST-rotated WGS84 approximate; UTC=UT1; no EOP/precession/nutation/polar motion",
            quaternion="Hamilton scalarfirst q_B_from_I",
            sun=FRAME_VERSION,
            magnetic=MAGNETIC_MODEL,
        ),
        time=dict(
            elapsed_scale="SI seconds; POSIX UTC labels; no leap second dynamics",
            **orbit_metadata(config.orbit.elements)
        ),
        numerical_settings=config.clocks.model_dump(mode="json")
        | dict(
            orbit_step_s=orbit_config.step_s,
            orbit_method=config.orbit.method,
            attitude_method="RK4",
            thermal_method="implicit_Euler_mean_held_forcing",
            rf_integral="left dynamics tick; slot/mode/eclipse crossings grid resolved",
            earth_environment_hold_s=config.clocks.thermal_step_s,
            power_sample_semantics="preceding dynamics interval average;initial sample first-interval values",
            completed_dynamics_ticks=completed_ticks,
        ),
        prefix_semantics="completed result is immutable; no live sample streaming; power termination retains last valid common-state prefix",
        source_code_hashes=source_hashes_at_start,
        source_identity_capture="disk source hashes at run start, checked again before result publication; API uses fresh isolated process",
        versions=dict(python=platform.python_version()),
        sources=[
            dict(
                url=IGRF_URL,
                scope="degree1 2025+SV reference only; fulldegree13 not implemented",
            ),
            dict(
                url="https://www.ngdc.noaa.gov/stp/space-weather/online-publications/stp_sii/spades/algorithm-theoretic-basis-documents/atbds_mag/atbd_mag07_coordinate-systems_v1-3.pdf",
                locator="v1.3 (2009),sections3.4.2.3/4,pp26/27",
                scope="lowprecisionSun/GMST",
            ),
        ],
        warnings=[
            "Provisional mass/inertia, loads, coil/wheel electrical properties, thermal materials/contacts and initial conditions; no hardware validation.",
            "First-order mean-J2 SSO starting estimate used as OSCULATING initial elements; not exactSSO or operational ephemeris. No drag/lunisolar perturbations.",
            "Degree1-only IGRF14 reference omits degree2..13 and external magnetic disturbances; not an IGRF accuracy claim.",
            "Free-roll instantaneous minimum-rotation guidance, optional full angular-rate damping, zero target-rate feedforward; actual rigid-body dynamics and actuator limits determine pointing.",
            "MTQ quadratic axis watts are an explicit example assumption. No cellOCV/current/voltage/temperaturecapacity or hardware brownout dynamics.",
            "Uniform spherical Earth albedo/IR and hard geometric eclipse; held environment flux, fixed deployed panels, no selfshadow or geographic weather.",
            "Ideal threshold radio capacity only, not delivered packets, acquisition, mount servos or hardware receiver performance.",
            "Power demand that cannot be served terminates at last valid shared-state prefix; postbrownout dynamics are not modeled.",
        ],
    )
    harmonic_patterns = harmonic_pattern_records(config)
    if harmonic_patterns:
        manifest["antenna_patterns"] = harmonic_patterns
        manifest["rf_transmit_radiation_efficiency"] = dict(
            value=transmit_efficiency,
            source="downlink coefficient profile" if "downlink" in harmonic_patterns else "power input",
        )
        manifest["warnings"].append(
            "Spherical harmonics represent supplied complex fields; provenance is supplied with the coefficients, not independently validated installed spacecraft performance."
        )
    if _source_hashes() != source_hashes_at_start:
        raise RuntimeError(
            "Numerical source files changed during mission; retry after implementation is stable"
        )
    summary = dict(
        requested_duration_s=config.duration_s,
        computed_duration_s=orbit.time_s,
        end_reason=end_reason,
        sample_count=len(samples["time_s"]),
        stage_energy=list(stage_energy.values()),
        ideal_capacity_bits={
            d: capacity[d] if capacity_available[d] else None for d in capacity
        },
        capacity_available=capacity_available,
        capacity_kind="ideal_threshold_capacity_not_packet_delivery",
        max_elevation_deg=maximum_elevation,
        max_pointing_error_deg=maximum_pointing,
        max_angular_rate_rad_s=maximum_rate,
        energy_j=totals
        | dict(
            chemical_storage_delta_j=storage_delta,
            thermal_storage_delta_j=thermal_delta,
            rotational_storage_delta_j=rotational_delta,
            closure_residual_j=closure,
        ),
        maximum_quaternion_projection_error=maximum_quaternion_norm_error,
    )
    if progress:
        progress(
            dict(
                completed_time_s=orbit.time_s,
                requested_duration_s=config.duration_s,
                fraction=orbit.time_s / config.duration_s,
                output_samples=len(samples["time_s"]),
                state="finished",
                end_reason=end_reason,
            )
        )
    return dict(manifest=manifest, summary=summary, samples=samples, events=events)


def sum_vectors(vectors):
    return tuple(sum(v[i] for v in vectors) for i in range(3))

"""Fixed-clock mission coupling with one authoritative Cartesian/attitude state.

Loads and geometry are held over each dynamics interval. RF capacity uses that
same grid; it is an ideal threshold integral, never delivered packets. Thermal
forcing is interval-averaged before the separate implicit thermal update.
"""

from dataclasses import replace
from copy import deepcopy
import hashlib
import math
from pathlib import Path
import platform
from ..mission_models import MissionScenario, PointingCommand, mission_execution_limits
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
    allocate_wheel_pd_control,
    wheel_momentum_body,
)
from ..attitude.actuators import (
    allocate_magnetic_torque,
    bdot_dipole,
)
from ..attitude.kinematics import rotate, conjugate, boresight_reference
from ..geometry.vectors import add, cross, dot, scale, norm
from ..geomagnetism.igrf14 import field_ecef_t_at_utc, model_metadata as igrf_metadata
from ..operations.schedule import active_direction
from ..rf.link_budget import evaluate_link_budget
from ..rf.mission_efficiency import mission_downlink_efficiency
from ..rf.pattern_provenance import harmonic_pattern_records
from ..power.solar import pv_generation, pv_extraction
from ..power.battery import advance_battery, capacity_wh
from ..power.battery_electrical import (
    advance_electrical_battery,
    electrical_energy_j,
    electrical_state,
    electrical_model_metadata,
)
from ..power.radio import transmit_power
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
from .geometry import geometry_at, operation_at, target_direction, target_motion
from .defaults import orbit_metadata
from .reporting import MissionReporter
from .runtime import RuntimeDirective

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
        "geomagnetism",
    ):
        paths.update((package / domain).rglob("*.py"))
        paths.update((package / domain).rglob("*.json"))
        paths.update((package / domain).rglob("*.txt"))
    return {
        "cubesat_sim/"
        + p.relative_to(package).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(paths)
    }


def run_mission(config: MissionScenario, cancelled=None, progress=None, runtime=None):
    if not isinstance(config, MissionScenario):
        raise TypeError("Validated MissionScenario required")
    source_hashes_at_start = _source_hashes()
    full_magnetic_field = config.magnetic_model == "igrf14_degree13"
    field_evaluator = field_ecef_t_at_utc if full_magnetic_field else magnetic_field_ecef_t
    dt = config.clocks.dynamics_step_s
    count = round(config.duration_s / dt)
    control_stride = round(config.clocks.controller_period_s / dt)
    thermal_stride = round(config.clocks.thermal_step_s / dt)
    output_stride = round(config.clocks.output_step_s / dt)
    telemetry_stride = None
    telemetry_callback = None
    telemetry_period = getattr(runtime, "telemetry_period_s", None)
    if telemetry_period is not None:
        if (type(telemetry_period) not in (int, float) or not math.isfinite(telemetry_period)
                or telemetry_period <= 0):
            raise ValueError("Live telemetry period must be positive finite seconds")
        telemetry_stride = round(telemetry_period / dt)
        if telemetry_stride < 1 or abs(telemetry_period / dt - telemetry_stride) > 1e-8:
            raise ValueError("Live telemetry period must be integer dynamics ticks")
        telemetry_callback = getattr(runtime, "on_telemetry", None)
        if not callable(telemetry_callback):
            raise ValueError("Live telemetry requires an on_telemetry callback")
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
        wheel_relative_speed_rad_s=tuple(
            w.initial_speed_rpm * 2 * math.pi / 60
            for w in config.spacecraft.wheels
            if w.enabled
        ),
    )
    mechanics0 = mechanical_invariants(body, attitude)
    power = config.power
    downlink_efficiency = mission_downlink_efficiency(config)
    transmit_efficiency = downlink_efficiency.radiation_efficiency
    radio_transmit_power = transmit_power(
        power.spacecraft_tx_electrical_w,
        config.downlink.tx_power_w,
        config.downlink.tx_feed_loss_db,
        transmit_efficiency,
    )
    electrical = power.battery.electrical
    soc = electrical.initial_soc if electrical else None
    last_electrical = None
    energy_capacity_j = (
        electrical_energy_j(power.battery, 1)
        if electrical
        else capacity_wh(power.battery) * 3600
    )
    temperatures = tuple(n.initial_temperature_k for n in power.thermal.nodes)
    temperatures0 = temperatures
    energy0 = energy = (
        electrical_energy_j(power.battery, soc)
        if electrical
        else capacity_wh(power.battery) * 3600 * power.battery.initial_energy_fraction
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
    unloading_status = "disabled"
    unloading_requested = unloading_allocated = (0.0, 0.0, 0.0)
    unloading_command_time_s = None
    capacity = {d: 0.0 for d in ("uplink", "downlink")}
    capacity_available = {d: True for d in capacity}
    radio_delivery = None
    if config.radio_delivery is not None:
        from ..operations.radio_delivery import RadioDeliveryAccumulator
        radio_delivery = RadioDeliveryAccumulator(config.radio_delivery)
    reporting = MissionReporter(config.epoch_utc, delivery_enabled=radio_delivery is not None)
    samples = {}
    stage_energy = {}
    events = []
    previous_operation = None
    command_cutoff_time_s = -1.0
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
        mode, stage_id, window = operation_at(
            config, orbit.time_s, geo["visible"], geo["elevation_deg"],
            command_cutoff_time_s=command_cutoff_time_s,
        )
        target = target_direction(config, geo, sun, mode, window, orbit)
        visibility = sun_visibility(orbit.position_m, sun, power.earth_radius_m)
        field_ecef = field_evaluator(
            geo["satellite_position_ecef_m"], config.epoch_utc, orbit.time_s
        )
        field = ecef_to_inertial(field_ecef, config.epoch_utc, orbit.time_s)
        return geo, sun, mode, stage_id, target, visibility, field, window

    def update_control(geo, sun, mode, target, field, window):
        nonlocal forcing, requested, allocation_residual, field_previous, field_previous_time, mtq_saturated, control_status
        nonlocal unloading_status, unloading_requested, unloading_allocated, unloading_command_time_s
        field_body = rotate(attitude.q_body_from_inertial_wxyz, field)
        motors = (0.0,) * len(body.wheels)
        dipole = (0.0, 0.0, 0.0)
        requested = (0.0, 0.0, 0.0)
        allocation_residual = (0.0, 0.0, 0.0)
        mtq_saturated = False
        control_status = "coast"
        unloading_requested = unloading_allocated = (0.0, 0.0, 0.0)
        unloading_command_time_s = None
        if not config.spacecraft.magnetic_unloading_enabled:
            unloading_status = "disabled"
        elif config.spacecraft.controller != "quaternion_pd" or mode == "detumble":
            unloading_status = "controller_inactive"
        elif (
            not body.wheels
            or body.magnetorquer is None
            or body.magnetorquer.max_dipole_am2 == 0
        ):
            unloading_status = "hardware_unavailable"
        else:
            unloading_status = "active"
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
            if config.spacecraft.pointing_reference == "moving_boresight":
                motion = target_motion(
                    config, geo, mode, window, orbit,
                    orbit_config.gravity.acceleration_m_s2(orbit.position_m),
                )
                reference = AttitudeReference(
                    reference.q_reference_from_inertial_wxyz,
                    motion.omega_inertial_rad_s,
                    motion.alpha_inertial_rad_s2,
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
                wheel_allocation = allocate_wheel_pd_control(
                    body,
                    attitude,
                    requested,
                    field_body,
                    (
                        config.spacecraft.magnetic_unloading_time_constant_s
                        if unloading_status == "active"
                        else None
                    ),
                )
                motors = wheel_allocation.wheel_motor_torques_nm
                control_status = "wheel_pd"
                if wheel_allocation.unloading is not None:
                    allocation = wheel_allocation.unloading
                    dipole = allocation.dipole_body_am2
                    mtq_saturated = allocation.dipole_saturated
                    unloading_requested = allocation.requested_torque_body_nm
                    unloading_allocated = allocation.torque_body_nm
                    unloading_command_time_s = orbit.time_s
                    if allocation.field_has_authority:
                        control_status = "wheel_pd_magnetic_unloading"
                    else:
                        unloading_status = "field_unavailable"
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

    def append_sample(*, store=True):
        nonlocal maximum_pointing, maximum_rate, maximum_elevation
        geo, sun, mode, stage_id, target, visibility, field, window = state_geometry()
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
        if store:
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
            if store and link["ideal_rate_bps"] is None:
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
                wheel_momentum_body_nms=wheel_momentum_body(body, attitude),
                wheel_momentum_norm_nms=norm(wheel_momentum_body(body, attitude)),
                unloading_requested_torque_body_nm=unloading_requested,
                unloading_allocated_torque_body_nm=unloading_allocated,
                unloading_achieved_torque_body_nm=(
                    report.magnetic_torque_body_nm
                    if unloading_status == "active"
                    else (0.0, 0.0, 0.0)
                ),
                unloading_command_time_s=unloading_command_time_s,
                unloading_status=unloading_status,
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
                energy_fraction=energy / energy_capacity_j,
                sun_visibility=visibility,
                battery_voltage_v=(
                    last_electrical.voltage_v
                    if last_electrical
                    else (
                        electrical_state(power.battery, soc)[
                            "battery_open_circuit_voltage_v"
                        ]
                        if electrical
                        else None
                    )
                ),
                battery_current_a=(
                    last_electrical.current_a
                    if last_electrical
                    else (0.0 if electrical else None)
                ),
                battery_electrical_reason=(
                    electrical.model if electrical else "capacity_only_energy_model"
                ),
                **(
                    dict(
                        **electrical_state(power.battery, soc),
                        battery_terminal_power_w=(
                            last_electrical.terminal_power_w if last_electrical else 0.0
                        ),
                        battery_ohmic_heat_w=(
                            last_electrical.ohmic_heat_w if last_electrical else 0.0
                        ),
                        battery_mean_resistance_ohm=(
                            last_electrical.mean_resistance_ohm
                            if last_electrical
                            else electrical_state(power.battery, soc)[
                                "battery_resistance_ohm"
                            ]
                        ),
                        battery_temperature_outside_reference=(
                            abs(
                                temperatures[nodes.index(electrical.heat_node_id)]
                                - 298.15
                            )
                            > 1
                        ),
                    )
                    if electrical
                    else {}
                ),
                component_electrical_w={
                    key: last_components.get(key, 0.0) for key in sorted(component_ids)
                },
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
        if radio_delivery is not None:
            row["radio_delivery"] = radio_delivery.sample()
        if store:
            _append(samples, row)
            if runtime is not None:
                runtime.on_sample(deepcopy(row))
        if telemetry_callback is not None:
            telemetry_callback(deepcopy(row))

    component_ids = {
        "radio",
        "wheels",
        "magnetorquers",
        *[load.component_id for profile in power.mode_loads for load in profile.loads],
    }
    progress_stride = max(1, round(10 / dt), math.ceil(count / 10000))
    for tick in range(count):
        if tick % 16 == 0 and cancelled and cancelled():
            raise InterruptedError("Mission cancelled")
        if config.stop_time_s is not None and tick >= round(config.stop_time_s / dt):
            end_reason = "user_stop"
            events.append(dict(time_s=orbit.time_s, type="terminated", reason=end_reason))
            break
        if runtime is not None:
            directive = runtime.before_step(orbit.time_s, tick % control_stride == 0)
            if directive is not None and not isinstance(directive, RuntimeDirective):
                raise TypeError("Runtime before_step must return RuntimeDirective or None")
            if directive is not None and directive.stop:
                config = MissionScenario.model_validate(
                    config.model_dump(mode="json") | dict(stop_time_s=orbit.time_s)
                )
                end_reason = "user_stop"
                events.append(dict(time_s=orbit.time_s, type="terminated", reason=end_reason))
                break
            if directive is not None and directive.commands:
                if tick % control_stride:
                    raise ValueError("Runtime pointing commands require a controller boundary")
                accepted = tuple(PointingCommand.model_validate(
                    intent.model_dump(mode="json") | dict(effective_time_s=orbit.time_s)
                ) for intent in directive.commands)
                combined = sorted(
                    (*(config.pointing_commands or ()), *accepted),
                    key=lambda command: command.effective_time_s,
                )
                config = MissionScenario.model_validate(
                    config.model_dump(mode="json") | dict(
                        pointing_commands=[command.model_dump(mode="json") for command in combined]
                    )
                )
                for command in accepted:
                    runtime.on_command(deepcopy(command.model_dump(mode="json")))
        command_cutoff_time_s = orbit.time_s
        for command in config.pointing_commands or ():
            if round(command.effective_time_s / dt) == tick:
                events.append(dict(
                    time_s=orbit.time_s, type="pointing_command",
                    command=command.model_dump(mode="json"),
                ))
        geo, sun, mode, stage_id, target, visibility, field, window = state_geometry()
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
            update_control(geo, sun, mode, target, field, window)
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
        escaped_rf = radio_transmit_power.escaped_rf_w if transmit else 0.0
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
        battery = (
            advance_electrical_battery(
                power.battery,
                soc,
                potential_bus,
                requested_w,
                dt,
                temperatures[nodes.index(electrical.heat_node_id)],
            )
            if electrical
            else advance_battery(power.battery, energy, potential_bus, requested_w, dt)
        )
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
            pv_extraction(panel, flow, extraction, power.regulator_efficiency)
            for panel, flow in zip(power.panels, potential)
        )
        heat = {node: 0.0 for node in nodes}
        for panel, flow in zip(power.panels, pv):
            heat[panel.thermal_node_id] -= flow.terminal_w
        regulator = sum(flow.regulator_heat_w for flow in pv)
        heat[power.regulator_heat_node_id] += regulator
        heat[
            electrical.heat_node_id if electrical else power.storage_loss_heat_node_id
        ] += battery.storage_loss_w
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
        if electrical:
            last_electrical = battery
        if tick == 0:
            append_sample()
        interval_links = {}
        for d in capacity:
            interval_links[d] = evaluate_link_budget(
                config, d, geo, radio_active and direction == d
            )
            rate = interval_links[d]["ideal_rate_bps"]
            if rate is None:
                capacity_available[d] = False
            elif capacity_available[d]:
                capacity[d] += rate * dt
        def delivery_interval(start_s, end_s):
            before = radio_delivery.sample()
            radio_delivery.advance(
                start_s, end_s, active_direction=direction, radio_active=radio_active,
                cn0_db_hz={d: interval_links[d]["cn0_dbhz"] for d in capacity},
                known_outage={
                    d: interval_links[d]["reason"] == "field_or_polarization_null"
                    for d in capacity
                },
            )
            after = radio_delivery.sample()
            increments = {}
            for d in capacity:
                unresolved = (after[d]["unresolved_time_s"] > before[d]["unresolved_time_s"]
                              or after[d]["unresolved_frames"] > before[d]["unresolved_frames"])
                old_bits = before[d]["delivered_useful_bits"]
                new_bits = after[d]["delivered_useful_bits"]
                increments[d] = dict(
                    delivered_useful_bits=(new_bits - old_bits
                                           if old_bits is not None and new_bits is not None else 0),
                    delivery_available=not unresolved and new_bits is not None,
                    receiver_locked_s=after[d]["locked_time_s"] - before[d]["locked_time_s"],
                    receiver_ready_s=after[d]["ready_time_s"] - before[d]["ready_time_s"],
                    boundary_delivered_useful_bits=after[d]["boundary_delivered_useful_bits"],
                    boundary_delivered_frames=after[d]["boundary_delivered_frames"],
                    boundary_unresolved_frames=after[d]["boundary_unresolved_frames"],
                )
            return increments
        reporting.advance(
            tick * dt, (tick + 1) * dt,
            visible=geo["visible"], elevation_deg=geo["elevation_deg"],
            radio_active=radio_active, direction=direction,
            ideal_rates_bps={d: interval_links[d]["ideal_rate_bps"] for d in capacity},
            delivery_interval=delivery_interval if radio_delivery is not None else None,
        )
        energy = battery.stored_energy_j
        if electrical:
            soc = battery.soc
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
        elif telemetry_stride is not None and completed_ticks % telemetry_stride == 0:
            append_sample(store=False)
        if progress and (
            completed_ticks % progress_stride == 0 or completed_ticks == count
        ):
            progress(
                dict(
                    completed_time_s=orbit.time_s,
                    requested_duration_s=config.duration_s,
                    fraction=completed_ticks / count,
                    output_samples=len(samples.get("time_s", [])),
                    state="running",
                    reporting=reporting.snapshot(include_passes=False),
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
            magnetic=("IGRF14-degree13-2025-SV" if full_magnetic_field else MAGNETIC_MODEL),
        ),
        time=dict(
            elapsed_scale="SI seconds; POSIX UTC labels; no leap second dynamics",
            **orbit_metadata(config.orbit.elements),
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
        prefix_semantics="completed result is immutable; bounded UTC day progress summaries are live but samples are not streamed; termination retains last valid common-state prefix; no resume checkpoint",
        execution_limits=mission_execution_limits(config),
        source_code_hashes=source_hashes_at_start,
        source_identity_capture="disk source hashes at run start, checked again before result publication; API uses fresh isolated process",
        versions=dict(python=platform.python_version()),
        sources=[
            dict(
                url=IGRF_URL,
                scope=(
                    "IGRF-14 degree 13 internal field, 2025 coefficients with degree 8 secular variation through 2030"
                    if full_magnetic_field else "IGRF-14 degree 1 reference, 2025 coefficients with secular variation through 2030"
                ),
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
            (
                "Full degree 13 IGRF-14 internal main field with degree 8 secular variation. External disturbance fields and local spacecraft fields are omitted; no magnetic sensor model."
                if full_magnetic_field else "Degree1-only IGRF14 reference omits degree2..13 and external magnetic disturbances; not an IGRF accuracy claim."
            ),
            (
                "Moving-boresight reduced-attitude guidance uses zero-twist target angular rate and acceleration with optional full rate-error damping. Instantaneous mode switches require physical acquisition slews; actuator limits and sampled control remain. No optimal tracking or polarization-roll guarantee."
                if config.spacecraft.pointing_reference == "moving_boresight"
                else "Free-roll instantaneous minimum-rotation guidance, optional full angular-rate damping, zero target-rate feedforward; actual rigid-body dynamics and actuator limits determine pointing."
            ),
            "MTQ quadratic axis watts are an explicit example assumption. No cellOCV/current/voltage/temperaturecapacity or hardware brownout dynamics.",
            "Uniform spherical Earth albedo/IR and hard geometric eclipse; held environment flux, fixed deployed panels, no selfshadow or geographic weather.",
            "Ideal threshold radio capacity only, not delivered packets, acquisition, mount servos or hardware receiver performance.",
            "Power demand that cannot be served terminates at last valid shared-state prefix; postbrownout dynamics are not modeled.",
        ],
    )
    if config.pointing_commands is not None or config.stop_time_s is not None:
        manifest["runtime_control"] = dict(
            model="continuous_integrator_pointing_commands_v1",
            command_times="Core-stamped controller boundaries; same-time commands retain order and the last controls the mode. Auto restores configured CONOPS.",
            telemetry="Copied physical rows after the preceding accepted interval and before commands received at that boundary. Initial t=0 follows initial command acceptance and uses first-interval power unless stopped before any interval.",
            stopping="User stop preserves the common-state prefix, flushes partial thermal accumulation and records stop_time_s for exact production replay.",
            clocks="Pacing and pause are I/O only; all numerical clocks remain the scenario clocks.",
        )
    if config.spacecraft.pointing_reference == "moving_boresight":
        manifest["pointing_reference"] = dict(
            model="moving_boresight_zero_twist_v1",
            angular_rate="omega_I = rho cross rho_dot / dot(rho,rho)",
            angular_acceleration="alpha_I = rho cross rho_ddot / dot(rho,rho) - 2*dot(rho,rho_dot)/dot(rho,rho)*omega_I",
            roll_policy="Zero reference twist about target; roll angle is free. Optional damping acts on full angular-rate error.",
            clocks="Reference evaluated at controller updates and operation events; motor/dipole commands held between updates.",
            limits="Truth state and approximate mission ephemeris; no estimator, anticipatory acquisition, bounded trajectory optimization or polarization roll constraint.",
        )
        manifest["sources"].extend([
            dict(url="https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/dvhat_c.html", locator="Particulars and Example1", scope="Unit LOS derivative and angular sky rate; zero-twist vector formula derived from udot=omega cross u"),
            dict(url="https://hanspeterschaub.info/basilisk/_downloads/60d29bf47a58b1d4a34f79e83abf922a/Basilisk-attTrackingError-20190220.pdf", locator="rev1.1 (2019-02-20),sections1.3-1.5,equations11-15", scope="Moving reference rate/acceleration rotation into body axes and angular-rate tracking error"),
        ])
    if full_magnetic_field:
        manifest["geomagnetic_model"] = igrf_metadata()
    if electrical:
        manifest["battery_electrical"] = electrical_model_metadata() | dict(
            configuration=electrical.model_dump(mode="json"),
            pack_capacity_c=power.battery.cells.parallel_count
            * power.battery.cells.cell_capacity_mah
            * 3.6,
            chemical_full_energy_j=energy_capacity_j,
            initial_energy_j=energy0,
            telemetry="SOC, remaining charge, open circuit voltage and resistance are sampled state; terminal voltage/current/power, mean resistance and ohmic heat refer to the preceding accepted dynamics interval (initial sample uses first accepted interval); positive current/power discharge",
        )
        manifest["warnings"] = [
            warning.replace(
                " No cellOCV/current/voltage/temperaturecapacity or hardware brownout dynamics.",
                "",
            )
            for warning in manifest["warnings"]
        ]
        manifest["warnings"].extend(manifest["battery_electrical"]["limits"])
    if config.spacecraft.magnetic_unloading_enabled:
        manifest["magnetic_unloading"] = dict(
            law="desired external torque = -H_w / time_constant; minimum-norm m = B cross torque / |B|^2, with total-norm dipole saturation",
            time_constant_s=config.spacecraft.magnetic_unloading_time_constant_s,
            controller_hold_s=config.clocks.controller_period_s,
            ideal_static_field_rest_update_multiplier=(
                1
                - config.clocks.controller_period_s
                / config.spacecraft.magnetic_unloading_time_constant_s
            ),
            target="H_w = sum(axis_i * h_i), absolute rotor axial h_i = J_i*(relative_speed_i + axis_i dot body_rate); zero aggregate vector target",
            compensation="Wheel allocation uses actual allocated magnetic torque at controller update; finite wheel span/torque/speed/power and subsequent field motion retain actual residual",
            command_hold="PD, unloading dipole and compensated wheel motor commands held until controller update or operation event; sampled achieved unload torque is zero while unloading inactive",
            telemetry="unloading requested/allocated vectors refer to unloading_command_time_s; achieved is at the sample state; power samples retain preceding-interval averages",
            limits="Truth-state reference only. Instantaneously field-parallel momentum and redundant-wheel nullspace are uncontrolled; no general individual-wheel desaturation or tracking guarantee.",
            source=dict(
                url="https://www.hanspeterschaub.info/PapersPrivate/Hogan2015a.pdf",
                locator="Hogan & Schaub (2015), JGCD 38(10), equations (2), (3), (17), (21)-(26)",
                scope="absolute wheel momentum, projected magnetic torque and achieved-torque wheel compensation; not the paper's complete nonlinear controller/stability guarantee",
            ),
        )
        if (
            config.spacecraft.magnetic_unloading_time_constant_s
            < config.clocks.controller_period_s
        ):
            manifest["warnings"].append(
                "Unloading time constant is shorter than the controller hold. In the ideal rest/static-field unsaturated scalar limit, each update multiplies available wheel momentum by 1-Tc/T: T<Tc alternates sign, T=Tc/2 has no decay, and T<Tc/2 is unstable. This is a sampled-reference limit, not a universal mission stability result."
            )
    if power.analytical_efficiency_semantics is not None:
        manifest["downlink_efficiency"] = downlink_efficiency.record()
    harmonic_patterns = harmonic_pattern_records(config)
    if harmonic_patterns:
        manifest["antenna_patterns"] = harmonic_patterns
        manifest["rf_transmit_radiation_efficiency"] = dict(
            value=transmit_efficiency,
            source=(
                "downlink coefficient profile"
                if "downlink" in harmonic_patterns
                else "power input"
            ),
        )
        manifest["warnings"].append(
            "Spherical harmonics represent supplied complex fields; provenance is supplied with the coefficients, not independently validated installed spacecraft performance."
        )
    if _source_hashes() != source_hashes_at_start:
        raise RuntimeError(
            "Numerical source files changed during mission; retry after implementation is stable"
        )
    reporting.finish(geometry_at(config, orbit, attitude)["visible"])
    summary = dict(
        reporting=reporting.snapshot(),
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
    if radio_delivery is not None:
        summary["radio_delivery"] = radio_delivery.summary()
        manifest["radio_delivery"] = radio_delivery.metadata() | dict(
            configuration=config.radio_delivery.model_dump(mode="json"),
            channel_semantics="C/N0 held on accepted dynamics intervals; receiver and frame timing split at UTC midnight without changing physics clocks",
            driver_limits="Explicit assumed acquisition/lock/frame policy; no hardware correlation, packet acknowledgements or retransmission guarantees",
        )
        receiver_events = [
            event | {"type": "radio_delivery"}
            for event in radio_delivery.events
            if 0 <= event["time_s"] <= orbit.time_s
        ]
        receiver_event_limit = 20000
        omitted = max(0, len(receiver_events) - receiver_event_limit)
        receiver_events = receiver_events[:receiver_event_limit]
        manifest["radio_delivery"]["events_dropped"] += omitted
        manifest["radio_delivery"]["event_export"] = dict(
            maximum_receiver_events=receiver_event_limit,
            exported_receiver_events=len(receiver_events),
            outside_computed_prefix=sum(
                not 0 <= event["time_s"] <= orbit.time_s
                for event in radio_delivery.events
            ),
            order="Stable by time; mission events precede receiver events at ties; receiver causal and direction tie order is preserved",
        )
        events.extend(receiver_events)
        events.sort(key=lambda event: event["time_s"])
    if config.duration_s > 86400:
        manifest["warnings"].append(
            "Week/month results extend the same approximate fixed-epoch frame, central/J2 gravity, selected internal magnetic field and provisional hardware models. No drag, orbit determination, calibrated receiver reliability or mission-lifetime accuracy is established."
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
                reporting=reporting.snapshot(include_passes=False),
            )
        )
    return dict(manifest=manifest, summary=summary, samples=samples, events=events)


def sum_vectors(vectors):
    return tuple(sum(v[i] for v in vectors) for i in range(3))

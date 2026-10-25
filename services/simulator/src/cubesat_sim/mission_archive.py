"""Bounded, data-only mission replay archives; integrity is not authenticity.

This module never computes a mission, resolves archived paths, imports code from
an archive, or compares recorded numerical sources with currently installed code.
"""
from __future__ import annotations

import hashlib
import json
import math
import re

from .mission_models import MissionScenario

FORMAT = "ssi-coupled-mission"
VERSION = 1
CANONICALIZATION = "ssi-json-v1"
ARCHIVE_PATHS = frozenset({"/api/mission/archive/export", "/api/mission/archive/import"})
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_SAMPLES = 20001
MAX_DEPTH = 24
MAX_NODES = 5_000_000
MAX_STRING = 1024 * 1024
HASH = re.compile(r"[0-9a-f]{64}\Z")
STOP_REASONS = {
    "power_unserved", "dynamics_step_too_large", "quaternion_integration_accuracy_guard",
}
ENERGY_FIELDS = {
    "generated_bus_j", "requested_load_j", "served_load_j", "pv_terminal_j",
    "regulator_loss_j", "storage_loss_j", "escaped_rf_j", "other_export_j",
    "wheel_bus_j", "wheel_heat_j", "magnetorquer_bus_j", "external_mechanical_work_j",
    "absorbed_environment_j", "emitted_ir_j", "thermal_residual_j", "battery_residual_j",
    "mechanical_residual_j", "chemical_storage_delta_j", "thermal_storage_delta_j",
    "rotational_storage_delta_j", "closure_residual_j",
}
BOOLEAN_SERIES = {
    "samples.visible", "samples.radio_active", "samples.uplink.valid", "samples.downlink.valid",
    "samples.gnc.wheel_saturated", "samples.gnc.magnetic_saturated",
}
TEXT_SERIES = {
    "samples.elapsed_ns", "samples.active_direction", "samples.mode", "samples.stage_id",
    "samples.uplink.reason", "samples.downlink.reason", "samples.gnc.controller_status",
    "samples.gnc.unloading_status", "samples.power.battery_electrical_reason",
}
UNLOADING_FIELDS = {
    "wheel_momentum_body_nms", "wheel_momentum_norm_nms",
    "unloading_requested_torque_body_nm", "unloading_allocated_torque_body_nm",
    "unloading_achieved_torque_body_nm", "unloading_command_time_s", "unloading_status",
}


class ArchiveError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ArchiveError(message)


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def content_digest(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _reject_constant(_value):
    raise ArchiveError("Archive numbers must be finite JSON numbers")


def _float(value):
    result = float(value)
    require(math.isfinite(result), "Archive numbers must be finite")
    return result


def _object_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON object keys are unsupported")
        result[key] = value
    return result


def _bounded_tree(value):
    pending = [(value, 0)]
    count = 0
    while pending:
        item, depth = pending.pop()
        count += 1
        require(count <= MAX_NODES, "Archive exceeds the decoded node limit")
        require(depth <= MAX_DEPTH, "Archive nesting exceeds the depth limit")
        if type(item) is dict:
            require(len(item) <= MAX_SAMPLES, "Archive object has too many fields")
            for key, child in item.items():
                require(type(key) is str and len(key) <= 512, "Archive keys must be bounded strings")
                pending.append((child, depth+1))
        elif type(item) is list:
            require(len(item) <= 100000, "Archive array exceeds its item limit")
            pending.extend((child, depth+1) for child in item)
        elif type(item) is str:
            require(len(item) <= MAX_STRING, "Archive string exceeds its size limit")
        elif type(item) is float:
            require(math.isfinite(item), "Archive numbers must be finite")
        elif type(item) is int:
            require(abs(item) <= 9007199254740991, "Archive integer exceeds exact browser precision")
        else:
            require(item is None or type(item) is bool, "Archive contains an unsupported value type")


def parse_json(data: bytes):
    require(type(data) is bytes and len(data) <= MAX_ARCHIVE_BYTES, "Archive exceeds the 64 MiB byte limit")
    depth, quoted, escaped = 0, False, False
    for byte in data:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (91, 123):
            depth += 1
            require(depth <= MAX_DEPTH, "Archive nesting exceeds the depth limit")
        elif byte in (93, 125):
            depth -= 1
    try:
        value = json.loads(data.decode("utf-8"), parse_constant=_reject_constant,
                           parse_float=_float, object_pairs_hook=_object_pairs)
    except (UnicodeError, ValueError, RecursionError, OverflowError) as error:
        if isinstance(error, ArchiveError):
            raise
        raise ArchiveError("Invalid or truncated archive JSON") from error
    _bounded_tree(value)
    return value


def _keys(value, required, optional=(), path="object"):
    require(type(value) is dict, f"{path} must be an object")
    require(set(required) <= value.keys(), f"{path} is missing required fields")
    require(value.keys() <= set(required) | set(optional), f"{path} contains unsupported fields")


def _number(value, path, *, minimum=-1e100, maximum=1e100, nullable=False):
    if value is None and nullable:
        return
    require(type(value) in (int, float) and math.isfinite(value), f"{path} must be a finite number")
    require(minimum <= value <= maximum, f"{path} is outside the supported range")


def _integer(value, path, minimum=0, maximum=1_000_000):
    require(type(value) is int and minimum <= value <= maximum, f"{path} must be a bounded integer")


def _text(value, path, maximum=1000):
    require(type(value) is str and 0 < len(value) <= maximum, f"{path} must be a bounded nonempty string")


def _typed_projection(raw, typed, path="scenario"):
    """Normalize existing declared numeric types; never add default fields.

    A browser loses the lexical distinction between 1.0 and 1. The projected
    candidate restores schema-declared number types for identity comparison,
    while the archived snapshot itself remains unchanged.
    """
    if type(typed) is dict:
        require(type(raw) is dict and raw.keys() <= typed.keys(), f"{path} has unsupported fields")
        return {key: _typed_projection(value, typed[key], f"{path}.{key}") for key, value in raw.items()}
    if type(typed) is list:
        require(type(raw) is list and len(raw) == len(typed), f"{path} has an invalid array shape")
        return [_typed_projection(a, b, path) for a, b in zip(raw, typed)]
    if type(typed) is bool:
        require(type(raw) is bool, f"{path} must be Boolean")
    elif type(typed) is int:
        require(type(raw) is int, f"{path} must be an integer")
    elif type(typed) is float:
        require(type(raw) in (int, float), f"{path} must be a number")
    else:
        require(type(raw) is type(typed), f"{path} has an invalid scalar type")
    require(raw == typed, f"{path} is not a canonical scenario value")
    return typed


def _scenario(raw):
    require(type(raw) is dict, "scenario must be an object")
    try:
        model = MissionScenario.model_validate(raw)
    except (ValueError, TypeError, ArithmeticError) as error:
        raise ArchiveError("Archive scenario is unsupported or invalid") from error
    projected = _typed_projection(raw, model.model_dump(mode="json"))
    return model, projected


def _column(samples, path):
    value = samples
    for key in path.split("."):
        require(type(value) is dict and key in value, f"samples.{path} is required")
        value = value[key]
    require(type(value) is list, f"samples.{path} must be a series")
    return value


def _all_series(value, count, path="samples"):
    if type(value) is dict:
        for key, child in value.items():
            _all_series(child, count, f"{path}.{key}")
    else:
        require(type(value) is list and len(value) == count, f"{path} has an inconsistent sample count")
        for row in value:
            require(type(row) in (int, float, bool, str, list) or row is None,
                    f"{path} contains an invalid sample")
            if type(row) is list:
                require(all(type(v) in (int, float) for v in row), f"{path} vectors must contain numbers")
            elif type(row) is str:
                require(path in TEXT_SERIES and len(row) <= 2000, f"{path} does not accept sample text")
            elif type(row) is bool:
                require(path in BOOLEAN_SERIES, f"{path} does not accept Booleans as numbers")
            elif row is not None:
                _number(row, path)


def _numbers(samples, path, **limits):
    for value in _column(samples, path):
        _number(value, "samples."+path, **limits)


def _vectors(samples, path, size=3, *, unit=False, maximum=1e100):
    for row in _column(samples, path):
        require(type(row) is list and len(row) == size, f"samples.{path} requires {size}-component vectors")
        for value in row:
            _number(value, "samples."+path, maximum=maximum, minimum=-maximum)
        if unit:
            require(abs(math.hypot(*row)-1) <= 1e-6, f"samples.{path} requires unit vectors/quaternions")


def _booleans(samples, path):
    require(all(type(v) is bool for v in _column(samples, path)), f"samples.{path} requires Booleans")


def _choice(samples, path, choices):
    require(all(type(v) is str and v in choices for v in _column(samples, path)), f"samples.{path} has an unsupported value")


def _validate_samples(samples, model, summary):
    require(type(samples) is dict, "result.samples must be an object")
    times = _column(samples, "time_s")
    require(1 <= len(times) <= MAX_SAMPLES, "Archive supports 1..20001 samples")
    _all_series(samples, len(times))
    time_tolerance = max(1e-12, 32*math.ulp(model.duration_s))
    for time in times:
        _number(time, "sample time", minimum=0, maximum=model.duration_s+time_tolerance)
    require(times[0] == 0, "Mission samples must begin at zero")
    require(all(a < b for a, b in zip(times, times[1:])), "Mission sample times must increase strictly")
    dt, output = model.clocks.dynamics_step_s, model.clocks.output_step_s
    require(all(abs(t/dt-round(t/dt)) <= 1e-7 for t in times), "Samples must lie on dynamics ticks")
    require(all(abs(t-i*output) <= 1e-7 for i, t in enumerate(times[:-1])), "Intermediate samples must follow the output clock")
    if len(times) > 1:
        require(times[-1]-times[-2] <= output+1e-7, "Final sample skips an output interval")
    require(abs(times[-1]-summary["computed_duration_s"]) <= 1e-7, "Final sample differs from computed duration")
    require(summary["sample_count"] == len(times), "Summary sample count disagrees with arrays")
    elapsed = _column(samples, "elapsed_ns")
    require(all(type(v) is str and v == str(round(t*1e9)) for t, v in zip(times, elapsed)),
            "Elapsed nanosecond strings disagree with sample times")
    for name in ("satellite_position_m", "station_position_m", "satellite_position_ecef_m", "station_position_ecef_m"):
        _vectors(samples, name, maximum=1e12)
        require(all(math.hypot(*row) > 1 for row in _column(samples, name)), "Position vectors cannot be zero")
    _vectors(samples, "satellite_velocity_m_s", maximum=1e9)
    _vectors(samples, "q_body_from_inertial_wxyz", size=4, unit=True, maximum=1.000001)
    for name in ("sun_direction_inertial", "sun_direction_ecef"):
        _vectors(samples, name, unit=True, maximum=1.000001)
    for name in ("range_m",):
        _numbers(samples, name, minimum=1e-9, maximum=2e12)
    for name in ("range_rate_m_s", "ecef_from_inertial_angle_rad", "attitude_angle_deg", "elevation_deg", "azimuth_deg"):
        _numbers(samples, name)
    for name in ("visible", "radio_active"):
        _booleans(samples, name)
    _choice(samples, "active_direction", {"uplink", "downlink"})
    _choice(samples, "mode", {"sun_pointing", "ground_tracking", "imaging", "detumble"})
    for value in _column(samples, "stage_id"):
        _text(value, "stage_id", 256)
    for direction in ("uplink", "downlink"):
        for name in ("received_power_dbw", "cn0_dbhz", "esn0_db", "margin_db", "polarization_coupling",
                     "polarization_loss_db", "tx_gain_dbi", "rx_gain_dbi", "ideal_rate_bps", "cumulative_ideal_bits"):
            _numbers(samples, direction+"."+name, nullable=True)
        for name in ("fspl_db", "noise_density_dbw_hz", "doppler_hz"):
            _numbers(samples, direction+"."+name)
        _booleans(samples, direction+".valid")
        _numbers(samples, direction+".polarization_coupling", minimum=0, maximum=1, nullable=True)
        _numbers(samples, direction+".ideal_rate_bps", minimum=0, nullable=True)
        for value in _column(samples, direction+".reason"):
            _text(value, "link reason", 256)
        cumulative = _column(samples, direction+".cumulative_ideal_bits")
        require(all(v is None for v in cumulative) or
                (all(type(v) in (int, float) and v >= 0 for v in cumulative)
                 and all(a <= b for a, b in zip(cumulative, cumulative[1:]))),
                "Cumulative capacity must be nondecreasing or wholly unresolved")
        require(cumulative[-1] == summary["ideal_capacity_bits"][direction], "Summary capacity disagrees with final sample")
    for name in ("omega_body_rad_s", "requested_torque_body_nm", "actual_torque_body_nm",
                 "residual_torque_body_nm", "magnetic_field_body_t", "magnetic_dipole_body_am2"):
        _vectors(samples, "gnc."+name)
    wheel_count = sum(w.enabled for w in model.spacecraft.wheels)
    for name in ("wheel_relative_speed_rad_s", "wheel_absolute_axial_momentum_nms", "wheel_speed_utilization"):
        _vectors(samples, "gnc."+name, size=wheel_count)
    for name in ("wheel_saturated", "magnetic_saturated"):
        _booleans(samples, "gnc."+name)
    for value in _column(samples, "gnc.controller_status"):
        _text(value, "controller status", 256)
    present = UNLOADING_FIELDS & samples["gnc"].keys()
    require(not present or present == UNLOADING_FIELDS, "Unloading telemetry is incomplete")
    if present:
        for name in ("wheel_momentum_body_nms", "unloading_requested_torque_body_nm",
                     "unloading_allocated_torque_body_nm", "unloading_achieved_torque_body_nm"):
            _vectors(samples, "gnc."+name)
        _numbers(samples, "gnc.wheel_momentum_norm_nms", minimum=0)
        _numbers(samples, "gnc.unloading_command_time_s", minimum=0, maximum=times[-1], nullable=True)
        require(all(v is None or v <= t+1e-7 for t, v in zip(times, samples["gnc"]["unloading_command_time_s"])), "Unloading command time exceeds sample time")
        _choice(samples, "gnc.unloading_status", {"disabled", "controller_inactive", "hardware_unavailable", "field_unavailable", "active"})
    for name in ("pv_available_mpp_w", "pv_terminal_w", "generated_bus_w", "potential_bus_w",
                 "requested_load_w", "served_load_w", "unserved_load_w", "curtailed_bus_w",
                 "charge_bus_w", "discharge_bus_w", "storage_loss_w", "regulator_heat_w",
                 "escaped_rf_w", "net_bus_w", "stored_energy_j", "stored_energy_wh",
                 "energy_fraction", "actuator_bus_w", "actuator_heat_w", "sun_visibility"):
        _numbers(samples, "power."+name)
    for name in ("energy_fraction", "sun_visibility"):
        _numbers(samples, "power."+name, minimum=0, maximum=1+1e-9)
    for name in ("battery_voltage_v", "battery_current_a"):
        _numbers(samples, "power."+name, nullable=True)
    for value in _column(samples, "power.battery_electrical_reason"):
        _text(value, "battery electrical-model status", 256)
    require(type(samples["power"].get("component_electrical_w")) is dict, "Component power series are required")
    for column in samples["power"]["component_electrical_w"].values():
        for value in column:
            _number(value, "component electrical power")
    nodes = {n.node_id for n in model.power.thermal.nodes}
    for name in ("node_temperature_k", "node_internal_heat_w", "node_net_heat_w",
                 "node_absorbed_environment_w", "node_emitted_ir_w"):
        columns = samples.get("thermal", {}).get(name)
        require(type(columns) is dict and set(columns) == nodes, "Thermal node series disagree with scenario")
        for node in nodes:
            # Node IDs are keys, not paths to resolve or code to execute.
            for value in columns[node]:
                _number(value, "thermal node sample", minimum=1e-9 if name == "node_temperature_k" else -1e100)
    return len(times)


def validate_snapshot(snapshot):
    _bounded_tree(snapshot)
    _keys(snapshot, {"scenario", "run"}, path="snapshot")
    model, projected = _scenario(snapshot["scenario"])
    run = snapshot["run"]
    _keys(run, {"run_id", "status", "scenario_id", "scenario_hash", "result", "error"}, {"progress"}, "run")
    _text(run["run_id"], "run_id", 160)
    require(run["status"] == "complete" and run["error"] is None, "Only finished complete run records can be archived")
    digest = run["scenario_hash"]
    require(type(digest) is str and HASH.fullmatch(digest), "Invalid scenario hash")
    require(digest in (content_digest(snapshot["scenario"]), content_digest(projected)), "Scenario identity does not match archived inputs")
    require(run["scenario_id"] == "mission-"+digest[:16], "Scenario ID disagrees with its hash")
    result = run["result"]
    _keys(result, {"manifest", "summary", "samples", "events"}, path="result")
    manifest, summary = result["manifest"], result["summary"]
    require(type(manifest) is dict and type(summary) is dict, "Manifest and summary must be objects")
    require(manifest.get("schema_version") == "0.1.0", "Unsupported mission result schema version")
    _text(manifest.get("model_version"), "model version", 160)
    require(manifest.get("scenario_id") == run["scenario_id"] and manifest.get("scenario_hash") == digest,
            "Run and manifest scenario identities disagree")
    archived_scenario = manifest.get("scenario")
    _scenario(archived_scenario)
    require(archived_scenario == snapshot["scenario"], "Manifest scenario conflicts with snapshot inputs")
    require("partial" not in manifest or manifest["partial"] is False,
            "A partial result cannot be imported as complete")
    hashes = manifest.get("source_code_hashes")
    require(type(hashes) is dict and 1 <= len(hashes) <= 2048, "Recorded source hashes are required")
    require(all(type(key) is str and type(value) is str and HASH.fullmatch(value) for key, value in hashes.items()),
            "Recorded source hashes must contain SHA-256 digests")
    time_tolerance = max(1e-12, 32*math.ulp(model.duration_s))
    for key in ("requested_duration_s", "computed_duration_s"):
        _number(summary.get(key), key, minimum=0, maximum=model.duration_s+time_tolerance)
    require(summary["requested_duration_s"] == model.duration_s, "Requested duration conflicts with scenario")
    reason = summary.get("end_reason")
    require(type(reason) is str and reason in STOP_REASONS | {"requested_duration"}, "Unsupported completed-run end reason")
    completed = summary["computed_duration_s"]
    require((reason == "requested_duration") == (abs(completed-model.duration_s) <= time_tolerance), "Complete/stopped-prefix duration semantics disagree")
    _integer(summary.get("sample_count"), "sample_count", 1, MAX_SAMPLES)
    _keys(summary.get("ideal_capacity_bits"), {"uplink", "downlink"}, path="capacity summary")
    for value in summary["ideal_capacity_bits"].values():
        _number(value, "capacity", minimum=0, nullable=True)
    _keys(summary.get("capacity_available"), {"uplink", "downlink"}, path="capacity availability")
    for direction, available in summary["capacity_available"].items():
        require(type(available) is bool and available == (summary["ideal_capacity_bits"][direction] is not None),
                "Capacity availability conflicts with summary")
    require(summary.get("capacity_kind") == "ideal_threshold_capacity_not_packet_delivery", "Unsupported capacity semantics")
    for name in ("max_elevation_deg", "max_pointing_error_deg", "max_angular_rate_rad_s", "maximum_quaternion_projection_error"):
        _number(summary.get(name), "summary."+name)
    energy = summary.get("energy_j")
    require(type(energy) is dict and ENERGY_FIELDS <= energy.keys(), "Complete energy ledger is required")
    for value in energy.values():
        _number(value, "summary energy")
    stages = summary.get("stage_energy")
    require(type(stages) is list and len(stages) <= 100000, "Stage energy records are required")
    for stage in stages:
        require(type(stage) is dict and {
            "stage_id", "mode", "duration_s", "generated_bus_j", "requested_load_j",
            "escaped_rf_j", "actuator_bus_j",
        } <= stage.keys(), "Complete stage energy record is required")
        _text(stage.get("stage_id"), "stage ID", 256)
        require(stage.get("mode") in ("sun_pointing", "ground_tracking", "imaging", "detumble"), "Invalid stage mode")
        for key, value in stage.items():
            if key not in ("stage_id", "mode"):
                _number(value, "stage energy/elapsed time")
    settings = manifest.get("numerical_settings")
    require(type(settings) is dict, "Numerical settings are required")
    for key, value in model.clocks.model_dump(mode="json").items():
        require(settings.get(key) == value and type(settings.get(key)) is not bool, "Numerical clock settings conflict with scenario")
    for key in ("orbit_step_s", "earth_environment_hold_s"):
        _number(settings.get(key), "numerical setting "+key, minimum=1e-12)
    require(settings["orbit_step_s"] == model.clocks.dynamics_step_s/model.clocks.orbit_substeps,
            "Orbit step conflicts with scenario")
    ticks = settings.get("completed_dynamics_ticks")
    _integer(ticks, "completed dynamics ticks")
    require(abs(ticks*model.clocks.dynamics_step_s-completed) <= 1e-7, "Completed dynamics ticks disagree with duration")
    count = _validate_samples(result["samples"], model, summary)
    events = result["events"]
    require(type(events) is list and len(events) <= 100000, "Invalid event array")
    previous = -1.0
    terminated = []
    for event in events:
        require(type(event) is dict, "Events must be objects")
        _number(event.get("time_s"), "event time", minimum=0, maximum=completed)
        require(event["time_s"] >= previous, "Event times must be nondecreasing")
        previous = event["time_s"]
        require(event.get("type") in ("state", "terminated"), "Unsupported mission event type")
        if "visible" in event:
            require(type(event["visible"]) is bool, "Event visibility must be Boolean")
        for key in ("sun_visibility", "attempted_interval_s", "unserved_load_w", "projection_error"):
            if key in event:
                _number(event[key], "event."+key, minimum=0)
        if event["type"] == "terminated":
            terminated.append(event)
    if reason == "requested_duration":
        require(not terminated, "Full-duration result contains a termination event")
    else:
        require(len(terminated) == 1 and terminated[0].get("reason") == reason
                and terminated[0]["time_s"] == completed, "Stopped prefix needs its matching termination event")
    progress = run.get("progress")
    if progress is not None:
        _keys(progress, {"state"}, {"completed_time_s", "requested_duration_s", "fraction", "output_samples", "end_reason"}, "progress")
        require(progress["state"] == "finished", "A complete archive cannot contain running/partial progress")
        for key, expected in (("completed_time_s", completed), ("requested_duration_s", model.duration_s),
                              ("fraction", completed/model.duration_s), ("output_samples", count)):
            if key in progress:
                _number(progress[key], "progress."+key)
                require(abs(progress[key]-expected) <= 1e-8, "Progress conflicts with complete result")
        require("end_reason" not in progress or progress["end_reason"] == reason, "Progress end reason conflicts with summary")
    return snapshot


def export_archive(snapshot):
    validate_snapshot(snapshot)
    envelope = dict(format=FORMAT, version=VERSION, snapshot=snapshot,
                    integrity=dict(algorithm="sha256", canonicalization=CANONICALIZATION,
                                   sha256=content_digest(snapshot)))
    _bounded_tree(envelope)
    data = canonical_json(envelope).encode("utf-8")
    require(len(data) <= MAX_ARCHIVE_BYTES, "Archive exceeds the 64 MiB byte limit")
    return data


def import_archive(data: bytes):
    envelope = parse_json(data)
    _keys(envelope, {"format", "version", "snapshot", "integrity"}, path="archive")
    require(envelope["format"] == FORMAT and type(envelope["version"]) is int and envelope["version"] == VERSION,
            "Unsupported mission archive format/version")
    integrity = envelope["integrity"]
    _keys(integrity, {"algorithm", "canonicalization", "sha256"}, path="integrity")
    require(integrity["algorithm"] == "sha256" and integrity["canonicalization"] == CANONICALIZATION,
            "Unsupported archive integrity convention")
    require(type(integrity["sha256"]) is str and HASH.fullmatch(integrity["sha256"]), "Invalid archive checksum")
    require(content_digest(envelope["snapshot"]) == integrity["sha256"], "Archive integrity checksum mismatch")
    snapshot = validate_snapshot(envelope["snapshot"])
    return dict(snapshot=snapshot, import_metadata=dict(
        format=FORMAT, version=VERSION, sha256=integrity["sha256"],
        validation="structural_and_integrity_only", source_identity="retained_not_recomputed",
    ))


def export_request(data: bytes):
    """Accept an exact raw completed worker response or an explicit snapshot.

    Retaining the original response text avoids JavaScript dropping negative
    zero and integer/float lexical distinctions used by the original identity.
    Neither form depends on the worker manager retaining the job.
    """
    value = parse_json(data)
    if type(value) is dict and "run_id" in value:
        result = value.get("result")
        require(type(result) is dict and type(result.get("manifest")) is dict,
                "A completed raw run record with a manifest is required")
        value = dict(scenario=result["manifest"].get("scenario"), run=value)
    return export_archive(value)

"""Bounded one-axis mission refinement: python -m cubesat_sim.validation.mission_refinement.

Numerical differences are measured on exact common output times, without
interpolation. Controller sampling changes the physical sampled controller.
Thermal-step changes also change the currently coupled environment hold.
"""

from dataclasses import dataclass
import argparse
import hashlib
import json
import math
import multiprocessing
from pathlib import Path
import queue
import time

from ..mission.defaults import default_mission_scenario
from ..mission.driver import run_mission
from ..mission.ephemeris import ecef_to_inertial
from ..mission_models import MissionScenario
from ..geometry.frames import geodetic_ecef
from ..power.battery_electrical import electrical_defaults

VERSION = "mission-independent-clock-refinement-0.1.0"
AXES = {
    "dynamics": "Coupled dynamics/event/RF/power grid refinement; other clocks fixed. Not a pure smooth-ODE order test.",
    "orbit": "Orbit substep refinement with dynamics/controller/thermal/output clocks fixed.",
    "controller": "Sampled-controller sensitivity; this changes the held-control system and is not integrator convergence.",
    "thermal_environment": "Thermal integration and Earth-environment hold refine together in the current model; their errors are not separated.",
    "environment_quadrature": "Earth disk angular quadrature refinement; all time clocks fixed.",
    "output": "Output-only sampling refinement; shared-time states, events and integrated summaries should remain unchanged.",
}
TRACE_FIELDS = (
    "attitude_angle_deg",
    "power.stored_energy_wh",
    "power.battery_soc",
    "power.battery_voltage_v",
    "power.battery_current_a",
    "power.battery_ohmic_heat_w",
)


@dataclass(frozen=True)
class RefinementBudget:
    max_total_dynamics_ticks: int = 250_000
    max_total_output_samples: int = 50_000
    max_cases: int = 24
    max_case_wall_s: float = 120.0
    max_total_wall_s: float = 600.0
    max_case_output_bytes: int = 64 * 1024 * 1024

    def __post_init__(self):
        integer_bounds = (
            (self.max_total_dynamics_ticks, 1, 5_000_000),
            (self.max_total_output_samples, 1, 200_000),
            (self.max_cases, 1, 48),
            (self.max_case_output_bytes, 1024, 64 * 1024 * 1024),
        )
        if any(type(v) is not int or not lo <= v <= hi for v, lo, hi in integer_bounds):
            raise ValueError("Refinement count/size budgets exceed supported bounds")
        if any(
            not math.isfinite(v) or not 0 < v <= 3600
            for v in (self.max_case_wall_s, self.max_total_wall_s)
        ):
            raise ValueError(
                "Refinement wall budgets must be finite, positive and at most3600s"
            )


def overhead_pass_scenario(duration_s=1200.0, electrical=True):
    """Construct an overhead circular central-gravity pass, not a predicted orbit."""
    data = default_mission_scenario().model_dump(mode="json")
    data["duration_s"] = duration_s
    data["clocks"]["dynamics_step_s"] = 0.5
    data["orbit"].update(force_model="central", preset=None, ltan_hours_at_epoch=None)
    elements = data["orbit"]["elements"]
    station = data["station"]
    midpoint = duration_s / 2
    position = ecef_to_inertial(
        geodetic_ecef(
            station["latitude_deg"], station["longitude_deg"], station["height_m"]
        ),
        elements["epoch_utc"],
        midpoint,
    )
    latitude = math.atan2(position[2], math.hypot(position[0], position[1]))
    longitude = math.atan2(position[1], position[0])
    inclination = math.radians(elements["inclination_deg"])
    argument = math.asin(math.sin(latitude) / math.sin(inclination))
    raan = longitude - math.atan2(
        math.cos(inclination) * math.sin(argument), math.cos(argument)
    )
    mean_motion = math.sqrt(
        data["orbit"]["mu_m3_s2"] / elements["semi_major_axis_m"] ** 3
    )
    elements.update(
        eccentricity=0.0,
        raan_deg=math.degrees(raan) % 360,
        argument_of_periapsis_deg=0.0,
        true_anomaly_deg=math.degrees(argument - mean_motion * midpoint) % 360,
    )
    if electrical:
        data["power"]["battery"]["electrical"] = electrical_defaults()
    data["name"] = "Constructed overhead pass for independent clock refinement"
    data["provenance"].append(
        "Validation case: circular central-gravity phase places the radial position over the station at half the configured duration. No catalog orbit, flight hardware calibration or hot/cold electrical validation."
    )
    return MissionScenario.model_validate(data)


def _cost(config):
    return dict(
        dynamics_ticks=round(config.duration_s / config.clocks.dynamics_step_s),
        output_samples=round(config.duration_s / config.clocks.output_step_s) + 1,
        orbit_substeps=round(config.duration_s / config.clocks.dynamics_step_s)
        * config.clocks.orbit_substeps,
    )


def _variant(base, axis, level):
    data = base.model_dump(mode="json")
    factor = 2**level
    clocks = data["clocks"]
    if axis == "dynamics":
        clocks["dynamics_step_s"] /= factor
    elif axis == "orbit":
        clocks["orbit_substeps"] *= factor
    elif axis == "controller":
        clocks["controller_period_s"] /= factor
    elif axis == "thermal_environment":
        clocks["thermal_step_s"] /= factor
    elif axis == "environment_quadrature":
        data["power"]["earth_quadrature_rings"] *= factor
        data["power"]["earth_quadrature_azimuths"] *= factor
    elif axis == "output":
        thermal = clocks["thermal_step_s"]
        initial_stride = round(clocks["output_step_s"] / thermal)
        duration_ticks = round(data["duration_s"] / thermal)
        target = math.ceil(initial_stride / factor)
        allowed = [n for n in range(1, target + 1) if duration_ticks % n == 0]
        clocks["output_step_s"] = thermal * max(allowed)
    return MissionScenario.model_validate(data)


def refinement_cases(base, axes=tuple(AXES), levels=3, budget=RefinementBudget()):
    if not isinstance(base, MissionScenario):
        raise TypeError("Validated MissionScenario required")
    if type(levels) is not int or not 2 <= levels <= 4:
        raise ValueError("Refinement requires2..4 declared levels")
    if (
        not axes
        or len(set(axes)) != len(axes)
        or any(axis not in AXES for axis in axes)
    ):
        raise ValueError("Refinement axes must be unique supported names")
    requested = 1 + len(axes) * (levels - 1)
    if requested > budget.max_cases:
        raise ValueError("Refinement exceeds declared case budget")
    cases = []
    totals = dict(dynamics_ticks=0, output_samples=0, orbit_substeps=0)

    def add(case_id, axis, level, config):
        cost = _cost(config)
        if (
            totals["dynamics_ticks"] + cost["dynamics_ticks"]
            > budget.max_total_dynamics_ticks
            or totals["output_samples"] + cost["output_samples"]
            > budget.max_total_output_samples
        ):
            cases.append(
                dict(
                    case_id=case_id,
                    axis=axis,
                    level=level,
                    status="skipped_budget",
                    cost=cost,
                )
            )
            return
        for key, value in cost.items():
            totals[key] += value
        cases.append(
            dict(
                case_id=case_id,
                axis=axis,
                level=level,
                status="planned",
                cost=cost,
                scenario=config.model_dump(mode="json"),
            )
        )

    add("baseline", "baseline", 0, base)
    if cases[0]["status"] != "planned":
        raise ValueError("Baseline exceeds declared work/output budget")
    for axis in axes:
        previous = base.identity()[1]
        for level in range(1, levels):
            case_id = f"{axis}-{level}"
            try:
                config = _variant(base, axis, level)
            except (ValueError, ArithmeticError) as error:
                cases.append(
                    dict(
                        case_id=case_id,
                        axis=axis,
                        level=level,
                        status="skipped_unrepresentable",
                        reason=str(error),
                    )
                )
                continue
            identity = config.identity()[1]
            if identity == previous:
                cases.append(
                    dict(
                        case_id=case_id,
                        axis=axis,
                        level=level,
                        status="skipped_duplicate_resolution",
                    )
                )
                continue
            add(case_id, axis, level, config)
            previous = identity
    return cases, totals


def _column(samples, path):
    value = samples
    for field in path.split("."):
        if not isinstance(value, dict) or field not in value:
            return None
        value = value[field]
    return value


def _scalar_metric(a, b):
    missing = sum((x is None) != (y is None) for x, y in zip(a, b))
    differences = [x - y for x, y in zip(a, b) if x is not None and y is not None]
    return dict(
        paired_samples=len(differences),
        unresolved_disagreements=missing,
        max_abs=max(map(abs, differences), default=None),
        rms=(
            math.sqrt(math.fsum(d * d for d in differences) / len(differences))
            if differences
            else None
        ),
    )


def _event_signature(event):
    return tuple(
        event.get(key)
        for key in ("type", "mode", "stage_id", "visible", "sun_visibility", "reason")
    )


def compare_runs(coarse, fine):
    a, b = coarse["samples"], fine["samples"]
    indices_a = {value: i for i, value in enumerate(a["elapsed_ns"])}
    indices_b = {value: i for i, value in enumerate(b["elapsed_ns"])}
    common = sorted(indices_a.keys() & indices_b.keys(), key=int)
    if not common:
        raise ValueError("Runs have no exact common output epochs")
    ia, ib = [indices_a[t] for t in common], [indices_b[t] for t in common]
    traces = {}
    for path in TRACE_FIELDS:
        ca, cb = _column(a, path), _column(b, path)
        if ca is not None and cb is not None:
            traces[path] = _scalar_metric([ca[i] for i in ia], [cb[i] for i in ib])
    nodes = (
        a["thermal"]["node_temperature_k"].keys()
        & b["thermal"]["node_temperature_k"].keys()
    )
    for node in sorted(nodes):
        traces[f"temperature_k.{node}"] = _scalar_metric(
            [a["thermal"]["node_temperature_k"][node][i] for i in ia],
            [b["thermal"]["node_temperature_k"][node][i] for i in ib],
        )
    attitude_errors = []
    rate_errors = []
    for i, j in zip(ia, ib):
        qa, qb = a["q_body_from_inertial_wxyz"][i], b["q_body_from_inertial_wxyz"][j]
        # The quaternion sign is unobservable; chord distance avoids acos loss near zero.
        chord = min(math.dist(qa, qb), math.dist(qa, [-v for v in qb]))
        attitude_errors.append(math.degrees(4 * math.asin(min(1.0, chord / 2))))
        rate_errors.append(
            math.dist(a["gnc"]["omega_body_rad_s"][i], b["gnc"]["omega_body_rad_s"][j])
        )
    traces["attitude_geodesic_deg"] = _scalar_metric(
        attitude_errors, [0.0] * len(common)
    )
    traces["body_rate_vector_rad_s"] = _scalar_metric(rate_errors, [0.0] * len(common))
    signatures_a = [_event_signature(e) for e in coarse["events"]]
    signatures_b = [_event_signature(e) for e in fine["events"]]
    same_events = signatures_a == signatures_b
    timing = (
        [x["time_s"] - y["time_s"] for x, y in zip(coarse["events"], fine["events"])]
        if same_events
        else []
    )
    capacity = {}
    for direction in ("uplink", "downlink"):
        ca = coarse["summary"]["ideal_capacity_bits"][direction]
        cb = fine["summary"]["ideal_capacity_bits"][direction]
        capacity[direction] = dict(
            coarse_bits=ca,
            fine_bits=cb,
            delta_bits=ca - cb if ca is not None and cb is not None else None,
            relative_to_fine=(
                (ca - cb) / cb if ca is not None and cb not in (None, 0) else None
            ),
        )
    duration_a, duration_b = (
        coarse["summary"]["computed_duration_s"],
        fine["summary"]["computed_duration_s"],
    )
    return dict(
        numerical_source_identity_match=coarse.get("manifest", {}).get(
            "source_code_hashes"
        )
        == fine.get("manifest", {}).get("source_code_hashes"),
        common_samples=len(common),
        common_interval_s=[int(common[0]) / 1e9, int(common[-1]) / 1e9],
        coarse_duration_s=duration_a,
        fine_duration_s=duration_b,
        same_completed_interval=duration_a == duration_b,
        coarse_end_reason=coarse["summary"]["end_reason"],
        fine_end_reason=fine["summary"]["end_reason"],
        traces=traces,
        ideal_capacity=capacity,
        events=dict(
            same_sequence=same_events,
            coarse_count=len(signatures_a),
            fine_count=len(signatures_b),
            maximum_timing_difference_s=max(map(abs, timing), default=None),
            first_sequence_mismatch=next(
                (
                    i
                    for i, (x, y) in enumerate(zip(signatures_a, signatures_b))
                    if x != y
                ),
                min(len(signatures_a), len(signatures_b)) if not same_events else None,
            ),
        ),
        sampled_range_comparison="Trace extrema and RMS use exact common output samples, not unreported continuous extrema.",
        interval_power_comparison="Terminal V/I/heat are preceding-interval means; refining the dynamics grid changes that averaging interval.",
        exact_output_invariance=dict(
            summary=_selected_summary(coarse["summary"])
            == _selected_summary(fine["summary"]),
            events=[(e["time_s"], _event_signature(e)) for e in coarse["events"]]
            == [(e["time_s"], _event_signature(e)) for e in fine["events"]],
            common_samples=all(
                _selected_sample(a, i) == _selected_sample(b, j) for i, j in zip(ia, ib)
            ),
            scope="Declared physical traces, event signatures/times and pre-report summary fields; new report/delivery metadata is excluded",
        ),
    )


def _selected_sample(samples, index):
    paths = (
        *TRACE_FIELDS,
        "q_body_from_inertial_wxyz",
        "gnc.omega_body_rad_s",
        "mode",
        "visible",
        "stage_id",
        "radio_active",
    )
    result = {
        path: values[index]
        for path in paths
        if (values := _column(samples, path)) is not None
    }
    result["thermal"] = {
        key: value[index]
        for key, value in samples["thermal"]["node_temperature_k"].items()
    }
    for direction in ("uplink", "downlink"):
        result[direction] = {
            key: samples[direction][key][index]
            for key in ("margin_db", "ideal_rate_bps", "cumulative_ideal_bits")
            if key in samples.get(direction, {})
        }
    return result


def _selected_summary(summary):
    keys = (
        "computed_duration_s",
        "end_reason",
        "ideal_capacity_bits",
        "max_elevation_deg",
        "max_pointing_error_deg",
        "max_angular_rate_rad_s",
    )
    result = {key: summary[key] for key in keys if key in summary}
    result["energy_j"] = {
        key: value
        for key, value in summary.get("energy_j", {}).items()
        if key.endswith("_j")
    }
    return result


def adjacent_difference_assessment(comparisons):
    """Describe successive differences; no unknown exact-solution error is inferred."""
    names = (
        set.intersection(*(set(value["traces"]) for value in comparisons))
        if comparisons
        else set()
    )
    metrics = {}
    for name in sorted(names):
        differences = [value["traces"][name]["max_abs"] for value in comparisons]
        if len(differences) < 2 or any(value is None for value in differences):
            trend = "insufficient_levels"
        elif all(value == 0 for value in differences):
            trend = "unchanged_at_common_samples"
        elif all(fine < coarse for coarse, fine in zip(differences, differences[1:])):
            trend = "decreasing_adjacent_differences"
        else:
            trend = "decrease_not_demonstrated"
        metrics[name] = dict(adjacent_max_abs=differences, diagnostic=trend)
    return dict(
        metrics=metrics,
        interpretation="A nondecreasing difference flags that monotone refinement evidence is absent for this metric. It does not mean the finer solution is less accurate. Grid-resolved events, roundoff and physical controller changes can alter the trend; no exact-solution error or formal order is inferred.",
    )


class _BoundedWriter:
    def __init__(self, stream, limit):
        self.stream, self.limit, self.written = stream, limit, 0

    def write(self, text):
        self.written += len(
            text
        )  # json ensure_ascii=True makes one byte per character.
        if self.written > self.limit:
            raise ValueError("Case result exceeds declared output-byte limit")
        return self.stream.write(text)


def _worker(scenario, path, byte_limit, messages):
    start = time.monotonic()
    try:
        result = run_mission(MissionScenario.model_validate(scenario))
        with open(path, "w") as stream:
            json.dump(
                result,
                _BoundedWriter(stream, byte_limit),
                ensure_ascii=True,
                allow_nan=False,
                separators=(",", ":"),
            )
        messages.put(dict(status="complete", wall_s=time.monotonic() - start))
    except Exception as error:
        Path(path).unlink(missing_ok=True)
        messages.put(
            dict(
                status="failed",
                wall_s=time.monotonic() - start,
                error=f"{type(error).__name__}: {error}",
            )
        )


def _run_bounded(scenario, path, wall_s, byte_limit):
    context = multiprocessing.get_context("spawn")
    messages = context.Queue()
    process = context.Process(
        target=_worker, args=(scenario, str(path), byte_limit, messages)
    )
    start = time.monotonic()
    process.start()
    process.join(wall_s)
    if process.is_alive():
        process.terminate()
        process.join(3)
        if process.is_alive():
            process.kill()
            process.join(3)
        Path(path).unlink(missing_ok=True)
        outcome = dict(status="timed_out", wall_s=time.monotonic() - start)
    else:
        try:
            outcome = messages.get(timeout=1)
        except queue.Empty:
            outcome = dict(
                status="failed",
                wall_s=time.monotonic() - start,
                error=f"Child exited without a result, exitcode={process.exitcode}",
            )
    messages.close()
    messages.join_thread()
    return outcome


def run_refinement(
    base,
    destination,
    axes=tuple(AXES),
    levels=3,
    budget=RefinementBudget(),
    case_runner=None,
    progress=None,
):
    cases, cost = refinement_cases(base, axes, levels, budget)
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    runner = case_runner or _run_bounded
    start = time.monotonic()
    results = {}
    for case in cases:
        if case["status"] != "planned":
            continue
        remaining = budget.max_total_wall_s - (time.monotonic() - start)
        if remaining <= 0:
            case["status"] = "skipped_wall_budget"
            continue
        path = destination / (case["case_id"] + ".json")
        outcome = runner(
            case["scenario"],
            path,
            min(budget.max_case_wall_s, remaining),
            budget.max_case_output_bytes,
        )
        case.update(outcome)
        if case["status"] == "complete":
            result = json.loads(path.read_text())
            results[case["case_id"]] = result
            case["result_file"] = path.name
            case["result_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
            case["end_reason"] = result["summary"]["end_reason"]
            case["computed_duration_s"] = result["summary"]["computed_duration_s"]
            case["first_law_residual_j"] = result["summary"]["energy_j"][
                "closure_residual_j"
            ]
        if progress:
            progress({key: case[key] for key in ("case_id", "status", "wall_s")})
    comparisons = {}
    if "baseline" in results:
        reference_sources = results["baseline"]["manifest"]["source_code_hashes"]
        for case in cases:
            if case["case_id"] in results:
                case["comparable_numerical_sources"] = (
                    results[case["case_id"]]["manifest"]["source_code_hashes"]
                    == reference_sources
                )
                if not case["comparable_numerical_sources"]:
                    case["comparison_excluded_reason"] = (
                        "Numerical source identities differ from the baseline; not a controlled refinement case"
                    )
        for axis in axes:
            ordered = [
                "baseline",
                *[
                    c["case_id"]
                    for c in cases
                    if c["axis"] == axis
                    and c["case_id"] in results
                    and c.get("comparable_numerical_sources", True)
                ],
            ]
            comparisons[axis] = [
                dict(coarse=a, fine=b, **compare_runs(results[a], results[b]))
                for a, b in zip(ordered, ordered[1:])
            ]
    report = dict(
        version=VERSION,
        tooling_source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        base_scenario_id=base.identity()[0],
        axes={axis: AXES[axis] for axis in axes},
        requested_levels=levels,
        budget=vars(budget),
        estimated_work=cost,
        wall_budget_scope="Each child has a hard wall timeout; no new case starts after the total scheduling budget. Process cleanup and bounded result parsing/report serialization add overhead.",
        wall_s=time.monotonic() - start,
        cases=cases,
        comparisons=comparisons,
        adjacent_difference_assessment={
            axis: adjacent_difference_assessment(values)
            for axis, values in comparisons.items()
            if axis not in {"controller", "output"}
        },
        interpretation=[
            "Differences are case-specific resolution/sensitivity evidence, not hardware validation or universal accuracy bounds.",
            "Controller-period changes alter a physical sampled-control parameter; do not infer an integrator order from them.",
            "Thermal integration and environment hold share one current clock. Environment angular quadrature is varied separately.",
            "State events are compared by ordered signatures before timing differences; changed sequences remain explicitly unmatched.",
            "Reported ideal threshold capacity is not acquired or packet-delivered data. No measured confidence distribution is assumed.",
            "Stopped prefixes, missing levels, timeouts and failed cases remain in this report; a comparison does not certify completion.",
        ],
    )
    (destination / "report.json").write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n"
    )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--scenario", type=Path, help="Complete MissionScenario JSON")
    source.add_argument(
        "--default-mission",
        action="store_true",
        help="Use the current default mission instead of the constructed short pass",
    )
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="New output directory; existing directories are never overwritten",
    )
    parser.add_argument("--axes", default=",".join(AXES))
    parser.add_argument("--levels", type=int, default=3)
    parser.add_argument(
        "--duration-s",
        type=float,
        help="Explicit duration override; clocks/windows still must validate",
    )
    parser.add_argument("--max-total-ticks", type=int, default=250_000)
    parser.add_argument("--max-case-wall-s", type=float, default=120)
    parser.add_argument("--max-total-wall-s", type=float, default=600)
    args = parser.parse_args()
    base = (
        MissionScenario.model_validate_json(args.scenario.read_text())
        if args.scenario
        else (
            default_mission_scenario()
            if args.default_mission
            else overhead_pass_scenario(
                args.duration_s if args.duration_s is not None else 1200
            )
        )
    )
    if args.duration_s is not None and (args.scenario or args.default_mission):
        base = MissionScenario.model_validate(
            base.model_dump(mode="json") | dict(duration_s=args.duration_s)
        )
    budget = RefinementBudget(
        max_total_dynamics_ticks=args.max_total_ticks,
        max_case_wall_s=args.max_case_wall_s,
        max_total_wall_s=args.max_total_wall_s,
    )
    report = run_refinement(
        base,
        args.output,
        tuple(args.axes.split(",")),
        args.levels,
        budget,
        progress=lambda value: print(json.dumps(value), flush=True),
    )
    print(
        json.dumps(
            dict(report=str(args.output / "report.json"), wall_s=report["wall_s"])
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()

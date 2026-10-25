from copy import deepcopy
import json
import math

import pytest

from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.validation.mission_refinement import (
    adjacent_difference_assessment,
    RefinementBudget,
    refinement_cases,
    compare_runs,
    run_refinement,
    overhead_pass_scenario,
    _run_bounded,
)


def short_config():
    data = default_mission_scenario().model_dump(mode="json")
    data["duration_s"] = 60
    return MissionScenario.model_validate(data)


def changed_paths(a, b, prefix=""):
    result = set()
    for key in a.keys() | b.keys():
        path = f"{prefix}.{key}" if prefix else key
        if key not in a or key not in b:
            result.add(path)
        elif isinstance(a[key], dict) and isinstance(b[key], dict):
            result.update(changed_paths(a[key], b[key], path))
        elif a[key] != b[key]:
            result.add(path)
    return result


def test_only_declared_clock_or_quadrature_changes_and_unrepresentable_levels_remain_explicit():
    base = short_config()
    cases, work = refinement_cases(base)
    allowed = {
        "dynamics": {"clocks.dynamics_step_s"},
        "orbit": {"clocks.orbit_substeps"},
        "controller": {"clocks.controller_period_s"},
        "thermal_environment": {"clocks.thermal_step_s"},
        "environment_quadrature": {
            "power.earth_quadrature_rings",
            "power.earth_quadrature_azimuths",
        },
        "output": {"clocks.output_step_s"},
    }
    for case in cases[1:]:
        if case["status"] == "planned":
            assert (
                changed_paths(base.model_dump(mode="json"), case["scenario"])
                == allowed[case["axis"]]
            )
    statuses = {c["case_id"]: c["status"] for c in cases}
    assert statuses["controller-2"] == "skipped_unrepresentable"
    assert statuses["thermal_environment-2"] == "skipped_unrepresentable"
    output = [
        c["scenario"]["clocks"]["output_step_s"]
        for c in cases
        if c["axis"] == "output" and c["status"] == "planned"
    ]
    assert output == [20, 10]
    assert work["dynamics_ticks"] == sum(
        c["cost"]["dynamics_ticks"] for c in cases if c["status"] == "planned"
    )


def test_work_and_case_bounds_are_applied_before_computation():
    base = short_config()
    with pytest.raises(ValueError, match="Baseline"):
        refinement_cases(base, budget=RefinementBudget(max_total_dynamics_ticks=1))
    with pytest.raises(ValueError, match="case budget"):
        refinement_cases(base, budget=RefinementBudget(max_cases=2))
    with pytest.raises(ValueError):
        RefinementBudget(max_total_dynamics_ticks=True)
    cases, work = refinement_cases(
        base, axes=("dynamics",), budget=RefinementBudget(max_total_dynamics_ticks=60)
    )
    assert [c["status"] for c in cases] == [
        "planned",
        "skipped_budget",
        "skipped_budget",
    ]
    assert work["dynamics_ticks"] == 60
    with pytest.raises(ValueError):
        refinement_cases(base, axes=("controller", "controller"))


def synthetic_result():
    return dict(
        summary=dict(
            computed_duration_s=10,
            end_reason="requested_duration",
            ideal_capacity_bits=dict(uplink=0, downlink=100),
            energy_j=dict(closure_residual_j=0),
        ),
        samples=dict(
            elapsed_ns=["0", "10000000000"],
            q_body_from_inertial_wxyz=[[1, 0, 0, 0], [1, 0, 0, 0]],
            attitude_angle_deg=[0, 0],
            power=dict(stored_energy_wh=[10, 8], battery_voltage_v=[None, None]),
            gnc=dict(omega_body_rad_s=[[0, 0, 0], [0, 0, 0]]),
            thermal=dict(node_temperature_k=dict(battery=[290, 291])),
        ),
        events=[dict(type="state", time_s=0, mode="sun_pointing", visible=False)],
    )


def test_common_epoch_quaternion_sign_geodesic_units_nulls_and_ordered_event_mismatch():
    a = synthetic_result()
    b = deepcopy(a)
    b["samples"]["q_body_from_inertial_wxyz"][0] = [-1, 0, 0, 0]
    b["samples"]["q_body_from_inertial_wxyz"][1] = [
        math.sqrt(0.5),
        0,
        0,
        math.sqrt(0.5),
    ]
    b["samples"]["power"]["stored_energy_wh"][1] = 6
    b["samples"]["power"]["battery_voltage_v"][1] = 7
    b["events"][0]["time_s"] = 0.5
    comparison = compare_runs(a, b)
    assert comparison["traces"]["attitude_geodesic_deg"]["max_abs"] == pytest.approx(90)
    assert comparison["traces"]["attitude_geodesic_deg"]["rms"] == pytest.approx(
        90 / math.sqrt(2)
    )
    assert comparison["traces"]["power.stored_energy_wh"]["max_abs"] == 2
    assert comparison["traces"]["power.stored_energy_wh"]["rms"] == pytest.approx(
        math.sqrt(2)
    )
    assert (
        comparison["traces"]["power.battery_voltage_v"]["unresolved_disagreements"] == 1
    )
    assert comparison["events"]["maximum_timing_difference_s"] == 0.5
    assert comparison["ideal_capacity"]["uplink"]["relative_to_fine"] is None
    b["events"].append(
        dict(type="state", time_s=9, mode="ground_tracking", visible=True)
    )
    comparison = compare_runs(a, b)
    assert not comparison["events"]["same_sequence"]
    assert comparison["events"]["first_sequence_mismatch"] == 1
    assert comparison["events"]["maximum_timing_difference_s"] is None


def test_stopped_prefix_and_new_reporting_metadata_are_not_hidden():
    a = synthetic_result()
    b = deepcopy(a)
    b["summary"]["computed_duration_s"] = 5
    b["summary"]["end_reason"] = "power_unserved"
    b["samples"]["elapsed_ns"][-1] = "5000000000"
    comparison = compare_runs(a, b)
    assert comparison["common_samples"] == 1
    assert not comparison["same_completed_interval"]
    assert comparison["fine_end_reason"] == "power_unserved"
    b = deepcopy(a)
    b["summary"]["new_daily_report"] = {"future": True}
    b["events"][0]["new_delivery_detail"] = "uncompared"
    b["samples"]["new_delivery_telemetry"] = [1, 2]
    assert all(
        value
        for key, value in compare_runs(a, b)["exact_output_invariance"].items()
        if key != "scope"
    )


def test_output_sampling_changes_no_shared_physics_in_actual_short_mission():
    base = short_config()
    data = base.model_dump(mode="json")
    data["clocks"]["output_step_s"] = 10
    a = run_mission(base)
    b = run_mission(MissionScenario.model_validate(data))
    comparison = compare_runs(a, b)
    assert comparison["common_samples"] == 3
    assert comparison["exact_output_invariance"]["summary"]
    assert comparison["exact_output_invariance"]["events"]
    assert comparison["exact_output_invariance"]["common_samples"]
    assert all(
        metric["max_abs"] in (0, None) for metric in comparison["traces"].values()
    )


def test_constructed_case_has_declared_reference_and_fits_three_independent_levels():
    base = overhead_pass_scenario()
    assert base.duration_s == 1200
    assert base.orbit.force_model == "central"
    assert base.orbit.ltan_hours_at_epoch is None
    assert base.power.battery.electrical is not None
    cases, _ = refinement_cases(base)
    assert all(c["status"] == "planned" for c in cases)


def test_hard_case_timeout_cleans_partial_output(tmp_path):
    output = tmp_path / "case.json"
    outcome = _run_bounded(
        default_mission_scenario().model_dump(mode="json"), output, 0.01, 1024 * 1024
    )
    assert outcome["status"] == "timed_out"
    assert not output.exists()


def test_report_persists_failed_and_missing_levels_without_overwriting(tmp_path):
    def failed_runner(scenario, path, wall, byte_limit):
        return dict(
            status="failed", wall_s=0.01, error="constructed orchestration test"
        )

    destination = tmp_path / "new-report"
    report = run_refinement(
        short_config(), destination, axes=("dynamics",), case_runner=failed_runner
    )
    assert all(c["status"] == "failed" for c in report["cases"])
    assert report["comparisons"] == {}
    assert (
        json.loads((destination / "report.json").read_text())["cases"][0]["error"]
        == "constructed orchestration test"
    )
    with pytest.raises(FileExistsError):
        run_refinement(
            short_config(), destination, axes=("dynamics",), case_runner=failed_runner
        )


def test_nondecreasing_difference_is_a_diagnostic_without_a_fine_grid_accuracy_claim():
    pairs = [dict(traces={"angle_deg": dict(max_abs=value)}) for value in (0.001, 0.1)]
    assessment = adjacent_difference_assessment(pairs)
    metric = assessment["metrics"]["angle_deg"]
    assert metric["diagnostic"] == "decrease_not_demonstrated"
    assert metric["adjacent_max_abs"] == [0.001, 0.1]
    assert (
        "does not mean the finer solution is less accurate"
        in assessment["interpretation"]
    )
    pairs.reverse()
    assert (
        adjacent_difference_assessment(pairs)["metrics"]["angle_deg"]["diagnostic"]
        == "decreasing_adjacent_differences"
    )


def test_source_identity_changes_are_explicit_and_excluded_from_refinement(tmp_path):
    called = 0

    def source_changes(scenario, path, wall, byte_limit):
        nonlocal called
        value = synthetic_result()
        value["manifest"] = {"source_code_hashes": {"model.py": str(called)}}
        called += 1
        path.write_text(json.dumps(value))
        return dict(status="complete", wall_s=0.01)

    report = run_refinement(
        short_config(),
        tmp_path / "sources",
        axes=("dynamics",),
        case_runner=source_changes,
    )
    assert report["cases"][0]["comparable_numerical_sources"]
    assert not report["cases"][1]["comparable_numerical_sources"]
    assert (
        "source identities differ" in report["cases"][1]["comparison_excluded_reason"]
    )
    assert report["comparisons"]["dynamics"] == []

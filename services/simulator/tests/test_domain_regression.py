"""Exact histories captured before numerical-module extraction at ba3ccb7.

The independent physical reference/convergence tests remain in test_physics and
test_core. These fixtures detect changes to complete previously computed runs.
"""
import hashlib
import json
from pathlib import Path

import pytest

from cubesat_sim.antenna_models import PatternRequest
from cubesat_sim.core import run_scenario
from cubesat_sim.models import Scenario, content_hash
from cubesat_sim.rf.pattern_sampling import probe_response, sample_pattern

FIXTURES = Path(__file__).parent / "fixtures"
BASELINE = json.loads((FIXTURES / "numerical-extraction-ba3ccb7.json").read_text())


def sha256_json(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


@pytest.mark.parametrize("name", BASELINE["scenarios"])
def test_complete_run_matches_pre_extraction_history(name):
    result = run_scenario(Scenario.model_validate(BASELINE["scenarios"][name]))
    for path in BASELINE["comparison_exclusions"]:
        group, field = path.split(".")
        result[group].pop(field, None)
    assert sha256_json(result) == BASELINE["run_sha256"][name]


@pytest.mark.parametrize("name", BASELINE["pattern_requests"])
def test_full_pattern_and_probe_match_pre_extraction_history(name):
    request = PatternRequest.model_validate(BASELINE["pattern_requests"][name])
    pattern = sample_pattern(request)
    # Added lab inputs do not change these older models. Project only their
    # serialization additions; retain every legacy field/cut/probe value hash.
    assert pattern["model_version"] == "antenna-lab-core-patterns-0.1.0"
    assert pattern["request"].pop("frequency_hz") == 438e6
    assert pattern["request"].pop("arm_length_m") == pytest.approx(299792458/(4*438e6))
    pattern["identity"] = content_hash(pattern["request"] | {"model_version": pattern["model_version"]})
    for cut in (pattern["cuts"] or {}).values():
        cut.pop("half_power", None)
    for path in BASELINE["pattern_comparison_exclusions"]:
        group, field = path.split(".")
        pattern[group].pop(field, None)
    assert sha256_json(pattern) == BASELINE["pattern_sha256"][name]
    assert sha256_json(probe_response(request)) == BASELINE["probe_sha256"][name]


def test_scenario_schema_unchanged_and_lab_schema_changes_are_additive():
    schemas = json.loads((FIXTURES / "schemas-before-extraction.json").read_text())
    assert Scenario.model_json_schema() == schemas["scenario"]
    pattern = PatternRequest.model_json_schema()
    properties = pattern["properties"]
    assert properties.pop("frequency_hz") == dict(default=438e6, minimum=1e6, maximum=10e9, title="Frequency Hz", type="number")
    length = properties.pop("arm_length_m")
    assert length == dict(default=299792458/(4*438e6), minimum=1e-4, maximum=10, title="Arm Length M", type="number")
    assert properties["model"]["enum"][-2:] == ["bent_v_up_45", "bent_v_out_45"]
    properties["model"]["enum"] = properties["model"]["enum"][:-2]
    assert pattern == schemas["pattern"]

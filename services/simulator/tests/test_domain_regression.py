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
from cubesat_sim.models import Scenario
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
    for path in BASELINE["pattern_comparison_exclusions"]:
        group, field = path.split(".")
        pattern[group].pop(field, None)
    assert sha256_json(pattern) == BASELINE["pattern_sha256"][name]
    assert sha256_json(probe_response(request)) == BASELINE["probe_sha256"][name]


def test_scenario_and_pattern_json_schemas_are_unchanged():
    schemas = json.loads((FIXTURES / "schemas-before-extraction.json").read_text())
    assert Scenario.model_json_schema() == schemas["scenario"]
    assert PatternRequest.model_json_schema() == schemas["pattern"]

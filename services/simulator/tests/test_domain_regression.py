"""Exact histories captured before numerical-module extraction at ba3ccb7.

The independent physical reference/convergence tests remain in test_physics and
test_core. These fixtures detect changes to complete previously computed runs.
"""
import gzip
import hashlib
import json
import math
from pathlib import Path
import struct

import pytest

from cubesat_sim.antenna_models import PatternRequest
from cubesat_sim.core import run_scenario
from cubesat_sim.models import Scenario, content_hash
from cubesat_sim.rf.pattern_sampling import probe_response, sample_pattern

FIXTURES = Path(__file__).parent / "fixtures"
BASELINE = json.loads((FIXTURES / "numerical-extraction-ba3ccb7.json").read_text())
REFERENCE = json.loads(gzip.decompress((FIXTURES / "numerical-extraction-ba3ccb7-payloads.json.gz").read_bytes()))


def sha256_json(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def legacy_run(name):
    result = run_scenario(Scenario.model_validate(BASELINE["scenarios"][name]))
    # Project only added inactive profile/mount metadata back to the archived schema.
    manifest = result["manifest"]
    for direction in ("uplink", "downlink"):
        link = manifest["scenario"][direction]
        assert link.pop("spherical_harmonic_profile") is None
        assert link.pop("antenna_orientation_deg") == [0, 0, 0]
    digest = content_hash(manifest["scenario"])
    manifest["scenario_hash"], manifest["scenario_id"] = digest, "scenario_"+digest[:16]
    manifest["input_provenance"] = [record for record in manifest["input_provenance"]
                                    if record["path"].split(".")[-1] not in {"spherical_harmonic_profile", "antenna_orientation_deg"}]
    for path in BASELINE["comparison_exclusions"]:
        group, field = path.split(".")
        result[group].pop(field, None)
    return result


def legacy_pattern_and_probe(name):
    request = PatternRequest.model_validate(BASELINE["pattern_requests"][name])
    pattern = sample_pattern(request)
    # Added lab inputs do not change these older models. Project only their
    # serialization additions; retain every legacy field/cut/probe value hash.
    assert pattern["model_version"] == "antenna-lab-core-patterns-0.1.0"
    assert pattern["request"].pop("spherical_harmonic_profile") is None
    assert pattern["request"].pop("frequency_hz") == 438e6
    assert pattern["request"].pop("arm_length_m") == pytest.approx(299792458/(4*438e6))
    pattern["identity"] = content_hash(pattern["request"] | {"model_version": pattern["model_version"]})
    for cut in (pattern["cuts"] or {}).values():
        cut.pop("half_power", None)
    for path in BASELINE["pattern_comparison_exclusions"]:
        group, field = path.split(".")
        pattern[group].pop(field, None)
    return pattern, probe_response(request)


def reference(kind, name):
    payload = REFERENCE[kind][name]
    # Recovered payloads must retain the unchanged pre-extraction fingerprints.
    assert sha256_json(payload) == BASELINE[f"{kind}_sha256"][name]
    return payload


def ulp_distance(a, b):
    def ordered(value):
        bits = struct.unpack(">Q", struct.pack(">d", value))[0]
        return ~bits & ((1 << 64) - 1) if bits >> 63 else bits | (1 << 63)
    return abs(ordered(a) - ordered(b))


def assert_exact_payload(actual, expected):
    # Match the JSON array representation used by the original fingerprints.
    actual = json.loads(json.dumps(actual, allow_nan=False))
    structural = []
    changed = []
    maxima = {"absolute": None, "relative": None, "ulp": None}
    counts = {"float_leaves": 0, "changed_floats": 0, "structural": 0}

    def mismatch(path, detail):
        counts["structural"] += 1
        if len(structural) < 5:
            structural.append(f"{path}: {detail}")

    def visit(a, e, path):
        if type(a) is not type(e):
            mismatch(path, f"type {type(a).__name__}, expected {type(e).__name__}")
        elif isinstance(e, dict):
            if a.keys() != e.keys():
                mismatch(path, f"keys added={sorted(a.keys() - e.keys())}, removed={sorted(e.keys() - a.keys())}")
            for key in sorted(a.keys() & e.keys()):
                visit(a[key], e[key], f"{path}.{key}")
        elif isinstance(e, list):
            if len(a) != len(e):
                mismatch(path, f"length {len(a)}, expected {len(e)}")
            for index, (item, baseline) in enumerate(zip(a, e)):
                visit(item, baseline, f"{path}[{index}]")
        elif isinstance(e, float):
            counts["float_leaves"] += 1
            if not math.isfinite(a) or not math.isfinite(e):
                mismatch(path, f"nonfinite float {a!r}, expected {e!r}")
                return
            if a.hex() == e.hex():
                return
            counts["changed_floats"] += 1
            absolute = abs(a - e)
            denominator = max(abs(a), abs(e))
            item = dict(path=path, actual=a, expected=e,
                        actual_hex=a.hex(), expected_hex=e.hex(),
                        absolute=absolute, relative=absolute / denominator if denominator else 0,
                        ulp=ulp_distance(a, e))
            if len(changed) < 5:
                changed.append(item)
            for metric in maxima:
                if maxima[metric] is None or item[metric] > maxima[metric][metric]:
                    maxima[metric] = item
        elif a != e:
            mismatch(path, f"{a!r}, expected {e!r}")

    visit(actual, expected, "$")
    assert not counts["structural"] and not counts["changed_floats"], json.dumps(
        dict(counts=counts, structural=structural, first_changes=changed, maxima=maxima),
        indent=2, sort_keys=True,
    )


@pytest.mark.parametrize("name", BASELINE["scenarios"])
def test_complete_run_matches_pre_extraction_history(name):
    assert_exact_payload(legacy_run(name), reference("run", name))


@pytest.mark.parametrize("name", BASELINE["pattern_requests"])
def test_full_pattern_and_probe_match_pre_extraction_history(name):
    pattern, probe = legacy_pattern_and_probe(name)
    assert_exact_payload(
        dict(pattern=pattern, probe=probe),
        dict(pattern=reference("pattern", name), probe=reference("probe", name)),
    )


def test_legacy_schema_is_preserved_after_projecting_explicit_extensions():
    schemas = json.loads((FIXTURES / "schemas-before-extraction.json").read_text())
    scenario = Scenario.model_json_schema()
    link_properties = scenario["$defs"]["Link"]["properties"]
    assert link_properties.pop("spherical_harmonic_profile")["default"] is None
    assert link_properties.pop("antenna_orientation_deg")["default"] == [0, 0, 0]
    assert link_properties["spacecraft_antenna"]["enum"].pop() == "spherical_harmonic"
    for name in ("SphericalHarmonicProfile", "HarmonicCoefficient", "HarmonicProvenance"):
        scenario["$defs"].pop(name)
    schedule_properties = scenario["$defs"]["Schedule"]["properties"]
    for direction in ("uplink", "downlink"):
        assert schedule_properties.pop(f"{direction}_duration_s")["default"] is None
    radio_properties = scenario["$defs"]["RadioProfile"]["properties"]
    for name in ("channel_bandwidth_hz", "rolloff"):
        assert radio_properties.pop(name)["default"] is None
    assert scenario == schemas["scenario"]
    pattern = PatternRequest.model_json_schema()
    properties = pattern["properties"]
    assert properties.pop("frequency_hz") == dict(default=438e6, minimum=1e6, maximum=40e9, title="Frequency Hz", type="number")
    length = properties.pop("arm_length_m")
    assert length == dict(default=299792458/(4*438e6), minimum=1e-4, maximum=10, title="Arm Length M", type="number")
    gain = properties["patch_peak_gain_dbi"]
    assert gain["minimum"] == -10 and gain["maximum"] == 30
    gain["minimum"], gain["maximum"] = 10*math.log10(2), 20
    assert properties.pop("spherical_harmonic_profile")["default"] is None
    for name in ("SphericalHarmonicProfile", "HarmonicCoefficient", "HarmonicProvenance"):
        pattern["$defs"].pop(name)
    assert properties["model"]["enum"][-3:] == ["bent_v_up_45", "bent_v_out_45", "spherical_harmonic"]
    properties["model"]["enum"] = properties["model"]["enum"][:-3]
    assert pattern == schemas["pattern"]

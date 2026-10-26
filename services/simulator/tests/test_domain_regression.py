"""Histories captured before numerical-module extraction at ba3ccb7.

The independent physical reference/convergence tests remain in test_physics and
test_core. These fixtures detect changes to complete previously computed runs.
"""
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import struct

import pytest

from cubesat_sim.antenna_models import PatternRequest
from cubesat_sim.core import run_scenario
from cubesat_sim.models import Scenario, content_hash
from cubesat_sim.rf.pattern_sampling import probe_response, sample_pattern

FIXTURES = Path(__file__).parent / "fixtures"
BASELINE = json.loads((FIXTURES / "numerical-extraction-ba3ccb7.json").read_text())
REFERENCE = json.loads(gzip.decompress((FIXTURES / "numerical-extraction-ba3ccb7-payloads.json.gz").read_bytes()))

# Fixed benchmark roundoff budgets, not model-accuracy allowances: 8 ULP at
# Earth position scale and 32 ULP at orbital velocity scale. Normalized-field
# cancellation and logarithmic gain need absolute, rather than relative, bounds.
EPSILON = math.ulp(1.0)
POSITION_M = 8 * math.ulp(7e6)
VELOCITY_M_S = 32 * math.ulp(1e4)
NORMALIZED = 64 * EPSILON
DB = 1e-12
ANGLE_DEG = 1e-11
DOPPLER_HZ = 32 * math.ulp(1e5)
ANGULAR_RATE_DEG_S = 1e-13

SAMPLE_BUDGETS = {
    **dict.fromkeys(("satellite_position_m", "satellite_position_ecef_m", "station_position_m", "range_m"), POSITION_M),
    **dict.fromkeys(("satellite_velocity_m_s", "station_velocity_m_s", "range_rate_m_s"), VELOCITY_M_S),
    "q_body_from_inertial_wxyz": NORMALIZED,
    "azimuth_deg": ANGLE_DEG, "elevation_deg": ANGLE_DEG,
    "tracking_rate_deg_s": ANGULAR_RATE_DEG_S,
}
RF_BUDGETS = dict.fromkeys(("cn0_dbhz", "esn0_db", "fspl_db", "margin_db", "noise_density_dbw_hz",
                           "polarization_loss_db", "received_power_dbw", "rx_gain_dbi", "tx_gain_dbi"), DB)
# Near-horizon polarization projection and log10(coupling) amplify roundoff.
# Keep this allowance out of antenna gain, path loss and noise comparisons.
RF_BUDGETS.update(dict.fromkeys(("polarization_loss_db", "received_power_dbw", "cn0_dbhz", "esn0_db", "margin_db"), 1e-11))
RF_BUDGETS.update(polarization_coupling=128 * EPSILON, doppler_hz=DOPPLER_HZ)


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


def within_roundoff(a, e, path):
    family = re.sub(r"\[\d+\]", "[]", path)
    if family == "$.samples.attitude_angle_deg[]":
        # acos amplifies dot-product roundoff near 0/180 degrees. Compare its
        # dimensionless input, retaining the physical principal-angle domain.
        return (0 <= a <= 180 and 0 <= e <= 180
                and abs(math.cos(math.radians(a)) - math.cos(math.radians(e))) <= 8 * EPSILON)
    sample = re.fullmatch(r"\$\.samples\.(\w+)(?:\[\]){1,2}", family)
    rf = re.fullmatch(r"\$\.samples\.(?:uplink|downlink)\.(\w+)\[\]", family)
    budget = (SAMPLE_BUDGETS.get(sample[1]) if sample else
              RF_BUDGETS.get(rf[1]) if rf else
              {"$.summary.min_range_m": POSITION_M, "$.summary.max_elevation_deg": ANGLE_DEG}.get(family))
    if family == "$.pattern.peak_gain_dbi" or re.fullmatch(
        r"\$\.(?:pattern\.(?:grid|cuts\.(?:azimuth|elevation)|probe)|probe)\.gain_dbi(?:\[\])?", family
    ):
        budget = DB
    elif family in {"$.pattern.peak_gain_linear", "$.pattern.sphere_mean_gain"} or re.fullmatch(
        r"\$\.(?:pattern\.(?:grid|cuts\.(?:azimuth|elevation)|probe)|probe)\."
        r"(?:gain_linear|field_real|field_imag|directions_body|direction_body|linear_analyzer_body|linear_coupling)(?:\[\]){0,2}", family
    ):
        budget = NORMALIZED
    return budget is not None and abs(a - e) <= budget


def assert_portable_payload(actual, expected):
    # Match the JSON array representation used by the original fingerprints.
    actual = json.loads(json.dumps(actual, allow_nan=False))
    structural = []
    changed = []
    maxima = {"absolute": None, "relative": None, "ulp": None}
    rejected_fields = {}
    counts = {"float_leaves": 0, "changed_floats": 0, "outside_budget": 0, "structural": 0}

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
            if within_roundoff(a, e, path):
                return
            counts["outside_budget"] += 1
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
            family = re.sub(r"\[\d+\]", "[]", path)
            field = rejected_fields.setdefault(family, dict(count=0, absolute=0, relative=0, ulp=0))
            field["count"] += 1
            for metric in maxima:
                field[metric] = max(field[metric], item[metric])
        elif a != e:
            mismatch(path, f"{a!r}, expected {e!r}")

    visit(actual, expected, "$")
    assert not counts["structural"] and not counts["outside_budget"], json.dumps(
        dict(counts=counts, structural=structural, first_changes=changed, maxima=maxima,
             rejected_fields=dict(sorted(rejected_fields.items())[:20]),
             omitted_field_count=max(0, len(rejected_fields) - 20)),
        indent=2, sort_keys=True,
    )


@pytest.mark.parametrize("name", BASELINE["scenarios"])
def test_complete_run_matches_pre_extraction_history(name):
    assert_portable_payload(legacy_run(name), reference("run", name))


@pytest.mark.parametrize("name", BASELINE["pattern_requests"])
def test_full_pattern_and_probe_match_pre_extraction_history(name):
    pattern, probe = legacy_pattern_and_probe(name)
    assert_portable_payload(
        dict(pattern=pattern, probe=probe),
        dict(pattern=reference("pattern", name), probe=reference("probe", name)),
    )


def nested_payload(path, value):
    for part in reversed(path):
        value = [value] if part == 0 else {part: value}
    return value


@pytest.mark.parametrize("path, expected, actual", [
    (("samples", "range_m", 0), 7e6, 7e6 + POSITION_M / 2),
    (("samples", "range_rate_m_s", 0), 0.0, VELOCITY_M_S / 2),
    (("samples", "elevation_deg", 0), 90.0, 90.0 - ANGLE_DEG / 2),
    (("samples", "attitude_angle_deg", 0), 8.537736462515939e-7, 0.0),
    (("samples", "uplink", "margin_db", 0), 0.13387020181477283, 0.13387020181471598),
    (("samples", "downlink", "polarization_coupling", 0), 0.36882181948229964, 0.3688218194823182),
    (("samples", "downlink", "polarization_loss_db", 0), 27.27990429983501, 27.27990429983251),
    (("samples", "uplink", "doppler_hz", 0), 0.0, DOPPLER_HZ / 2),
    (("samples", "tracking_rate_deg_s", 0), 0.0, ANGULAR_RATE_DEG_S / 2),
    (("pattern", "grid", "field_real", 0, 0), -1.470393538023152e-16, -9.749348458631769e-17),
    (("pattern", "grid", "gain_dbi", 0), -26.10670011723624, -26.10670011723579),
])
def test_portable_comparison_accepts_bounded_output_roundoff(path, expected, actual):
    assert_portable_payload(nested_payload(path, actual), nested_payload(path, expected))


@pytest.mark.parametrize("path, expected, actual", [
    (("samples", "range_m", 0), 7e6, 7e6 + 1e-6),
    (("samples", "range_rate_m_s", 0), 0.0, 1e-9),
    (("samples", "elevation_deg", 0), 90.0, 90.0 - 1e-8),
    (("samples", "attitude_angle_deg", 0), 0.0, 1e-3),
    (("samples", "attitude_angle_deg", 0), 0.0, -1e-7),
    (("samples", "uplink", "margin_db", 0), 0.0, 1e-9),
    (("samples", "downlink", "polarization_coupling", 0), 0.5, 0.5 + 1e-12),
    (("samples", "downlink", "fspl_db", 0), 150.0, 150.0 + 2e-12),
    (("samples", "uplink", "doppler_hz", 0), 0.0, 1e-8),
    (("samples", "tracking_rate_deg_s", 0), 0.0, 1e-10),
    (("pattern", "grid", "field_real", 0, 0), 0.0, 1e-12),
    (("pattern", "grid", "gain_dbi", 0), -26.0, -26.0 + 1e-9),
    (("manifest", "scenario", "orbit", "altitude_m"), 550000.0, math.nextafter(550000.0, math.inf)),
    (("manifest", "scenario_hash"), "unchanged", "different"),
    (("samples", "time_s", 0), 1.0, math.nextafter(1.0, math.inf)),
    (("samples", "visible", 0), True, False),
    (("samples", "visible", 0), True, 1),
    (("samples", "active_direction", 0), "uplink", "downlink"),
    (("samples", "uplink", "valid", 0), True, False),
    (("samples", "uplink", "reason", 0), "visible", "unknown"),
    (("samples", "uplink", "margin_db", 0), None, 0.0),
    (("samples", "uplink", "ideal_rate_bps", 0), 450000.0, math.nextafter(450000.0, math.inf)),
    (("samples", "uplink", "cumulative_ideal_bits", 0), 450000.0, math.nextafter(450000.0, math.inf)),
    (("summary", "sample_count"), 1201, 1202),
    (("events", 0, "time_s"), 30.0, math.nextafter(30.0, math.inf)),
    (("unknown_result",), 1.0, math.nextafter(1.0, math.inf)),
])
def test_portable_comparison_rejects_changes_outside_declared_outputs(path, expected, actual):
    with pytest.raises(AssertionError):
        assert_portable_payload(nested_payload(path, actual), nested_payload(path, expected))


@pytest.mark.parametrize("actual, expected", [({"x": 1}, {}), ([1], [1, 2]), (1, 1.0)])
def test_portable_comparison_preserves_structure_and_scalar_types(actual, expected):
    with pytest.raises(AssertionError):
        assert_portable_payload(actual, expected)


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_portable_comparison_rejects_nonfinite_outputs(value):
    with pytest.raises(ValueError):
        assert_portable_payload({"samples": {"range_m": [value]}}, {"samples": {"range_m": [1.0]}})


def test_recovered_payload_inventory_and_hash_integrity(monkeypatch):
    assert REFERENCE.keys() == {"run", "pattern", "probe"}
    for kind, cases in REFERENCE.items():
        assert cases.keys() == BASELINE[f"{kind}_sha256"].keys()
    changed = dict(REFERENCE["probe"]["dipole"], gain_linear=1.234)
    monkeypatch.setitem(REFERENCE["probe"], "dipole", changed)
    with pytest.raises(AssertionError):
        reference("probe", "dipole")


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

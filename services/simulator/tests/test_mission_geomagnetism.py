"""Independent mission selection, terrestrial/body frames and archive compatibility."""
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path

from pydantic import ValidationError
import pytest

from cubesat_sim import mission_archive as archive
from cubesat_sim.geomagnetism import igrf14
from cubesat_sim.mission import driver
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.environment import MAGNETIC_MODEL
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.models import canonical_json

BASELINE = Path(__file__).resolve().parents[3] / "private/verification/2026-10-25-results-igrf/legacy-baseline.json"


def inputs(selection=None, duration=60):
    data = default_mission_scenario().model_dump(mode="json")
    data["duration_s"] = duration
    if selection == "omitted":
        data.pop("magnetic_model", None)
    else:
        data["magnetic_model"] = selection
    data["spacecraft"]["magnetic_unloading_enabled"] = True
    for wheel, rpm in zip(data["spacecraft"]["wheels"], (3000, -2000, 1000)):
        wheel["initial_speed_rpm"] = rpm
    return data


def json_copy(value):
    return json.loads(json.dumps(value, allow_nan=False))


def rotate_body_independently(q, vector):
    w, x, y, z = q
    matrix = (
        (1 - 2*(y*y + z*z), 2*(x*y - w*z), 2*(x*z + w*y)),
        (2*(x*y + w*z), 1 - 2*(x*x + z*z), 2*(y*z - w*x)),
        (2*(x*z - w*y), 2*(y*z + w*x), 1 - 2*(x*x + y*y)),
    )
    return tuple(sum(a*b for a, b in zip(row, vector)) for row in matrix)


def terrestrial_to_body(field_ecef, ecef_from_inertial_angle, q):
    # The recorded angle maps I -> ECEF; the inverse maps the field ECEF -> I.
    angle = -ecef_from_inertial_angle
    cosine, sine = math.cos(angle), math.sin(angle)
    x, y, z = field_ecef
    inertial = (cosine*x - sine*y, sine*x + cosine*y, z)
    return rotate_body_independently(q, inertial)



@pytest.mark.parametrize("field,angle,q,expected", [
    ((1, 0, 0), 0, (1, 0, 0, 0), (1, 0, 0)),
    ((1, 0, 0), math.pi/2, (1, 0, 0, 0), (0, -1, 0)),
    ((1, 0, 0), 0, (math.sqrt(0.5), 0, 0, math.sqrt(0.5)), (0, 1, 0)),
    ((0, 0, 1), math.pi/2, (1, 0, 0, 0), (0, 0, 1)),
])
def test_independent_frame_rotation_known_axes(field, angle, q, expected):
    assert terrestrial_to_body(field, angle, q) == pytest.approx(expected, abs=3e-16)


def snapshot_for(selection):
    config = MissionScenario.model_validate(inputs(selection, 30))
    result = driver.run_mission(config)
    raw = config.model_dump(mode="json")
    if selection == "omitted":
        raw.pop("magnetic_model", None)
        result["manifest"]["scenario"].pop("magnetic_model", None)
    identity, digest = config.identity()
    return json_copy(dict(scenario=raw, run=dict(
        run_id="geomagnetic-archive-compatibility",status="complete",
        scenario_id=identity,scenario_hash=digest,result=result,error=None,
    )))


def test_new_default_explicitly_selects_full_field_without_reinterpreting_legacy():
    assert default_mission_scenario().magnetic_model == "igrf14_degree13"
    omitted = MissionScenario.model_validate(inputs("omitted"))
    null = MissionScenario.model_validate(inputs(None))
    degree1 = MissionScenario.model_validate(inputs("igrf14_degree1"))
    degree13 = MissionScenario.model_validate(inputs("igrf14_degree13"))
    assert omitted.magnetic_model is null.magnetic_model is None
    assert omitted.identity() == null.identity()
    assert len({omitted.identity(), degree1.identity(), degree13.identity()}) == 3


@pytest.mark.parametrize("selection", ["igrf14_degree2", "igrf14_degree14", "full", 13, True])
def test_unsupported_magnetic_selector_rejected(selection):
    with pytest.raises(ValidationError):
        MissionScenario.model_validate(inputs(selection))


def test_explicit_degree1_retains_exact_legacy_samples_summary_and_events():
    results = [driver.run_mission(MissionScenario.model_validate(inputs(selection)))
               for selection in ("omitted", None, "igrf14_degree1")]
    for result in results[1:]:
        for field in ("samples", "summary", "events"):
            assert canonical_json(result[field]) == canonical_json(results[0][field])
    for result in results:
        assert result["manifest"]["frames"]["magnetic"] == MAGNETIC_MODEL
        assert "geomagnetic_model" not in result["manifest"]


@pytest.mark.skipif(not BASELINE.exists(), reason="Private frozen HEAD integration record is not distributed")
def test_private_frozen_head_identity_and_complete_numerical_history_are_exact():
    baseline = json.loads(BASELINE.read_text())
    assert "magnetic_model" not in baseline["scenario"]
    config = MissionScenario.model_validate(baseline["scenario"])
    assert config.identity() == tuple(baseline["identity"])
    current = driver.run_mission(config)
    for field in ("samples", "summary", "events"):
        assert canonical_json(current[field]) == canonical_json(baseline["result"][field])
    assert current["summary"]["computed_duration_s"] == 1200
    assert current["manifest"]["frames"] == baseline["result"]["manifest"]["frames"]


@pytest.mark.parametrize("selection", ["omitted", None, "igrf14_degree1", "igrf14_degree13"])
def test_new_archives_roundtrip_all_selector_presence_without_inserting_or_reidentifying(selection):
    snapshot = snapshot_for(selection)
    before = deepcopy(snapshot)
    encoded = archive.export_archive(snapshot)
    opened = archive.import_archive(encoded)["snapshot"]
    assert opened == before == snapshot
    assert archive.export_archive(opened) == encoded
    if selection == "omitted":
        assert "magnetic_model" not in opened["scenario"]
    else:
        assert opened["scenario"]["magnetic_model"] == selection
    assert opened["run"]["scenario_hash"] == before["run"]["scenario_hash"]


@pytest.mark.skipif(not BASELINE.exists(), reason="Private frozen HEAD integration record is not distributed")
def test_pre_geomagnetism_archive_roundtrip_preserves_original_input_source_and_history():
    baseline = json.loads(BASELINE.read_text())
    identity, digest = baseline["identity"]
    snapshot = dict(scenario=baseline["scenario"], run=dict(
        run_id="frozen-head-legacy-degree1",status="complete",scenario_id=identity,
        scenario_hash=digest,result=baseline["result"],error=None,
    ))
    encoded = archive.export_archive(snapshot)
    opened = archive.import_archive(encoded)["snapshot"]
    assert canonical_json(opened) == canonical_json(snapshot)
    assert "magnetic_model" not in opened["scenario"]
    assert opened["run"]["result"]["manifest"]["source_code_hashes"] == baseline["result"]["manifest"]["source_code_hashes"]


@pytest.mark.parametrize("selection", [None, "omitted", "igrf14_degree1", "igrf14_degree13"])
def test_selected_evaluator_reaches_output_body_field_and_excludes_other_path(monkeypatch, selection):
    calls = []
    field = (12e-6, -19e-6, 31e-6)
    full = selection == "igrf14_degree13"
    def selected(position, epoch, elapsed):
        calls.append((position, epoch, elapsed))
        return field
    def wrong(*_args, **_kwargs):
        pytest.fail("Driver evaluated the unselected geomagnetic model")
    monkeypatch.setattr(driver, "field_ecef_t_at_utc", selected if full else wrong)
    monkeypatch.setattr(driver, "magnetic_field_ecef_t", wrong if full else selected)
    config = MissionScenario.model_validate(inputs(selection, 30))
    result = driver.run_mission(config)
    samples = result["samples"]
    assert calls and len(calls) > len(samples["time_s"])
    for index, time in enumerate(samples["time_s"]):
        expected = terrestrial_to_body(field, samples["ecef_from_inertial_angle_rad"][index],
                                       samples["q_body_from_inertial_wxyz"][index])
        assert samples["gnc"]["magnetic_field_body_t"][index] == pytest.approx(expected, abs=2e-18)
        assert any(elapsed == time and epoch == config.epoch_utc and
                   tuple(position) == tuple(samples["satellite_position_ecef_m"][index])
                   for position, epoch, elapsed in calls)


def test_actual_full_field_matches_ecef_to_inertial_to_body_at_every_output_and_has_provenance():
    config = MissionScenario.model_validate(inputs("igrf14_degree13"))
    result = driver.run_mission(config)
    samples, manifest = result["samples"], result["manifest"]
    for index, time in enumerate(samples["time_s"]):
        field = igrf14.field_ecef_t_at_utc(samples["satellite_position_ecef_m"][index], config.epoch_utc, time)
        expected = terrestrial_to_body(field, samples["ecef_from_inertial_angle_rad"][index],
                                       samples["q_body_from_inertial_wxyz"][index])
        actual = samples["gnc"]["magnetic_field_body_t"][index]
        assert actual == pytest.approx(expected, abs=2e-18)
        assert math.hypot(*actual) == pytest.approx(math.hypot(*field), abs=2e-18)
    metadata = manifest["geomagnetic_model"]
    assert metadata == igrf14.model_metadata()
    assert metadata["max_degree"] == 13 and metadata["secular_variation_degree"] == 8
    assert metadata["input_frame"] == metadata["output_frame"] == "ECEF"
    assert metadata["input_units"] == "metres" and metadata["output_units"] == "tesla"
    assert manifest["frames"]["magnetic"] == "IGRF14-degree13-2025-SV"
    assert "no EOP/precession/nutation/polar motion" in manifest["frames"]["earth_fixed"]
    assert any("degree 13" in source.get("scope", "") for source in manifest["sources"])
    assert any("no magnetic sensor model" in warning for warning in manifest["warnings"])
    source = Path(igrf14.__file__).with_name("igrf14coeffs.txt")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    assert digest == metadata["coefficient_sha256"]
    assert manifest["source_code_hashes"]["cubesat_sim/geomagnetism/igrf14coeffs.txt"] == digest
    assert manifest["source_code_hashes"]["cubesat_sim/geomagnetism/igrf14.py"] == hashlib.sha256(Path(igrf14.__file__).read_bytes()).hexdigest()


def test_full_field_changes_magnetic_control_while_orbit_inputs_and_propagation_stay_same():
    legacy = driver.run_mission(MissionScenario.model_validate(inputs("igrf14_degree1")))
    full = driver.run_mission(MissionScenario.model_validate(inputs("igrf14_degree13")))
    assert full["samples"]["satellite_position_m"] == legacy["samples"]["satellite_position_m"]
    assert full["samples"]["satellite_velocity_m_s"] == legacy["samples"]["satellite_velocity_m_s"]
    assert full["samples"]["gnc"]["magnetic_field_body_t"] != legacy["samples"]["gnc"]["magnetic_field_body_t"]
    assert full["samples"]["gnc"]["magnetic_dipole_body_am2"] != legacy["samples"]["gnc"]["magnetic_dipole_body_am2"]
    assert full["samples"]["gnc"]["wheel_momentum_body_nms"] != legacy["samples"]["gnc"]["wheel_momentum_body_nms"]

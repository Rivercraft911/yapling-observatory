"""Electrical telemetry survives exact replay without rerunning its model."""
from copy import deepcopy
import json
import pytest
from cubesat_sim import mission_archive as archive
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.power.battery_electrical import electrical_defaults


@pytest.fixture(scope="module")
def snapshot():
    data = default_mission_scenario().model_dump(mode="json")
    data["duration_s"] = 60
    data["power"]["battery"]["electrical"] = electrical_defaults()
    scenario = MissionScenario.model_validate(data)
    result = run_mission(scenario)
    identity, digest = scenario.identity()
    return json.loads(json.dumps(dict(
        scenario=scenario.model_dump(mode="json"),
        run=dict(run_id="electrical-archive-test", status="complete", scenario_id=identity,
                 scenario_hash=digest, result=result, error=None, progress=None),
    )))


def test_electrical_archive_keeps_all_columns_and_reference_manifest(snapshot):
    encoded = archive.export_archive(snapshot)
    opened = archive.import_archive(encoded)["snapshot"]
    assert opened == snapshot
    assert archive.export_archive(opened) == encoded
    assert opened["run"]["result"]["manifest"]["battery_electrical"]["sources"]
    assert all(type(v) is bool for v in opened["run"]["result"]["samples"]["power"]["battery_temperature_outside_reference"])


@pytest.mark.parametrize("column,value", [
    ("battery_voltage_v", None), ("battery_current_a", None),
    ("battery_soc", 1.1), ("battery_remaining_charge_ah", -1),
    ("battery_open_circuit_voltage_v", 0), ("battery_resistance_ohm", -1),
    ("battery_terminal_power_w", True), ("battery_ohmic_heat_w", -1),
    ("battery_mean_resistance_ohm", -1), ("battery_temperature_outside_reference", 1),
])
def test_electrical_columns_reject_wrong_types_and_ranges(snapshot, column, value):
    broken = deepcopy(snapshot)
    broken["run"]["result"]["samples"]["power"][column][0] = value
    with pytest.raises(archive.ArchiveError):
        archive.export_archive(broken)


def test_enabled_electrical_snapshot_requires_complete_telemetry(snapshot):
    broken = deepcopy(snapshot)
    del broken["run"]["result"]["samples"]["power"]["battery_soc"]
    with pytest.raises(archive.ArchiveError, match="battery_soc is required"):
        archive.export_archive(broken)

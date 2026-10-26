"""Lab probes use the same archived antenna, body attitude and RF port as a mission."""
import math

from fastapi.testclient import TestClient
import pytest

from cubesat_sim.api import create_app
from cubesat_sim.antenna_models import RunProbe
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission_models import MissionScenario


def test_computed_mission_probe_matches_both_direction_spacecraft_gain_ports():
    data = default_mission_scenario().model_dump(mode="json")
    data["duration_s"] = 60
    data["antenna_variant"] = "turnstile"
    data["uplink"].update(spacecraft_antenna="wire", spacecraft_peak_gain_dbi=1,
                           antenna_orientation_deg=[21, -37, 63])
    data["downlink"].update(spacecraft_antenna="patch", spacecraft_peak_gain_dbi=8,
                             antenna_orientation_deg=[-15, 23, 41])
    result = run_mission(MissionScenario.model_validate(data))
    archived, samples = result["manifest"]["scenario"], result["samples"]
    with TestClient(create_app()) as client:
        for direction, spacecraft_gain in (("uplink", "rx_gain_dbi"), ("downlink", "tx_gain_dbi")):
            response = client.post("/api/antenna-lab/reference-request", json={
                "link": archived[direction], "antenna_variant": archived["antenna_variant"],
            })
            assert response.status_code == 200
            reference = response.json()
            assert reference["frequency_hz"] == archived[direction]["frequency_hz"]
            assert reference["orientation_deg"] == archived[direction]["antenna_orientation_deg"]
            for index in range(len(samples["time_s"])):
                probe = client.post("/api/antenna-lab/probe", json=reference | {"run_probe": {
                    "spacecraft_position_m": samples["satellite_position_m"][index],
                    "station_position_m": samples["station_position_m"][index],
                    "q_body_from_inertial_wxyz": samples["q_body_from_inertial_wxyz"][index],
                }})
                assert probe.status_code == 200
                body = probe.json()
                assert body["source"] == "run_line_of_sight"
                assert body["gain_dbi"] == pytest.approx(samples[direction][spacecraft_gain][index], abs=2e-12)
                assert sum(v*v for v in body["direction_body"]) == pytest.approx(1, abs=2e-14)


def test_run_probe_rejects_incomplete_or_degenerate_geometry_without_manual_fallback():
    with TestClient(create_app()) as client:
        good = dict(spacecraft_position_m=[7e6, 0, 0], station_position_m=[6e6, 0, 0],
                    q_body_from_inertial_wxyz=[1, 0, 0, 0])
        for change in (
            {"station_position_m": [7e6, 0, 0]},
            {"q_body_from_inertial_wxyz": [0, 0, 0, 0]},
            {"q_body_from_inertial_wxyz": [1, 1, 0, 0]},
        ):
            response = client.post("/api/antenna-lab/probe", json={"run_probe": good | change})
            assert response.status_code == 422
        run = RunProbe(**good)
        assert math.isfinite(run.spacecraft_position_m[0])

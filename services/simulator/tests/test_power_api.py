import copy
from fastapi.testclient import TestClient
import pytest
from cubesat_sim.api import create_app


def test_power_routes_preserve_config_energy_and_real_mode_presets():
    with TestClient(create_app()) as client:
        config = client.get("/api/power-lab/default").json()
        presets = client.get("/api/power-lab/stage-templates").json()
        assert presets["ground_tracking"]["loads"] != presets["sun_pointing"]["loads"]
        assert presets["imaging"]["sun_direction_body"] != presets["sun_pointing"]["sun_direction_body"]
        capacity = client.post("/api/power-lab/capacity", json=config["battery"]).json()
        assert capacity["capacity_wh"] == pytest.approx(48.24)
        response = client.post("/api/power-lab/study", json=config)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["manifest"]["config"] == config
        assert result["manifest"]["voltage_history_model"] is None
        assert abs(result["summary"]["first_law_residual_j"]) < 1e-5
        assert result["samples"]["time_s"][-1] == 1200
        assert result["samples"]["stored_energy_wh"][-1] != result["samples"]["stored_energy_wh"][0]
        original_hash = result["manifest"]["config_hash"]
        config["stages"][1].update(presets["imaging"])
        result2 = client.post("/api/power-lab/study", json=config).json()
        assert result2["manifest"]["config_hash"] != original_hash
        assert result2["summary"]["escaped_rf_j"] == 0
        assert "imaging" in result2["samples"]["mode"]


def test_power_routes_reject_invalid_and_excessive_work():
    with TestClient(create_app()) as client:
        base = client.get("/api/power-lab/default").json()
        config = copy.deepcopy(base)
        config["stages"][1]["loads"][2]["escaped_rf_w"] = 100
        assert client.post("/api/power-lab/study", json=config).status_code == 422
        config = copy.deepcopy(base)
        config["integration_step_s"] = .02
        assert client.post("/api/power-lab/study", json=config).status_code == 422
        config = copy.deepcopy(base)
        config["battery"]["total_capacity_wh"] = 12
        assert client.post("/api/power-lab/study", json=config).status_code == 422

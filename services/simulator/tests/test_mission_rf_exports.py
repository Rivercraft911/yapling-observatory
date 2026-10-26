"""Mode-load RF exports leave local heat and the mission boundary exactly once."""
import json
import math

import pytest

from cubesat_sim.geometry.frames import WGS84_A_M
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission.ephemeris import gmst_rad
from cubesat_sim.mission_archive import export_archive, import_archive
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.rf.uhf_beacon import default_uhf_beacon


def scenario(*, ground, solar, electrical, uhf):
    values = default_mission_scenario().model_dump(mode="json")
    values.update(duration_s=20, radio_delivery=None, uhf_beacon=default_uhf_beacon() if uhf else None)
    values["clocks"].update(controller_period_s=1, output_step_s=10, thermal_step_s=10)
    values["station"].update(latitude_deg=0, longitude_deg=0, minimum_elevation_deg=10)
    values["orbit"].update(force_model="central", preset=None, ltan_hours_at_epoch=None)
    epoch = "2026-10-25T12:00:00Z"
    values["orbit"]["elements"].update(epoch_utc=epoch, semi_major_axis_m=WGS84_A_M+550000,
        eccentricity=0, inclination_deg=0, raan_deg=math.degrees(gmst_rad(epoch)) % 360,
        argument_of_periapsis_deg=0, true_anomaly_deg=10)
    values["spacecraft"].update(wheels=[], magnetorquer=None, controller="coast",
        magnetic_unloading_enabled=False, initial_q_body_from_inertial_wxyz=[1,0,0,0],
        initial_omega_body_rad_s=[0,0,0])
    values["conops"].update(auto_ground_tracking=False, default_mode="sun_pointing", windows=[
        dict(window_id="contact", start_s=0, end_s=10, mode="ground_tracking")
    ] if ground else [])
    values["schedule"] = dict(first_direction="downlink", slot_duration_s=30)
    values["downlink"].update(tx_power_w=4, tx_feed_loss_db=1, spacecraft_antenna="patch",
        spacecraft_peak_gain_dbi=6, spherical_harmonic_profile=None)
    values["power"].update(solar_irradiance_w_m2=1361 if solar else 0,
        transmit_radiation_efficiency=1, analytical_efficiency_semantics="pattern_times_additional_v1")
    if not electrical:
        values["power"]["battery"].pop("electrical", None)
    for profile in values["power"]["mode_loads"]:
        profile["loads"] = [
            dict(component_id="bus-rf-source", thermal_node_id="bus", electrical_w=5,
                 escaped_rf_w=2.25 if profile["mode"] == "ground_tracking" else 1.25),
            dict(component_id="radio-node-source", thermal_node_id="radio", electrical_w=3, escaped_rf_w=.75),
        ]
    return MissionScenario.model_validate(values)


@pytest.mark.parametrize("ground", [False, True])
@pytest.mark.parametrize("solar", [False, True])
@pytest.mark.parametrize("electrical", [False, True])
@pytest.mark.parametrize("uhf", [False, True])
def test_mode_rf_export_closes_bus_radio_solar_and_storage_boundaries(ground, solar, electrical, uhf):
    config = scenario(ground=ground, solar=solar, electrical=electrical, uhf=uhf)
    result = run_mission(config)
    samples, summary = result["samples"], result["summary"]
    assert summary["computed_duration_s"] == 20
    assert all(samples["visible"])
    expected_mode = 3 * 10 + 2 * 10 if ground else 2 * 20
    expected_sband = 4 * 10**(-1/10) * 10 if ground else 0
    expected_uhf = 10**((29-30)/10) * 10**(-1/10) * .987136 if uhf else 0
    assert summary["energy_j"]["escaped_rf_j"] == pytest.approx(expected_mode+expected_sband+expected_uhf, abs=2e-12)
    assert sum(stage["escaped_rf_j"] for stage in summary["stage_energy"]) == pytest.approx(summary["energy_j"]["escaped_rf_j"], abs=2e-12)
    assert abs(summary["energy_j"]["closure_residual_j"]) < 1e-6
    assert (max(samples["power"]["potential_bus_w"]) > 0) is solar
    zero = config.model_dump(mode="json")
    for profile in zero["power"]["mode_loads"]:
        for load in profile["loads"]:
            load["escaped_rf_w"] = 0
    baseline = run_mission(MissionScenario.model_validate(zero))
    assert samples["power"]["stored_energy_j"] == baseline["samples"]["power"]["stored_energy_j"]
    assert samples["power"]["requested_load_w"] == baseline["samples"]["power"]["requested_load_w"]
    assert summary["energy_j"]["escaped_rf_j"]-baseline["summary"]["energy_j"]["escaped_rf_j"] == pytest.approx(expected_mode, abs=2e-12)
    for node, removed_heat in (("bus", 1.25), ("radio", .75)):
        actual = samples["thermal"]["node_internal_heat_w"][node][-1]
        before = baseline["samples"]["thermal"]["node_internal_heat_w"][node][-1]
        assert before-actual == pytest.approx(removed_heat, abs=2e-12)


def test_mode_rf_exports_archive_roundtrip_and_sampled_boundary():
    config = scenario(ground=True, solar=True, electrical=True, uhf=False)
    result = run_mission(config)
    expected = [3+4*10**(-1/10), 3+4*10**(-1/10), 2]
    assert result["samples"]["power"]["escaped_rf_w"] == pytest.approx(expected)
    snapshot = json.loads(json.dumps(dict(scenario=config.model_dump(mode="json"), run=dict(
        run_id="component-rf-exports", status="complete", scenario_id=config.identity()[0],
        scenario_hash=config.identity()[1], error=None, result=result))))
    archive = export_archive(snapshot)
    assert import_archive(archive)["snapshot"] == snapshot
    assert export_archive(import_archive(archive)["snapshot"]) == archive

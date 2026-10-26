import pytest
from cubesat_sim.power.profiles import PLANNING_TRANSMITTER, TransmitterPlanningProfile
from cubesat_sim.power.radio import transmit_power
from cubesat_sim.power.study import default_study_config, stage_templates
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.models import default_scenario


def test_user_confirmed_planning_inputs_and_separate_downstream_loss_planes():
    profile = PLANNING_TRANSMITTER
    assert profile.electrical_w == 14
    assert profile.pa_output_w == 2.5
    assert profile.source_status == "user_confirmed_editable_planning_input"
    flow = transmit_power(
        profile.electrical_w,
        profile.pa_output_w,
        profile.feed_loss_db,
        profile.radiation_efficiency,
    )
    assert flow.transmitter_heat_w == 11.5
    assert flow.feed_heat_w == pytest.approx(2.5 - 2.5 * 10 ** (-1 / 10))
    assert flow.antenna_heat_w == 0
    assert flow.total_heat_w == pytest.approx(12.014179413189297)
    assert flow.total_heat_w + flow.escaped_rf_w == 14
    with pytest.raises(ValueError):
        TransmitterPlanningProfile(electrical_w=3, pa_output_w=4)


def test_authoritative_mission_and_power_presets_share_new_inputs_while_legacy_rf_reference_is_preserved():
    mission = default_mission_scenario()
    assert mission.power.spacecraft_tx_electrical_w == 14
    assert mission.downlink.tx_power_w == 2.5
    assert mission.downlink.tx_feed_loss_db == 1
    assert any("14 W total transmitter electrical input" in entry for entry in mission.provenance)
    assert any("separate RX activity loads are unresolved" in entry for entry in mission.provenance)
    standalone = default_study_config()
    tx = next(
        load
        for stage in standalone.stages
        if stage.mode == "ground_tracking"
        for load in stage.loads
        if load.component_id == "radio"
    )
    assert tx.electrical_w == 14
    assert tx.escaped_rf_w == pytest.approx(2.5 * 10 ** (-1 / 10))
    assert default_scenario().downlink.tx_power_w == 2


def test_activity_profiles_keep_requested_loads_and_independent_allowances():
    mission = default_mission_scenario()
    mission_profiles = {
        profile.mode: {load.component_id: load.electrical_w for load in profile.loads}
        for profile in mission.power.mode_loads
    }
    standalone_profiles = {
        mode: {load["component_id"]: load["electrical_w"] for load in stage["loads"]}
        for mode, stage in stage_templates().items()
    }
    for mode in ("imaging", "ground_tracking"):
        for profiles in (mission_profiles, standalone_profiles):
            assert profiles[mode]["obc"] == 8
            assert profiles[mode]["camera"] == 1
            assert profiles[mode]["eps"] == 0.5
    for mode in ("sun_pointing", "detumble"):
        for profiles in (mission_profiles, standalone_profiles):
            assert profiles[mode]["obc"] == 2
            assert profiles[mode]["camera"] == 0
            assert profiles[mode]["eps"] == 0.5
    assert standalone_profiles["imaging"]["radio"] == 0.5
    assert standalone_profiles["sun_pointing"]["radio"] == 0.5
    assert standalone_profiles["detumble"]["magnetorquers"] == 0.75
    assert mission.power.radio_idle_w == 0.5
    assert mission.power.spacecraft_receive_w == 1.5


def test_explicit_older_or_custom_inputs_roundtrip_without_default_migration():
    values = default_mission_scenario().model_dump(mode="json")
    values["power"].update(spacecraft_tx_electrical_w=10, radio_idle_w=0.7)
    values["downlink"]["tx_power_w"] = 4
    for profile in values["power"]["mode_loads"]:
        for load in profile["loads"]:
            if load["component_id"] == "obc":
                load["electrical_w"] = 3
            if load["component_id"] == "camera":
                load["electrical_w"] = 2
    restored = MissionScenario.model_validate(values)
    assert restored.model_dump(mode="json") == values
    assert MissionScenario.model_validate_json(restored.model_dump_json()).identity() == restored.identity()

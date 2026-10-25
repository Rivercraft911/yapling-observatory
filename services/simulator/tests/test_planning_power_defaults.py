import pytest
from cubesat_sim.power.profiles import PLANNING_TRANSMITTER, TransmitterPlanningProfile
from cubesat_sim.power.radio import transmit_power
from cubesat_sim.power.study import default_study_config
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.models import default_scenario


def test_user_confirmed_planning_inputs_and_separate_downstream_loss_planes():
    profile = PLANNING_TRANSMITTER
    assert profile.electrical_w == 10
    assert profile.pa_output_w == 4
    assert profile.source_status == "user_confirmed_editable_planning_input"
    flow = transmit_power(
        profile.electrical_w,
        profile.pa_output_w,
        profile.feed_loss_db,
        profile.radiation_efficiency,
    )
    assert flow.transmitter_heat_w == 6
    assert flow.feed_heat_w == pytest.approx(4 - 4 * 10 ** (-1 / 10))
    assert flow.antenna_heat_w == 0
    assert flow.total_heat_w > 6
    assert flow.total_heat_w + flow.escaped_rf_w == 10
    with pytest.raises(ValueError):
        TransmitterPlanningProfile(electrical_w=3, pa_output_w=4)


def test_authoritative_mission_and_power_presets_share_new_inputs_while_legacy_rf_reference_is_preserved():
    mission = default_mission_scenario()
    assert mission.power.spacecraft_tx_electrical_w == 10
    assert mission.downlink.tx_power_w == 4
    assert mission.downlink.tx_feed_loss_db == 1
    assert any("10 W electrical / 4 W PA-port RF" in entry for entry in mission.provenance)
    standalone = default_study_config()
    tx = next(
        load
        for stage in standalone.stages
        if stage.mode == "ground_tracking"
        for load in stage.loads
        if load.component_id == "radio"
    )
    assert tx.electrical_w == 10
    assert tx.escaped_rf_w == pytest.approx(4 * 10 ** (-1 / 10))
    assert default_scenario().downlink.tx_power_w == 2

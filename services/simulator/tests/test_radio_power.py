"""Reference-plane accounting shared by the draft preview and mission driver."""
import math
import pytest
from fastapi.testclient import TestClient
from cubesat_sim.api import create_app
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.power.radio import transmit_power, heat_only_load
from cubesat_sim.rf.spherical_harmonics import reference_profiles


def test_transmitter_heat_and_complete_onboard_heat_are_distinct():
    budget = transmit_power(10, 4, 10 * math.log10(2), .75)
    assert budget.transmitter_heat_w == 6
    assert budget.feed_heat_w == pytest.approx(2)
    assert budget.antenna_heat_w == pytest.approx(.5)
    assert budget.escaped_rf_w == pytest.approx(1.5)
    assert budget.total_heat_w == pytest.approx(8.5)
    assert budget.total_heat_w + budget.escaped_rf_w == budget.electrical_w
    assert budget.transmitter_heat_w + budget.feed_heat_w + budget.antenna_heat_w == pytest.approx(budget.total_heat_w)
    assert transmit_power(10, 4, 0, 1).total_heat_w == 6


@pytest.mark.parametrize('args', [(3,4,0,1), (10,4,-1,1), (10,4,0,1.1), (True,0,0,1), (10,4,0,float('nan'))])
def test_invalid_radio_partitions(args):
    with pytest.raises(ValueError):
        transmit_power(*args)


def test_idle_and_receive_have_no_escaped_rf():
    assert heat_only_load(.5) == {'electrical_w':.5,'heat_w':.5}


def test_draft_api_uses_explicit_pa_port_and_selected_profile_efficiency():
    scenario=default_mission_scenario().model_dump(mode='json')
    link=scenario['downlink']
    link.update(tx_power_w=4, tx_feed_loss_db=0)
    payload=dict(tx_electrical_w=10,rx_electrical_w=1.5,idle_electrical_w=.5,
                 downlink=link,analytical_radiation_efficiency=.8)
    with TestClient(create_app()) as client:
        result=client.post('/api/mission/radio-power',json=payload)
        assert result.status_code==200
        assert result.json()['transmit']['total_heat_w']==pytest.approx(6.8)
        assert result.json()['transmit']['transmitter_heat_w']==6
        payload['tx_electrical_w']=3
        assert client.post('/api/mission/radio-power',json=payload).status_code==422


def test_harmonic_profile_efficiency_overrides_analytical_value():
    link=default_mission_scenario().model_dump(mode='json')['downlink']
    profile=reference_profiles()[0]['profile']
    profile['radiation_efficiency']=.75
    link.update(tx_power_w=4, tx_feed_loss_db=0, spacecraft_antenna='spherical_harmonic',
                spherical_harmonic_profile=profile, frequency_hz=profile['frequency_hz'])
    payload=dict(tx_electrical_w=10,rx_electrical_w=1.5,idle_electrical_w=.5,
                 downlink=link,analytical_radiation_efficiency=.1)
    with TestClient(create_app()) as client:
        response=client.post('/api/mission/radio-power',json=payload)
        assert response.status_code==200, response.text
        transmit=response.json()['transmit']
        assert transmit['radiation_efficiency']==.75
        assert transmit['escaped_rf_w']==3
        assert transmit['total_heat_w']==7

import json
import math
import pytest
from pydantic import ValidationError

from cubesat_sim.core import CircularPass, run_scenario, evaluate_link
from cubesat_sim.models import Scenario, default_scenario
from cubesat_sim.physics import EARTH_MU_M3_S2, EARTH_OMEGA_RAD_S, WGS84_A_M, norm, dot, cross


def edited(scenario, **updates):
    return Scenario.model_validate(scenario.model_dump(mode="json") | updates)


def test_immutable_scenario_hash_and_input_validation():
    scenario=default_scenario()
    with pytest.raises(ValidationError):
        scenario.station.height_m=50
    assert scenario.identity() == Scenario.model_validate_json(scenario.model_dump_json()).identity()
    assert scenario.identity() != edited(scenario, step_s=2).identity()
    with pytest.raises(ValidationError):
        edited(scenario,duration_s=3600,step_s=.05)
    with pytest.raises(ValidationError):
        edited(scenario,epoch_utc="2026-10-25T00:00:00")
    with pytest.raises(ValidationError):
        edited(scenario,step_s=float('nan'))
    with pytest.raises(ValidationError):
        edited(scenario,render_camera=[1,2,3])


def test_circular_orbit_energy_range_rate_and_station_rotation():
    orbit=CircularPass(default_scenario());radius=WGS84_A_M+550000
    for t in (0,300,600,900,1200):
        state=orbit.state(t)
        assert norm(state['satellite_position_m']) == pytest.approx(radius,abs=1e-8)
        assert norm(state['satellite_velocity_m_s'])**2 == pytest.approx(EARTH_MU_M3_S2/radius,rel=1e-14)
        assert state['station_velocity_m_s'] == pytest.approx(cross((0,0,EARTH_OMEGA_RAD_S),state['station_position_m']))
    for t in (100,450,1000):
        numerical=(orbit.state(t+.001)['range_m']-orbit.state(t-.001)['range_m'])/.002
        assert orbit.state(t)['range_rate_m_s'] == pytest.approx(numerical,abs=1e-4)


def test_prescribed_tracking_offset_and_tumble_are_distinct():
    scenario=default_scenario();s=scenario.model_dump(mode='json')
    s['attitude']['pointing_error_deg']=12
    orbit=CircularPass(Scenario.model_validate(s))
    assert orbit.state(500)['attitude_angle_deg'] == pytest.approx(12,abs=1e-10)
    s['attitude']['mode']='tumble';tumble=CircularPass(Scenario.model_validate(s))
    assert abs(tumble.state(400)['attitude_angle_deg']-tumble.state(500)['attitude_angle_deg'])>1
    assert norm(orbit.state(500)['q_body_from_inertial_wxyz']) == pytest.approx(1)


def test_directions_have_separate_power_noise_and_modes():
    sc=default_scenario();state=CircularPass(sc).state(600)
    up,down=(evaluate_link(sc,d,state)for d in ('uplink','downlink'))
    assert up['received_power_dbw']-down['received_power_dbw'] == pytest.approx(10*math.log10(5/2))
    assert down['cn0_dbhz']-up['cn0_dbhz'] == pytest.approx(10*math.log10(2/5)+10*math.log10(800/150))
    assert down['esn0_db'] == pytest.approx(down['cn0_dbhz']-60)
    assert down['margin_db'] == pytest.approx(down['esn0_db']-1)


def test_deterministic_headless_result_and_provenance():
    sc=edited(default_scenario(),duration_s=30,step_s=2)
    a,b=run_scenario(sc),run_scenario(sc)
    assert a==b
    assert a['manifest']['scenario_hash']==sc.identity()[1]
    assert a['manifest']['versions']['pydantic']!='not installed'
    assert a['manifest']['input_provenance']
    assert a['samples']['elapsed_ns'][-1]=='30000000000'
    assert 'not GCRF' in a['manifest']['frames']['inertial']
    # Standard JSON rejects NaN and infinity; nulls remain actual unknowns.
    json.dumps(a,allow_nan=False)


def test_exact_alternating_slot_integration_with_constant_good_link():
    s=default_scenario().model_dump(mode='json');s.update(duration_s=10,step_s=2)
    s['schedule']['slot_duration_s']=3
    for d in ('uplink','downlink'):
        s[d]['profile'].update(symbol_rate_sps=100,net_efficiency=1,threshold_db=-20,threshold_status='illustrative')
    result=run_scenario(Scenario.model_validate(s))
    assert result['summary']['ideal_capacity_bits']==pytest.approx({'uplink':600,'downlink':400})


def test_step_refinement_capacity_converges_and_geometry_is_independent():
    sc=default_scenario();coarse=run_scenario(edited(sc,step_s=2));fine=run_scenario(edited(sc,step_s=.5))
    for d in ('uplink','downlink'):
        # Grid-resolved threshold edges, <= a few whole-sample durations.
        assert abs(coarse['summary']['ideal_capacity_bits'][d]-fine['summary']['ideal_capacity_bits'][d])<=4*2*900000
    assert coarse['samples']['satellite_position_m'][300] == fine['samples']['satellite_position_m'][1200]


def test_unknown_v45_pattern_is_not_zero_capacity():
    s=default_scenario().model_dump(mode='json');s.update(duration_s=10,antenna_variant='v45')
    s['uplink'].update(spacecraft_antenna='wire',spacecraft_peak_gain_dbi=2.15)
    r=run_scenario(Scenario.model_validate(s))
    assert r['summary']['ideal_capacity_bits']['uplink'] is None
    assert r['summary']['capacity_available']['uplink'] is False
    assert all(v is None for v in r['samples']['uplink']['ideal_rate_bps'])
    assert all(v is None for v in r['samples']['uplink']['cumulative_ideal_bits'])
    assert r['summary']['ideal_capacity_bits']['downlink'] is not None


def test_unresolved_lora_can_be_in_either_direction():
    from cubesat_sim.api import radio_profiles
    for direction in ('uplink','downlink'):
        s=default_scenario().model_dump(mode='json');s['duration_s']=10
        s[direction].update(frequency_hz=438e6,profile=radio_profiles()['lora'])
        r=run_scenario(Scenario.model_validate(s))
        assert r['summary']['ideal_capacity_bits'][direction] is None
        assert all(v is None for v in r['samples'][direction]['margin_db'])
        assert all(v is None for v in r['samples'][direction]['esn0_db'])
        assert all(v is None for v in r['samples'][direction]['ideal_rate_bps'])


def test_ideal_dvb_profile_cannot_silently_change_threshold_conditions():
    s=default_scenario().model_dump(mode='json');s['downlink']['profile']['modulation']='8PSK'
    with pytest.raises(ValidationError):Scenario.model_validate(s)
    s['downlink']['profile'].update(code_rate=2/3,threshold_db=6.62)
    assert Scenario.model_validate(s).downlink.profile.net_rate_bps()==pytest.approx(1800000)


def test_wire_peak_schema_and_runtime_have_one_exact_boundary():
    from cubesat_sim.physics import HALF_WAVE_PEAK_DBI
    s=default_scenario().model_dump(mode='json');s['duration_s']=10
    s['uplink'].update(spacecraft_antenna='wire',spacecraft_peak_gain_dbi=HALF_WAVE_PEAK_DBI)
    assert run_scenario(Scenario.model_validate(s))['summary']['capacity_available']['uplink']is True
    s['uplink']['spacecraft_peak_gain_dbi']=math.nextafter(HALF_WAVE_PEAK_DBI,math.inf)
    with pytest.raises(ValidationError):Scenario.model_validate(s)
    s['uplink']['spacecraft_peak_gain_dbi']=2.1509
    with pytest.raises(ValidationError):Scenario.model_validate(s)


@pytest.mark.parametrize('heading',[0,45,90,-90,180,-135])
def test_requested_heading_is_earth_fixed_enu_ground_track(heading):
    s=default_scenario().model_dump(mode='json');s['orbit']['ground_track_heading_deg']=heading
    orbit=CircularPass(Scenario.model_validate(s));state=orbit.state(s['duration_s']/2)
    position=state['satellite_position_m']
    relative=tuple(v-w for v,w in zip(state['satellite_velocity_m_s'],cross((0,0,EARTH_OMEGA_RAD_S),position)))
    east,north,_=orbit.enu_ecef
    actual=math.degrees(math.atan2(dot(relative,east),dot(relative,north)))
    difference=(actual-heading+180)%360-180
    assert difference==pytest.approx(0,abs=1e-10)
    assert dot(state['satellite_velocity_m_s'],position)==pytest.approx(0,abs=2e-5)
    assert norm(state['satellite_velocity_m_s'])**2==pytest.approx(EARTH_MU_M3_S2/orbit.radius,rel=1e-14)

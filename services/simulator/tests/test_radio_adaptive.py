"""Independent catalogue facts, frame accounting and ideal adaptation policies."""
from copy import deepcopy
from fractions import Fraction
import math

from pydantic import ValidationError
import pytest

from cubesat_sim import mission_archive as archive
from cubesat_sim.mission.daytime_demo import daytime_overhead_demo
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.models import default_scenario, canonical_json
from cubesat_sim.operations.radio_delivery import RadioDeliveryAccumulator, frame_layout
from cubesat_sim.operations.radio_delivery_models import (
    DeliveryMode, DirectionDelivery, RadioDeliveryConfig, delivery_example, normal_psk_modes,
)


def mode(identifier, rate='1/2', threshold=0, **change):
    values = dict(mode_id=identifier, modulation='QPSK', code_rate=rate,
        symbol_rate_sps=33282, frame_size='normal', pilots=True,
        decode_threshold_esn0_db=threshold,
        threshold_status='unresolved' if threshold is None else 'illustrative',
        threshold_source='Constructed policy test, not calibrated hardware')
    return DeliveryMode(**(values | change))


def profile(**changes):
    values = dict(policy='adaptive', assumptions='Constructed ideal policy test',
        modes=(mode('low'), mode('high', '3/4', 4)), initial_mode_id='low',
        acquisition_s=0, reacquisition_s=0, loss_hold_s=0,
        minimum_dwell_s=0, mode_change_s=0, acquisition_margin_db=0.5, hold_margin_db=-0.5)
    return DirectionDelivery(**(values | changes))


def accumulator(**changes):
    selected = profile(**changes)
    return RadioDeliveryAccumulator(RadioDeliveryConfig(uplink=selected, downlink=selected))


def advance(acc, start, end, esn0=2, active=True, direction='downlink'):
    cn0 = 10 * math.log10(33282) + esn0
    return acc.advance(start, end, direction, active, {'uplink': cn0, 'downlink': cn0})


def conserved(row):
    assert row['frames_started'] == sum(row[key] for key in
        ('delivered_frames', 'lost_frames', 'unresolved_frames', 'pending_frames'))
    assert row['offered_useful_bits'] == sum(row[key] for key in
        ('delivered_useful_bits', 'lost_useful_bits', 'unresolved_useful_bits', 'pending_useful_bits'))


def test_all_17_legal_normal_modes_match_checked_etsi_table13_values():
    modes = normal_psk_modes(5e6, 2.5)
    # EN302307-1 V1.4.1 Table13 printed p.36, normal64800-bit, ideal AWGN.
    expected = {
        'QPSK': {'1/4': -2.35, '1/3': -1.24, '2/5': -.30, '1/2': 1,
                 '3/5': 2.23, '2/3': 3.10, '3/4': 4.03, '4/5': 4.68,
                 '5/6': 5.18, '8/9': 6.20, '9/10': 6.42},
        '8PSK': {'3/5': 5.50, '2/3': 6.62, '3/4': 7.91,
                 '5/6': 9.35, '8/9': 10.69, '9/10': 10.98},
    }
    assert len(modes) == 17 and len({item.mode_id for item in modes}) == 17
    assert {(m.modulation, m.code_rate) for m in modes} == {
        (modulation, rate) for modulation, rates in expected.items() for rate in rates
    }
    for item in modes:
        assert item.decode_threshold_esn0_db == expected[item.modulation][item.code_rate] + 2.5
        assert item.threshold_status == 'ideal_awgn' and item.frame_size == 'normal'
        assert item.symbol_rate_sps == 5e6 and item.pilots
        assert 'Table13 printed p.36' in item.threshold_source
        assert 'not measured' in item.threshold_source.lower()
        layout = frame_layout(item)
        assert layout.fecframe_bits == 64800
        assert layout.data_field_bits == layout.kbch_bits - 80


def test_catalogue_factory_is_explicit_generic_and_current_preset_stays_unchanged():
    scenario = default_scenario()
    before = scenario.model_dump(mode='json')
    current = delivery_example(scenario.uplink, scenario.downlink)
    assert len(current.uplink.modes) == 1 and current.uplink.policy == 'fixed'
    assert current.uplink.modes[0].threshold_status == 'illustrative'
    adaptive = delivery_example(scenario.uplink, scenario.downlink, preset='adaptive_psk')
    for direction in ('uplink', 'downlink'):
        selected = getattr(adaptive, direction)
        assert selected.policy == 'adaptive' and len(selected.modes) == 17
        assert selected.hardware_profile == 'generic_dvb_s2_reference'
        assert selected.initial_mode_id == 'qpsk-1-4'
        assert selected.acquisition_margin_db > 0
        assert 'No delayed feedback' in selected.assumptions
    assert scenario.model_dump(mode='json') == before
    with pytest.raises(ValueError):
        delivery_example(scenario.uplink, scenario.downlink, preset='unknown')
    with pytest.raises(ValidationError):
        profile(hardware_profile='esp32_s3_short_pair')
    with pytest.raises(ValidationError):
        profile(schedule=({'start_s': 1, 'mode_id': 'high'},))
    for change in (dict(code_rate='7/8'), dict(modulation='16APSK'),
                   dict(modulation='8PSK', code_rate='4/5'),
                   dict(frame_size='short', threshold_status='ideal_awgn')):
        with pytest.raises(ValidationError):
            mode('bad', **change)


@pytest.mark.parametrize('esn0,expected', [(5.6, '8psk-3-5'), (6.5, 'qpsk-9-10'),
                                         (6.8, '8psk-2-3'), (20, '8psk-9-10')])
def test_selection_maximizes_complete_frame_useful_rate_not_catalogue_order(esn0, expected):
    modes = normal_psk_modes(1e6)
    selected = profile(modes=modes, initial_mode_id=modes[0].mode_id, acquisition_margin_db=0)
    acc = RadioDeliveryAccumulator(RadioDeliveryConfig(uplink=selected, downlink=selected))
    row = acc.advance(0, 1, 'downlink', True, dict(uplink=60+esn0, downlink=60+esn0))['downlink']
    assert row['mode_id'] == expected
    chosen = next(m for m in modes if m.mode_id == expected)
    # Independent normal-PLFRAME symbol count and payload boundary.
    symbols = 32400 + 90 + 22*36 if chosen.modulation == 'QPSK' else 21600 + 90 + 14*36
    assert row['ready_payload_rate_bps'] == (frame_layout(chosen).kbch_bits - 80) * 1e6 / symbols
    assert row['selected_margin_db'] == pytest.approx(esn0 - chosen.decode_threshold_esn0_db)
    assert row['delivered_frames'] == 1_000_000 // symbols
    assert row['delivered_useful_bits'] == row['delivered_frames'] * (frame_layout(chosen).kbch_bits - 80)
    conserved(row)


def test_capture_hysteresis_prevents_threshold_flapping_and_ties_keep_current():
    acc = accumulator()
    assert advance(acc, 0, 1, 6)['downlink']['mode_id'] == 'high'
    assert advance(acc, 1, 2, 4.1)['downlink']['mode_id'] == 'high'
    assert advance(acc, 2, 3, 3.9)['downlink']['mode_id'] == 'low'
    for start, esn0 in ((3, 4.1), (4, 3.99), (5, 4.3), (6, 4.49)):
        assert advance(acc, start, start+1, esn0)['downlink']['mode_id'] == 'low'
    assert advance(acc, 7, 8, 4.6)['downlink']['mode_id'] == 'high'
    assert acc.sample()['downlink']['mode_change_count'] == 3
    same = mode('equivalent')
    tie = accumulator(modes=(mode('low'), same), initial_mode_id='equivalent')
    assert advance(tie, 0, 10)['downlink']['mode_change_count'] == 0


def test_dwell_partial_frame_reconfiguration_and_reacquisition_are_charged():
    acc = accumulator(minimum_dwell_s=2, mode_change_s=0.2, reacquisition_s=0.3)
    advance(acc, 0, .5, 2)
    row = advance(acc, .5, 4.5, 6)['downlink']
    assert row['mode_id'] == 'high'
    assert row['delivered_useful_bits'] == 2*32128 + 48328
    assert row['lost_useful_bits'] == 48328
    assert row['mode_change_count'] == 1
    assert row['reconfiguration_time_s'] == .2
    assert row['locked_time_s'] == 4
    assert any(event['time_s'] == 2 and event['cause'] == 'adaptive_mode_change' for event in acc.events)
    conserved(row)
    pending = accumulator()
    advance(pending, 0, .5, 2)
    assert advance(pending, .5, .75, 6)['downlink']['mode_id'] == 'low'
    assert advance(pending, .75, 1, 6)['downlink']['mode_id'] == 'high'
    assert pending.sample()['downlink']['boundary_delivered_useful_bits'] == 32128


def test_unknown_thresholds_never_win_and_unknown_channel_is_not_zero_delivery_claim():
    acc = accumulator(modes=(mode('low'), mode('unknown', '9/10', None)))
    row = advance(acc, 0, 1, 100)['downlink']
    assert row['mode_id'] == 'low'
    row = acc.advance(1, 2, 'downlink', True, dict(uplink=100, downlink=None))['downlink']
    assert row['ready_payload_rate_bps'] is None and row['selected_margin_db'] is None
    assert not row['delivery_available'] and row['unresolved_frames'] > 0
    conserved(row)


def test_fades_outage_inactive_and_direction_turnaround_cannot_credit_frames():
    acc = accumulator(loss_hold_s=.25, reacquisition_s=.25)
    advance(acc, 0, 1.5, 2)
    before = acc.sample()['downlink']['delivered_useful_bits']
    row = advance(acc, 1.5, 2, -10)['downlink']
    assert row['ready_payload_rate_bps'] == 0 and row['selected_margin_db'] < 0
    assert row['delivered_useful_bits'] == before
    row = acc.advance(2, 3, 'downlink', True, dict(uplink=100, downlink=None),
                      known_outage=dict(uplink=False, downlink=True))['downlink']
    assert row['ready_payload_rate_bps'] == 0 and row['selected_margin_db'] is None
    assert row['unresolved_time_s'] == 0 and row['delivered_useful_bits'] == before
    rows = advance(acc, 3, 4, 100, direction='uplink')
    assert rows['downlink']['ready_payload_rate_bps'] == 0
    assert rows['downlink']['selected_margin_db'] is None
    assert rows['downlink']['delivered_useful_bits'] == before
    totals = {d: r['delivered_useful_bits'] for d, r in rows.items()}
    rows = advance(acc, 4, 6, 100, active=False)
    assert all(r['ready_payload_rate_bps'] == 0 and r['selected_margin_db'] is None for r in rows.values())
    assert {d: r['delivered_useful_bits'] for d, r in rows.items()} == totals
    for row in rows.values():
        conserved(row)


def test_constant_channel_subdivision_is_exact_and_millions_of_frames_are_batched():
    coarse, fine = accumulator(minimum_dwell_s=2, mode_change_s=.2, reacquisition_s=.3), accumulator(minimum_dwell_s=2, mode_change_s=.2, reacquisition_s=.3)
    advance(coarse, 0, 100, 6)
    cuts = [0, .1, .7, 1, 2, 2.1, 2.2, 2.5, 3.1, 99.999, 100]
    for a,b in zip(cuts,cuts[1:]):
        advance(fine,a,b,6)
    assert fine.sample() == coarse.sample() and fine.events == coarse.events
    modes = normal_psk_modes(5e6)
    selected = profile(modes=modes, initial_mode_id=modes[-1].mode_id, acquisition_margin_db=0)
    acc = RadioDeliveryAccumulator(RadioDeliveryConfig(uplink=selected,downlink=selected))
    row = acc.advance(0,86400,'downlink',True,dict(uplink=100,downlink=100))['downlink']
    assert row['delivered_frames'] > 10_000_000 and len(acc.events) < 10
    conserved(row)


@pytest.fixture(scope='module')
def adaptive_snapshot():
    data = daytime_overhead_demo().model_dump(mode='json')
    data['duration_s'] = 600
    base = MissionScenario.model_validate(data)
    data['radio_delivery'] = delivery_example(base.uplink,base.downlink,preset='adaptive_psk').model_dump(mode='json')
    config = MissionScenario.model_validate(data)
    result = run_mission(config)
    identity,digest = config.identity()
    return json_snapshot(dict(scenario=config.model_dump(mode='json'),run=dict(run_id='adaptive-archive',status='complete',scenario_id=identity,scenario_hash=digest,result=result,error=None)))


def json_snapshot(value):
    import json
    return json.loads(json.dumps(value,allow_nan=False))


def test_adaptive_mission_archive_and_policy_specific_columns(adaptive_snapshot):
    encoded = archive.export_archive(adaptive_snapshot)
    assert archive.import_archive(encoded)['snapshot'] == adaptive_snapshot
    assert archive.export_archive(archive.import_archive(encoded)['snapshot']) == encoded
    result = adaptive_snapshot['run']['result']
    assert 'adaptive_policy' in result['manifest']['radio_delivery']
    for direction in ('uplink','downlink'):
        rows = result['samples']['radio_delivery'][direction]
        for index,rate in enumerate(rows['ready_payload_rate_bps']):
            if not result['samples']['visible'][index] or not result['samples']['radio_active'][index] or result['samples']['active_direction'][index] != direction:
                assert rate == 0 and rows['selected_margin_db'][index] is None
    changed=deepcopy(adaptive_snapshot)
    changed['run']['result']['samples']['radio_delivery']['downlink']['ready_payload_rate_bps'][0]=100
    with pytest.raises(archive.ArchiveError):
        archive.export_archive(changed)


@pytest.mark.parametrize("field,wrong", [("ready_payload_rate_bps", 290_000_000),
                                         ("ready_payload_rate_bps", 0),
                                         ("selected_margin_db", 9999),
                                         ("selected_margin_db", None)])
def test_archive_rejects_finite_adaptive_telemetry_inconsistent_with_selected_mode(adaptive_snapshot, field, wrong):
    changed = deepcopy(adaptive_snapshot)
    result = changed["run"]["result"]
    rows = result["samples"]["radio_delivery"]["downlink"]
    index = next(i for i, rate in enumerate(rows["ready_payload_rate_bps"]) if rate and rate > 0)
    rows[field][index] = wrong
    if index == len(result["samples"]["time_s"]) - 1:
        result["summary"]["radio_delivery"]["downlink"][field] = wrong
    with pytest.raises(archive.ArchiveError, match="(Ready rate|Selected margin)"):
        archive.export_archive(changed)


def test_adaptive_archive_guard_preserves_zero_margin_and_distinguishes_unknown_from_outage(adaptive_snapshot):
    result = deepcopy(adaptive_snapshot["run"]["result"])
    samples, summary = result["samples"], result["summary"]
    config = MissionScenario.model_validate(adaptive_snapshot["scenario"])
    rows = samples["radio_delivery"]["downlink"]
    index = next(i for i, rate in enumerate(rows["ready_payload_rate_bps"]) if rate and rate > 0)
    mode = next(m for m in config.radio_delivery.downlink.modes if m.mode_id == rows["mode_id"][index])

    def fields(cn0, reason, rate, margin):
        samples["downlink"]["cn0_dbhz"][index] = cn0
        samples["downlink"]["reason"][index] = reason
        rows["ready_payload_rate_bps"][index], rows["selected_margin_db"][index] = rate, margin
        if index == len(samples["time_s"]) - 1:
            summary["radio_delivery"]["downlink"].update(ready_payload_rate_bps=rate, selected_margin_db=margin)

    rate = rows["ready_payload_rate_bps"][index]
    # Keep the constructed boundary on the nonnegative side after float cancellation.
    cn0 = math.nextafter(
        10 * math.log10(mode.symbol_rate_sps) + mode.decode_threshold_esn0_db,
        math.inf,
    )
    margin = cn0 - 10 * math.log10(mode.symbol_rate_sps) - mode.decode_threshold_esn0_db
    assert abs(margin) < 1e-12
    fields(cn0, "valid", rate, 0.0)
    archive._validate_delivery(samples, summary, config)
    fields(None, "pattern_unresolved", None, None)
    archive._validate_delivery(samples, summary, config)
    fields(None, "pattern_unresolved", 0, None)
    with pytest.raises(archive.ArchiveError, match="Unresolved channel"):
        archive._validate_delivery(samples, summary, config)
    fields(None, "field_or_polarization_null", 0, None)
    archive._validate_delivery(samples, summary, config)
    fields(None, "field_or_polarization_null", None, None)
    with pytest.raises(archive.ArchiveError, match="zero-signal receiver"):
        archive._validate_delivery(samples, summary, config)

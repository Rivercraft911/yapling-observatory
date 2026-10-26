"""Constructed frame histories, exact count conservation and source-backed sizes."""
from fractions import Fraction
import math

import pytest
from pydantic import ValidationError

from cubesat_sim.models import default_scenario
from cubesat_sim.operations.radio_delivery_models import (
    DeliveryMode, DirectionDelivery, RadioDeliveryConfig, delivery_example,
)
from cubesat_sim.operations.radio_delivery import RadioDeliveryAccumulator, frame_layout


def mode(mode_id="a", modulation="QPSK", code_rate="1/2", symbol_rate_sps=8370, **changes):
    values = dict(mode_id=mode_id, modulation=modulation, code_rate=code_rate,
                  symbol_rate_sps=symbol_rate_sps, frame_size="short", pilots=True,
                  decode_threshold_esn0_db=0, threshold_status="illustrative",
                  threshold_source="Constructed deterministic test, not hardware")
    values.update(changes)
    return DeliveryMode(**values)


def profile(**changes):
    values = dict(assumptions="Constructed saturated GCS example", modes=(mode(),),
                  initial_mode_id="a", acquisition_s=0, reacquisition_s=0,
                  loss_hold_s=0, minimum_dwell_s=0, mode_change_s=0)
    values.update(changes)
    return DirectionDelivery(**values)


def accumulator(**changes):
    p = profile(**changes)
    return RadioDeliveryAccumulator(RadioDeliveryConfig(uplink=p, downlink=p))


def advance(acc, start, end, direction="downlink", active=True, esn0=10):
    # Test profiles share the same known symbol rate except explicit mode-change tests.
    cn0 = esn0 + 10 * math.log10(float(acc.directions[direction].mode.symbol_rate_sps))
    return acc.advance(start, end, direction, active, dict(uplink=cn0, downlink=cn0))


def conserved(row):
    assert row["frames_started"] == (row["delivered_frames"] + row["lost_frames"]
                                     + row["unresolved_frames"] + row["pending_frames"])
    assert row["offered_useful_bits"] == (row["delivered_useful_bits"] + row["lost_useful_bits"]
                                          + row["unresolved_useful_bits"] + row["pending_useful_bits"])
    assert row["aborted_frames"] <= row["lost_frames"]


@pytest.mark.parametrize("modulation,rate,kbch,symbols", [
    ("QPSK", "1/2", 7032, 8370), ("QPSK", "3/4", 11712, 8370),
    ("8PSK", "3/4", 11712, 5598), ("8PSK", "8/9", 14232, 5598),
])
def test_short_layout_matches_checked_local_esp_examples(modulation, rate, kbch, symbols):
    result = frame_layout(mode(modulation=modulation, code_rate=rate, symbol_rate_sps=5e6))
    assert result.kbch_bits == kbch
    assert result.data_field_bits == kbch - 80
    assert result.plframe_symbols == symbols
    assert result.duration_s == Fraction(symbols, 5_000_000)


def test_normal_layout_etsi_and_no_pilot_boundary():
    normal = frame_layout(mode(frame_size="normal", symbol_rate_sps=1e6))
    assert normal.kbch_bits == 32208
    assert normal.data_field_bits == 32128
    assert normal.plframe_symbols == 33282  # 32400 coded symbols +90 header +22*36 pilots.
    no_pilots = frame_layout(mode(frame_size="normal", symbol_rate_sps=1e6, pilots=False))
    assert no_pilots.plframe_symbols == 32490
    eight = frame_layout(mode(modulation="8PSK", code_rate="3/4", frame_size="normal"))
    assert eight.plframe_symbols == 22194  # 21600 coded symbols +90 header +14*36 pilots.


def test_exact_completion_partial_and_application_overhead():
    acc = accumulator(application_overhead_bits_per_frame=80)
    row = advance(acc, 0, 2.5)["downlink"]
    assert row["frames_started"] == 3
    assert row["delivered_frames"] == 2
    assert row["delivered_data_field_bits"] == 2 * 6952
    assert row["delivered_useful_bits"] == 2 * 6872
    assert row["pending_useful_bits"] == 6872
    assert row["partial_frame_elapsed_s"] == 0.5
    assert row["locked_time_s"] == row["ready_time_s"] == 2.5
    conserved(row)
    row = advance(acc, 2.5, 3)["downlink"]
    assert row["delivered_frames"] == 3
    assert row["pending_frames"] == 0
    conserved(row)


def test_frame_crossing_acquisition_is_lost_even_if_it_finishes_locked():
    acc = accumulator(acquisition_s=0.5)
    row = advance(acc, 0, 2)["downlink"]
    assert row["delivered_frames"] == row["lost_frames"] == 1
    assert row["acquisition_count"] == 1
    assert row["locked_time_s"] == 1.5
    assert [(event["time_s"], event["state"]) for event in acc.events] == [(0, "acquiring"), (0.5, "locked")]
    conserved(row)


def test_acquisition_requires_continuous_above_capture_threshold():
    acc = accumulator(acquisition_s=1, acquisition_margin_db=2)
    advance(acc, 0, 0.5, esn0=3)
    advance(acc, 0.5, 0.6, esn0=1)
    row = advance(acc, 0.6, 3, esn0=3)["downlink"]
    assert row["delivered_frames"] == 1
    assert row["lost_frames"] == 2
    assert row["locked_time_s"] == 1.4
    assert acc.events[-1]["time_s"] == 1.6
    conserved(row)


def test_decoder_failure_need_not_lose_lock_with_hold_hysteresis():
    acc = accumulator(hold_margin_db=-2, loss_hold_s=0.25)
    advance(acc, 0, 1.25)
    advance(acc, 1.25, 1.5, esn0=-1)
    row = advance(acc, 1.5, 3)["downlink"]
    assert row["delivered_frames"] == 2
    assert row["lost_frames"] == 1
    assert row["locked_time_s"] == 3
    assert row["lock_loss_count"] == 0
    conserved(row)


def test_hold_timeout_loss_then_explicit_reacquisition():
    acc = accumulator(hold_margin_db=-2, loss_hold_s=0.25, reacquisition_s=0.25)
    advance(acc, 0, 1.25)
    advance(acc, 1.25, 1.75, esn0=-3)
    row = advance(acc, 1.75, 3)["downlink"]
    assert row["delivered_frames"] == 2
    assert row["lost_frames"] == 1
    assert row["lock_loss_count"] == 1
    assert row["acquisition_count"] == 2
    assert row["locked_time_s"] == 2.5
    assert any(event["cause"] == "hold_threshold_timeout" and event["time_s"] == 1.5 for event in acc.events)
    conserved(row)


def test_direction_turnaround_aborts_partial_and_reacquires_separately():
    acc = accumulator(reacquisition_s=0.25)
    advance(acc, 0, 1.5)
    rows = advance(acc, 1.5, 3, direction="uplink")
    assert rows["downlink"]["delivered_frames"] == 1
    assert rows["downlink"]["aborted_frames"] == 1
    assert rows["downlink"]["lock_reset_count"] == 1
    assert rows["downlink"]["lock_loss_count"] == 0
    assert rows["uplink"]["delivered_frames"] == 1
    rows = advance(acc, 3, 5, direction="downlink")
    assert rows["downlink"]["delivered_frames"] == 2
    assert rows["downlink"]["lost_frames"] == 2  # Old partial +first frame after turnaround.
    for row in rows.values():
        conserved(row)


def test_scheduled_change_finishes_frame_then_pauses_and_reacquires():
    second = mode("b", "8PSK", "3/4", 5598)
    acc = accumulator(modes=(mode(), second), policy="scheduled",
                      schedule=({"start_s": 0.5, "mode_id": "b"},),
                      mode_change_s=0.2, reacquisition_s=0.3)
    rows = acc.advance(0, 3.5, "downlink", True, dict(uplink=100, downlink=100))
    row = rows["downlink"]
    assert row["mode_id"] == "b" and row["mode_index"] == 1
    assert row["delivered_frames"] == 2 and row["lost_frames"] == 1
    assert row["delivered_useful_bits"] == 6952 + 11632
    assert row["mode_change_count"] == 1
    assert row["reconfiguration_time_s"] == 0.2
    assert row["acquisition_count"] == 2
    assert [(event["time_s"], event["state"]) for event in acc.events] == [
        (0, "acquiring"), (0, "locked"), (1, "reconfiguring"),
        (1.2, "acquiring"), (1.5, "locked"),
    ]
    conserved(row)


def test_dwell_defers_change_and_latest_scheduled_choice_wins():
    b, c = mode("b"), mode("c")
    acc = accumulator(modes=(mode(), b, c), policy="scheduled", minimum_dwell_s=2,
                      schedule=({"start_s": 0.5, "mode_id": "b"}, {"start_s": 1.5, "mode_id": "c"}))
    row = advance(acc, 0, 3)["downlink"]
    assert row["mode_id"] == "c" and row["mode_change_count"] == 1
    assert row["delivered_frames"] == 3
    assert any(event["time_s"] == 2 and event["cause"] == "scheduled_mode_change" for event in acc.events)
    conserved(row)


def test_arbitrary_adjacent_subdivisions_and_daily_boundary_are_exact():
    changes = dict(acquisition_s=0.123, reacquisition_s=0.25,
                   modes=(mode(), mode("b", "8PSK", "3/4", 5e6)), policy="scheduled",
                   schedule=({"start_s": 1.234, "mode_id": "b"},), mode_change_s=0.14,
                   application_overhead_bits_per_frame=64)
    coarse, fine = accumulator(**changes), accumulator(**changes)
    coarse.advance(0, 100, "downlink", True, dict(uplink=100, downlink=100))
    times = [0, 0.071, 0.1, 0.3, 1.01, 1.234, 2, 2.15, 6.3, 99.999, 100]
    for first, second in zip(times, times[1:]):
        fine.advance(first, second, "downlink", True, dict(uplink=100, downlink=100))
    assert fine.sample() == coarse.sample()
    assert fine.events == coarse.events
    acc = accumulator()
    advance(acc, 0, 86399.5)
    before = acc.sample()["downlink"]["delivered_useful_bits"]
    midnight = advance(acc, 86399.5, 86400)["downlink"]["delivered_useful_bits"]
    after = advance(acc, 86400, 86400.5)["downlink"]["delivered_useful_bits"]
    assert midnight - before == 6952
    assert after - midnight == 0
    conserved(acc.summary()["downlink"])


def test_unresolved_channel_or_threshold_is_reported_without_claiming_frame_losses():
    acc = accumulator(modes=(mode(decode_threshold_esn0_db=None, threshold_status="unresolved"),))
    row = advance(acc, 0, 2.5)["downlink"]
    assert row["delivery_available"] is False
    assert row["unresolved_frames"] == 2 and row["lost_frames"] == 0
    assert row["receiver_state"] == "unresolved"
    conserved(row)
    acc = accumulator()
    row = acc.advance(0, 1, "downlink", True, dict(uplink=100, downlink=None))["downlink"]
    assert row["unresolved_frames"] == 1
    row = advance(acc, 1, 2)["downlink"]
    assert row["delivered_frames"] == 1 and row["delivery_available"] is False
    conserved(row)


def test_day_scale_whole_frames_are_batched_and_json_compatible():
    acc = accumulator(modes=(mode("a", "8PSK", "3/4", 5e6),))
    row = advance(acc, 0, 86400)["downlink"]
    expected = (86400 * 5_000_000) // 5598
    assert row["delivered_frames"] == expected > 70_000_000
    assert row["delivered_useful_bits"] == expected * 11632
    assert len(acc.events) == 2
    conserved(row)
    import json
    json.dumps(acc.sample(), allow_nan=False)
    json.dumps(acc.metadata(), allow_nan=False)


@pytest.mark.parametrize("changes", [
    dict(modulation="8PSK", code_rate="1/2"),
    dict(code_rate="9/10"), dict(decode_threshold_esn0_db=None),
    dict(decode_threshold_esn0_db=float("nan")), dict(symbol_rate_sps=0),
])
def test_invalid_modes_rejected(changes):
    with pytest.raises(ValidationError):
        mode(**changes)


@pytest.mark.parametrize("changes", [
    dict(modes=(mode(), mode())), dict(initial_mode_id="missing"),
    dict(schedule=({"start_s": 1, "mode_id": "a"},)),
    dict(policy="scheduled", schedule=({"start_s": 1, "mode_id": "missing"},)),
    dict(policy="scheduled", schedule=({"start_s": 1, "mode_id": "a"}, {"start_s": 1, "mode_id": "a"})),
    dict(application_overhead_bits_per_frame=6952), dict(application_overhead_bits_per_frame=True),
    dict(hardware_profile="esp32_s3_short_pair", modes=(mode(symbol_rate_sps=2e6),)),
    dict(hardware_profile="esp32_s3_short_pair", modes=(mode(frame_size="normal", symbol_rate_sps=1e6),)),
    dict(hardware_profile="esp32_s3_short_pair", policy="scheduled"),
    dict(hardware_profile="esp32_s3_short_pair", modes=(mode("a", "8PSK", "3/4", 1e6),)),
])
def test_invalid_direction_policy_and_unproven_hardware_rejected(changes):
    with pytest.raises(ValidationError):
        profile(**changes)


def test_local_esp32_pair_evidence_valid_but_threshold_still_assumed():
    config = profile(hardware_profile="esp32_s3_short_pair", modes=(mode(symbol_rate_sps=1e6),))
    assert config.modes[0].threshold_status == "illustrative"
    assert profile(hardware_profile="esp32_s3_short_pair", modes=(mode("a", "8PSK", "8/9", 5e6),))


def test_factory_preserves_existing_rf_knobs_and_records_assumptions():
    scenario = default_scenario()
    old = scenario.model_dump(mode="json")
    result = delivery_example(scenario.uplink, scenario.downlink)
    assert result.uplink.modes[0].code_rate == "1/2"
    assert result.uplink.modes[0].symbol_rate_sps == 1e6
    assert result.uplink.modes[0].decode_threshold_esn0_db == 1
    assert result.uplink.modes[0].threshold_status == "illustrative"
    assert result.uplink.hardware_profile == "generic_dvb_s2_reference"
    assert "not measured" in result.uplink.assumptions
    assert scenario.model_dump(mode="json") == old


@pytest.mark.parametrize("args", [
    (1, 2, "downlink", True, dict(uplink=100, downlink=100)),
    (0, 0, "downlink", True, dict(uplink=100, downlink=100)),
    (0, 1, "wrong", True, dict(uplink=100, downlink=100)),
    (0, 1, "downlink", 1, dict(uplink=100, downlink=100)),
    (0, 1, "downlink", True, dict(uplink=100)),
    (0, 1, "downlink", True, dict(uplink=100, downlink=float("inf"))),
])
def test_invalid_interval_is_atomic(args):
    acc = accumulator()
    before = acc.sample()
    with pytest.raises(ValueError):
        acc.advance(*args)
    assert acc.sample() == before


def test_boundary_completion_counters_allow_utc_calendar_rebucketing():
    acc = accumulator()
    row = advance(acc, 0, 1)["downlink"]
    assert row["boundary_delivered_frames"] == 1
    assert row["boundary_delivered_useful_bits"] == 6952
    row = advance(acc, 1, 1.5)["downlink"]
    assert row["boundary_delivered_useful_bits"] == 0
    unresolved = accumulator(modes=(mode(decode_threshold_esn0_db=None, threshold_status="unresolved"),))
    row = advance(unresolved, 0, 1)["downlink"]
    assert row["unresolved_time_s"] == 1
    assert row["boundary_unresolved_frames"] == 1
    assert row["boundary_unresolved_useful_bits"] == 6952
    row = advance(unresolved, 1, 2, active=False)["downlink"]
    assert row["unresolved_time_s"] == 1
    assert row["boundary_unresolved_frames"] == 0


def test_receiver_events_are_chronological_and_keep_same_time_causal_order():
    acc = accumulator(acquisition_s=0.25, reacquisition_s=0.25)
    advance(acc, 0, 1.5)
    advance(acc, 1.5, 3, direction="uplink")
    assert [event["time_s"] for event in acc.events] == sorted(event["time_s"] for event in acc.events)
    uplink = [event for event in acc.events if event["direction"] == "uplink"]
    assert [(event["time_s"], event["state"]) for event in uplink] == [(1.5, "acquiring"), (1.75, "locked")]
    coarse, fine = accumulator(), accumulator()
    advance(coarse, 0, 1.5)
    advance(coarse, 1.5, 3, direction="uplink")
    for start, end in [(0, 0.5), (0.5, 1), (1, 1.5)]:
        advance(fine, start, end)
    for start, end in [(1.5, 2), (2, 2.5), (2.5, 3)]:
        advance(fine, start, end, direction="uplink")
    assert fine.events == coarse.events
    assert fine.sample() == coarse.sample()


def test_event_cap_keeps_earliest_ordered_records_and_reports_drop_count():
    acc = accumulator()
    acc.events = [{"time_s": -1}] * 19999
    advance(acc, 0, 1)
    assert len(acc.events) == 20000
    assert acc.events_dropped == 1
    assert acc.events[-1]["state"] == "acquiring"


def test_independent_constructed_fade_oracle_checks_whole_frames():
    # A continuous one-second frame train. Any overlap with a known fade loses
    # that frame; the long hold timer deliberately preserves receiver lock.
    fades = [(0.999, 1.001), (3.25, 3.5), (7.0, 7.25)]
    cuts = sorted({0, 10.5, *[time for fade in fades for time in fade]})
    acc = accumulator(loss_hold_s=100)
    for start, end in zip(cuts, cuts[1:]):
        bad = any(first <= start and end <= last for first, last in fades)
        advance(acc, start, end, esn0=-1 if bad else 1)
    lost = sum(any(max(frame, first) < min(frame + 1, last) for first, last in fades)
               for frame in range(10))
    row = acc.summary()["downlink"]
    assert lost == 4
    assert row["lost_frames"] == lost
    assert row["delivered_frames"] == 10 - lost
    assert row["pending_frames"] == 1
    assert row["lock_loss_count"] == 0
    conserved(row)


def test_known_zero_signal_is_resolved_loss_without_cno_floor():
    acc = accumulator()
    row = acc.advance(0, 2, "downlink", True, dict(uplink=100, downlink=None),
                      known_outage=dict(uplink=False, downlink=True))["downlink"]
    assert row["delivery_available"] is True
    assert row["lost_frames"] == 2 and row["unresolved_frames"] == 0
    assert row["acquisition_count"] == 0 and row["ready_time_s"] == 0
    assert row["unresolved_time_s"] == 0
    conserved(row)
    # Zero RF cannot deliver even when no decoder threshold has been supplied.
    acc = accumulator(modes=(mode(decode_threshold_esn0_db=None, threshold_status="unresolved"),))
    row = acc.advance(0, 1, "downlink", True, dict(uplink=100, downlink=None),
                      known_outage=dict(uplink=False, downlink=True))["downlink"]
    assert row["delivery_available"] is True
    assert row["lost_frames"] == 1 and row["unresolved_frames"] == 0


def test_known_zero_signal_obeys_hold_timeout_and_reacquisition():
    acc = accumulator(loss_hold_s=0.25, reacquisition_s=0.25)
    advance(acc, 0, 1)
    row = acc.advance(1, 1.5, "downlink", True, dict(uplink=100, downlink=None),
                      known_outage=dict(uplink=False, downlink=True))["downlink"]
    assert row["lock_loss_count"] == 1 and row["locked_time_s"] == 1.25
    row = advance(acc, 1.5, 3)["downlink"]
    assert row["delivered_frames"] == 2 and row["lost_frames"] == 1
    assert row["acquisition_count"] == 2 and row["unresolved_time_s"] == 0
    conserved(row)


def test_supported_patch_null_and_unresolved_installed_pattern_stay_distinct():
    from cubesat_sim.models import Scenario
    from cubesat_sim.rf.link_budget import evaluate_link_budget
    state = dict(k=(0, 1, 0), x=(1, 0, 0), y=(0, 1, 0), z=(0, 0, 1),
                 east=(1, 0, 0), north=(0, 0, 1), range_m=600000,
                 range_rate_m_s=0, visible=True)
    scenario = default_scenario()
    result = evaluate_link_budget(scenario, "downlink", state, True)
    assert result["reason"] == "field_or_polarization_null" and result["cn0_dbhz"] is None
    acc = accumulator()
    known = result["reason"] == "field_or_polarization_null"
    row = acc.advance(0, 1, "downlink", True, dict(uplink=100, downlink=result["cn0_dbhz"]),
                      known_outage=dict(uplink=False, downlink=known))["downlink"]
    assert row["lost_frames"] == 1 and row["delivery_available"] is True
    inputs = scenario.model_dump(mode="json")
    inputs["antenna_variant"] = "v45"
    inputs["downlink"].update(spacecraft_antenna="wire", spacecraft_peak_gain_dbi=2.15)
    result = evaluate_link_budget(Scenario.model_validate(inputs), "downlink", state, True)
    assert result["reason"] == "pattern_unresolved"
    acc = accumulator()
    row = acc.advance(0, 1, "downlink", True, dict(uplink=100, downlink=result["cn0_dbhz"]),
                      known_outage=dict(uplink=False, downlink=False))["downlink"]
    assert row["unresolved_frames"] == 1 and row["delivery_available"] is False


@pytest.mark.parametrize("outage", [dict(uplink=False), dict(uplink=False,downlink=1), dict(uplink=False,downlink=True)])
def test_invalid_or_contradictory_known_outage_flags_are_atomic(outage):
    acc = accumulator()
    before = acc.sample()
    with pytest.raises(ValueError):
        acc.advance(0, 1, "downlink", True, dict(uplink=100, downlink=100),known_outage=outage)
    assert acc.sample() == before

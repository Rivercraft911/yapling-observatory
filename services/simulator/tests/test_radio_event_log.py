"""Applied MODCOD transitions remain visible during overlapping reconfiguration."""

import pytest

from cubesat_sim.operations.radio_delivery import RadioDeliveryAccumulator
from cubesat_sim.operations.radio_delivery_models import (
    DeliveryMode, DirectionDelivery, RadioDeliveryConfig,
)


def accumulator():
    modes = tuple(DeliveryMode(
        mode_id=identifier, modulation=modulation, code_rate=rate,
        symbol_rate_sps=symbols, frame_size="short", pilots=True,
        decode_threshold_esn0_db=0, threshold_status="illustrative",
        threshold_source="Constructed one-second PLFRAME, not hardware",
    ) for identifier, modulation, rate, symbols in (
        ("a", "QPSK", "1/2", 8370),
        ("b", "QPSK", "3/4", 8370),
        ("c", "8PSK", "3/4", 5598),
    ))
    profile = DirectionDelivery(
        assumptions="Constructed event logging test, not hardware",
        policy="scheduled", modes=modes, initial_mode_id="a",
        schedule=({"start_s": 0.5, "mode_id": "b"},
                  {"start_s": 1.1, "mode_id": "c"}),
        acquisition_s=0, reacquisition_s=0, loss_hold_s=0,
        minimum_dwell_s=0, mode_change_s=0.5,
    )
    return RadioDeliveryAccumulator(RadioDeliveryConfig(uplink=profile, downlink=profile))


@pytest.mark.parametrize("direction", ["uplink", "downlink"])
def test_every_applied_mode_change_is_logged_at_its_true_time(direction):
    coarse, fine = accumulator(), accumulator()
    coarse.advance(0, 3, direction, True, dict(uplink=100, downlink=100))
    times = [0, 0.3, 0.5, 1, 1.05, 1.1, 1.2, 1.5, 1.6, 2.6, 3]
    for start, end in zip(times, times[1:]):
        fine.advance(start, end, direction, True, dict(uplink=100, downlink=100))
    assert fine.sample() == coarse.sample()
    assert fine.events == coarse.events
    assert [(event["time_s"], event["state"], event["mode_id"], event["cause"])
            for event in coarse.events] == [
        (0, "acquiring", "a", "radio_scheduled"),
        (0, "locked", "a", "acquisition_complete"),
        (1, "reconfiguring", "b", "scheduled_mode_change"),
        (1.1, "reconfiguring", "c", "scheduled_mode_change"),
        (1.6, "acquiring", "c", "mode_change_complete"),
        (1.6, "locked", "c", "acquisition_complete"),
    ]
    row = coarse.sample()[direction]
    assert row["mode_change_count"] == 2
    assert row["frames_started"] == 3 and row["delivered_frames"] == 2
    assert row["delivered_useful_bits"] == 6952 + 11632
    assert row["pending_useful_bits"] == 11632 and row["lost_frames"] == 0
    assert row["locked_time_s"] == row["ready_time_s"] == 2.4
    assert row["reconfiguration_time_s"] == 0.6
    assert row["partial_frame_elapsed_s"] == 0.4


def test_same_state_mode_events_count_toward_the_existing_event_limit():
    acc = accumulator()
    acc.events = [{"time_s": 0}] * 19997
    acc.advance(0, 3, "downlink", True, dict(uplink=100, downlink=100))
    assert len(acc.events) == 20000
    assert acc.events[-1]["time_s"] == 1
    assert acc.events[-1]["mode_id"] == "b"
    assert acc.events_dropped == acc.metadata()["events_dropped"] == 3

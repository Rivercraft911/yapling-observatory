"""Independent interval, UTC, pass and completion-time accounting checks."""

from copy import deepcopy
import json
import pytest
from cubesat_sim.mission.reporting import MissionReporter
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.operations.radio_delivery_models import delivery_example


def interval(report, start, end, *, visible=True, elevation=20, active=True,
             direction="uplink", rates=None, delivery=None):
    report.advance(start, end, visible=visible, elevation_deg=elevation,
                   radio_active=active, direction=direction,
                   ideal_rates_bps=rates or dict(uplink=10.0, downlink=0.0),
                   delivery_interval=delivery)


def increment(bits=0, *, available=True, boundary=0, boundary_unknown=0):
    return dict(delivered_useful_bits=bits, delivery_available=available,
                receiver_locked_s=0.5, receiver_ready_s=0.5,
                boundary_delivered_useful_bits=boundary,
                boundary_delivered_frames=int(boundary > 0),
                boundary_unresolved_frames=boundary_unknown)


def test_fractional_utc_midnight_splits_held_rates_without_output_sampling():
    r = MissionReporter("2026-10-25T23:59:59.750000Z")
    interval(r, 0, 2)
    r.finish(False)
    result = r.snapshot()
    days = result["days"]
    assert [d["date_utc"] for d in days] == ["2026-10-25", "2026-10-26"]
    assert [d["computed_duration_s"] for d in days] == [0.25, 1.75]
    assert [d["uplink"]["ideal_capacity_bits"] for d in days] == [2.5, 17.5]
    assert [d["geometric_pass_count"] for d in days] == [1, 1]
    assert [d["geometric_pass_entries"] for d in days] == [0, 0]
    assert len(result["passes"]) == 1
    assert result["passes"][0]["duration_s"] == 2
    assert result["passes"][0]["start_clipped"] is True
    assert result["passes"][0]["end_clipped"] is False
    assert days[0]["uplink"]["delivered_useful_bits"] is None
    assert days[0]["uplink"]["delivery_available"] is None
    assert "passes" not in r.snapshot(include_passes=False)
    json.dumps(result, allow_nan=False)


def test_geometric_passes_are_independent_of_radio_direction_and_threshold():
    r = MissionReporter("2026-10-25T00:00:00Z")
    interval(r, 0, 1, visible=False, active=False)
    interval(r, 1, 2, elevation=25, active=False)
    interval(r, 2, 3, elevation=40, direction="downlink", rates=dict(uplink=0, downlink=None))
    interval(r, 3, 4, visible=False, active=False)
    r.finish(False)
    result = r.snapshot()
    p, day = result["passes"][0], result["days"][0]
    assert (p["start_s"], p["end_s"], p["duration_s"]) == (1, 3, 2)
    assert (p["start_clipped"], p["end_clipped"], p["max_elevation_deg"]) == (False, False, 40)
    assert day["geometric_pass_entries"] == day["geometric_pass_count"] == 1
    assert day["geometric_visible_s"] == 2
    assert day["scheduled_contact_s"] == 1
    assert day["downlink"]["scheduled_s"] == 1
    assert day["downlink"]["ideal_capacity_bits"] is None
    assert day["uplink"]["ideal_capacity_bits"] == 30


def test_full_day_and_stopped_prefix_have_explicit_coverage():
    r = MissionReporter("2026-10-25T00:00:00Z")
    interval(r, 0, 86400, visible=False, active=False)
    assert r.snapshot()["days"][0]["partial_day"] is False
    interval(r, 86400, 86401, visible=False, active=False)
    assert r.snapshot()["days"][1]["partial_day"] is True
    assert r.snapshot()["computed_end_utc"] == "2026-10-26T00:00:01Z"
    empty = MissionReporter("2026-10-25T00:00:00Z").snapshot()
    assert empty["days"] == empty["passes"] == []


def test_midnight_frame_completion_belongs_to_new_date_only():
    r = MissionReporter("2026-10-25T23:59:59Z", delivery_enabled=True)
    def delivery(start, end):
        assert (start, end) == (0, 1)
        return dict(uplink=increment(100, boundary=100), downlink=increment())
    interval(r, 0, 1, delivery=delivery)
    r.finish(True)
    result = r.snapshot()
    first, endpoint = result["days"]
    assert first["uplink"]["delivered_useful_bits"] == 0
    assert endpoint["date_utc"] == "2026-10-26"
    assert endpoint["uplink"]["delivered_useful_bits"] == 100
    assert endpoint["endpoint_only"] is True
    assert endpoint["endpoint_frame_count"] == 1
    assert endpoint["computed_duration_s"] == endpoint["geometric_visible_s"] == 0
    assert endpoint["scheduled_contact_s"] == endpoint["geometric_pass_count"] == 0
    assert endpoint["uplink"]["ideal_capacity_bits"] == 0
    assert result["passes"][0]["uplink"]["delivered_useful_bits"] == 100
    interval(r, 1, 2, delivery=lambda *_: dict(uplink=increment(20), downlink=increment()))
    assert "endpoint_only" not in r.snapshot()["days"][1]
    assert r.snapshot()["days"][1]["uplink"]["delivered_useful_bits"] == 120


def test_unresolved_delivery_is_local_and_never_becomes_known_zero():
    r = MissionReporter("2026-10-25T23:59:59Z", delivery_enabled=True)
    interval(r, 0, 1, delivery=lambda *_: dict(uplink=increment(available=False), downlink=increment()))
    interval(r, 1, 2, delivery=lambda *_: dict(uplink=increment(42), downlink=increment()))
    days = r.snapshot()["days"]
    assert days[0]["uplink"]["delivered_useful_bits"] is None
    assert days[0]["uplink"]["delivery_available"] is False
    assert days[1]["uplink"]["delivered_useful_bits"] == 42
    assert days[1]["uplink"]["delivery_available"] is True
    assert days[0]["downlink"]["delivered_useful_bits"] == 0
    assert r.snapshot()["passes"][0]["uplink"]["delivered_useful_bits"] is None


def test_unresolved_midnight_frame_has_unknown_endpoint_event():
    r = MissionReporter("2026-10-25T23:59:59Z", delivery_enabled=True)
    interval(r, 0, 1, delivery=lambda *_: dict(uplink=increment(available=False, boundary_unknown=1), downlink=increment()))
    endpoint = r.snapshot()["days"][1]
    assert endpoint["endpoint_only"] is True
    assert endpoint["endpoint_frame_count"] == 1
    assert endpoint["uplink"]["delivered_useful_bits"] is None
    assert endpoint["uplink"]["delivery_available"] is False


def test_invalid_gaps_and_implicit_delivery_counters_rejected():
    r = MissionReporter("2026-10-25T00:00:00Z")
    with pytest.raises(ValueError, match="contiguous"):
        interval(r, 1, 2)
    with pytest.raises(ValueError, match="UTC"):
        MissionReporter("2026-10-25T00:00:00")
    with pytest.raises(ValueError, match="counters"):
        interval(MissionReporter("2026-10-25T00:00:00Z", delivery_enabled=True), 0, 1)


def test_driver_reports_do_not_depend_on_output_sampling_and_opt_out_is_unchanged():
    c = default_mission_scenario().model_dump(mode="json")
    c["duration_s"] = 1200
    a = run_mission(MissionScenario.model_validate(c))
    c["clocks"]["output_step_s"] = 60
    b = run_mission(MissionScenario.model_validate(c))
    assert a["summary"]["reporting"] == b["summary"]["reporting"]
    assert a["summary"]["energy_j"] == b["summary"]["energy_j"]
    assert "radio_delivery" not in a["samples"]
    assert "radio_delivery" not in a["summary"]
    for direction in ("uplink", "downlink"):
        assert sum(day[direction]["ideal_capacity_bits"] for day in a["summary"]["reporting"]["days"]) == a["summary"]["ideal_capacity_bits"][direction]
    c["duration_s"] = 60
    v = MissionScenario.model_validate(c)
    identity = v.identity()
    without_optional = deepcopy(c)
    without_optional.pop("radio_delivery")
    assert MissionScenario.model_validate(without_optional).identity() == identity
    c["radio_delivery"] = delivery_example(v.uplink, v.downlink).model_dump(mode="json")
    result = run_mission(MissionScenario.model_validate(c))
    assert "radio_delivery" in result["samples"]
    assert result["manifest"]["radio_delivery"]["sources"]
    assert result["summary"]["reporting"]["days"][0]["downlink"]["delivered_useful_bits"] == 0


@pytest.mark.parametrize("null_reason,available,lost,unknown", [
    ("field_or_polarization_null", True, 5, 0),
    ("pattern_unresolved", False, 0, 5),
])
def test_driver_complete_frames_at_utc_midnight_and_known_null_channels(
    monkeypatch, null_reason, available, lost, unknown,
):
    import cubesat_sim.mission.driver as driver
    from cubesat_sim.operations.radio_delivery_models import (
        DeliveryMode, DirectionDelivery, RadioDeliveryConfig,
    )
    c = default_mission_scenario().model_dump(mode="json")
    c["duration_s"] = 10
    c["clocks"].update(output_step_s=10)
    c["orbit"]["elements"]["epoch_utc"] = "2026-10-25T23:59:59Z"
    c["orbit"]["ltan_hours_at_epoch"] = None
    c["spacecraft"]["controller"] = "coast"
    c["spacecraft"]["magnetorquer"]["enabled"] = False
    c["schedule"].update(first_direction="downlink", slot_duration_s=3600)
    mode = DeliveryMode(
        mode_id="constructed-one-second-frame", modulation="QPSK", code_rate="1/2",
        symbol_rate_sps=8370, frame_size="short", pilots=True,
        decode_threshold_esn0_db=0, threshold_status="illustrative",
        threshold_source="Constructed one-second frame, not a hardware threshold",
    )
    profile = DirectionDelivery(
        assumptions="Constructed geometry/channel to check driver interval accounting",
        modes=(mode,), initial_mode_id=mode.mode_id, acquisition_s=0,
        reacquisition_s=0, loss_hold_s=0, minimum_dwell_s=0, mode_change_s=0,
    )
    c["radio_delivery"] = RadioDeliveryConfig(uplink=profile, downlink=profile).model_dump(mode="json")
    geometry = driver.geometry_at
    budget = driver.evaluate_link_budget
    monkeypatch.setattr(driver, "geometry_at", lambda *args: geometry(*args) | {"visible": True})
    def link(config, direction, state, scheduled):
        original = budget(config, direction, state, scheduled)
        null = direction == "downlink" and state["time_s"] < 5
        return original | dict(
            cn0_dbhz=None if null else 100,
            reason=null_reason if null else "constructed_known_channel",
            ideal_rate_bps=0 if null or not scheduled else 1000,
        )
    monkeypatch.setattr(driver, "evaluate_link_budget", link)
    result = driver.run_mission(MissionScenario.model_validate(c))
    summary = result["summary"]["radio_delivery"]["downlink"]
    assert summary["lost_frames"] == lost
    assert summary["unresolved_frames"] == unknown
    assert summary["delivery_available"] is available
    assert summary["delivered_useful_bits"] == 5 * 6952
    days = result["summary"]["reporting"]["days"]
    assert [day["computed_duration_s"] for day in days] == [1, 9]
    assert sum(day["scheduled_contact_s"] for day in days) == 10
    if available:
        assert [day["downlink"]["delivered_useful_bits"] for day in days] == [0, 5 * 6952]
    else:
        assert all(day["downlink"]["delivered_useful_bits"] is None for day in days)
    assert all(day["uplink"]["delivered_useful_bits"] == 0 for day in days)



def test_receiver_event_export_is_opt_in_stable_bounded_and_prefix_filtered(monkeypatch):
    import cubesat_sim.operations.radio_delivery as delivery_module
    actual_accumulator = delivery_module.RadioDeliveryAccumulator
    constructed_events = [
        dict(time_s=0.0, direction="uplink", type="receiver", state="acquiring",
             mode_id="test", cause="first_causal_event"),
        dict(time_s=0.0, direction="uplink", type="receiver", state="locked",
             mode_id="test", cause="second_causal_event"),
        dict(time_s=30.0, direction="downlink", type="receiver", state="idle",
             mode_id="test", cause="endpoint_event"),
        dict(time_s=31.0, direction="downlink", type="receiver", state="idle",
             mode_id="test", cause="outside_prefix"),
    ]
    class ConstructedAccumulator(actual_accumulator):
        def __init__(self, config):
            super().__init__(config)
            self.events = deepcopy(constructed_events)
    monkeypatch.setattr(delivery_module, "RadioDeliveryAccumulator", ConstructedAccumulator)
    c = default_mission_scenario().model_dump(mode="json")
    c["duration_s"] = 30
    baseline = run_mission(MissionScenario.model_validate(c))
    assert all(event["type"] != "radio_delivery" for event in baseline["events"])
    validated = MissionScenario.model_validate(c)
    c["radio_delivery"] = delivery_example(validated.uplink, validated.downlink).model_dump(mode="json")
    result = run_mission(MissionScenario.model_validate(c))
    events = result["events"]
    assert [event["time_s"] for event in events] == sorted(event["time_s"] for event in events)
    assert [event for event in events if event["type"] != "radio_delivery"] == baseline["events"]
    receiver = [event for event in events if event["type"] == "radio_delivery"]
    assert [event["cause"] for event in receiver] == ["first_causal_event", "second_causal_event", "endpoint_event"]
    assert events[0] == baseline["events"][0]
    assert all(event["time_s"] <= result["summary"]["computed_duration_s"] for event in receiver)
    metadata = result["manifest"]["radio_delivery"]
    assert isinstance(metadata["limits"], list)
    assert metadata["event_export"]["maximum_receiver_events"] == 20000
    assert metadata["event_export"]["exported_receiver_events"] == 3
    assert metadata["event_export"]["outside_computed_prefix"] == 1
    assert metadata["events_dropped"] == 0
    assert metadata["driver_limits"]
    constructed_events[:] = [constructed_events[0]] * 20001
    bounded = run_mission(MissionScenario.model_validate(c))
    assert sum(event["type"] == "radio_delivery" for event in bounded["events"]) == 20000
    assert bounded["manifest"]["radio_delivery"]["events_dropped"] == 1

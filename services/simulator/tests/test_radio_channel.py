"""Allocated-channel edits, receiver preservation and legacy-record identity."""

from copy import deepcopy
import json
import math

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from cubesat_sim.api import create_app
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission.radio_channel import resolve_radio_channel
from cubesat_sim.mission_archive import export_archive, import_archive
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.models import RadioProfile, Scenario, default_scenario
from cubesat_sim.operations.radio_delivery import RadioDeliveryAccumulator, frame_layout
from cubesat_sim.operations.radio_delivery_models import (
    DeliveryMode,
    DirectionDelivery,
    RadioDeliveryConfig,
    delivery_example,
)
from cubesat_sim.rf.bandwidth import bandwidth_for_symbol_rate, symbol_rate_for_bandwidth
from cubesat_sim.rf.link_budget import evaluate_link_budget


@pytest.mark.parametrize("rolloff,expected", [(0.2, 50e6 / 3), (0.25, 16e6), (0.35, 400e6 / 27)])
def test_20_mhz_planning_symbol_rates_follow_checked_filter_support(rolloff, expected):
    # EN302307-1 V1.4.1 clause5.6 p35: endpoints ±(Rs/2)(1+alpha).
    rate = symbol_rate_for_bandwidth(20e6, rolloff)
    assert rate == pytest.approx(expected, rel=1e-15)
    assert bandwidth_for_symbol_rate(rate, rolloff) == pytest.approx(20e6, rel=1e-15)
    assert bandwidth_for_symbol_rate(5e6, 0.35) == 6.75e6
    assert bandwidth_for_symbol_rate(20e6, 0.35) == 27e6


@pytest.mark.parametrize("bandwidth,rolloff", [
    (0, 0.35), (-1, 0.35), (True, 0.35), ("20000000", 0.35),
    (float("nan"), 0.35), (float("inf"), 0.35), (1e300, 0.35),
    (1, 0.35), (20e6, 0), (20e6, 0.5), (20e6, True), (20e6, float("nan")),
])
def test_invalid_or_unsupported_channel_inputs_are_rejected(bandwidth, rolloff):
    with pytest.raises(ValueError):
        symbol_rate_for_bandwidth(bandwidth, rolloff)


def test_default_mission_applies_user_bandwidth_before_constructing_all_adaptive_modes():
    scenario = default_mission_scenario()
    for direction in ("uplink", "downlink"):
        profile = getattr(scenario, direction).profile
        assert profile.channel_bandwidth_hz == 20e6 and profile.rolloff == 0.35
        assert profile.symbol_rate_sps == pytest.approx(400e6 / 27)
        receiver = getattr(scenario.radio_delivery, direction)
        assert receiver.hardware_profile == "generic_dvb_s2_reference"
        assert receiver.policy == "adaptive" and len(receiver.modes) == 17
        assert {mode.symbol_rate_sps for mode in receiver.modes} == {profile.symbol_rate_sps}
    assert any("20 MHz allocated bandwidth" in entry for entry in scenario.provenance)
    assert any("clause 5.6 printed p. 35" in entry for entry in scenario.provenance)


def test_legacy_profile_and_scenario_shapes_and_identities_stay_unchanged():
    scenario = default_scenario()
    values = scenario.model_dump(mode="json")
    for direction in ("uplink", "downlink"):
        old = values[direction]["profile"]
        assert "channel_bandwidth_hz" not in old and "rolloff" not in old
        explicit_null = RadioProfile.model_validate(old | dict(channel_bandwidth_hz=None, rolloff=None))
        assert explicit_null.model_dump(mode="json") == old
        values[direction]["profile"] = explicit_null.model_dump(mode="json")
    assert Scenario.model_validate(values).identity() == scenario.identity()


@pytest.mark.parametrize("changes", [
    dict(channel_bandwidth_hz=20e6), dict(rolloff=0.35),
    dict(channel_bandwidth_hz=20e6, rolloff=0.35),
    dict(channel_bandwidth_hz=1.35e6, rolloff=0.3),
])
def test_profile_rejects_partial_or_inconsistent_allocation_metadata(changes):
    values = default_scenario().downlink.profile.model_dump(mode="json")
    with pytest.raises(ValidationError):
        RadioProfile.model_validate(values | changes)


def test_channel_change_preserves_every_receiver_setting_except_symbol_rates():
    scenario = default_mission_scenario()
    original = scenario.radio_delivery.downlink.model_dump(mode="json")
    original.update(
        policy="scheduled", schedule=[dict(start_s=7.25, mode_id="8psk-3-4")],
        initial_mode_id="qpsk-1-2", acquisition_s=0.7, reacquisition_s=0.3,
        loss_hold_s=0.12, minimum_dwell_s=3.1, mode_change_s=0.21,
        application_overhead_bits_per_frame=137,
        assumptions="Custom receiver timing, framing and threshold assumptions to preserve.",
    )
    original["modes"][0].update(
        decode_threshold_esn0_db=None, threshold_status="unresolved",
        threshold_source="Custom unresolved decoder curve", pilots=False,
    )
    receiver = DirectionDelivery.model_validate(original)
    before = scenario.downlink.profile.model_dump(mode="json")
    updated = resolve_radio_channel(scenario.downlink.profile, receiver, 10e6, 0.25)
    expected = deepcopy(original)
    for mode in expected["modes"]:
        mode["symbol_rate_sps"] = 8e6
    assert updated["delivery"] == expected
    assert updated["profile"] == before | dict(
        channel_bandwidth_hz=10e6, rolloff=0.25, symbol_rate_sps=8e6
    )
    assert receiver.model_dump(mode="json") == original
    assert scenario.downlink.profile.model_dump(mode="json") == before


def hardware_receiver():
    mode = DeliveryMode(
        mode_id="measured-settings-assumed-decoder", modulation="QPSK", code_rate="1/2",
        symbol_rate_sps=5e6, frame_size="short", pilots=True,
        threshold_source="Receiver threshold unresolved, hardware configuration only",
    )
    return DirectionDelivery(
        hardware_profile="esp32_s3_short_pair", assumptions="Existing paired-hardware limits",
        modes=(mode,), initial_mode_id=mode.mode_id,
        acquisition_s=1, reacquisition_s=1, loss_hold_s=0, minimum_dwell_s=2, mode_change_s=0.1,
    )


def test_hardware_constraints_are_preserved_and_never_silently_converted():
    profile = default_scenario().downlink.profile
    receiver = hardware_receiver()
    compatible = resolve_radio_channel(profile, receiver, 6.75e6, 0.35)
    assert compatible["delivery"] == receiver.model_dump(mode="json")
    with pytest.raises(ValidationError, match="ESP32 pair evidence"):
        resolve_radio_channel(profile, receiver, 20e6, 0.35)
    with pytest.raises(ValueError, match="rolloff 0.35"):
        resolve_radio_channel(profile, receiver, 6.25e6, 0.25)
    assert receiver.hardware_profile == "esp32_s3_short_pair"
    assert receiver.modes[0].symbol_rate_sps == 5e6


def aligned_state():
    return dict(
        k=(0, 0, 1), east=(1, 0, 0), north=(0, 1, 0),
        x=(1, 0, 0), y=(0, 0, -1), z=(0, 1, 0),
        range_m=1e6, range_rate_m_s=0, visible=True,
    )


def test_wider_bandwidth_changes_base_and_adaptive_esn0_at_unchanged_cn0():
    scenario = default_scenario()
    catalog = delivery_example(scenario.uplink, scenario.downlink, preset="adaptive_psk")
    narrow = resolve_radio_channel(scenario.downlink.profile, catalog.downlink, 1.35e6, 0.35)
    wide = resolve_radio_channel(scenario.downlink.profile, catalog.downlink, 20e6, 0.35)
    budgets = []
    for channel in (narrow, wide):
        values = scenario.model_dump(mode="json")
        values["downlink"]["profile"] = channel["profile"]
        budgets.append(evaluate_link_budget(Scenario.model_validate(values), "downlink", aligned_state(), True))
    loss_db = 10 * math.log10(20 / 1.35)
    assert budgets[1]["cn0_dbhz"] == budgets[0]["cn0_dbhz"]
    assert budgets[1]["received_power_dbw"] == budgets[0]["received_power_dbw"]
    assert budgets[1]["esn0_db"] == pytest.approx(budgets[0]["esn0_db"] - loss_db)
    rows = []
    for channel in (narrow, wide):
        selected = DirectionDelivery.model_validate(channel["delivery"])
        accumulator = RadioDeliveryAccumulator(RadioDeliveryConfig(uplink=selected, downlink=selected))
        rows.append(accumulator.advance(0, 10, "downlink", True, dict(uplink=70, downlink=70))["downlink"])
    assert rows[0]["mode_id"] == "8psk-5-6"
    assert rows[1]["mode_id"] == "qpsk-1-4"
    for channel, row in zip((narrow, wide), rows):
        mode = next(mode for mode in DirectionDelivery.model_validate(channel["delivery"]).modes if mode.mode_id == row["mode_id"])
        assert row["selected_margin_db"] == pytest.approx(
            70 - 10 * math.log10(channel["symbol_rate_sps"]) - mode.decode_threshold_esn0_db
        )
    for old, new in zip(catalog.downlink.modes, DirectionDelivery.model_validate(wide["delivery"]).modes):
        old_layout, new_layout = frame_layout(old), frame_layout(new)
        assert new_layout.data_field_bits == old_layout.data_field_bits
        assert float(old_layout.duration_s / new_layout.duration_s) == pytest.approx(20 / 1.35)


def test_api_returns_atomic_profile_and_delivery_and_rejects_invalid_hardware():
    scenario = default_mission_scenario()
    payload = dict(
        profile=scenario.downlink.profile.model_dump(mode="json"),
        delivery=scenario.radio_delivery.downlink.model_dump(mode="json"),
        channel_bandwidth_hz=20e6, rolloff=0.25,
    )
    with TestClient(create_app()) as client:
        response = client.post("/api/mission/radio-channel", json=payload)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["symbol_rate_sps"] == 16e6
        assert {mode["symbol_rate_sps"] for mode in result["delivery"]["modes"]} == {16e6}
        assert "No guard band" in result["assumptions"]
        payload["delivery"] = None
        assert client.post("/api/mission/radio-channel", json=payload).json()["delivery"] is None
        payload.update(delivery=hardware_receiver().model_dump(mode="json"), rolloff=0.35)
        assert client.post("/api/mission/radio-channel", json=payload).status_code == 422
        payload.update(delivery=None, rolloff=0.3)
        assert client.post("/api/mission/radio-channel", json=payload).status_code == 422


@pytest.mark.parametrize("explicit_channel", [False, True])
def test_channel_and_legacy_archives_roundtrip_without_input_expansion(explicit_channel):
    values = default_mission_scenario().model_dump(mode="json")
    values["duration_s"] = 30
    if not explicit_channel:
        values.pop("radio_delivery")
        values["provenance"] = ["Constructed legacy input with explicit symbol rate and no channel allocation."]
        for direction in ("uplink", "downlink"):
            profile = values[direction]["profile"]
            profile.pop("channel_bandwidth_hz")
            profile.pop("rolloff")
            profile["symbol_rate_sps"] = 1e6
    scenario = MissionScenario.model_validate(values)
    values = scenario.model_dump(mode="json")
    result = run_mission(scenario)
    identity, digest = scenario.identity()
    snapshot = json.loads(json.dumps(dict(
        scenario=values,
        run=dict(run_id="channel-archive-test", status="complete", scenario_id=identity,
                 scenario_hash=digest, result=result, error=None, progress=None),
    )))
    encoded = export_archive(snapshot)
    restored = import_archive(encoded)["snapshot"]
    assert restored == snapshot
    assert export_archive(restored) == encoded
    assert MissionScenario.model_validate(restored["scenario"]).identity() == (identity, digest)

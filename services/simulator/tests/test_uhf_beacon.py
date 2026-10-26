"""Independent LoRa airtime, beacon-edge power and optional-lane regressions."""

from copy import deepcopy
from fractions import Fraction
import json
import math
from pathlib import Path

import pytest
from pydantic import ValidationError

from cubesat_sim import mission_archive as archive
from cubesat_sim.rf.lora import LoraModulation, lora_airtime
from cubesat_sim.rf.uhf_beacon import (
    UhfBeaconConfig,
    default_uhf_beacon,
    uhf_beacon_preview,
    beacon_segments,
    beacon_timing,
    uhf_link,
)
from cubesat_sim.rf.antennas import HALF_WAVE_DIRECTIVITY
from cubesat_sim.rf.free_space import fspl_db
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission.runtime import RuntimeDirective


def config(duration=60, uhf=True):
    value = default_mission_scenario().model_dump(mode="json")
    value.update(duration_s=duration, radio_delivery=None)
    value["uhf_beacon"] = default_uhf_beacon() if uhf else None
    value["clocks"].update(output_step_s=10)
    return value


def snapshot(result):
    return json.loads(
        json.dumps(
            dict(
                scenario=result["manifest"]["scenario"],
                run=dict(
                    run_id="uhf-test",
                    status="complete",
                    scenario_id=result["manifest"]["scenario_id"],
                    scenario_hash=result["manifest"]["scenario_hash"],
                    result=result,
                    error=None,
                ),
            )
        )
    )


@pytest.mark.parametrize("sf", range(7, 13))
@pytest.mark.parametrize("payload", [0, 1, 32, 64, 255])
def test_airtime_matches_independent_legacy_symbol_equation(sf, payload):
    for denominator in (5, 6, 7, 8):
        for explicit in (False, True):
            for crc in (False, True):
                for ldro in (False, True):
                    c = LoraModulation(
                        spreading_factor=sf,
                        payload_bytes=payload,
                        coding_rate_denominator=denominator,
                        explicit_header=explicit,
                        payload_crc=crc,
                        low_data_rate_optimization=ldro,
                    )
                    groups = max(
                        0,
                        math.ceil(
                            (8 * payload - 4 * sf + 28 + 16 * crc - 20 * (not explicit))
                            / (4 * (sf - 2 * ldro))
                        ),
                    )
                    symbols = Fraction(8 + groups * denominator + 8) + Fraction(17, 4)
                    expected = float(symbols * 2**sf / 125000)
                    assert lora_airtime(c)["packet_airtime_s"] == expected


def test_new_mission_default_couples_separate_uhf_and_adaptive_sband():
    values = default_mission_scenario().model_dump(mode="json")
    values["duration_s"] = 60
    selected = MissionScenario.model_validate(values)
    assert selected.uhf_beacon is not None
    assert selected.radio_delivery is not None
    for direction in ("uplink", "downlink"):
        receiver = getattr(selected.radio_delivery, direction)
        assert receiver.policy == "adaptive"
        assert len(receiver.modes) == 17
        assert {mode.modulation for mode in receiver.modes} == {"QPSK", "8PSK"}
    result = run_mission(selected)
    assert {"radio_delivery", "uhf_beacon"} <= result["samples"].keys()
    assert {"radio_delivery", "uhf_beacon"} <= result["summary"].keys()
    assert result["summary"]["uhf_beacon"]["tx_airtime_s"] == pytest.approx(
        2 * 0.987136, abs=2e-14
    )
    assert abs(result["summary"]["energy_j"]["closure_residual_j"]) < 1e-7
    assert archive.import_archive(archive.export_archive(snapshot(result)))[
        "snapshot"
    ] == snapshot(result)


def test_omitted_and_null_optional_radios_keep_identical_legacy_results():
    explicit_null = config(60, uhf=False)
    omitted = deepcopy(explicit_null)
    omitted.pop("uhf_beacon")
    omitted.pop("radio_delivery")
    a = MissionScenario.model_validate(omitted)
    b = MissionScenario.model_validate(explicit_null)
    assert a.identity() == b.identity()
    assert a.model_dump(mode="json") == b.model_dump(mode="json")
    legacy = run_mission(a)
    assert json.loads(json.dumps(legacy)) == json.loads(json.dumps(run_mission(b)))
    assert "uhf_beacon" not in legacy["samples"]
    assert "radio_delivery" not in legacy["samples"]


def test_adopted_defaults_and_unknown_inputs_are_explicit():
    c = UhfBeaconConfig()
    p = uhf_beacon_preview(c)
    assert p["airtime"]["packet_airtime_s"] == 0.987136
    assert p["airtime"]["low_data_rate_optimization"] is True
    assert p["power"]["transmit_electrical_w"] == 2.5
    assert p["power"]["receive_electrical_w"] == 0.0198
    assert p["power"]["conducted_rf_w"] == pytest.approx(0.7943282347242815)
    assert p["power"]["escaped_rf_w"] == pytest.approx(0.6309573444801932)
    assert p["power"]["average_electrical_w"] == pytest.approx(0.10140982357333334)
    assert p["power"]["average_heat_w"] + p["power"]["escaped_rf_w"] * p["beacon"][
        "duty_fraction"
    ] == pytest.approx(p["power"]["average_electrical_w"])
    unknown = c.model_copy(update=dict(tx_feed_loss_db=None, tx_electrical_w=None))
    preview = uhf_beacon_preview(unknown)
    assert preview["power"]["average_electrical_w"] is None
    assert preview["power"]["average_heat_w"] is None
    assert preview["mission_coupling_ready"] is False
    assert set(preview["missing_inputs"]) == {"tx_feed_loss_db", "tx_electrical_w"}


def test_periodic_edges_are_half_open_and_do_not_round_to_dynamics_ticks():
    c = UhfBeaconConfig()
    duration = lora_airtime(c.modulation)["packet_airtime_s"]
    assert beacon_segments(c, 0, 1) == ((duration, True), (1 - duration, False))
    assert beacon_timing(c, 0)["transmitting"] is True
    assert beacon_timing(c, duration)["transmitting"] is False
    assert beacon_timing(c, 30)["transmitting"] is True
    assert beacon_timing(c, 60)["scheduled_beacons_completed"] == 2
    for a, b in ((0, 60), (0.2, 0.9), (0.9, 30.5), (29.9, 31), (2591990, 2592000)):
        pieces = beacon_segments(c, a, b)
        assert math.fsum(dt for dt, _ in pieces) == pytest.approx(b - a, abs=1e-10)
        assert all(dt > 0 for dt, _ in pieces)
    shifted = c.model_copy(update=dict(phase_s=4.5))
    assert beacon_segments(shifted, 0, 1) == ((1, False),)
    assert beacon_timing(shifted, 4.5)["transmitting"] is True


def test_uhf_vector_link_has_correct_los_axis_polarization_and_unknown_threshold():
    geo = dict(
        visible=True,
        k=(0, -1, 0),
        x=(1, 0, 0),
        y=(0, 1, 0),
        z=(0, 0, 1),
        east=(1, 0, 0),
        north=(0, 0, 1),
        range_m=1e6,
    )
    c = UhfBeaconConfig()
    r = uhf_link(c, geo)
    expected = (
        29 - 1 + 10 * math.log10(HALF_WAVE_DIRECTIVITY) + 15 - fspl_db(1e6, 438e6)
    )
    assert r["received_power_dbm"] == pytest.approx(expected, abs=2e-13)
    assert r["margin_db"] is None and r["cn0_db_hz"] is None
    chosen = c.model_copy(
        update=dict(receiver_threshold_dbm=-120, rx_system_noise_temperature_k=300)
    )
    assert uhf_link(chosen, geo)["margin_db"] == pytest.approx(expected + 120)
    assert uhf_link(c, geo | dict(visible=False))["received_power_dbm"] is None
    assert (
        uhf_link(c, geo | dict(east=(0, 0, 1), north=(1, 0, 0)))["reason"]
        == "field_or_polarization_null"
    )


@pytest.mark.parametrize(
    "updates",
    [
        dict(tx_electrical_w=0.1),
        dict(interval_s=1, modulation=dict(spreading_factor=12, payload_bytes=255)),
        dict(phase_s=30),
        dict(antenna_variant="fake"),
        dict(radiation_efficiency=1.1),
    ],
)
def test_invalid_beacon_inputs_reject_without_changing_existing_scenario(updates):
    raw = default_uhf_beacon()
    raw.update(updates)
    with pytest.raises(ValidationError):
        UhfBeaconConfig.model_validate(raw)


def test_exact_uhf_mode_energy_rf_heat_and_output_alias_metadata():
    c = MissionScenario.model_validate(config())
    r = run_mission(c)
    s = r["samples"]
    u = r["summary"]["uhf_beacon"]
    airtime = 2 * 0.987136
    assert u["tx_airtime_s"] == pytest.approx(airtime, abs=2e-14)
    assert u["electrical_j"] == pytest.approx(
        2.5 * airtime + 0.0198 * (60 - airtime), abs=1e-12
    )
    assert u["escaped_rf_j"] == pytest.approx(0.6309573444801932 * airtime, abs=1e-12)
    assert u["heat_j"] + u["escaped_rf_j"] == pytest.approx(
        u["electrical_j"], abs=1e-12
    )
    assert u["decoded_beacons"] is None and u["delivered_bits"] is None
    assert s["uhf_beacon"]["output_interval_tx_fraction"][4] == pytest.approx(
        0.987136 / 10
    )
    assert abs(r["summary"]["energy_j"]["closure_residual_j"]) < 1e-7
    assert all(x >= 0 for x in s["power"]["dissipated_power_w"])
    assert "uhf_beacon" in s["power"]["component_electrical_w"]
    assert archive.import_archive(archive.export_archive(snapshot(r)))[
        "snapshot"
    ] == snapshot(r)


@pytest.mark.parametrize("stop", [0, 1, 7, 30])
def test_uhf_zero_and_off_output_stop_prefixes_replay_and_archive(stop):
    value = config()
    value["stop_time_s"] = stop
    r = run_mission(MissionScenario.model_validate(value))
    assert r["summary"]["computed_duration_s"] == stop
    assert r["samples"]["uhf_beacon"]["cumulative_tx_airtime_s"][-1] <= stop
    assert r["samples"]["power"]["dissipated_power_w"][0] >= 0
    assert archive.import_archive(archive.export_archive(snapshot(r)))[
        "snapshot"
    ] == snapshot(r)


def test_uhf_unknown_power_or_feed_prevents_claiming_coupled_mission():
    for key in ("tx_electrical_w", "tx_feed_loss_db"):
        value = config()
        value["uhf_beacon"][key] = None
        with pytest.raises(ValidationError, match="UHF mission coupling requires"):
            MissionScenario.model_validate(value)


def test_omitted_uhf_preserves_frozen_identity_and_numerical_prefix():
    root = Path(__file__).resolve().parents[3]
    path = (
        root
        / "private/verification/2026-10-25-month-performance/unprofiled-day-result.json"
    )
    if not path.exists():
        pytest.skip("Private frozen reference unavailable")
    original = json.loads(path.read_text())
    value = deepcopy(original["manifest"]["scenario"])
    assert MissionScenario.model_validate(value).identity() == (
        original["manifest"]["scenario_id"],
        original["manifest"]["scenario_hash"],
    )
    value["duration_s"] = 360
    result = run_mission(MissionScenario.model_validate(value))
    assert "uhf_beacon" not in result["samples"]
    assert "dissipated_power_w" not in result["samples"]["power"]

    def row(columns, i):
        return {
            k: row(v, i) if isinstance(v, dict) else v[i] for k, v in columns.items()
        }

    assert [row(json.loads(json.dumps(result["samples"])), i) for i in range(3)] == [
        row(original["samples"], i) for i in range(3)
    ]


def test_transient_telemetry_does_not_change_uhf_counters_or_results():
    class Runtime:
        telemetry_period_s = 1

        def before_step(self, t, b):
            return RuntimeDirective()

        def on_command(self, c):
            pass

        def on_sample(self, r):
            pass

        def on_telemetry(self, r):
            r["uhf_beacon"]["electrical_w"] = 999

    c = MissionScenario.model_validate(config())
    baseline = run_mission(c)
    live = run_mission(c, runtime=Runtime())
    assert json.loads(json.dumps(live)) == json.loads(json.dumps(baseline))


def test_beacon_burst_battery_matches_sequential_solver_not_average_load():
    from cubesat_sim.power.battery_electrical import advance_electrical_battery

    value = config(1)
    value["clocks"].update(
        dynamics_step_s=1, controller_period_s=1, thermal_step_s=1, output_step_s=1
    )
    value["spacecraft"].update(wheels=[], magnetorquer=None, controller="coast")
    value["power"].update(panels=[], surfaces=[], radio_idle_w=0)
    value["conops"]["auto_ground_tracking"] = False
    value["power"]["thermal"].update(conductive_links=[], radiative_links=[])
    for node in value["power"]["thermal"]["nodes"]:
        node.update(initial_temperature_k=298.15, radiating_area_m2=0)
    for mode in value["power"]["mode_loads"]:
        mode["loads"] = []
    c = MissionScenario.model_validate(value)
    z = c.power.battery.electrical.initial_soc
    on = 0.987136
    first = advance_electrical_battery(c.power.battery, z, 0, 2.5, on, 298.15)
    second = advance_electrical_battery(
        c.power.battery, first.soc, 0, 0.0198, 1 - on, 298.15
    )
    averaged = advance_electrical_battery(
        c.power.battery, z, 0, 2.5 * on + 0.0198 * (1 - on), 1, 298.15
    )
    result = run_mission(c)
    assert result["samples"]["power"]["battery_soc"][-1] == second.soc
    exact_heat = first.ohmic_heat_w * on + second.ohmic_heat_w * (1 - on)
    assert result["summary"]["energy_j"]["storage_loss_j"] == pytest.approx(
        exact_heat, abs=1e-14
    )
    assert exact_heat > averaged.ohmic_heat_w + 1e-6
    assert result["samples"]["power"]["battery_soc"][-1] != averaged.soc
    assert abs(result["summary"]["energy_j"]["closure_residual_j"]) < 1e-8


def test_zero_power_prefix_archives_with_complete_optional_heat_lane():
    value = config()
    value["power"]["panels"] = []
    value["power"]["battery"]["electrical"]["initial_soc"] = 0
    result = run_mission(MissionScenario.model_validate(value))
    assert result["summary"]["end_reason"] == "power_unserved"
    assert result["summary"]["computed_duration_s"] == 0
    assert result["samples"]["power"]["dissipated_power_w"] == [0]
    assert archive.import_archive(archive.export_archive(snapshot(result)))[
        "snapshot"
    ] == snapshot(result)


def test_uhf_archive_rejects_invented_decoding_and_output_interval_power():
    result = run_mission(MissionScenario.model_validate(config()))
    for change in ("decoding", "power", "count"):
        edited = snapshot(result)
        if change == "decoding":
            edited["run"]["result"]["summary"]["uhf_beacon"]["decoded_beacons"] = 1
        elif change == "power":
            edited["run"]["result"]["samples"]["uhf_beacon"][
                "output_interval_electrical_w"
            ][-1] += 1
        else:
            edited["run"]["result"]["summary"]["uhf_beacon"][
                "scheduled_beacons_completed"
            ] += 1
        with pytest.raises(archive.ArchiveError):
            archive.validate_snapshot(edited)

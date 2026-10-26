"""Opt-in analytical loss is counted once in RF, radiated energy and Lab fields."""

import math
import json

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from cubesat_sim.api import create_app
from cubesat_sim.geometry.frames import WGS84_A_M
from cubesat_sim.geometry.vectors import scale
from cubesat_sim.attitude.dynamics import AttitudeState
from cubesat_sim.attitude.kinematics import boresight_reference
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission.ephemeris import gmst_rad
from cubesat_sim.mission.geometry import geometry_at
from cubesat_sim.mission_archive import (
    ArchiveError,
    _scenario,
    export_request,
    import_archive,
)
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.operations.radio_delivery_models import delivery_example
from cubesat_sim.orbit.elements import elements_to_cartesian
from cubesat_sim.orbit.two_body import CartesianState
from cubesat_sim.rf.antennas import HALF_WAVE_PEAK_DBI
from cubesat_sim.rf.link_budget import evaluate_link_budget
from cubesat_sim.rf.mission_efficiency import (
    EFFICIENCY_SEMANTICS,
    mission_downlink_efficiency,
)
from cubesat_sim.rf.pattern_sampling import pattern_request_for_link
from cubesat_sim.rf.spherical_harmonics import reference_profiles, sphere_mean_gain


def config(additional=1, pattern="patch", peak=6):
    values = default_mission_scenario().model_dump(mode="json")
    values.update(
        duration_s=4, magnetic_model="igrf14_degree1", antenna_variant="turnstile"
    )
    values["clocks"].update(
        dynamics_step_s=1, controller_period_s=1, thermal_step_s=1, output_step_s=1
    )
    values["station"].update(
        latitude_deg=0, longitude_deg=0, height_m=30, minimum_elevation_deg=10
    )
    epoch = values["orbit"]["elements"]["epoch_utc"]
    values["orbit"].update(force_model="central", preset=None, ltan_hours_at_epoch=None)
    values["orbit"]["elements"].update(
        semi_major_axis_m=WGS84_A_M + 550000,
        eccentricity=0,
        inclination_deg=0,
        raan_deg=math.degrees(gmst_rad(epoch)) % 360,
        argument_of_periapsis_deg=0,
        true_anomaly_deg=10,
    )
    values["spacecraft"].update(
        wheels=[],
        magnetorquer=None,
        controller="coast",
        magnetic_unloading_enabled=False,
        initial_q_body_from_inertial_wxyz=[1, 0, 0, 0],
        initial_omega_body_rad_s=[0, 0, 0],
    )
    values["conops"]["windows"] = [
        dict(window_id="visible_test", start_s=0, end_s=4, mode="ground_tracking")
    ]
    values["schedule"].update(first_direction="downlink", slot_duration_s=30)
    values["power"]["battery"].pop("electrical", None)
    values["power"].update(
        transmit_radiation_efficiency=additional,
        analytical_efficiency_semantics=EFFICIENCY_SEMANTICS,
    )
    for direction in ("uplink", "downlink"):
        values[direction].update(ground_peak_gain_dbi=70, ground_feed_roll_deg=45)
    values["downlink"].update(
        spacecraft_antenna=pattern,
        spacecraft_peak_gain_dbi=peak,
        spherical_harmonic_profile=None,
    )
    initial = MissionScenario.model_validate(values)
    cartesian = elements_to_cartesian(initial.orbit.elements, initial.orbit.mu_m3_s2)
    orbit = CartesianState(0, cartesian.position_m, cartesian.velocity_m_s)
    geo = geometry_at(initial, orbit, AttitudeState(0, (1, 0, 0, 0), (0, 0, 0)))
    values["spacecraft"]["initial_q_body_from_inertial_wxyz"] = boresight_reference(
        (1, 0, 0, 0), (0, 1, 0), scale(geo["k"], -1)
    )
    values["radio_delivery"] = delivery_example(
        initial.uplink, initial.downlink
    ).model_dump(mode="json")
    return MissionScenario.model_validate(values)


def test_zero_efficiency_means_no_downlink_signal_capacity_or_decoded_payload():
    scenario = config(0)
    result = run_mission(scenario)
    samples, summary = result["samples"], result["summary"]
    assert samples["visible"] == [True] * 5
    assert samples["radio_active"] == [True] * 5
    assert samples["downlink"]["received_power_dbw"] == [None] * 5
    assert samples["downlink"]["cn0_dbhz"] == [None] * 5
    assert samples["downlink"]["ideal_rate_bps"] == [0] * 5
    assert summary["ideal_capacity_bits"]["downlink"] == 0
    receiver = samples["radio_delivery"]["downlink"]
    assert receiver["delivered_useful_bits"] == [0] * 5
    assert receiver["delivered_frames"] == [0] * 5
    assert receiver["delivery_available"] == [True] * 5
    assert summary["energy_j"]["escaped_rf_j"] == 0
    assert summary["energy_j"]["closure_residual_j"] == pytest.approx(0, abs=1e-6)
    assert result["manifest"]["downlink_efficiency"]["radiation_efficiency"] == 0
    # Known zero RF remains zero even if a decoder threshold is unresolved.
    values = scenario.model_dump(mode="json")
    values["downlink"]["profile"].update(
        threshold_db=None, threshold_status="unresolved"
    )
    unresolved = MissionScenario.model_validate(values)
    state = dict(
        k=(0, 0, 1),
        east=(1, 0, 0),
        north=(0, 1, 0),
        x=(1, 0, 0),
        y=(0, 0, -1),
        z=(0, 1, 0),
        range_m=1e6,
        range_rate_m_s=0,
        visible=True,
    )
    assert (
        evaluate_link_budget(unresolved, "downlink", state, True)["ideal_rate_bps"] == 0
    )


def test_half_additional_efficiency_halves_radiation_and_costs_three_db_once():
    high, low = (run_mission(config(value)) for value in (1, 0.5))
    for i in range(5):
        for field in (
            "tx_gain_dbi",
            "received_power_dbw",
            "cn0_dbhz",
            "esn0_db",
            "margin_db",
        ):
            assert low["samples"]["downlink"][field][i] == pytest.approx(
                high["samples"]["downlink"][field][i] - 10 * math.log10(2), abs=1e-12
            )
        assert (
            low["samples"]["uplink"]["rx_gain_dbi"][i]
            == high["samples"]["uplink"]["rx_gain_dbi"][i]
        )
    assert low["summary"]["energy_j"]["escaped_rf_j"] == pytest.approx(
        0.5 * high["summary"]["energy_j"]["escaped_rf_j"], abs=1e-12
    )
    for result in (high, low):
        assert abs(result["summary"]["energy_j"]["closure_residual_j"]) < 1e-6
        assert (
            result["samples"]["radio_delivery"]["downlink"]["delivered_useful_bits"][-1]
            > 0
        )


@pytest.mark.parametrize(
    "pattern,peak,expected_mean",
    [
        ("wire", HALF_WAVE_PEAK_DBI, 1),
        ("wire", HALF_WAVE_PEAK_DBI - 10 * math.log10(2), 0.5),
        ("patch", 0, 0.5),
        ("patch", 6, 1),
    ],
)
def test_inferred_pattern_mean_and_additional_loss_are_not_counted_twice(
    pattern, peak, expected_mean
):
    scenario = config(0.4, pattern, peak)
    resolved = mission_downlink_efficiency(scenario)
    assert resolved.pattern_mean_efficiency == pytest.approx(expected_mean)
    assert resolved.gain_multiplier == 0.4
    assert resolved.radiation_efficiency == pytest.approx(0.4 * expected_mean)
    request = pattern_request_for_link(
        scenario.downlink,
        scenario.antenna_variant,
        direction="downlink",
        analytical_efficiency_semantics=EFFICIENCY_SEMANTICS,
        analytical_radiation_efficiency=0.4,
    )
    if pattern == "patch":
        # The analytic cosine integral is 2 pi Gpeak/(n+1); below3.01dBi n=0.
        gain = 10 ** (peak / 10)
        n = max(0, gain / 2 - 1)
        mean = request.efficiency * gain / (2 * (n + 1))
    else:
        mean = request.efficiency
    assert mean == pytest.approx(resolved.radiation_efficiency)


def test_harmonic_profile_owns_total_efficiency_and_ignores_additional_factor():
    values = config(0).model_dump(mode="json")
    profile = reference_profiles()[0]["profile"]
    profile["radiation_efficiency"] = 0.37
    values["downlink"].update(
        spacecraft_antenna="spherical_harmonic",
        spherical_harmonic_profile=profile,
        frequency_hz=profile["frequency_hz"],
    )
    scenario = MissionScenario.model_validate(values)
    resolved = mission_downlink_efficiency(scenario)
    assert resolved.radiation_efficiency == 0.37
    assert resolved.gain_multiplier == 1
    assert resolved.additional_efficiency is None
    assert sphere_mean_gain(
        scenario.downlink.spherical_harmonic_profile
    ) == pytest.approx(0.37, abs=1e-14)
    request = pattern_request_for_link(
        scenario.downlink,
        scenario.antenna_variant,
        direction="downlink",
        analytical_efficiency_semantics=EFFICIENCY_SEMANTICS,
        analytical_radiation_efficiency=0,
    )
    assert request.efficiency == 1


def test_absent_and_null_keep_exact_legacy_shape_identity_and_rf_behavior():
    values = config(0).model_dump(mode="json")
    values["power"].pop("analytical_efficiency_semantics")
    absent = MissionScenario.model_validate(values)
    values["power"]["analytical_efficiency_semantics"] = None
    explicit_null = MissionScenario.model_validate(values)
    assert explicit_null.identity() == absent.identity()
    assert explicit_null.model_dump(mode="json") == absent.model_dump(mode="json")
    assert (
        "analytical_efficiency_semantics" not in absent.model_dump(mode="json")["power"]
    )
    _, projected = _scenario(values)
    assert "analytical_efficiency_semantics" not in projected["power"]
    result = run_mission(absent)
    assert result["summary"]["ideal_capacity_bits"]["downlink"] > 0
    assert result["summary"]["energy_j"]["escaped_rf_j"] == 0
    assert "downlink_efficiency" not in result["manifest"]
    assert (
        "analytical_efficiency_semantics" not in result["manifest"]["scenario"]["power"]
    )


@pytest.mark.parametrize("pattern", ["wire", "patch"])
def test_unresolved_v45_rejected_only_for_opted_in_wire(pattern):
    values = config(0.5, pattern, 2).model_dump(mode="json")
    values["antenna_variant"] = "v45"
    if pattern == "wire":
        with pytest.raises(ValidationError, match="resolved downlink pattern"):
            MissionScenario.model_validate(values)
        values["power"].pop("analytical_efficiency_semantics")
        legacy = MissionScenario.model_validate(values)
        assert mission_downlink_efficiency(legacy).radiation_efficiency == 0.5
    else:
        assert (
            mission_downlink_efficiency(
                MissionScenario.model_validate(values)
            ).gain_multiplier
            == 0.5
        )


def test_archived_lab_reference_and_power_preview_match_mission():
    scenario = config(0.5, "wire", 1)
    result = run_mission(scenario)
    archived = result["manifest"]["scenario"]
    with TestClient(create_app()) as client:
        for direction, gain_field in (
            ("uplink", "rx_gain_dbi"),
            ("downlink", "tx_gain_dbi"),
        ):
            reference = client.post(
                "/api/antenna-lab/reference-request",
                json=dict(
                    link=archived[direction],
                    antenna_variant=archived["antenna_variant"],
                    direction=direction,
                    analytical_efficiency_semantics=archived["power"][
                        "analytical_efficiency_semantics"
                    ],
                    analytical_radiation_efficiency=archived["power"][
                        "transmit_radiation_efficiency"
                    ],
                ),
            )
            assert reference.status_code == 200, reference.text
            for index in range(5):
                body = client.post(
                    "/api/antenna-lab/probe",
                    json=reference.json()
                    | dict(
                        run_probe=dict(
                            spacecraft_position_m=result["samples"][
                                "satellite_position_m"
                            ][index],
                            station_position_m=result["samples"]["station_position_m"][
                                index
                            ],
                            q_body_from_inertial_wxyz=result["samples"][
                                "q_body_from_inertial_wxyz"
                            ][index],
                        )
                    ),
                )
                assert body.status_code == 200, body.text
                assert body.json()["gain_dbi"] == pytest.approx(
                    result["samples"][direction][gain_field][index], abs=2e-12
                )
        preview = client.post(
            "/api/mission/radio-power",
            json=dict(
                tx_electrical_w=scenario.power.spacecraft_tx_electrical_w,
                rx_electrical_w=1.5,
                idle_electrical_w=0.5,
                downlink=archived["downlink"],
                antenna_variant=archived["antenna_variant"],
                analytical_efficiency_semantics=EFFICIENCY_SEMANTICS,
                analytical_radiation_efficiency=0.5,
            ),
        )
        assert preview.status_code == 200, preview.text
        assert (
            preview.json()["transmit"]["radiation_efficiency"]
            == mission_downlink_efficiency(scenario).radiation_efficiency
        )
        assert preview.json()["transmit"]["escaped_rf_w"] * 4 == pytest.approx(
            result["summary"]["energy_j"]["escaped_rf_j"], abs=1e-12
        )
        incomplete = client.post(
            "/api/antenna-lab/reference-request",
            json=dict(
                link=archived["downlink"],
                antenna_variant="turnstile",
                analytical_efficiency_semantics=EFFICIENCY_SEMANTICS,
            ),
        )
        assert incomplete.status_code == 422
    identity, digest = scenario.identity()
    snapshot = dict(
        run_id="efficiency-test",
        status="complete",
        scenario_id=identity,
        scenario_hash=digest,
        result=result,
        error=None,
        progress=None,
    )
    archive = export_request(json.dumps(snapshot).encode())
    imported = import_archive(archive)
    assert (
        imported["snapshot"]["run"]["result"]["manifest"]["scenario"]["power"][
            "analytical_efficiency_semantics"
        ]
        == EFFICIENCY_SEMANTICS
    )


def test_archive_rejects_changed_efficiency_context_without_recomputing_physics():
    scenario = config(0.5)
    result = run_mission(scenario)
    identity, digest = scenario.identity()
    raw = dict(
        run_id="efficiency-context",
        status="complete",
        scenario_id=identity,
        scenario_hash=digest,
        result=result,
        error=None,
        progress=None,
    )
    result["manifest"]["downlink_efficiency"]["radiation_efficiency"] = 0.25
    with pytest.raises(ArchiveError, match="downlink efficiency conflicts"):
        export_request(json.dumps(raw).encode())


def test_new_api_rejects_unresolved_wire_efficiency_but_preserves_legacy_request():
    scenario = config(0.5, "wire", 1)
    request = dict(
        tx_electrical_w=10,
        rx_electrical_w=1.5,
        idle_electrical_w=0.5,
        downlink=scenario.downlink.model_dump(mode="json"),
        antenna_variant="v45",
        analytical_radiation_efficiency=0.5,
    )
    with TestClient(create_app()) as client:
        legacy = client.post("/api/mission/radio-power", json=request)
        assert legacy.status_code == 200
        request["analytical_efficiency_semantics"] = EFFICIENCY_SEMANTICS
        rejected = client.post("/api/mission/radio-power", json=request)
        assert rejected.status_code == 422
        assert "resolved downlink pattern" in rejected.json()["detail"]

"""Independent linear-power Friis, LOS and receiver-metric reference checks.

References: ITU-R P.525-5 (2024), Annex 2.3 equations 4-6; S. V. Hum,
Friis' Formula and Effects, pp. 1, 3-7; ETSI EN 302 307-1 V1.4.1,
section 6/Table 13, printed p. 36. Exact SI constants follow BIPM.
"""

import math

import pytest

from cubesat_sim.models import IDEAL_DVB_THRESHOLDS, Scenario, default_scenario
from cubesat_sim.rf.link_budget import evaluate_link_budget, spacecraft_response
from cubesat_sim.rf.polarization import polarization_coupling

C = 299792458.0
K = 1.380649e-23


def aligned_state():
    # Ground looks +Z; the spacecraft antenna looks -Z. Body X is aligned
    # with the declared east fallback for the singular zenith H-feed angle.
    return dict(
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


@pytest.mark.parametrize("direction", ["uplink", "downlink"])
@pytest.mark.parametrize(
    "distance,frequency,ground_roll,modulation,rate,threshold",
    [
        (550e3, 2.4e9, 0, "QPSK", 0.5, 1.0),
        (2e6, 8.4e9, 45, "8PSK", 0.75, 7.91),
    ],
)
def test_full_budget_matches_flux_times_effective_aperture(
    direction,
    distance,
    frequency,
    ground_roll,
    modulation,
    rate,
    threshold,
):
    values = default_scenario().model_dump(mode="json")
    values[direction].update(
        frequency_hz=frequency,
        tx_feed_loss_db=2,
        extra_path_loss_db=1.5,
        ground_feed_roll_deg=ground_roll,
    )
    values[direction]["profile"].update(
        modulation=modulation,
        code_rate=rate,
        threshold_db=threshold,
        engineering_reserve_db=2.3,
    )
    scenario = Scenario.model_validate(values)
    link = getattr(scenario, direction)
    state = aligned_state() | {"range_m": distance}
    result = evaluate_link_budget(scenario, direction, state, True)
    ground_gain = 10 ** (link.ground_peak_gain_dbi / 10)
    spacecraft_gain = 10 ** (link.spacecraft_peak_gain_dbi / 10)
    tx_gain, rx_gain = (
        (ground_gain, spacecraft_gain)
        if direction == "uplink"
        else (spacecraft_gain, ground_gain)
    )
    power_at_antenna = link.tx_power_w / 10 ** (link.tx_feed_loss_db / 10)
    flux = power_at_antenna * tx_gain / (4 * math.pi * distance**2)
    effective_aperture = rx_gain * (C / frequency) ** 2 / (4 * math.pi)
    coupling = math.cos(math.radians(ground_roll)) ** 2
    received = (
        flux * effective_aperture * coupling / 10 ** (link.extra_path_loss_db / 10)
    )
    cn0_linear = received / (K * link.rx_system_noise_temperature_k)
    esn0_linear = cn0_linear / link.profile.symbol_rate_sps
    expected_margin = 10 * math.log10(esn0_linear) - threshold - 2.3
    assert result["received_power_dbw"] == pytest.approx(
        10 * math.log10(received), abs=5e-13
    )
    assert result["cn0_dbhz"] == pytest.approx(10 * math.log10(cn0_linear), abs=5e-13)
    assert result["esn0_db"] == pytest.approx(10 * math.log10(esn0_linear), abs=5e-13)
    assert result["margin_db"] == pytest.approx(expected_margin, abs=5e-13)
    assert result["polarization_coupling"] == pytest.approx(coupling, abs=1e-15)
    estimated_rate = (
        link.profile.symbol_rate_sps
        * (2 if modulation == "QPSK" else 3)
        * rate
        * link.profile.net_efficiency
    )
    assert result["ideal_rate_bps"] == (estimated_rate if expected_margin >= 0 else 0)


@pytest.mark.parametrize("angle", [0, 30, 60, 180])
def test_patch_gain_uses_spacecraft_to_station_los_and_body_y(angle):
    scenario = default_scenario()
    theta = math.radians(angle)
    state = aligned_state() | {
        "y": (0, math.sin(theta), -math.cos(theta)),
        "z": (0, math.cos(theta), math.sin(theta)),
    }
    peak = 10 ** (scenario.downlink.spacecraft_peak_gain_dbi / 10)
    response = spacecraft_response(scenario, scenario.downlink, state)
    expected = peak * math.cos(theta) ** (peak / 2 - 1) if angle < 90 else 0
    assert response.gain_linear == pytest.approx(expected, abs=2e-15)
    if angle == 180:
        result = evaluate_link_budget(scenario, "downlink", state, True)
        assert result["reason"] == "field_or_polarization_null"
        assert result["ideal_rate_bps"] == 0
    else:
        assert response.polarization == pytest.approx((1, 0, 0))


@pytest.mark.parametrize("pitch,yaw,coupling", [(45, 0, 0.5), (0, 45, 1.0)])
def test_native_mount_rotation_moves_gain_and_polarization_separately(
    pitch, yaw, coupling
):
    values = default_scenario().model_dump(mode="json")
    values["downlink"]["antenna_orientation_deg"] = [0, pitch, yaw]
    scenario = Scenario.model_validate(values)
    result = evaluate_link_budget(scenario, "downlink", aligned_state(), True)
    peak = 10 ** (scenario.downlink.spacecraft_peak_gain_dbi / 10)
    gain = peak * math.cos(math.radians(yaw)) ** (peak / 2 - 1)
    assert result["tx_gain_dbi"] == pytest.approx(10 * math.log10(gain), abs=1e-13)
    assert result["polarization_coupling"] == pytest.approx(coupling, abs=1e-15)


def test_common_scene_rotation_preserves_full_link_budget():
    scenario = default_scenario()
    state = aligned_state()
    rotated = state | {
        key: (value[2], value[0], value[1])
        for key, value in state.items()
        if key in ("k", "east", "north", "x", "y", "z")
    }
    for direction in ("uplink", "downlink"):
        first = evaluate_link_budget(scenario, direction, state, True)
        second = evaluate_link_budget(scenario, direction, rotated, True)
        assert second == first


def test_receive_reciprocity_uses_opposite_propagation_circular_vectors():
    # Hum pp. 5-6 equations 26-31: equal named circular polarization has
    # opposite complex signs when referred to one common Cartesian basis.
    incident = (2**-0.5, 1j * 2**-0.5, 0)
    reciprocal_transmit = (2**-0.5, -1j * 2**-0.5, 0)
    analyzer = tuple(
        value.conjugate() if isinstance(value, complex) else value
        for value in reciprocal_transmit
    )
    assert polarization_coupling(incident, analyzer) == pytest.approx(1, abs=1e-15)
    cross_analyzer = tuple(
        value.conjugate() if isinstance(value, complex) else value for value in incident
    )
    assert polarization_coupling(incident, cross_analyzer) == pytest.approx(
        0, abs=1e-30
    )
    assert polarization_coupling(incident, (1, 0, 0)) == pytest.approx(0.5)


def test_supported_thresholds_match_checked_etsi_normal_frame_table():
    # Independent transcription of Table 13, QEF PER=1e-7, normal 64800-bit
    # frames, 50 LDPC iterations, ideal AWGN and perfect synchronization.
    qpsk = [-2.35, -1.24, -0.30, 1.00, 2.23, 3.10, 4.03, 4.68, 5.18, 6.20, 6.42]
    qpsk_rates = [
        1 / 4,
        1 / 3,
        2 / 5,
        1 / 2,
        3 / 5,
        2 / 3,
        3 / 4,
        4 / 5,
        5 / 6,
        8 / 9,
        9 / 10,
    ]
    psk8 = [5.50, 6.62, 7.91, 9.35, 10.69, 10.98]
    psk8_rates = [3 / 5, 2 / 3, 3 / 4, 5 / 6, 8 / 9, 9 / 10]
    expected = {
        (modulation, rate): threshold
        for modulation, rates, thresholds in (
            ("QPSK", qpsk_rates, qpsk),
            ("8PSK", psk8_rates, psk8),
        )
        for rate, threshold in zip(rates, thresholds)
    }
    assert IDEAL_DVB_THRESHOLDS == expected

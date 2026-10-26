"""Direction-specific antenna-port link budget, metric, margin and ideal gate."""
import math
from ..geometry.vectors import scale, dot, matvec, transpose
from .antennas import (AntennaResponse, HALF_WAVE_DIRECTIVITY, HALF_WAVE_PEAK_DBI,
                       half_wave_dipole, short_dipole_turnstile, cosine_patch, antenna_orientation_matrix)
from .spherical_harmonics import spherical_harmonic_response
from .polarization import horizontal_feed, polarization_coupling
from .free_space import C_M_S, fspl_db, power_db
from .noise import noise_density_dbw_hz
from .modem import net_rate_bps
from .mission_efficiency import mission_downlink_efficiency


def spacecraft_response(scenario, link, state):
    look = scale(state["k"], -1)  # antenna look from spacecraft toward station.
    if link.spacecraft_antenna == "spherical_harmonic":
        body_axes = (state["x"], state["y"], state["z"])
        look_body = tuple(dot(axis, look) for axis in body_axes)
        response = spherical_harmonic_response(link.spherical_harmonic_profile, link.frequency_hz, look_body,
                                               antenna_orientation_matrix(link.antenna_orientation_deg))
        return AntennaResponse(response.gain_linear,
                               matvec(transpose(body_axes), response.polarization) if response.polarization is not None else None)
    if any(link.antenna_orientation_deg):
        mount = antenna_orientation_matrix(link.antenna_orientation_deg)
        inertial_from_body = transpose((state["x"], state["y"], state["z"]))
        state = state | {name: matvec(inertial_from_body, column)
                         for name, column in zip(("x", "y", "z"), transpose(mount))}
    if link.spacecraft_antenna == "patch":
        return cosine_patch(state["y"], state["x"], look, link.spacecraft_peak_gain_dbi)
    if scenario.antenna_variant == "v45":
        return None  # No feed/current/installed model supplied; never borrow a straight-dipole pattern.
    # This parameter calibrates a common efficiency against the half-wave reference,
    # preserving one total source-power budget when switching to the turnstile.
    efficiency = 10**(link.spacecraft_peak_gain_dbi/10)/HALF_WAVE_DIRECTIVITY
    if link.spacecraft_peak_gain_dbi > HALF_WAVE_PEAK_DBI:
        raise ValueError("Wire peak gain exceeds the shared ideal half-wave reference bound")
    if scenario.antenna_variant == "dipole":
        return half_wave_dipole(state["x"], look, efficiency)
    return short_dipole_turnstile(state["x"], state["z"], look, efficiency)


def evaluate_link_budget(scenario, direction, state, scheduled):
    link = getattr(scenario, direction)
    sc_response = spacecraft_response(scenario, link, state)
    additional_zero = False
    if direction == "downlink" and getattr(getattr(scenario, "power", None), "analytical_efficiency_semantics", None) is not None:
        multiplier = mission_downlink_efficiency(scenario).gain_multiplier
        additional_zero = multiplier == 0
        if sc_response is not None and multiplier != 1:
            sc_response = AntennaResponse(
                sc_response.gain_linear * multiplier,
                sc_response.polarization if multiplier > 0 else None,
            )
    ground_pol = tuple(complex(v) for v in horizontal_feed(state["east"], state["north"], state["k"], link.ground_feed_roll_deg))
    ground_response = AntennaResponse(10**(link.ground_peak_gain_dbi/10), ground_pol)
    tx, rx = (ground_response, sc_response) if direction == "uplink" else (sc_response, ground_response)
    result = dict(received_power_dbw=None, cn0_dbhz=None, esn0_db=None, margin_db=None,
                  polarization_coupling=None, polarization_loss_db=None,
                  tx_gain_dbi=power_db(tx.gain_linear) if tx else None,
                  rx_gain_dbi=power_db(rx.gain_linear) if rx else None,
                  fspl_db=fspl_db(state["range_m"], link.frequency_hz),
                  noise_density_dbw_hz=noise_density_dbw_hz(link.rx_system_noise_temperature_k),
                  ideal_rate_bps=0.0, valid=False, reason="pattern_unresolved",
                  doppler_hz=-state["range_rate_m_s"]/C_M_S*link.frequency_hz)
    if tx is None or rx is None:
        result["ideal_rate_bps"] = None
        return result
    # Effective receive analyzer is conjugated transmit pattern by reciprocity.
    analyzer = tuple(v.conjugate() for v in rx.polarization) if rx.polarization else None
    coupling = polarization_coupling(tx.polarization, analyzer)
    result["polarization_coupling"] = coupling
    if link.profile.threshold_db is None and not additional_zero:
        result["ideal_rate_bps"] = None
    coupling_db = power_db(coupling) if coupling is not None else None
    result["polarization_loss_db"] = -coupling_db if coupling_db is not None else None
    if coupling_db is None or result["tx_gain_dbi"] is None or result["rx_gain_dbi"] is None:
        result["reason"] = "field_or_polarization_null"
        return result
    received = (power_db(link.tx_power_w) - link.tx_feed_loss_db + result["tx_gain_dbi"]
                + result["rx_gain_dbi"] - result["fspl_db"] - link.extra_path_loss_db + coupling_db)
    cn0 = received - result["noise_density_dbw_hz"]
    esn0 = cn0-10*math.log10(link.profile.symbol_rate_sps) if link.profile.symbol_rate_sps else None
    metric = cn0 if link.profile.threshold_metric == "cn0" else esn0
    margin = metric-link.profile.threshold_db-link.profile.engineering_reserve_db if metric is not None and link.profile.threshold_db is not None else None
    delivering = state["visible"] and scheduled and margin is not None and margin >= 0
    result.update(received_power_dbw=received, cn0_dbhz=cn0, esn0_db=esn0, margin_db=margin,
                  ideal_rate_bps=(net_rate_bps(link.profile) if delivering else 0.0) if margin is not None else None,
                  valid=True, reason="ideal_gate" if margin is not None else "receiver_threshold_unresolved")
    return result

"""Conditional peak-gain DVB-S2 planning footprints, independent of mission state.

ITU-R P.525-5 (11/2024), Annex section 2.3, equation (5), printed p.3:
Lfs = 20 log10(4 pi d / lambda). A constant RF/noise budget therefore gives
one maximum range for each supplied Es/N0 threshold. Geometry intersects that
range with a fixed geodetic-height shell above the station elevation mask.
"""

import math

from ..geometry.ellipsoid_shell import AZIMUTH_SEGMENTS, StationShell
from ..models import content_hash
from .antennas import HALF_WAVE_DIRECTIVITY
from .free_space import C_M_S, fspl_db, power_db
from .mission_efficiency import mission_downlink_efficiency
from .noise import noise_density_dbw_hz

MODEL_VERSION = "conditional_peak_gain_coverage_v1"
FREE_SPACE_SOURCE = (
    "ITU-R P.525-5 (11/2024), Annex 2.3, equation (5), printed p.3: "
    "https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.525-5-202411-I!!PDF-E.pdf"
)


def _spacecraft_peak(scenario, direction):
    link = getattr(scenario, direction)
    if link.spacecraft_antenna == "spherical_harmonic":
        return None, "pattern_unresolved", "Global peak has not been solved for this coefficient profile"
    if link.spacecraft_antenna == "wire" and scenario.antenna_variant == "v45":
        return None, "pattern_unresolved", "The installed V45 wire field is unresolved"
    peak = 10 ** (link.spacecraft_peak_gain_dbi / 10)
    source = "configured cosine-patch peak" if link.spacecraft_antenna == "patch" else "half-wave dipole peak"
    if link.spacecraft_antenna == "wire" and scenario.antenna_variant == "turnstile":
        peak *= 1.5 / HALF_WAVE_DIRECTIVITY
        source = "quadrature short-dipole turnstile peak, shared total power normalization"
    if direction == "downlink" and getattr(
        getattr(scenario, "power", None), "analytical_efficiency_semantics", None
    ) is not None:
        peak *= mission_downlink_efficiency(scenario).gain_multiplier
        source += "; mission additional radiation-efficiency multiplier applied"
    return (10 * math.log10(peak) if peak > 0 else None,
            "zero_antenna_efficiency" if peak == 0 else None, source)


def coverage_contours(scenario, direction, altitude_m, modes, *, mode_source,
                      polarization_loss_db=0, altitude_source="explicit_geodetic_height"):
    """Evaluate immutable inputs; supplied mode thresholds already include reserve.

    `modes` contains receiver/catalogue records prepared by the HTTP adapter.
    No receiver state, acquisition margin, dwell, schedule or attitude is run.
    """
    if direction not in ("uplink", "downlink"):
        raise ValueError("Coverage direction must be uplink or downlink")
    if (isinstance(polarization_loss_db, bool) or not math.isfinite(polarization_loss_db)
            or not 0 <= polarization_loss_db <= 100):
        raise ValueError("Assumed polarization loss must be finite and within 0..100 dB")
    if not 1 <= len(modes) <= 32:
        raise ValueError("Coverage requires 1..32 receiver modes")
    link = getattr(scenario, direction)
    if link.profile.waveform != "dvb_s2":
        raise ValueError("MODCOD coverage requires a DVB-S2 link; LoRa remains separate")
    shell = StationShell(scenario.station, altitude_m)
    spacecraft_gain, pattern_reason, gain_source = _spacecraft_peak(scenario, direction)
    noise_density = noise_density_dbw_hz(link.rx_system_noise_temperature_k)
    rf = dict(frequency_hz=link.frequency_hz, tx_power_w=link.tx_power_w,
              tx_feed_loss_db=link.tx_feed_loss_db, ground_gain_dbi=link.ground_peak_gain_dbi,
              spacecraft_gain_dbi=spacecraft_gain, spacecraft_gain_source=gain_source,
              extra_path_loss_db=link.extra_path_loss_db,
              polarization_loss_db=polarization_loss_db,
              rx_system_noise_temperature_k=link.rx_system_noise_temperature_k,
              noise_density_dbw_hz=noise_density,
              link_profile_engineering_reserve_db=link.profile.engineering_reserve_db,
              reserve_policy=("already_encoded_in_configured_threshold; link profile reserve not added again"
                              if mode_source == "configured_receiver" else
                              "link profile reserve added once to each ideal catalogue threshold"))
    contours = []
    for mode in modes:
        threshold = mode["threshold_esn0_db"]
        row = dict(mode, label=f'{mode["modulation"]} {mode["code_rate"]}',
                   threshold_includes_reserve=True, status="unresolved",
                   limit="receiver_threshold_unresolved", max_slant_range_m=None,
                   zenith_margin_db=None, boundary=[])
        if pattern_reason:
            row.update(limit=pattern_reason,
                       status="no_coverage" if pattern_reason == "zero_antenna_efficiency" else "unresolved")
            contours.append(row)
            continue
        if threshold is None:
            contours.append(row)
            continue
        range_independent_cn0 = (
            power_db(link.tx_power_w) - link.tx_feed_loss_db
            + link.ground_peak_gain_dbi + spacecraft_gain
            - link.extra_path_loss_db - polarization_loss_db - noise_density
        )
        allowed_fspl = range_independent_cn0 - 10 * math.log10(mode["symbol_rate_sps"]) - threshold
        maximum_range = C_M_S / (4 * math.pi * link.frequency_hz) * 10 ** (allowed_fspl / 20)
        boundary, limit = shell.boundary(maximum_range)
        row.update(status="coverage" if boundary else "no_coverage", limit=limit,
                   max_slant_range_m=maximum_range, boundary=boundary,
                   zenith_margin_db=allowed_fspl - fspl_db(shell.minimum_range_m, link.frequency_hz))
        contours.append(row)
    assumptions = [
        "Conditional planning footprint at a fixed WGS84 geodetic height. Satellite geodetic coordinates are retained separately from the display boundary.",
        "Boundary latitude/longitude use the radial WGS84 surface intersection, matching the run ground-track display. These display coordinates differ slightly from the shell satellite geodetic latitude; they do not change the RF geometry.",
        "Both antennas maintain their effective peak gains with perfect tracking; spacecraft attitude, antenna pointing errors and vector polarization are not simulated.",
        f"Constant assumed polarization loss {polarization_loss_db:g} dB replaces vector coupling for this calculation. Zero dB assumes matched polarization independently of the archived ground feed.",
        "Peak gain and assumed polarization loss may not be simultaneously achievable with the installed antennas. These conditional boundaries are not an assurance of attainable coverage.",
        "Free-space loss plus the configured constant extra path loss, transmit feed loss and antenna-referred system noise temperature; no terrain, refraction, weather or obstruction model.",
        "Only the configured station elevation mask is applied. RF range is monotone only under these constant-gain/noise/loss assumptions.",
        "Each threshold includes any encoded engineering reserve once. Receiver acquisition, capture/hold margins, lock, scheduling, frame delivery and tracking dynamics are not predicted.",
        "144 azimuth segments close each geodetic boundary; plotted chords have finite angular resolution.",
    ]
    if link.spacecraft_antenna == "wire" and scenario.antenna_variant == "turnstile":
        assumptions.append("The analytical turnstile has circular polarization at its gain peak, while the run ground-feed model is linear. An assumed zero polarization loss is optimistic for that pair; the editable loss is not inferred from the rendered antenna.")
    if altitude_source == "nominal_orbit_planning_height":
        assumptions.append("Shell height is the nominal orbit planning height (semimajor axis minus configured reference radius, or legacy circular altitude); it is not the instantaneous mission altitude or an eccentric-orbit envelope.")
    return dict(schema_version="0.1.0", model=MODEL_VERSION,
                scenario_sha256=content_hash(scenario.model_dump(mode="json")),
                direction=direction, altitude_m=altitude_m, altitude_source=altitude_source,
                station=scenario.station.model_dump(mode="json"), mode_source=mode_source,
                display_projection="radial_wgs84_surface_geodetic",
                azimuth_segments=AZIMUTH_SEGMENTS, assumptions=assumptions,
                sources=[FREE_SPACE_SOURCE], rf=rf, contours=contours)

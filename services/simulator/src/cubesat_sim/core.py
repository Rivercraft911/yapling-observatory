"""Deterministic illustrative circular-pass study, independent of plotting/API."""
from __future__ import annotations

from datetime import datetime, timedelta
from importlib.metadata import version, PackageNotFoundError
import math
import platform

from . import __version__
from .models import Scenario, content_hash, default_scenario, ITU_URL, ETSI_URL
from .physics import (
    C_M_S, K_B_J_K, EARTH_MU_M3_S2, EARTH_OMEGA_RAD_S, WGS84_A_M, WGS84_F,
    HALF_WAVE_DIRECTIVITY, HALF_WAVE_PEAK_DBI, AntennaResponse, add, scale, dot, cross, norm, unit,
    matvec, matmul, transpose, rotation, rz, geodetic_ecef, enu_axes,
    tracking_matrix, horizontal_feed, quaternion_from_matrix,
    half_wave_dipole, short_dipole_turnstile, cosine_patch,
    polarization_coupling, fspl_db, noise_density_dbw_hz, power_db,
)

MODEL_VERSION = "analytic-circular-vector-rf-0.1.0"
WARNINGS = [
    "Illustrative analytical pass, not a forecast from launch elements or a TLE.",
    "Approximate Stanford station is unsurveyed. Obstruction mask, ground mount limits and hardware tracking are absent.",
    "Prescribed attitude is kinematic. Tracking error and spin are inputs, not simulated magnetorquer/controller performance.",
    "Analytical free-space patterns are not radiation patterns of the rendered GLB/tape hardware. Mutual coupling, installed metal, resonance and feeder mismatch are unmodeled.",
    "Ideal threshold capacity only: no packet/frame history, acquisition, lock, retries, protocol timing, queue, energy or measured receiver curve.",
    "Default schedule alternates links. No simultaneous operation or RF isolation is implied by the two counterfactual budgets.",
    "Noise temperature is referred to the receive antenna available-power port and includes all assumed receive-chain noise/loss. Do not subtract receive feeder loss again.",
    "No atmosphere, ionosphere, rain, interference, refraction or measured obstruction model. extra_path_loss_db is only an explicit input.",
]


class CircularPass:
    """Central point-mass orbit, with uniformly rotating WGS84 station.

    Analytic inertial axes coincide with Earth-fixed XYZ at pass midpoint. This
    deliberately synthetic frame is not GCRF/TEME/realized ITRF. Epoch labels the
    first sample; UTC labels use POSIX-like elapsed seconds without leap seconds.
    Orbit radius is WGS84 equatorial semi-major axis + input altitude. At midpoint
    the satellite is radially above the station's geocentric direction. Ellipsoidal
    geodetic up differs slightly, so maximum geodetic elevation need not be 90 deg.
    """
    def __init__(self, scenario: Scenario):
        self.scenario = scenario
        station = scenario.station
        self.station_ecef = geodetic_ecef(station.latitude_deg, station.longitude_deg, station.height_m)
        self.enu_ecef = enu_axes(station.latitude_deg, station.longitude_deg)
        self.radial = unit(self.station_ecef)
        heading = math.radians(scenario.orbit.ground_track_heading_deg)
        horizontal = add(scale(self.enu_ecef[1], math.cos(heading)), scale(self.enu_ecef[0], math.sin(heading)))
        # Preserve the requested ENU bearing while making the relative tangent
        # perpendicular to geocentric radius. A simple radial projection would
        # slightly change the ENU bearing because geodetic up is not radial.
        relative_tangent = unit(add(horizontal, scale(self.enu_ecef[2], -dot(horizontal, self.radial)/dot(self.enu_ecef[2], self.radial))))
        self.radius = WGS84_A_M + scenario.orbit.altitude_m
        self.mean_motion = math.sqrt(EARTH_MU_M3_S2/self.radius**3)
        mid_sat = scale(self.radial, self.radius)
        rotation_velocity = cross((0, 0, EARTH_OMEGA_RAD_S), mid_sat)
        circular_speed = self.radius*self.mean_motion
        projection = dot(relative_tangent, rotation_velocity)
        relative_speed = -projection + math.sqrt(projection**2+circular_speed**2-dot(rotation_velocity, rotation_velocity))
        # v_inertial = v_earth_fixed + omega cross r, with fixed |v|=sqrt(mu/r).
        self.along = unit(add(scale(relative_tangent, relative_speed), rotation_velocity))
        self.mid_tracking = tracking_matrix(add(self.station_ecef, scale(mid_sat, -1)), self.enu_ecef[1], self.enu_ecef[0])

    def state(self, time_s):
        scn = self.scenario
        t = time_s - scn.duration_s/2
        theta = self.mean_motion*t
        sat = scale(add(scale(self.radial, math.cos(theta)), scale(self.along, math.sin(theta))), self.radius)
        sat_velocity = scale(add(scale(self.radial, -math.sin(theta)), scale(self.along, math.cos(theta))), self.radius*self.mean_motion)
        earth_rotation = rz(EARTH_OMEGA_RAD_S*t)
        station = matvec(earth_rotation, self.station_ecef)
        station_velocity = cross((0, 0, EARTH_OMEGA_RAD_S), station)
        east, north, up = (matvec(earth_rotation, a) for a in self.enu_ecef)
        ground_to_sat = add(sat, scale(station, -1))
        distance = norm(ground_to_sat)
        k = unit(ground_to_sat)
        range_rate = dot(add(sat_velocity, scale(station_velocity, -1)), k)
        east_component, north_component = dot(k, east), dot(k, north)
        horizontal = math.hypot(east_component, north_component)
        azimuth = math.degrees(math.atan2(east_component, north_component)) % 360 if horizontal > 1e-10 else None
        elevation = math.degrees(math.asin(max(-1, min(1, dot(k, up)))))
        if scn.attitude.mode == "tracking":
            body_from_inertial = tracking_matrix(scale(k, -1), north, east)
        else:
            # Constant prescribed body-axis spin; not a torque-free dynamics solve.
            body_from_inertial = matmul(rotation(scn.attitude.spin_axis_body, -math.radians(scn.attitude.spin_rate_deg_s)*t), self.mid_tracking)
        body_from_inertial = matmul(rotation((1, 0, 0), math.radians(scn.attitude.pointing_error_deg)), body_from_inertial)
        inertial_from_body = transpose(body_from_inertial)
        x, y, z = (matvec(inertial_from_body, axis) for axis in ((1,0,0),(0,1,0),(0,0,1)))
        pointing_error = math.degrees(math.acos(max(-1, min(1, dot(y, scale(k, -1))))))
        relative_velocity = add(sat_velocity, scale(station_velocity, -1))
        los_rate = norm(add(relative_velocity, scale(k, -range_rate)))/distance
        return dict(time_s=time_s, satellite_position_m=sat, station_position_m=station,
                    satellite_position_ecef_m=matvec(transpose(earth_rotation), sat),
                    satellite_velocity_m_s=sat_velocity, station_velocity_m_s=station_velocity,
                    q_body_from_inertial_wxyz=quaternion_from_matrix(body_from_inertial),
                    range_m=distance, range_rate_m_s=range_rate,
                    elevation_deg=elevation, azimuth_deg=azimuth,
                    visible=elevation >= scn.station.minimum_elevation_deg,
                    attitude_angle_deg=pointing_error, tracking_rate_deg_s=math.degrees(los_rate),
                    east=east, north=north, k=k, x=x, y=y, z=z)


def active_direction(scenario, time_s):
    # Half-open slots, including t=0. Final sample is an instantaneous endpoint.
    slot = int(math.floor(time_s/scenario.schedule.slot_duration_s + 1e-12))
    first = scenario.schedule.first_direction
    return first if slot % 2 == 0 else ("downlink" if first == "uplink" else "uplink")


def spacecraft_response(scenario, link, state):
    look = scale(state["k"], -1)  # antenna look from spacecraft toward station.
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


def evaluate_link(scenario, direction, state):
    link = getattr(scenario, direction)
    sc_response = spacecraft_response(scenario, link, state)
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
    if link.profile.threshold_db is None:
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
    delivering = state["visible"] and active_direction(scenario, state["time_s"]) == direction and margin is not None and margin >= 0
    result.update(received_power_dbw=received, cn0_dbhz=cn0, esn0_db=esn0, margin_db=margin,
                  ideal_rate_bps=(link.profile.net_rate_bps() if delivering else 0.0) if margin is not None else None,
                  valid=True, reason="ideal_gate" if margin is not None else "receiver_threshold_unresolved")
    return result


def input_provenance(scenario):
    """Record every effective leaf input and flag edits to bundled default values."""
    default = default_scenario().model_dump(mode="json")
    current = scenario.model_dump(mode="json")
    records = []
    def walk(value, baseline, path):
        if isinstance(value, dict):
            for key, item in value.items():
                if key != "provenance":
                    walk(item, baseline.get(key) if isinstance(baseline, dict) else None, f"{path}.{key}".strip("."))
            return
        evidence = max((e for e in scenario.provenance if not e.path or path == e.path or path.startswith(e.path+".")), key=lambda e: len(e.path), default=None)
        edited = value != baseline
        suffix_units = (("_deg_s", "deg/s"), ("_sps", "symbol/s"), ("_bps", "bit/s"),
                        ("_dbi", "dBi"), ("_hz", "Hz"), ("_deg", "deg"),
                        ("_db", "dB"), ("_m", "m"), ("_s", "s"), ("_w", "W"), ("_k", "K"))
        unit_name = next((u for suffix,u in suffix_units if path.endswith(suffix)), "1 / categorical")
        if path.endswith(".threshold_db"):
            direction = path.split(".")[0]
            unit_name = "dB Hz" if getattr(scenario, direction).profile.threshold_metric == "cn0" else "dB"
        if path == "epoch_utc":
            unit_name = "ISO 8601 UTC"
        records.append(dict(path=path, value=value, status="user_input" if edited else (evidence.status if evidence else "unresolved"),
                            source="Edited input, not independently verified" if edited else (evidence.source if evidence else "No evidence supplied"),
                            conditions=("Bundled evidence does not validate this edited value. " if edited else "") + (evidence.conditions if evidence else ""),
                            edited_from_bundled_default=edited, unit=unit_name))
    walk(current, default, "")
    return records


def runtime_versions():
    result = {"python": platform.python_version(), "application": __version__}
    for name in ("fastapi", "pydantic", "uvicorn"):
        try:
            result[name] = version(name)
        except PackageNotFoundError:
            result[name] = "not installed"
    return result


def run_scenario(scenario: Scenario):
    """Compute one deterministic result. API cancellation terminates its process."""
    orbit = CircularPass(scenario)
    count = math.ceil(scenario.duration_s/scenario.step_s)
    times = [min(i*scenario.step_s, scenario.duration_s) for i in range(count+1)]
    sample_keys = ("time_s", "satellite_position_m", "station_position_m", "satellite_position_ecef_m",
                   "satellite_velocity_m_s", "station_velocity_m_s", "q_body_from_inertial_wxyz",
                   "range_m", "range_rate_m_s", "elevation_deg", "azimuth_deg", "visible",
                   "attitude_angle_deg", "tracking_rate_deg_s")
    samples = {key: [] for key in sample_keys}
    samples["active_direction"] = []
    channels = {direction: {} for direction in ("uplink", "downlink")}
    for t in times:
        state = orbit.state(t)
        for key in sample_keys:
            samples[key].append(state[key])
        samples["active_direction"].append(active_direction(scenario, t))
        for direction in channels:
            for key, value in evaluate_link(scenario, direction, state).items():
                channels[direction].setdefault(key, []).append(value)
    # Integrate at actual midpoint geometry, split exactly at direction changes.
    # Never infer a whole packet's success from a point sample.
    capacity_available = {direction: getattr(scenario, direction).profile.threshold_db is not None and
                          not (scenario.antenna_variant == "v45" and getattr(scenario, direction).spacecraft_antenna == "wire")
                          for direction in channels}
    cumulative = {direction: [0.0 if capacity_available[direction] else None] for direction in channels}
    slot = scenario.schedule.slot_duration_s
    for start, end in zip(times, times[1:]):
        first_boundary = (math.floor(start/slot)+1)*slot
        cuts = [start]
        boundary = first_boundary
        while boundary < end-1e-12:
            if boundary > start+1e-12:
                cuts.append(boundary)
            boundary += slot
        cuts.append(end)
        bits = {direction: 0.0 for direction in channels}
        for a, b in zip(cuts, cuts[1:]):
            state = orbit.state((a+b)/2)
            direction = active_direction(scenario, state["time_s"])
            if capacity_available[direction]:
                bits[direction] += (b-a)*evaluate_link(scenario, direction, state)["ideal_rate_bps"]
        for direction in channels:
            cumulative[direction].append(cumulative[direction][-1]+bits[direction] if capacity_available[direction] else None)
    for direction in channels:
        channels[direction]["cumulative_ideal_bits"] = cumulative[direction]
        samples[direction] = channels[direction]
    events = []
    for i in range(1, len(times)):
        for key in ("visible", "active_direction"):
            if samples[key][i] != samples[key][i-1]:
                events.append(dict(time_s=times[i], kind=key, value=samples[key][i], timing="first sample after transition; grid resolved"))
    warnings = list(WARNINGS)
    if scenario.antenna_variant == "v45" and any(getattr(scenario, d).spacecraft_antenna == "wire" for d in channels):
        warnings.append("The V45 tape shape has no supplied current/feed pattern model. Wire-link RF, margin and capacity remain unresolved for this variant.")
    for direction in channels:
        profile = getattr(scenario, direction).profile
        if profile.waveform == "lora":
            warnings.append(f"{direction}: MiniF27 SX1262 versus LLCC68 hardware and LoRa settings unresolved. No measured LoRa success or acquisition model exists.")
        if profile.threshold_status == "unresolved":
            warnings.append(f"{direction}: receiver threshold is unresolved; margin and ideal capacity are null, not zero.")
    identity, digest = scenario.identity()
    summary = dict(ideal_capacity_bits={d: cumulative[d][-1] for d in channels},
                   capacity_available=capacity_available,
                   max_elevation_deg=max(samples["elevation_deg"]), min_range_m=min(samples["range_m"]),
                   capacity_kind="ideal_threshold_capacity_not_packet_delivery",
                   sample_count=len(times), duration_s=scenario.duration_s)
    manifest = dict(schema_version="0.1.0", model_version=MODEL_VERSION,
                    scenario_id=identity, scenario_hash=digest, scenario=scenario.model_dump(mode="json"),
                    versions=runtime_versions(), seeds=None, external_input_hashes={},
                    model_fidelity="analytical_illustrative", warnings=warnings,
                    frames={"inertial":"ANALYTIC_INERTIAL: Earth-fixed XYZ coincident at pass midpoint; not GCRF/TEME",
                            "earth_fixed":"WGS84 ellipsoid with constant nominal rotation; not a realized ITRF/EOP solution",
                            "body":"+X dipole/linear feed, +Y patch boresight, +Z turnstile second arm / roll datum",
                            "quaternion":"scalar-first Hamilton q_body_from_inertial: q [0,v_I] conjugate(q) = [0,v_B]",
                            "ground_feed":"horizon H = up cross LOS, projected local-east fallback at zenith/nadir, then right-hand roll about station-to-spacecraft LOS"},
                    time={"epoch_utc":scenario.epoch_utc,"epoch_meaning":"first sample; orbit midpoint is constructed at duration/2",
                          "elapsed_scale":"SI seconds, POSIX-like UTC label arithmetic, no leap second/EOP model",
                          "elapsed_ns_encoding":"decimal strings in elapsed_ns", "earth_orientation_data":None},
                    numerical_settings={"requested_step_s":scenario.step_s,"max_sample_points":7201,
                                        "capacity_integration":"midpoint geometry, exact schedule cuts, grid-resolved threshold/visibility crossings",
                                        "worker_count":1},
                    rf_reference_planes={"tx_power_w":"available RF power at radio/PA output; tx_feed_loss_db applied once to antenna feed",
                                         "received_power_dbw":"available wanted power at matched receive antenna port",
                                         "noise":"k*Tsys at same receive antenna port; includes assumed receive feeder/receiver contributions",
                                         "gains":"analytical gain surrogates; no installed-field import or GLB-derived RF"},
                    constants={"speed_of_light_m_s":C_M_S,"boltzmann_j_k":K_B_J_K,"earth_mu_m3_s2":EARTH_MU_M3_S2,
                               "earth_omega_rad_s":EARTH_OMEGA_RAD_S,"wgs84_a_m":WGS84_A_M,"wgs84_flattening":WGS84_F},
                    sources=[{"url":ITU_URL,"locator":"P.525-5 (11/2024), 2.3 equation (5), p. 3","scope":"free-space attenuation"},
                             {"url":ETSI_URL,"locator":"EN 302 307-1 V1.4.1, section 6/Table 13, p. 36","scope":"ideal simulated DVB-S2 thresholds only"},
                             {"url":"https://earth-info.nga.mil/index.php?action=wgs84&dir=wgs84","locator":"Defining Parameters table, checked 2026-10-25","scope":"WGS84 constants, not frame realization"},
                             {"url":"https://physics.nist.gov/cuu/Constants/","locator":"SI exact c and k, checked 2026-10-25","scope":"physical constants"}],
                    input_provenance=input_provenance(scenario))
    samples["elapsed_ns"] = [str(round(t*1e9)) for t in times]
    epoch = datetime.fromisoformat(scenario.epoch_utc.replace("Z", "+00:00"))
    samples["utc"] = [(epoch+timedelta(seconds=t)).isoformat().replace("+00:00", "Z") for t in times]
    result = dict(manifest=manifest, summary=summary, samples=samples, events=events)
    manifest["result_hash"] = content_hash(result)
    return result

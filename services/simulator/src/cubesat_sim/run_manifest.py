"""Run metadata, effective-input provenance and numerical-source identities."""
from __future__ import annotations
from importlib.metadata import version, PackageNotFoundError
from pathlib import Path
import hashlib
import platform
from . import __version__
from .models import default_scenario, ITU_URL, ETSI_URL
from .geometry.frames import WGS84_A_M, WGS84_F
from .orbit.circular_pass import EARTH_MU_M3_S2, EARTH_OMEGA_RAD_S
from .rf.free_space import C_M_S
from .rf.noise import K_B_J_K
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


def source_code_hashes():
    package = Path(__file__).parent
    paths = {package/name for name in ("__init__.py", "core.py", "models.py", "antenna_models.py", "run_manifest.py", "physics.py")}
    for domain in ("geometry", "attitude", "orbit", "rf", "operations"):
        paths.update((package/domain).rglob("*.py"))
    result = {}
    for path in sorted(paths):
        key = "cubesat_sim/"+path.relative_to(package).as_posix()
        try:
            result[key] = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError:
            result[key] = None
    return result


def build_run_metadata(scenario, times, samples, capacity_available, cumulative):
    channels = ("uplink", "downlink")
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
    manifest["source_code_hashes"] = source_code_hashes()
    return manifest, summary

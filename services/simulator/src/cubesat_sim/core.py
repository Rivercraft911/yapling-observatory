"""Run orchestration; physical formulas live in the numerical domain packages."""
from __future__ import annotations
from datetime import datetime, timedelta
from .models import Scenario, content_hash
from .orbit.circular_pass import CircularPass
from .operations.schedule import active_direction, sample_times
from .operations.capacity import integrate_ideal_capacity
from .rf.link_budget import evaluate_link_budget, spacecraft_response
from .run_manifest import MODEL_VERSION, WARNINGS, input_provenance, runtime_versions, build_run_metadata


def evaluate_link(scenario, direction, state):
    scheduled = active_direction(scenario, state["time_s"]) == direction
    return evaluate_link_budget(scenario, direction, state, scheduled)


def run_scenario(scenario: Scenario):
    """Compute one deterministic result. API cancellation terminates its process."""
    orbit = CircularPass(scenario)
    times = sample_times(scenario.duration_s, scenario.step_s)
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
    capacity_available, cumulative = integrate_ideal_capacity(scenario, times, orbit.state, evaluate_link)
    for direction in channels:
        channels[direction]["cumulative_ideal_bits"] = cumulative[direction]
        samples[direction] = channels[direction]
    events = []
    for i in range(1, len(times)):
        for key in ("visible", "active_direction"):
            if samples[key][i] != samples[key][i-1]:
                events.append(dict(time_s=times[i], kind=key, value=samples[key][i], timing="first sample after transition; grid resolved"))
    manifest, summary = build_run_metadata(scenario, times, samples, capacity_available, cumulative)
    samples["elapsed_ns"] = [str(round(t*1e9)) for t in times]
    epoch = datetime.fromisoformat(scenario.epoch_utc.replace("Z", "+00:00"))
    samples["utc"] = [(epoch+timedelta(seconds=t)).isoformat().replace("+00:00", "Z") for t in times]
    result = dict(manifest=manifest, summary=summary, samples=samples, events=events)
    manifest["result_hash"] = content_hash(result)
    return result

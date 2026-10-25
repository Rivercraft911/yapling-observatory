"""Half-open alternating slots and the requested sample grid."""
import math


def active_direction(scenario, time_s):
    # Half-open slots, including t=0. Final sample is an instantaneous endpoint.
    slot = int(math.floor(time_s/scenario.schedule.slot_duration_s + 1e-12))
    first = scenario.schedule.first_direction
    return first if slot % 2 == 0 else ("downlink" if first == "uplink" else "uplink")


def sample_times(duration_s, step_s):
    count = math.ceil(duration_s/step_s)
    return [min(i*step_s, duration_s) for i in range(count+1)]


def schedule_cuts(start, end, slot_duration_s):
    first_boundary = (math.floor(start/slot_duration_s)+1)*slot_duration_s
    cuts = [start]
    boundary = first_boundary
    while boundary < end-1e-12:
        if boundary > start+1e-12:
            cuts.append(boundary)
        boundary += slot_duration_s
    cuts.append(end)
    return cuts

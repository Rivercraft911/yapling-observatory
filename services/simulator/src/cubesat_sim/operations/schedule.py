"""Half-open direction slots and the requested sample grid.

Explicit direction durations repeat from mission time zero, including outside
contact. They contain no RF turnaround, acquisition or hardware timing model.
"""

import math


def active_direction(scenario, time_s):
    schedule = scenario.schedule
    first = schedule.first_direction
    other = "downlink" if first == "uplink" else "uplink"
    if schedule.uplink_duration_s is None:
        # Preserve the legacy equal-slot arithmetic and endpoint convention.
        slot = int(math.floor(time_s / schedule.slot_duration_s + 1e-12))
        return first if slot % 2 == 0 else other
    first_duration, second_duration = slot_durations_s(schedule)
    period = first_duration + second_duration
    phase = time_s % period
    tolerance = 4 * max(math.ulp(time_s), math.ulp(period))
    if period - phase <= tolerance:
        phase = 0.0
    return first if phase < first_duration - tolerance else other


def slot_durations_s(schedule):
    """Return first/second direction durations, with the exact equal-slot fallback."""
    if schedule.uplink_duration_s is None:
        return schedule.slot_duration_s, schedule.slot_duration_s
    durations = schedule.uplink_duration_s, schedule.downlink_duration_s
    return durations if schedule.first_direction == "uplink" else durations[::-1]


def sample_times(duration_s, step_s):
    count = math.ceil(duration_s / step_s)
    return [min(i * step_s, duration_s) for i in range(count + 1)]


def schedule_cuts(start, end, schedule_or_slot_duration_s):
    """Split intervals at direction changes; scalar callers retain legacy cuts."""
    schedule = schedule_or_slot_duration_s
    if isinstance(schedule, (int, float)) or schedule.uplink_duration_s is None:
        slot = (
            schedule if isinstance(schedule, (int, float)) else schedule.slot_duration_s
        )
        first_boundary = (math.floor(start / slot) + 1) * slot
        cuts = [start]
        boundary = first_boundary
        while boundary < end - 1e-12:
            if boundary > start + 1e-12:
                cuts.append(boundary)
            boundary += slot
        cuts.append(end)
        return cuts
    first_duration, second_duration = slot_durations_s(schedule)
    period = first_duration + second_duration
    tolerance = 4 * max(math.ulp(start), math.ulp(end), math.ulp(period))
    cuts = [start]
    for cycle in range(math.floor(start / period), math.floor(end / period) + 1):
        for offset in (0.0, first_duration):
            boundary = cycle * period + offset
            if start + tolerance < boundary < end - tolerance:
                cuts.append(boundary)
    cuts.append(end)
    return cuts

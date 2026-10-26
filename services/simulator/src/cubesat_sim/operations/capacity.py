"""Grid-resolved ideal threshold capacity; no packet or receiver-state model."""
from .schedule import active_direction, schedule_cuts


def integrate_piecewise(times, predicate, rate_bps, breakpoints=()):
    """Midpoint integration with exact schedule boundaries; no packet model.

    Returns cumulative bits at requested times. The predicate is evaluated at
    each subinterval midpoint; threshold/visibility crossings therefore retain
    the stated requested-step discretization error.
    """
    result = [0.0]
    boundaries = sorted(set(breakpoints))
    for start, end in zip(times, times[1:]):
        cuts = [start] + [t for t in boundaries if start < t < end] + [end]
        bits = sum((b-a)*rate_bps for a, b in zip(cuts, cuts[1:]) if predicate((a+b)/2))
        result.append(result[-1]+bits)
    return result


def integrate_ideal_capacity(scenario, times, state_at, evaluate_link):
    channels = ("uplink", "downlink")
    capacity_available = {direction: getattr(scenario, direction).profile.threshold_db is not None and
                          not (scenario.antenna_variant == "v45" and getattr(scenario, direction).spacecraft_antenna == "wire")
                          for direction in channels}
    cumulative = {direction: [0.0 if capacity_available[direction] else None] for direction in channels}
    for start, end in zip(times, times[1:]):
        cuts = schedule_cuts(start, end, scenario.schedule)
        bits = {direction: 0.0 for direction in channels}
        for a, b in zip(cuts, cuts[1:]):
            state = state_at((a+b)/2)
            direction = active_direction(scenario, state["time_s"])
            if capacity_available[direction]:
                bits[direction] += (b-a)*evaluate_link(scenario, direction, state)["ideal_rate_bps"]
        for direction in channels:
            cumulative[direction].append(cumulative[direction][-1]+bits[direction] if capacity_available[direction] else None)
    return capacity_available, cumulative

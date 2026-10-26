"""Half-power span around the largest sampled lobe in an angular cut."""
import math

# Definition: CommScope, Derren Oliver, 16 July 2014, beamwidth paragraphs.
# https://www.commscope.com/blog/2014/back-to-basics-in-microwave-systems-front-to-back-ratio-and-antenna-beamwidth/
def half_power_span(angles_deg, gain_linear, *, periodic=False, evaluate=None):
    if len(angles_deg) != len(gain_linear) or len(angles_deg) < 3:
        raise ValueError("A cut requires matching angle and power samples")
    if any(not math.isfinite(v) for v in (*angles_deg, *gain_linear)) or any(v < 0 for v in gain_linear):
        raise ValueError("Cut samples must be finite; power cannot be negative")
    if any(b <= a for a, b in zip(angles_deg, angles_deg[1:])):
        raise ValueError("Cut angles must increase")
    angles, gains = list(angles_deg), list(gain_linear)
    if periodic:
        if not math.isclose(angles[-1] - angles[0], 360, abs_tol=1e-8):
            raise ValueError("Periodic cuts must include both endpoints of 360 degrees")
        angles, gains = angles[:-1], gains[:-1]
    peak_index = max(range(len(gains)), key=gains.__getitem__)
    peak = gains[peak_index]
    if peak <= 1e-24:
        return None
    threshold = peak / 2

    def sample(index):
        if periodic:
            turns, wrapped = divmod(index, len(gains))
            return angles[wrapped] + turns * 360, gains[wrapped]
        if not 0 <= index < len(gains):
            return None
        return angles[index], gains[index]

    def crossing(direction):
        previous_angle, previous_gain = sample(peak_index)
        for offset in range(1, len(gains) + 1):
            current = sample(peak_index + direction * offset)
            if current is None:
                return None
            angle, gain = current
            if gain < threshold:
                if evaluate is None:
                    return previous_angle + (angle - previous_angle) * (threshold - previous_gain) / (gain - previous_gain)
                inside, outside = previous_angle, angle
                for _ in range(40):
                    midpoint = (inside + outside) / 2
                    if evaluate(midpoint) >= threshold:
                        inside = midpoint
                    else:
                        outside = midpoint
                return (inside + outside) / 2
            previous_angle, previous_gain = angle, gain
        return None

    lower, upper = crossing(-1), crossing(1)
    return dict(lower_deg=lower, upper_deg=upper,
                width_deg=upper - lower if lower is not None and upper is not None else None,
                peak_angle_deg=angles[peak_index], peak_gain_linear=peak,
                threshold_gain_dbi=10 * math.log10(threshold),
                relative_level_db=10 * math.log10(0.5),
                peak_search_step_deg=max(b-a for a,b in zip(angles, angles[1:])),
                reference="largest sampled cut peak", periodic=periodic)

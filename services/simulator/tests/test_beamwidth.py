import math
import pytest
from cubesat_sim.rf.beamwidth import half_power_span
from cubesat_sim.antenna_models import PatternRequest
from cubesat_sim.rf.pattern_sampling import sample_pattern

@pytest.mark.parametrize('gain', [6, 12, 20])
def test_patch_half_power_matches_closed_form(gain):
    result = sample_pattern(PatternRequest(model='patch', patch_peak_gain_dbi=gain, cut_azimuth_deg=90))
    exponent = 10**(gain/10)/2 - 1
    expected = 2 * math.degrees(math.acos(0.5**(1/exponent)))
    for cut in result['cuts'].values():
        assert cut['half_power']['width_deg'] == pytest.approx(expected, abs=1e-9)
        assert cut['half_power']['relative_level_db'] == pytest.approx(-3.01029995664)

def test_periodic_beam_crosses_seam_without_becoming_huge():
    angles = list(range(-180,181,2))
    response = lambda angle: max(0, math.cos(math.radians(angle-180)))**8
    span = half_power_span(angles, [response(a) for a in angles], periodic=True, evaluate=response)
    assert span['lower_deg'] < -180 < span['upper_deg']
    assert span['width_deg'] == pytest.approx(2*math.degrees(math.acos(0.5**(1/8))), abs=1e-9)

def test_zero_flat_and_truncated_cuts_have_no_bounded_beamwidth():
    assert half_power_span([-1,0,1], [0,0,0]) is None
    assert half_power_span([-1,0,1], [1,1,1])['width_deg'] is None
    assert half_power_span([-1,0,1], [0,0.2,1])['width_deg'] is None

def test_beamwidth_rejects_invalid_samples_and_preserves_inputs():
    angles, gains = [-2,0,2], [0,1,0]
    assert half_power_span(angles,gains)['width_deg'] == 2
    assert angles == [-2,0,2] and gains == [0,1,0]
    with pytest.raises(ValueError): half_power_span([0,0,1],gains)
    with pytest.raises(ValueError): half_power_span(angles,[0,float('nan'),0])

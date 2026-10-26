"""Ideal DVB-S2 root-raised-cosine support width, not a measured RF mask.

ETSI EN 302 307-1 V1.4.1 (2014-11), clause 5.6, printed p. 35:
the one-sided baseband cutoff is f_N(1+alpha), with f_N=R_s/2.
The corresponding full RF support width is B=R_s(1+alpha).
"""

import math

DVB_S2_ROLLOFFS = (0.2, 0.25, 0.35)
BANDWIDTH_SOURCE = (
    "ETSI EN 302 307-1 V1.4.1 (2014-11), clause 5.6 printed p. 35 "
    "and Annex A printed p. 37. "
    "https://www.etsi.org/deliver/etsi_en/302300_302399/30230701/01.04.01_60/"
    "en_30230701v010401p.pdf"
)
CHANNEL_ASSUMPTIONS = (
    "Planning uses the full allocated channel as the ideal root-raised-cosine RF "
    "support width B = Rs (1 + rolloff). No guard band, implementation filter skirt, "
    "oscillator error or regulatory occupied-bandwidth calculation is included. "
    "This does not qualify transmitter sample rate, encoder throughput or receiver bandwidth."
)


def _positive(value, name):
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive finite number")
    return float(value)


def _rolloff(value):
    if type(value) not in (int, float) or value not in DVB_S2_ROLLOFFS:
        raise ValueError("DVB-S2 rolloff must be 0.20, 0.25 or 0.35")
    return float(value)


def bandwidth_for_symbol_rate(symbol_rate_sps, rolloff):
    """Full ideal RF spectral support in Hz, with no additional guard band."""
    rate = _positive(symbol_rate_sps, "Symbol rate")
    width = rate * (1 + _rolloff(rolloff))
    if not math.isfinite(width):
        raise ValueError("RF support width must be finite")
    return width


def symbol_rate_for_bandwidth(channel_bandwidth_hz, rolloff):
    """Fill the declared planning allocation with the ideal spectral support."""
    width = _positive(channel_bandwidth_hz, "Allocated channel bandwidth")
    rate = width / (1 + _rolloff(rolloff))
    if not 1 <= rate <= 1e8:
        raise ValueError("Derived symbol rate must be within 1..100000000 symbol/s")
    return rate

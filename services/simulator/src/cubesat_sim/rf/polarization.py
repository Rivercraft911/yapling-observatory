"""Complex-field coupling and physical horizon-horizontal feed orientation.

Phasors use exp(+j omega t). The receive analyzer supplied to the Hermitian
inner product is the conjugated reciprocal transmit response.
"""
import math
from ..geometry.frames import rotation
from ..geometry.vectors import add, scale, dot, cross, norm, unit, transverse, matvec


def horizontal_feed(east, north, k, roll_deg=0):
    """Az/el mount H feed: horizontal and transverse, then explicit feed roll.

    H = unit(up cross look). At zenith/nadir the horizon-H orientation is
    undefined; use projected local east as a reproducible declared fallback.
    """
    up = unit(cross(east, north))
    v = cross(up, k)
    if norm(v) < 1e-10:
        v = transverse(east, k)
    v = unit(v)
    return matvec(rotation(k, math.radians(roll_deg)), v)


def polarization_coupling(tx_field, receive_analyzer):
    """|analyzer^H E|^2 / (|analyzer|^2 |E|^2), null -> undefined."""
    if tx_field is None or receive_analyzer is None:
        return None
    denominator = norm(tx_field)**2 * norm(receive_analyzer)**2
    if denominator < 1e-24:
        return None
    return max(0, min(1, abs(sum(complex(a).conjugate()*e for a, e in zip(receive_analyzer, tx_field)))**2/denominator))

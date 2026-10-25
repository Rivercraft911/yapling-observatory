"""Small, plotting-independent vector and analytical RF functions, all SI.

Phasor convention exp(+j omega t). A transmit pattern is a Cartesian transverse
complex electric-field vector. By reciprocity the receive voltage is proportional
to the *bilinear* product F_rx(look-to-source) dot E_incident. We expose a conjugated
receive analyzer to polarization_coupling(), whose convention is Hermitian.
These functions contain no screen, mesh, packet or hardware receiver state.
"""
from __future__ import annotations

from dataclasses import dataclass
import math

C_M_S = 299792458.0  # Exact SI definition.
K_B_J_K = 1.380649e-23  # Exact SI definition.
EARTH_MU_M3_S2 = 3.986004418e14  # WGS84 defining GM, atmosphere included.
EARTH_OMEGA_RAD_S = 7.292115e-5  # WGS84 nominal angular velocity.
WGS84_A_M = 6378137.0
WGS84_F = 1 / 298.257223563
HALF_WAVE_DIRECTIVITY = 1.640922376984585
HALF_WAVE_PEAK_DBI = 10*math.log10(HALF_WAVE_DIRECTIVITY)


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def add(a, b):
    return tuple(x+y for x, y in zip(a, b))


def scale(a, s):
    return tuple(s*x for x in a)


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def norm(a):
    return math.sqrt(sum(abs(x)**2 for x in a))


def unit(a):
    n = norm(a)
    if n < 1e-14:
        raise ValueError("Cannot normalize a zero vector")
    return scale(a, 1/n)


def matvec(matrix, v):
    return tuple(dot(row, v) for row in matrix)


def transpose(matrix):
    return tuple(zip(*matrix))


def matmul(a, b):
    return tuple(tuple(dot(row, col) for col in zip(*b)) for row in a)


def rz(angle):
    c, s = math.cos(angle), math.sin(angle)
    return ((c, -s, 0), (s, c, 0), (0, 0, 1))


def rotation(axis, angle):
    x, y, z = unit(axis)
    c, s, v = math.cos(angle), math.sin(angle), 1-math.cos(angle)
    return ((c+x*x*v, x*y*v-z*s, x*z*v+y*s),
            (y*x*v+z*s, c+y*y*v, y*z*v-x*s),
            (z*x*v-y*s, z*y*v+x*s, c+z*z*v))


def quaternion_from_matrix(m):
    """Scalar-first Hamilton quaternion, q [0,v_I] q* = [0,v_B]."""
    trace = sum(m[i][i] for i in range(3))
    if trace > 0:
        s = math.sqrt(trace+1)*2
        q = (s/4, (m[2][1]-m[1][2])/s, (m[0][2]-m[2][0])/s, (m[1][0]-m[0][1])/s)
    else:
        i = max(range(3), key=lambda k: m[k][k])
        j, k = (i+1)%3, (i+2)%3
        s = math.sqrt(1+m[i][i]-m[j][j]-m[k][k])*2
        a = [0.0]*4
        a[0] = (m[k][j]-m[j][k])/s
        a[i+1] = s/4
        a[j+1] = (m[j][i]+m[i][j])/s
        a[k+1] = (m[k][i]+m[i][k])/s
        q = tuple(a)
    q = unit(q)
    return scale(q, -1) if q[0] < 0 else q


def geodetic_ecef(latitude_deg, longitude_deg, height_m):
    lat, lon = math.radians(latitude_deg), math.radians(longitude_deg)
    e2 = WGS84_F*(2-WGS84_F)
    n = WGS84_A_M / math.sqrt(1-e2*math.sin(lat)**2)
    return ((n+height_m)*math.cos(lat)*math.cos(lon),
            (n+height_m)*math.cos(lat)*math.sin(lon),
            (n*(1-e2)+height_m)*math.sin(lat))


def enu_axes(latitude_deg, longitude_deg):
    lat, lon = math.radians(latitude_deg), math.radians(longitude_deg)
    return ((-math.sin(lon), math.cos(lon), 0),
            (-math.sin(lat)*math.cos(lon), -math.sin(lat)*math.sin(lon), math.cos(lat)),
            (math.cos(lat)*math.cos(lon), math.cos(lat)*math.sin(lon), math.sin(lat)))


def transverse(axis, k):
    return add(axis, scale(k, -dot(axis, k)))


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


def tracking_matrix(sc_to_station, north, east):
    """Body +Y points to station; +Z is projected station north (east fallback)."""
    y = unit(sc_to_station)
    z = transverse(north, y)
    if norm(z) < 1e-10:
        z = transverse(east, y)
    x = unit(cross(y, unit(z)))
    return (x, y, unit(cross(x, y)))


@dataclass(frozen=True)
class AntennaResponse:
    gain_linear: float
    polarization: tuple[complex, complex, complex] | None


def normalized_response(field, gain):
    n = norm(field)
    if n < 1e-12 or gain <= 1e-24:
        return AntennaResponse(0, None)
    return AntennaResponse(gain, tuple(complex(v/n) for v in field))


def half_wave_dipole(axis, look, efficiency=1.0):
    """Thin, resonant, sinusoidal-current half-wave dipole in free space."""
    axis, look = unit(axis), unit(look)
    c = max(-1, min(1, dot(axis, look)))
    s = math.sqrt(max(0, 1-c*c))
    if s < 1e-10:
        return AntennaResponse(0, None)
    amplitude = math.cos(math.pi*c/2)/s
    return normalized_response(transverse(axis, look), efficiency*HALF_WAVE_DIRECTIVITY*amplitude**2)


def short_dipole_turnstile(axis_a, axis_b, look, efficiency=1.0):
    """Equal total power in two orthogonal short dipoles at +90 deg phase.

    Each short-dipole directivity is 1.5 sin(theta)^2. Equal half-power weights
    give .75*(|P a|^2 + |P b|^2), integrated mean gain = efficiency, not two
    independently full-power antennas. No mutual coupling or installed metal.
    """
    a, b, k = unit(axis_a), unit(axis_b), unit(look)
    if abs(dot(a, b)) > 1e-8:
        raise ValueError("Turnstile axes must be orthogonal")
    pa, pb = transverse(a, k), transverse(b, k)
    field = tuple(complex(x, y) for x, y in zip(pa, pb))
    return normalized_response(field, efficiency*.75*(dot(pa, pa)+dot(pb, pb)))


def cosine_patch(boresight, polarization_axis, look, peak_gain_dbi):
    """Illustrative one-sided cosine-power lobe, linearly polarized.

    For peak gain >= 3.01 dBi choose n=Gpeak/2-1 so its sphere-average gain is
    unity. Lower peaks use a uniform forward hemisphere with an efficiency
    factor. Not an EM, installed, measured or frequency-resonance model.
    """
    c = dot(unit(boresight), unit(look))
    if c <= 0:
        return AntennaResponse(0, None)
    peak = 10**(peak_gain_dbi/10)
    exponent = max(0, peak/2-1)
    return normalized_response(transverse(unit(polarization_axis), unit(look)), peak*c**exponent)


def polarization_coupling(tx_field, receive_analyzer):
    """|analyzer^H E|^2 / (|analyzer|^2 |E|^2), null -> undefined."""
    if tx_field is None or receive_analyzer is None:
        return None
    denominator = norm(tx_field)**2 * norm(receive_analyzer)**2
    if denominator < 1e-24:
        return None
    return max(0, min(1, abs(sum(complex(a).conjugate()*e for a, e in zip(receive_analyzer, tx_field)))**2/denominator))


def fspl_db(distance_m, frequency_hz):
    if distance_m <= 0 or frequency_hz <= 0:
        raise ValueError("Positive SI range and frequency required")
    return 20*math.log10(4*math.pi*distance_m*frequency_hz/C_M_S)


def noise_density_dbw_hz(temperature_k):
    if temperature_k <= 0:
        raise ValueError("Positive antenna-referred system noise temperature required")
    return 10*math.log10(K_B_J_K*temperature_k)


def power_db(value):
    return 10*math.log10(value) if value > 1e-24 else None


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

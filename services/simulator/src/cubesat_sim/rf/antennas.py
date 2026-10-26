"""Free-space vector antenna surrogates with one total source-power budget."""
from dataclasses import dataclass
import math
from ..geometry.frames import rotation
from ..geometry.vectors import dot, norm, unit, transverse, matmul
HALF_WAVE_DIRECTIVITY = 1.640922376984585
HALF_WAVE_PEAK_DBI = 10*math.log10(HALF_WAVE_DIRECTIVITY)


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


def antenna_orientation_matrix(angles):
    """R_body_from_native = Rz(yaw) Ry(pitch) Rx(roll), active right-hand."""
    roll, pitch, yaw = map(math.radians, angles)
    return matmul(rotation((0, 0, 1), yaw), matmul(rotation((0, 1, 0), pitch), rotation((1, 0, 0), roll)))

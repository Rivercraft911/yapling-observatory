"""Prescribed-current, equal-arm bent dipole in free space.

This is a thin-filament approximation, not a solved current, installed pattern,
impedance or tape-width model. Phasors use exp(+j omega t). Each straight arm
starts at the same ideal balanced feed; their outward current signs are opposite.
The assumed end-zero envelope is sin(k*(length-s)); its common amplitude cancels
in the one-source-power normalization. Near quarter-wave arms are the reference.

Basis: Haus/Melcher, Electromagnetic Fields and Energy (1989), section 12.4,
equations 1-9 and 24-25. Extending that prescribed-current integral to a bend
does not solve the conductor boundary condition or mutual interaction.
https://web.mit.edu/6.013_book/www/chapter12/12.4.html
NASA CR-2398 (1974), section III, p.6, equations 14-15, independently illustrates
the opposite outward signs for a hypothetical sinusoidal V-current basis.
https://ntrs.nasa.gov/api/citations/19740019578/downloads/19740019578.pdf
"""
from __future__ import annotations

import cmath
from dataclasses import dataclass
from functools import cached_property, lru_cache
import math

from ..geometry.vectors import dot, norm, transverse
from .antennas import AntennaResponse
from .free_space import C_M_S

MODEL_VERSION = "bent-wire-prescribed-sinusoidal-0.1.0"
Vector = tuple[float, float, float]
ComplexVector = tuple[complex, complex, complex]
_DIAGONAL = math.sqrt(0.5)
UPWARD_45_ARMS = ((_DIAGONAL, 0.0, _DIAGONAL), (-_DIAGONAL, 0.0, _DIAGONAL))
OUTWARD_45_ARMS = ((_DIAGONAL, -_DIAGONAL, 0.0), (-_DIAGONAL, -_DIAGONAL, 0.0))


def _direction(vector) -> Vector:
    if len(vector) != 3 or not all(math.isfinite(v) for v in vector):
        raise ValueError("A direction requires three finite real components")
    magnitude = math.hypot(*vector)
    if not math.isfinite(magnitude) or magnitude < 1e-14:
        raise ValueError("A direction must have a finite nonzero norm")
    return tuple(v / magnitude for v in vector)


def _sinc(value: float) -> float:
    return math.sin(value) / value if abs(value) > 1e-8 else 1 - value * value / 6


@lru_cache(maxsize=8)
def _gauss_legendre(order: int):
    """Nodes/weights on [-1,1]; no numerical-library runtime dependency."""
    result = []
    for index in range(1, order + 1):
        root = math.cos(math.pi * (index - 0.25) / (order + 0.5))
        for _ in range(30):
            p0, p1 = 1.0, root
            for degree in range(2, order + 1):
                p0, p1 = p1, ((2 * degree - 1) * root * p1 - (degree - 1) * p0) / degree
            derivative = order * (root * p1 - p0) / (root * root - 1)
            change = p1 / derivative
            root -= change
            if abs(change) < 2e-15:
                break
        result.append((root, 2 / ((1 - root * root) * derivative * derivative)))
    return tuple(result)


def _arm_integral(kappa: float, cosine: float) -> complex:
    """Integral sin[kappa*(1-t)]/kappa exp(+j*kappa*cosine*t) dt, t=0..1.

    Division by kappa is a common amplitude choice, retaining a finite short-arm
    limit. The sinc form removes the apparent singularities at cosine=+/-1.
    """
    if kappa < 1e-3:
        return sum(weight * (1 - t) * _sinc(kappa * (1 - t)) * cmath.exp(1j * kappa * cosine * t)
                   for node, weight0 in _gauss_legendre(8)
                   for t, weight in (((node + 1) / 2, weight0 / 2),))

    def exponential_integral(phase):
        return cmath.exp(0.5j * phase) * _sinc(phase / 2)

    return (cmath.exp(1j * kappa) * exponential_integral(kappa * (cosine - 1))
            - cmath.exp(-1j * kappa) * exponential_integral(kappa * (cosine + 1))) / (2j * kappa)


def _raw_field(kappa: float, arm_a: Vector, arm_b: Vector, look: Vector) -> ComplexVector:
    a = _arm_integral(kappa, dot(look, arm_a))
    b = _arm_integral(kappa, dot(look, arm_b))
    # Opposite outward signs describe one continuous balanced dipole current.
    return transverse(tuple(ua * a - ub * b for ua, ub in zip(arm_a, arm_b)), look)


@lru_cache(maxsize=128)
def _power_integral(kappa: float, cosine_included: float, polar_order=32, azimuth_steps=64) -> float:
    # The integral is rotation invariant; cache electrical size and included angle
    # rather than pose or probe direction. Equal-arm canonical geometry is enough.
    x = math.sqrt(max(0.0, (1 - cosine_included) / 2))
    z = math.sqrt(max(0.0, (1 + cosine_included) / 2))
    arm_a, arm_b = (x, 0.0, z), (-x, 0.0, z)
    terms = []
    for u, weight in _gauss_legendre(polar_order):
        radius = math.sqrt(max(0.0, 1 - u * u))
        for j in range(azimuth_steps):
            phi = 2 * math.pi * (j + 0.5) / azimuth_steps
            look = (radius * math.cos(phi), radius * math.sin(phi), u)
            terms.append(weight * norm(_raw_field(kappa, arm_a, arm_b, look)) ** 2)
    return math.fsum(terms) * 2 * math.pi / azimuth_steps


@dataclass(frozen=True)
class BentWire:
    """One balanced source, two equal straight arms, explicitly assumed current.

    Directions point away from the common feed in the caller's Cartesian frame.
    Frequency is Hz, arm length is metres, efficiency is radiation/accepted power
    in [0,1]. No mismatch or feed loss is inferred. Numerical scope is at most
    half a wavelength per arm; that guard is not a physical accuracy guarantee.
    """

    frequency_hz: float
    arm_length_m: float
    arm_a: Vector
    arm_b: Vector
    efficiency: float = 1.0

    def __post_init__(self):
        if not all(math.isfinite(value) and value > 0 for value in (self.frequency_hz, self.arm_length_m)):
            raise ValueError("Frequency and arm length must be positive finite SI values")
        if not math.isfinite(self.efficiency) or not 0 <= self.efficiency <= 1:
            raise ValueError("Radiation efficiency must be finite and in [0,1]")
        if not math.isfinite(self.kappa) or not 0 < self.kappa <= math.pi * (1 + 1e-14):
            raise ValueError("Numerical scope is 0 < arm length <= wavelength/2")
        object.__setattr__(self, "arm_a", _direction(self.arm_a))
        object.__setattr__(self, "arm_b", _direction(self.arm_b))
        if dot(self.arm_a, self.arm_b) > 1 - 1e-12:
            raise ValueError("Coincident arms cancel and cannot be power normalized")

    @cached_property
    def kappa(self) -> float:
        return 2 * math.pi * (self.frequency_hz / C_M_S) * self.arm_length_m

    @cached_property
    def normalization_integral(self) -> float:
        """Integral |raw_field|^2 dOmega, dimensionless, one source budget."""
        cosine = max(-1.0, min(1.0, dot(self.arm_a, self.arm_b)))
        return _power_integral(self.kappa, cosine)

    def raw_field(self, look) -> ComplexVector:
        """Transverse radiation shape with arbitrary common amplitude, not V/m."""
        return _raw_field(self.kappa, self.arm_a, self.arm_b, _direction(look))

    def response(self, look) -> AntennaResponse:
        """Gain relative to accepted power and unit complex Cartesian polarization.

        Sphere-average gain equals efficiency. At a field null or zero efficiency
        gain is zero and polarization is undefined, never an arbitrary unit vector.
        """
        field = self.raw_field(look)
        squared = math.fsum(abs(v) ** 2 for v in field)
        integral = self.normalization_integral
        if self.efficiency == 0 or squared <= integral * 1e-28:
            return AntennaResponse(0.0, None)
        gain = self.efficiency * 4 * math.pi * squared / integral
        return AntennaResponse(gain, tuple(v / math.sqrt(squared) for v in field))

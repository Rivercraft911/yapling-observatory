"""Static axisymmetric central/J2 gravitational potential in inertial +Z axes.

Mechanical potential Phi is NEGATIVE; acceleration=-grad(Phi). No centrifugal
term, time-varying pole, tesseral harmonics, drag or other perturbation is added.
The default degree2 reference is dynamic tide-free EGM2008 C20 only, not the
full EGM2008 field. NGA.STND.0036_1.0.0_WGS84 (2014), Table5.1; associated
scaling parameters: Pavlis et al., EGM2008 development paper, appendix A.
"""

from dataclasses import dataclass
import math

from ..geometry.vectors import add, scale

WGS84_REFERENCE_RADIUS_M = 6378137.0
WGS84_MU_M3_S2 = 3.986004418e14
WGS84_NORMAL_J2 = 1.082629821313e-3
EGM2008_MU_M3_S2 = 3.986004415e14
EGM2008_REFERENCE_RADIUS_M = 6378136.3
EGM2008_C20_NORMALIZED = -0.484165143790815e-3
EGM2008_J2 = -math.sqrt(5) * EGM2008_C20_NORMALIZED
MODEL_VERSION = "static-central-j2-potential-0.1.0"


@dataclass(frozen=True)
class GravityPotential:
    mu_m3_s2: float
    reference_radius_m: float = EGM2008_REFERENCE_RADIUS_M
    j2: float = 0.0

    def __post_init__(self):
        if not all(
            math.isfinite(v) and v > 0 for v in (self.mu_m3_s2, self.reference_radius_m)
        ):
            raise ValueError(
                "Positive finite gravitational parameter and reference radius required"
            )
        if not math.isfinite(self.j2) or abs(self.j2) > 0.1:
            raise ValueError("J2 must be finite within the numerical scope |J2|<=0.1")

    def _radius(self, position_m):
        if len(position_m) != 3 or not all(math.isfinite(v) for v in position_m):
            raise ValueError("Position requires three finite SI components")
        radius = math.hypot(*position_m)
        if radius <= 0 or not math.isfinite(radius):
            raise ValueError("Positive finite geocentric radius required")
        if self.j2 != 0 and radius < self.reference_radius_m:
            raise ValueError(
                "The exterior J2 model requires radius >= reference radius"
            )
        return radius

    def specific_potential_j_kg(self, position_m):
        radius = self._radius(position_m)
        central = -self.mu_m3_s2 / radius
        if self.j2 == 0:
            return central
        z_fraction = position_m[2] / radius
        legendre2 = (3 * z_fraction * z_fraction - 1) / 2
        return (
            central
            + self.mu_m3_s2
            / radius
            * self.j2
            * (self.reference_radius_m / radius) ** 2
            * legendre2
        )

    def acceleration_m_s2(self, position_m):
        radius = self._radius(position_m)
        # Keep the frozen central arithmetic order for exact J2=0 regressions.
        central = scale(position_m, -self.mu_m3_s2 / radius / radius / radius)
        if self.j2 == 0:
            return central
        z_squared = (position_m[2] / radius) ** 2
        coefficient = (
            1.5
            * self.j2
            * self.mu_m3_s2
            / radius
            / radius
            / radius
            * (self.reference_radius_m / radius) ** 2
        )
        perturbation = tuple(
            coefficient * component * (5 * z_squared - (3 if i == 2 else 1))
            for i, component in enumerate(position_m)
        )
        return add(central, perturbation)

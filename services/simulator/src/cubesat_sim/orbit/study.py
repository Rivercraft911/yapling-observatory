"""JSON-safe standalone central/J2 study adapter; no pass replacement."""

from dataclasses import asdict, dataclass
import json
import math

from .two_body import CartesianState, TwoBodyConfig, integer_steps, propagate
from .elements import node_history
from .gravity import EGM2008_MU_M3_S2


@dataclass(frozen=True)
class OrbitStudyInput:
    initial: CartesianState
    config: TwoBodyConfig
    duration_s: float
    output_step_s: float

    def __post_init__(self):
        if not isinstance(self.initial, CartesianState) or not isinstance(
            self.config, TwoBodyConfig
        ):
            raise ValueError("Validated Cartesian state and two-body config required")
        count = integer_steps(self.duration_s, self.config.step_s, allow_zero=True)
        stride = integer_steps(self.output_step_s, self.config.step_s)
        if count % stride or count // stride > 100_000:
            raise ValueError(
                "Output interval must divide duration with at most100,000 samples"
            )


def run_orbit_study(request: OrbitStudyInput, cancelled=None):
    result = propagate(
        request.initial,
        request.config,
        request.duration_s,
        request.output_step_s,
        cancelled=cancelled,
    )
    return json.loads(
        json.dumps(
            dict(
                input=asdict(request),
                result=asdict(result),
                nodes=asdict(node_history(result.states, request.config.mu_m3_s2)),
                limits=[
                    "Selected central or static J2 gravity in a caller-declared inertial frame; fixed symmetry +Z; no drag, higher harmonics, Earth orientation or operational ephemeris.",
                    "Velocity Verlet is second-order symplectic for either static position-only potential, with bounded energy error in resolved regular motion, not exact energy or phase.",
                    "Energy uses the full selected potential. J2 conserves axial Hz but generally changes the total angular-momentum vector. Scaled axial drift divides by initial |h|, including polar cases.",
                    "Initial elements are osculating; first-order SSO inclination is a mean-element planning reference, not a guarantee of exact osculating SSO.",
                    "Fixed physics timestep; duration and output cadence are integer multiples. The numerical radius guard is not an Earth collision model.",
                ],
            ),
            allow_nan=False,
        )
    )


def default_orbit_study():
    """Editable circular reference; no spacecraft or operational orbit selected."""
    mu = EGM2008_MU_M3_S2
    radius = 6_928_137.0
    return OrbitStudyInput(
        CartesianState(0, (radius, 0, 0), (0, math.sqrt(mu / radius), 0)),
        TwoBodyConfig(mu, 5, "rk4"),
        6000,
        10,
    )

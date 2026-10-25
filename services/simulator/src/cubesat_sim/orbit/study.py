"""JSON-safe standalone central-gravity study adapter; no pass replacement."""

from dataclasses import asdict, dataclass
import json
import math

from .two_body import CartesianState, TwoBodyConfig, integer_steps, propagate


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
                limits=[
                    "Central point-mass conservative gravity in a caller-declared inertial frame; no J2, drag, Earth orientation or operational ephemeris.",
                    "Velocity Verlet is second-order symplectic for this separable model, with bounded energy error in resolved regular motion, not exact energy or exact phase.",
                    "Fixed physics timestep; duration and output cadence are integer multiples. The numerical radius guard is not an Earth collision model.",
                ],
            ),
            allow_nan=False,
        )
    )


def default_orbit_study():
    """Editable circular reference; no spacecraft or operational orbit selected."""
    mu = 3.986004418e14
    radius = 6_928_137.0
    return OrbitStudyInput(
        CartesianState(0, (radius, 0, 0), (0, math.sqrt(mu / radius), 0)),
        TwoBodyConfig(mu, 5, "rk4"),
        6000,
        10,
    )

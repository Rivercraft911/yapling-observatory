"""Fixed-step central/J2 propagation in a caller-declared inertial frame.

RK4 is fourth order. Velocity Verlet is second order, reversible and symplectic
for this conservative separable problem; it does not conserve energy exactly.
The fixed J2 symmetry axis is +Z. No drag, time-varying pole, Earth orientation,
collision surface or operational ephemeris.
"""

from dataclasses import dataclass
from functools import cached_property
import math
from typing import Literal

from ..geometry.vectors import add, cross, dot, norm, scale
from .gravity import GravityPotential, EGM2008_REFERENCE_RADIUS_M, EGM2008_J2

MODEL_VERSION = "cartesian-central-j2-0.2.0"
Vector = tuple[float, float, float]


def _vector(value):
    if len(value) != 3 or not all(math.isfinite(v) for v in value):
        raise ValueError("Expected three finite SI components")
    return tuple(float(v) for v in value)


@dataclass(frozen=True)
class CartesianState:
    time_s: float
    position_m: Vector
    velocity_m_s: Vector

    def __post_init__(self):
        if not math.isfinite(self.time_s):
            raise ValueError("Time must be finite")
        object.__setattr__(self, "position_m", _vector(self.position_m))
        object.__setattr__(self, "velocity_m_s", _vector(self.velocity_m_s))
        if not 0 < math.hypot(*self.position_m) < math.inf:
            raise ValueError("Position must have finite nonzero radius")


@dataclass(frozen=True)
class TwoBodyConfig:
    mu_m3_s2: float
    step_s: float
    method: Literal["rk4", "velocity_verlet"] = "rk4"
    minimum_radius_m: float = 1.0
    force_model: Literal["central", "j2"] = "central"
    reference_radius_m: float = EGM2008_REFERENCE_RADIUS_M
    j2: float = EGM2008_J2

    def __post_init__(self):
        if not all(
            math.isfinite(v) and v > 0
            for v in (self.mu_m3_s2, self.step_s, self.minimum_radius_m)
        ):
            raise ValueError(
                "Positive finite mu, step and numerical radius guard required"
            )
        if self.method not in ("rk4", "velocity_verlet"):
            raise ValueError("Implemented methods are rk4 and velocity_verlet")
        if self.force_model not in ("central", "j2"):
            raise ValueError("Implemented force models are central and j2")
        GravityPotential(self.mu_m3_s2, self.reference_radius_m, self.j2)

    @cached_property
    def gravity(self):
        return GravityPotential(
            self.mu_m3_s2,
            self.reference_radius_m,
            self.j2 if self.force_model == "j2" else 0.0,
        )


@dataclass(frozen=True)
class OrbitInvariants:
    specific_energy_j_kg: float
    specific_angular_momentum_m2_s: Vector
    eccentricity_vector: Vector


@dataclass(frozen=True)
class OrbitDiagnosticSample:
    time_s: float
    specific_energy_change_j_kg: float
    relative_energy_change: float | None
    angular_momentum_change_norm_m2_s: float
    relative_angular_momentum_change: float | None
    axial_angular_momentum_change_m2_s: float
    scaled_axial_angular_momentum_change: float | None


@dataclass(frozen=True)
class OrbitResult:
    states: tuple[CartesianState, ...]
    invariants: tuple[OrbitInvariants, ...]
    diagnostics: tuple[OrbitDiagnosticSample, ...]
    method: str
    physics_step_s: float
    output_step_s: float
    steps: int
    acceleration_evaluations: int
    maximum_absolute_energy_change_j_kg: float
    maximum_relative_energy_change: float | None
    maximum_relative_angular_momentum_change: float | None
    force_model: str = "central"
    maximum_scaled_axial_angular_momentum_change: float | None = None
    model_version: str = MODEL_VERSION


def _radius(position_m, config):
    radius = math.hypot(*position_m)
    if not math.isfinite(radius) or radius < config.minimum_radius_m:
        raise ValueError("State reached the configured numerical radius guard")
    return radius


def acceleration(position_m, config: TwoBodyConfig):
    _radius(position_m, config)
    return config.gravity.acceleration_m_s2(position_m)


def invariants(
    state: CartesianState, mu_m3_s2: float, gravity: GravityPotential | None = None
) -> OrbitInvariants:
    """Energy uses the supplied potential; h/e vectors are osculating diagnostics.

    Both vectors are constants under central gravity. Static J2 conserves only
    axial h_z, not the full h or central eccentricity vector.
    """
    if not math.isfinite(mu_m3_s2) or mu_m3_s2 <= 0:
        raise ValueError("Positive finite mu required")
    radius = math.hypot(*state.position_m)
    angular = cross(state.position_m, state.velocity_m_s)
    if gravity is not None and gravity.mu_m3_s2 != mu_m3_s2:
        raise ValueError("Invariant gravity and osculating mu must agree")
    potential = (
        gravity.specific_potential_j_kg(state.position_m)
        if gravity is not None
        else -mu_m3_s2 / radius
    )
    energy = dot(state.velocity_m_s, state.velocity_m_s) / 2 + potential
    eccentricity = add(
        scale(cross(state.velocity_m_s, angular), 1 / mu_m3_s2),
        scale(state.position_m, -1 / radius),
    )
    if not all(math.isfinite(v) for v in (energy, *angular, *eccentricity)):
        raise ValueError("Derived orbital quantities exceed finite numerical range")
    return OrbitInvariants(energy, angular, eccentricity)


def diagnostic_sample(time_s, current, reference):
    energy = current.specific_energy_j_kg - reference.specific_energy_j_kg
    angular = norm(
        add(
            current.specific_angular_momentum_m2_s,
            scale(reference.specific_angular_momentum_m2_s, -1),
        )
    )
    reference_norm = norm(reference.specific_angular_momentum_m2_s)
    axial = (
        current.specific_angular_momentum_m2_s[2]
        - reference.specific_angular_momentum_m2_s[2]
    )
    return OrbitDiagnosticSample(
        time_s,
        energy,
        (
            energy / abs(reference.specific_energy_j_kg)
            if reference.specific_energy_j_kg != 0
            else None
        ),
        angular,
        angular / reference_norm if reference_norm != 0 else None,
        axial,
        axial / reference_norm if reference_norm != 0 else None,
    )


def step(
    state: CartesianState, config: TwoBodyConfig, *, backward=False
) -> CartesianState:
    dt = -config.step_s if backward else config.step_s
    r, v = state.position_m, state.velocity_m_s
    if config.method == "velocity_verlet":
        half_velocity = add(v, scale(acceleration(r, config), dt / 2))
        position = add(r, scale(half_velocity, dt))
        velocity = add(half_velocity, scale(acceleration(position, config), dt / 2))
    else:
        y = (*r, *v)

        def rhs(value):
            return (*value[3:], *acceleration(value[:3], config))

        def increment(value, derivative, amount):
            return tuple(a + amount * b for a, b in zip(value, derivative))

        a = rhs(y)
        b = rhs(increment(y, a, dt / 2))
        c = rhs(increment(y, b, dt / 2))
        d = rhs(increment(y, c, dt))
        result = tuple(
            value + dt * (aa + 2 * bb + 2 * cc + dd) / 6
            for value, aa, bb, cc, dd in zip(y, a, b, c, d)
        )
        position, velocity = result[:3], result[3:]
    _radius(position, config)
    return CartesianState(state.time_s + dt, position, velocity)


def integer_steps(interval_s, step_s, *, allow_zero=False):
    if (
        not math.isfinite(interval_s)
        or interval_s < 0
        or (interval_s == 0 and not allow_zero)
    ):
        raise ValueError("Interval must be positive finite (or zero duration)")
    ratio = interval_s / step_s
    if not math.isfinite(ratio) or ratio > 2_000_000:
        raise ValueError("Study exceeds two million physics steps")
    count = round(ratio)
    if abs(ratio - count) > 1e-8:
        raise ValueError(
            "Duration and output intervals must be integer multiples of the fixed physics step"
        )
    if count == 0 and not allow_zero:
        raise ValueError("Output interval must be at least one physics step")
    return count


def propagate(
    initial: CartesianState,
    config: TwoBodyConfig,
    duration_s: float,
    output_step_s: float | None = None,
    *,
    cancelled=None,
) -> OrbitResult:
    output_step_s = config.step_s if output_step_s is None else output_step_s
    count = integer_steps(duration_s, config.step_s, allow_zero=True)
    stride = integer_steps(output_step_s, config.step_s)
    if count and count % stride:
        raise ValueError("Duration must be divisible by the output interval")
    if count // stride > 100_000:
        raise ValueError("Study output exceeds 100,000 samples")
    _radius(initial.position_m, config)
    reference = invariants(initial, config.mu_m3_s2, config.gravity)
    states, samples = [initial], [reference]
    diagnostics = [diagnostic_sample(initial.time_s, reference, reference)]
    energy_error = momentum_error = axial_error = 0.0
    state = initial
    for index in range(1, count + 1):
        if cancelled is not None and index % 32 == 1 and cancelled():
            raise InterruptedError("Orbit study cancelled")
        state = step(state, config)
        current = invariants(state, config.mu_m3_s2, config.gravity)
        axial_error = max(
            axial_error,
            abs(
                current.specific_angular_momentum_m2_s[2]
                - reference.specific_angular_momentum_m2_s[2]
            ),
        )
        energy_error = max(
            energy_error,
            abs(current.specific_energy_j_kg - reference.specific_energy_j_kg),
        )
        momentum_error = max(
            momentum_error,
            norm(
                add(
                    current.specific_angular_momentum_m2_s,
                    scale(reference.specific_angular_momentum_m2_s, -1),
                )
            ),
        )
        if index % stride == 0:
            # Integer ticks avoid cumulative timestamp roundoff changing clocks.
            state = CartesianState(
                initial.time_s + index * config.step_s,
                state.position_m,
                state.velocity_m_s,
            )
            states.append(state)
            samples.append(current)
            diagnostics.append(diagnostic_sample(state.time_s, current, reference))
    angular_norm = norm(reference.specific_angular_momentum_m2_s)
    return OrbitResult(
        tuple(states),
        tuple(samples),
        tuple(diagnostics),
        config.method,
        config.step_s,
        output_step_s,
        count,
        count * (4 if config.method == "rk4" else 2),
        energy_error,
        (
            energy_error / abs(reference.specific_energy_j_kg)
            if reference.specific_energy_j_kg != 0
            else None
        ),
        momentum_error / angular_norm if angular_norm != 0 else None,
        force_model=config.force_model,
        maximum_scaled_axial_angular_momentum_change=(
            axial_error / angular_norm if angular_norm != 0 else None
        ),
    )

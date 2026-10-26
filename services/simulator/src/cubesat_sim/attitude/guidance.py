"""Moving boresight kinematics in the declared inertial frame, all SI.

For u=rho/|rho|, zero twist about u gives omega=u cross udot.
Differentiate to obtain alpha=u cross uddot. This is a reduced-attitude
reference, not a full roll policy or a constrained slew trajectory.
"""

from dataclasses import dataclass

from ..geometry.vectors import add, cross, dot, scale
from .kinematics import finite_vector, unit_vector


@dataclass(frozen=True)
class DirectionMotion:
    direction_inertial: tuple[float, float, float]
    omega_inertial_rad_s: tuple[float, float, float]
    alpha_inertial_rad_s2: tuple[float, float, float]


def direction_motion(position, velocity, acceleration):
    """Zero-twist angular kinematics from a nonzero relative Cartesian state.

    rho cross v / rho^2 is unchanged by LOS reversal; both endpoints must
    nevertheless use the correct pointing direction. See NAIF dvhat_c,
    Particulars; Basilisk attTrackingError rev1.1, equations (11)-(15).
    """
    position, velocity, acceleration = map(
        finite_vector, (position, velocity, acceleration)
    )
    direction = unit_vector(position)
    squared = dot(position, position)
    omega = scale(cross(position, velocity), 1 / squared)
    alpha = add(
        scale(cross(position, acceleration), 1 / squared),
        scale(omega, -2 * dot(position, velocity) / squared),
    )
    return DirectionMotion(direction, omega, alpha)

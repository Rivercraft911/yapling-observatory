"""Osculating elliptic elements, true-anomaly initialization and node diagnostics.

Angles at this explicit interface are degrees; computations are SI/radians.
The inertial equatorial plane is XY and its fixed +Z is the J2 symmetry axis.
Mean elements are not silently converted to osculating elements.
"""

from dataclasses import dataclass
from datetime import datetime, timezone
import math

from ..geometry.frames import rotation, rz
from ..geometry.vectors import add, cross, dot, matmul, matvec, norm, scale


@dataclass(frozen=True)
class OrbitElements:
    semi_major_axis_m: float
    eccentricity: float
    inclination_deg: float
    raan_deg: float
    argument_of_periapsis_deg: float
    true_anomaly_deg: float
    epoch_utc: str

    def __post_init__(self):
        numbers = (
            self.semi_major_axis_m,
            self.eccentricity,
            self.inclination_deg,
            self.raan_deg,
            self.argument_of_periapsis_deg,
            self.true_anomaly_deg,
        )
        if (
            not all(math.isfinite(v) for v in numbers)
            or self.semi_major_axis_m <= 0
            or not 0 <= self.eccentricity < 1
            or not 0 <= self.inclination_deg <= 180
        ):
            raise ValueError(
                "Finite elliptic osculating elements require a>0, 0<=e<1, 0<=i<=180 deg"
            )
        try:
            epoch = datetime.fromisoformat(self.epoch_utc.replace("Z", "+00:00"))
        except (ValueError, AttributeError) as error:
            raise ValueError("Epoch must be an explicit ISO UTC timestamp") from error
        if epoch.tzinfo is None or epoch.utcoffset().total_seconds() != 0:
            raise ValueError("Epoch must explicitly identify UTC")
        object.__setattr__(
            self,
            "epoch_utc",
            epoch.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        )
        for name in ("raan_deg", "argument_of_periapsis_deg", "true_anomaly_deg"):
            object.__setattr__(self, name, getattr(self, name) % 360)


@dataclass(frozen=True)
class CartesianComponents:
    position_m: tuple[float, float, float]
    velocity_m_s: tuple[float, float, float]


def elements_to_cartesian(
    elements: OrbitElements, mu_m3_s2: float
) -> CartesianComponents:
    """Rz(Omega) Rx(i) Rz(omega) maps perifocal to inertial coordinates.

    For e=0, omega is an arbitrary phase reference and omega+nu is physical
    argument of latitude. At i=0/180, the node is undefined; input Omega/omega
    still define a reproducible perifocal reference. No singular values divide.
    """
    if not math.isfinite(mu_m3_s2) or mu_m3_s2 <= 0:
        raise ValueError("Positive finite mu required")
    e = elements.eccentricity
    p = elements.semi_major_axis_m * (1 - e * e)
    anomaly = math.radians(elements.true_anomaly_deg)
    c, s = math.cos(anomaly), math.sin(anomaly)
    radius = p / (1 + e * c)
    speed = math.sqrt(mu_m3_s2 / p)
    transform = matmul(
        rz(math.radians(elements.raan_deg)),
        matmul(
            rotation((1, 0, 0), math.radians(elements.inclination_deg)),
            rz(math.radians(elements.argument_of_periapsis_deg)),
        ),
    )
    return CartesianComponents(
        matvec(transform, (radius * c, radius * s, 0)),
        matvec(transform, (-speed * s, speed * (e + c), 0)),
    )


@dataclass(frozen=True)
class OsculatingElements:
    semi_major_axis_m: float | None
    eccentricity: float
    inclination_deg: float | None
    raan_deg: float | None
    argument_of_periapsis_deg: float | None
    true_anomaly_deg: float | None
    argument_of_latitude_deg: float | None
    true_longitude_deg: float | None


def osculating_elements(position_m, velocity_m_s, mu_m3_s2):
    radius = math.hypot(*position_m)
    if (
        len(position_m) != 3
        or len(velocity_m_s) != 3
        or not all(math.isfinite(v) for v in (*position_m, *velocity_m_s, mu_m3_s2))
        or radius <= 0
        or mu_m3_s2 <= 0
    ):
        raise ValueError("Finite Cartesian state and positive mu/radius required")
    h = cross(position_m, velocity_m_s)
    hn = norm(h)
    ev = add(
        scale(cross(velocity_m_s, h), 1 / mu_m3_s2), scale(position_m, -1 / radius)
    )
    e = norm(ev)
    energy = dot(velocity_m_s, velocity_m_s) / 2 - mu_m3_s2 / radius
    semimajor = -mu_m3_s2 / (2 * energy) if energy != 0 else None
    if hn < 1e-14:
        return OsculatingElements(semimajor, e, None, None, None, None, None, None)
    inclination = math.degrees(math.atan2(math.hypot(h[0], h[1]), h[2]))
    node = (-h[1], h[0], 0.0)
    nn = norm(node)
    raan = math.degrees(math.atan2(node[1], node[0])) % 360 if nn > hn * 1e-12 else None

    def signed_angle(a, b):
        return math.degrees(math.atan2(dot(cross(a, b), h) / hn, dot(a, b))) % 360

    argument = signed_angle(node, ev) if raan is not None and e > 1e-10 else None
    anomaly = signed_angle(ev, position_m) if e > 1e-10 else None
    latitude = signed_angle(node, position_m) if raan is not None else None
    longitude = (
        math.degrees(math.atan2(position_m[1], position_m[0])) % 360
        if raan is None
        else None
    )
    return OsculatingElements(
        semimajor, e, inclination, raan, argument, anomaly, latitude, longitude
    )


def first_order_raan_rate_rad_s(
    semi_major_axis_m, eccentricity, inclination_deg, gravity
):
    """First-order secular MEAN-element rate, not exact osculating SSO.

    NASA GSFC GDC Orbit Primer (Mesarch, 2018), slide4.
    """
    if (
        not all(
            math.isfinite(v) for v in (semi_major_axis_m, eccentricity, inclination_deg)
        )
        or semi_major_axis_m <= 0
        or not 0 <= eccentricity < 1
        or not 0 <= inclination_deg <= 180
    ):
        raise ValueError("Valid elliptic mean-element reference required")
    p = semi_major_axis_m * (1 - eccentricity * eccentricity)
    n = math.sqrt(gravity.mu_m3_s2 / semi_major_axis_m**3)
    return (
        -1.5
        * n
        * gravity.j2
        * (gravity.reference_radius_m / p) ** 2
        * math.cos(math.radians(inclination_deg))
    )


def first_order_sso_inclination_deg(
    semi_major_axis_m, eccentricity, desired_nodal_rate_deg_day, gravity
):
    if not math.isfinite(desired_nodal_rate_deg_day):
        raise ValueError("Finite desired solar nodal rate required")
    coefficient = first_order_raan_rate_rad_s(
        semi_major_axis_m, eccentricity, 0, gravity
    )
    target = math.radians(desired_nodal_rate_deg_day) / 86400
    if coefficient == 0:
        return None
    cosine = target / coefficient
    return math.degrees(math.acos(cosine)) if abs(cosine) <= 1 else None


def raan_from_ltan_deg(local_mean_solar_time_hours, mean_sun_ra_deg):
    """Mean LTAN at the same epoch as supplied mean-Sun RA; LTAN is not UTC."""
    if (
        not all(
            math.isfinite(v) for v in (local_mean_solar_time_hours, mean_sun_ra_deg)
        )
        or not 0 <= local_mean_solar_time_hours < 24
    ):
        raise ValueError("Finite mean-Sun RA and mean LTAN in [0,24) required")
    return (mean_sun_ra_deg + 15 * (local_mean_solar_time_hours - 12)) % 360


def ltan_from_raan_hours(raan_deg, mean_sun_ra_deg):
    if not all(math.isfinite(v) for v in (raan_deg, mean_sun_ra_deg)):
        raise ValueError("Finite RAAN and epoch mean-Sun RA required")
    return (12 + (raan_deg - mean_sun_ra_deg) / 15) % 24


@dataclass(frozen=True)
class NodeHistory:
    inclination_deg: tuple[float | None, ...]
    raan_unwrapped_deg: tuple[float | None, ...]
    raan_drift_deg: tuple[float | None, ...]
    fitted_raan_rate_deg_day: float | None
    defined_sample_count: int
    convention: str = (
        "Osculating node; least-squares drift includes short-period terms. Undefined for equatorial/radial states."
    )


def node_history(states, mu_m3_s2):
    elements = [
        osculating_elements(s.position_m, s.velocity_m_s, mu_m3_s2) for s in states
    ]
    unwrapped = []
    previous = None
    angle = None
    first = None
    valid = []
    for state, item in zip(states, elements):
        raw = item.raan_deg
        if raw is None:
            unwrapped.append(None)
            continue
        angle = raw if previous is None else angle + (raw - previous + 180) % 360 - 180
        previous = raw
        if first is None:
            first = angle
        unwrapped.append(angle)
        valid.append((state.time_s, angle))
    fitted = None
    if len(valid) >= 2:
        center_t = math.fsum(t for t, _ in valid) / len(valid)
        center_a = math.fsum(a for _, a in valid) / len(valid)
        denominator = math.fsum((t - center_t) ** 2 for t, _ in valid)
        if denominator > 0:
            fitted = (
                86400
                * math.fsum((t - center_t) * (a - center_a) for t, a in valid)
                / denominator
            )
    return NodeHistory(
        tuple(e.inclination_deg for e in elements),
        tuple(unwrapped),
        tuple(a - first if a is not None else None for a in unwrapped),
        fitted,
        len(valid),
    )

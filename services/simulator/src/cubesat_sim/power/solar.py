"""Flat-area PV projection, not string/IV or self-shadow ray tracing.

NASA SmallSat Power (2026),3.2.1: cosine incidence and no generation in eclipse.
"""

from dataclasses import dataclass
import math
from .models import PVPanel, unit_vector


@dataclass(frozen=True)
class PVGeneration:
    incident_solar_w: float
    absorbed_solar_w: float
    available_mpp_w: float
    terminal_w: float
    bus_w: float
    panel_heat_w: float
    regulator_heat_w: float
    curtailed_potential_w: float
    closure_residual_w: float


def pv_generation(
    panel: PVPanel,
    sun_direction_body,
    irradiance_w_m2=1361,
    sun_visibility=1,
    extraction_fraction=1,
    regulator_efficiency=1,
) -> PVGeneration:
    unit_vector(sun_direction_body)
    if (
        not math.isfinite(irradiance_w_m2)
        or irradiance_w_m2 < 0
        or any(
            not math.isfinite(v) or not 0 <= v <= 1
            for v in (sun_visibility, extraction_fraction, regulator_efficiency)
        )
    ):
        raise ValueError(
            "Finite nonnegative irradiance and fractions within[0,1] required"
        )
    cosine = max(0, sum(a * b for a, b in zip(panel.normal_body, sun_direction_body)))
    if cosine < 1e-14:
        cosine = 0
    incident = (
        irradiance_w_m2
        * panel.active_area_m2
        * cosine
        * sun_visibility
        * panel.self_visibility
    )
    absorbed = panel.solar_absorptivity * incident
    available = panel.efficiency * panel.electrical_derate * incident
    terminal = available * extraction_fraction * panel.enabled
    bus = terminal * regulator_efficiency
    heat, regulator = absorbed - terminal, terminal - bus
    return PVGeneration(
        incident,
        absorbed,
        available,
        terminal,
        bus,
        heat,
        regulator,
        available - terminal,
        absorbed - heat - regulator - bus,
    )


def cylindrical_sun_visibility(position_m, sun_direction, earth_radius_m=6378137):
    """Point-Sun spherical-Earth cylinder; no penumbra, ellipsoid or ephemeris."""
    unit_vector(sun_direction)
    if (
        len(position_m) != 3
        or any(not math.isfinite(v) for v in position_m)
        or not math.isfinite(earth_radius_m)
        or earth_radius_m <= 0
    ):
        raise ValueError("Finite Earth-centred position and positive radius required")
    radius = math.hypot(*position_m)
    if radius <= earth_radius_m:
        raise ValueError("Eclipse position must be outside the reference Earth")
    along = sum(a * b for a, b in zip(position_m, sun_direction))
    perpendicular = math.hypot(
        *(p - along * s for p, s in zip(position_m, sun_direction))
    )
    return 0.0 if along < 0 and perpendicular < earth_radius_m else 1.0

"""Validated antenna-lab inputs, shared by HTTP and headless studies."""
from __future__ import annotations
import math
from typing import Literal
from pydantic import Field, model_validator
from .models import FrozenModel
from .geometry.vectors import norm, add, scale


class RunProbe(FrozenModel):
    spacecraft_position_m: tuple[float, float, float]
    station_position_m: tuple[float, float, float]
    q_body_from_inertial_wxyz: tuple[float, float, float, float]

    @model_validator(mode="after")
    def valid_geometry(self):
        if max(abs(v) for v in (*self.spacecraft_position_m, *self.station_position_m)) > 1e12:
            raise ValueError("Run positions exceed the supported SI display domain")
        if any(abs(v) > 1.000001 for v in self.q_body_from_inertial_wxyz) or abs(norm(self.q_body_from_inertial_wxyz)-1) > 1e-6:
            raise ValueError("Run quaternion must have unit norm within 1e-6")
        if norm(add(self.station_position_m, scale(self.spacecraft_position_m, -1))) < 1e-6:
            raise ValueError("Station and spacecraft positions must be distinct")
        return self


class PatternRequest(FrozenModel):
    model: Literal["dipole", "turnstile", "patch", "v45"] = "dipole"
    efficiency: float = Field(default=1, ge=0, le=1)
    patch_peak_gain_dbi: float = Field(default=6, ge=10*math.log10(2), le=20)
    orientation_deg: tuple[float, float, float] = (0, 0, 0)
    probe_azimuth_deg: float = Field(default=90, ge=-180, le=180)
    probe_elevation_deg: float = Field(default=0, ge=-90, le=90)
    linear_feed_roll_deg: float = Field(default=0, ge=-180, le=180)
    cut_elevation_deg: float = Field(default=0, ge=-90, le=90)
    cut_azimuth_deg: float = Field(default=0, ge=-180, le=180)
    polar_steps: int = Field(default=48, ge=12, le=72)
    azimuth_steps: int = Field(default=96, ge=24, le=144)
    run_probe: RunProbe | None = None

    @model_validator(mode="after")
    def bounded_orientation(self):
        if any(abs(v) > 360 for v in self.orientation_deg):
            raise ValueError("Orientation angles must lie within ±360 degrees")
        return self

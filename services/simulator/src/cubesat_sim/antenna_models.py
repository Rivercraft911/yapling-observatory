"""Validated antenna-lab inputs, shared by HTTP and headless studies."""
from __future__ import annotations
from typing import Literal
from pydantic import Field, model_validator
from .models import FrozenModel, Link
from .geometry.vectors import norm, add, scale
from .rf.free_space import C_M_S
from .rf.mission_efficiency import AnalyticalEfficiencySemantics
from .rf.spherical_harmonic_models import SphericalHarmonicProfile


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
    model: Literal["dipole", "turnstile", "patch", "v45", "bent_v_up_45", "bent_v_out_45", "spherical_harmonic"] = "dipole"
    spherical_harmonic_profile: SphericalHarmonicProfile | None = None
    efficiency: float = Field(default=1, ge=0, le=1)
    frequency_hz: float = Field(default=438e6, ge=1e6, le=40e9)
    arm_length_m: float = Field(default=C_M_S/(4*438e6), ge=1e-4, le=10)
    patch_peak_gain_dbi: float = Field(default=6, ge=-10, le=30)
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
        if self.model == "spherical_harmonic":
            if self.spherical_harmonic_profile is None:
                raise ValueError("Spherical-harmonic pattern requires its coefficient profile")
            self.spherical_harmonic_profile.check_frequency(self.frequency_hz)
            if self.efficiency != 1:
                raise ValueError("Harmonic efficiency is defined only by profile.radiation_efficiency; request efficiency must be 1")
        elif self.spherical_harmonic_profile is not None:
            raise ValueError("A coefficient profile requires spherical_harmonic model selection")
        if any(abs(v) > 360 for v in self.orientation_deg):
            raise ValueError("Orientation angles must lie within ±360 degrees")
        if self.model in ("bent_v_up_45", "bent_v_out_45") and self.arm_length_m > C_M_S/(2*self.frequency_hz):
            raise ValueError("Bent-wire numerical scope requires arm length <= wavelength/2")
        return self


class LinkPatternReference(FrozenModel):
    link: Link
    antenna_variant: Literal["dipole", "turnstile", "v45"]
    direction: Literal["uplink", "downlink"] | None = None
    analytical_efficiency_semantics: AnalyticalEfficiencySemantics | None = None
    analytical_radiation_efficiency: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def complete_efficiency_context(self):
        if self.analytical_efficiency_semantics is not None and (
            self.direction is None or self.analytical_radiation_efficiency is None
        ):
            raise ValueError("A coupled run pattern requires archived direction and additional antenna efficiency")
        return self


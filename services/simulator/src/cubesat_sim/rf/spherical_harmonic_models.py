"""Strict, single-frequency transverse-field coefficient interchange."""
from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAXIMUM_DEGREE = 12


class HarmonicModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)


class HarmonicProvenance(HarmonicModel):
    status: Literal["analytical", "illustrative", "em_simulated", "measured"]
    source: str = Field(min_length=1, max_length=2000)
    conditions: str = Field(min_length=1, max_length=4000)


class HarmonicCoefficient(HarmonicModel):
    degree: int = Field(ge=1, le=MAXIMUM_DEGREE, strict=True)
    order: int = Field(ge=-MAXIMUM_DEGREE, le=MAXIMUM_DEGREE, strict=True)
    psi: tuple[float, float] = (0, 0)
    x: tuple[float, float] = (0, 0)

    @model_validator(mode="after")
    def bounded_mode(self):
        if abs(self.order) > self.degree:
            raise ValueError("Harmonic order must satisfy |m| <= degree")
        if any(abs(v) > 1e6 for v in (*self.psi, *self.x)):
            raise ValueError("Coefficient real/imaginary components must lie within ±1e6")
        return self


class SphericalHarmonicProfile(HarmonicModel):
    schema_version: Literal["vsh-1"] = "vsh-1"
    name: str = Field(min_length=1, max_length=160)
    revision: str = Field(min_length=1, max_length=160)
    provenance: HarmonicProvenance
    frequency_hz: float = Field(gt=1e6, le=40e9)
    maximum_degree: int = Field(ge=1, le=MAXIMUM_DEGREE, strict=True)
    radiation_efficiency: float = Field(ge=0, le=1)
    coefficients: tuple[HarmonicCoefficient, ...] = Field(
        min_length=1, max_length=MAXIMUM_DEGREE*(MAXIMUM_DEGREE+2))

    @model_validator(mode="after")
    def unique_nonzero_modes(self):
        keys = [(item.degree, item.order) for item in self.coefficients]
        if len(keys) != len(set(keys)):
            raise ValueError("Duplicate spherical-harmonic (degree, order) coefficients")
        if max(item.degree for item in self.coefficients) > self.maximum_degree:
            raise ValueError("Coefficient degree exceeds declared maximum_degree")
        power = sum(v*v for item in self.coefficients for v in (*item.psi, *item.x))
        if power < 1e-24:
            raise ValueError("A spherical-harmonic profile requires a nonzero field")
        return self

    def check_frequency(self, frequency_hz: float):
        if not math.isfinite(frequency_hz) or not math.isclose(
                frequency_hz, self.frequency_hz, rel_tol=1e-12, abs_tol=1e-6):
            raise ValueError("Carrier must match the profile frequency; interpolation/extrapolation is unavailable")

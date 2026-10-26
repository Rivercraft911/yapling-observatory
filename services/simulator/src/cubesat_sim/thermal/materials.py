"""Constant optical-property references; none identifies the installed finish."""

from typing import Literal

from pydantic import Field

from .models import ThermalModel


class ThermalMaterialProfile(ThermalModel):
    profile_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    status: Literal["unverified_assumption", "historical_reference"]
    solar_absorptivity: float = Field(ge=0, le=1)
    infrared_emissivity: float = Field(ge=0, le=1)
    emittance_basis: Literal["hemispherical"] = "hemispherical"
    reference_temperature_k: float | None = Field(default=None, gt=0)
    source: str = Field(min_length=1)
    source_locator: str = Field(min_length=1)
    conditions: str = Field(min_length=1)
    limitations: tuple[str, ...] = Field(min_length=1)


_PROFILES = (
    ThermalMaterialProfile(
        profile_id="generic_bus_current",
        label="Current generic bus assumption",
        status="unverified_assumption",
        solar_absorptivity=0.30,
        infrared_emissivity=0.75,
        source="Yapling Observatory provisional lumped thermal example",
        source_locator="cubesat_sim.power.study.default_study_config",
        conditions="Constant gray properties used by the current generic bus node.",
        limitations=(
            "These values are planning assumptions, not measurements or a specified finish.",
            "No temperature dependence, aging or contamination data are available.",
        ),
    ),
    ThermalMaterialProfile(
        profile_id="covered_cell_current",
        label="Current covered-cell assumption",
        status="unverified_assumption",
        solar_absorptivity=0.90,
        infrared_emissivity=0.85,
        source="Yapling Observatory provisional lumped thermal example",
        source_locator="cubesat_sim.power.study.default_study_config",
        conditions="Constant gray properties shared by the modeled cell-front and petal-back surfaces.",
        limitations=(
            "These values are unverified assumptions for the covered footprint.",
            "The petal PCB back and cell front have not been characterized separately.",
            "No temperature dependence, aging or contamination data are available.",
        ),
    ),
    ThermalMaterialProfile(
        profile_id="black_anodized_rca_1980039_reference",
        label="Black anodized aluminum, historical RCA reference",
        status="historical_reference",
        solar_absorptivity=0.65,
        infrared_emissivity=0.87,
        source="https://ntrs.nasa.gov/api/citations/19690012311/downloads/19690012311.pdf",
        source_locator="NASA CR-61267, 11 February 1969, printed p.39 (PDF p.43), RCA 1980039; reference 23 on printed p.248",
        conditions="The entry reports solar absorptance and hemispherical emittance. Measurement temperature, anodize thickness, preparation and exposure conditions are not stated in the entry.",
        limitations=(
            "Historical reference data for one named coating, not a generic value for all black anodizing or the installed bus.",
            "The cited original RCA report ASD-TDR-63-265 (October 1963) has not been checked here.",
            "Use as a constant-property comparison; no measured emissivity-versus-temperature curve is supplied.",
            "Actual coupon measurements and process-specific supplier data are needed to identify the spacecraft finish.",
        ),
    ),
)


def thermal_material_profiles() -> tuple[ThermalMaterialProfile, ...]:
    """Return immutable reference data without changing any mission defaults."""
    return _PROFILES

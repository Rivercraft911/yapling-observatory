import pytest
from pydantic import ValidationError

from cubesat_sim.power.study import default_study_config
from cubesat_sim.thermal.materials import (
    ThermalMaterialProfile,
    thermal_material_profiles,
)


def test_current_optics_are_explicit_assumptions_matching_existing_defaults():
    before = default_study_config().model_dump(mode="json")
    profiles = {p.profile_id: p for p in thermal_material_profiles()}
    nodes = {n["node_id"]: n for n in before["thermal"]["nodes"]}
    for profile_id, node_id in (
        ("generic_bus_current", "bus"),
        ("covered_cell_current", "panel"),
    ):
        p = profiles[profile_id]
        assert p.status == "unverified_assumption"
        assert p.solar_absorptivity == nodes[node_id]["solar_absorptivity"]
        assert p.infrared_emissivity == nodes[node_id]["infrared_emissivity"]
    assert default_study_config().model_dump(mode="json") == before


def test_black_anodized_reference_keeps_hemispherical_and_missing_conditions_explicit():
    profile = next(
        p for p in thermal_material_profiles() if p.status == "historical_reference"
    )
    assert profile.solar_absorptivity == 0.65
    assert profile.infrared_emissivity == 0.87
    assert profile.emittance_basis == "hemispherical"
    assert profile.reference_temperature_k is None
    assert "printed p.39" in profile.source_locator
    assert "not stated" in profile.conditions
    assert "original RCA report" in " ".join(profile.limitations)
    assert (
        ThermalMaterialProfile.model_validate(profile.model_dump(mode="json"))
        == profile
    )


@pytest.mark.parametrize(
    "change",
    [
        {"solar_absorptivity": -0.01},
        {"infrared_emissivity": 1.01},
        {"infrared_emissivity": float("nan")},
        {"reference_temperature_k": 0},
        {"emittance_basis": "normal"},
    ],
)
def test_material_optics_validate_physical_bounds_and_model_basis(change):
    value = thermal_material_profiles()[0].model_dump(mode="json") | change
    with pytest.raises(ValidationError):
        ThermalMaterialProfile.model_validate(value)

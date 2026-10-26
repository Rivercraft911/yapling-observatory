"""Source units, assumed envelopes and honest power budgets for wheel examples."""

from dataclasses import asdict, replace
import json
import math

import pytest

from cubesat_sim.attitude.actuators import wheel_output
from cubesat_sim.attitude.study import default_attitude_study
from cubesat_sim.attitude.wheel_profiles import (
    CW0017,
    RW1_TYPE_A,
    WheelElectricalAssumptions,
    mission_wheel_example,
    wheel_example_metadata,
    wheel_profiles,
    wheel_reference,
    wheel_spec_from_reference,
)


def test_rw1_published_inertia_units_and_rounded_nominal_momentum():
    reference = wheel_reference(RW1_TYPE_A.profile_id)
    assert reference.spin_inertia_kg_m2 == 694.5e-9
    assert reference.reference_torque_nm == 23e-6
    assert reference.nominal_speed_rpm == 8000
    assert reference.published_max_speed_rpm == 16380
    assert reference.rated_momentum_nms == 0.00058
    predicted = 694.5e-9 * 8000 * 2 * math.pi / 60
    assert reference.derived_nominal_momentum_nms == pytest.approx(predicted)
    assert predicted != reference.rated_momentum_nms
    assert 0.003 < predicted / reference.rated_momentum_nms - 1 < 0.004
    assert reference.wheel_mass_kg == 0.024
    assert reference.dimensions_m == (0.021, 0.021, 0.012)
    assert reference.motor_supply_range_v == (5.0, 5.0)
    assert reference.inertia_status == "manufacturer_published_rotating_inertia"


def test_cw0017_uses_rated_speed_for_inertia_not_maximum_speed():
    assert CW0017.reference_torque_nm == 0.23e-3
    assert CW0017.rated_momentum_nms == 1.77e-3
    assert CW0017.spin_inertia_kg_m2 == pytest.approx(
        1.77e-3 / (8000 * 2 * math.pi / 60)
    )
    assert CW0017.derived_nominal_momentum_nms == pytest.approx(1.77e-3)
    assert CW0017.nominal_speed_rpm != CW0017.published_max_speed_rpm
    assert CW0017.nominal_running_power_w == 0.3
    assert CW0017.peak_running_power_w == 0.85
    assert "derived" in CW0017.inertia_status
    assert any("3U" in limit for limit in CW0017.limits)


@pytest.mark.parametrize(
    "count,floor,cap", [(1, 0.63, 0.73), (2, 0.45, 0.55), (3, 0.4, 0.5)]
)
def test_power_budget_keeps_entire_shared_controller(count, floor, cap):
    example = mission_wheel_example((1, 0, 0), powered_axis_count=count)
    assert example.idle_power_w == floor
    assert example.max_bus_power_w == cap
    assert count * floor >= count * 0.275 + 0.350
    assert count * cap >= count * 0.375 + 0.350
    assert count * floor < count * 0.275 + 0.350 + count * 0.01
    metadata = wheel_example_metadata(powered_axis_count=count)
    assert metadata["powered_axis_count"] == count
    assert metadata["model_parameters"]["idle_power_w"] == floor
    assert metadata["power_allowance"]["shared_wde_allowance_w"] == 0.35
    assert metadata["unknowns"]
    assert any("not measured idle" in item for item in metadata["assumptions"])
    assert any("do not add" in item for item in metadata["assumptions"])


@pytest.mark.parametrize("count", [0, 4, -1, 1.0, True, math.nan])
def test_power_budget_rejects_invalid_axis_count(count):
    with pytest.raises(ValueError, match="one to three"):
        mission_wheel_example((1, 0, 0), powered_axis_count=count)


def test_example_uses_nominal_operational_cap_and_explicit_electrical_assumptions():
    example = mission_wheel_example((3, 0, 0))
    assert example.axis_body == (1, 0, 0)
    assert example.max_speed_rpm == 8000
    assert example.max_speed_rpm < RW1_TYPE_A.published_max_speed_rpm
    assert example.constant_torque_until_rpm == 0
    assert example.relative_momentum_capacity_nms == pytest.approx(
        RW1_TYPE_A.derived_nominal_momentum_nms
    )
    assert example.motor_torque_constant_nm_a == 0.005
    assert example.winding_resistance_ohm == 8
    assert example.non_ohmic_drive_efficiency == 0.8
    assert example.regenerative_efficiency == 0
    assert example.viscous_friction_nm_s == 0
    metadata = wheel_example_metadata()
    assert metadata["status"] == "editable_preliminary_planning_example"
    assert any("not identified RW1" in item for item in metadata["assumptions"])
    assert any("not a measured curve" in item for item in metadata["assumptions"])


@pytest.mark.parametrize("sign", [-1, 1])
def test_assumed_linear_envelope_and_no_regeneration_preserve_energy(sign):
    example = mission_wheel_example((1, 0, 0))
    for speed_fraction, torque_fraction in [(0, 1), (0.5, 0.5), (1, 0)]:
        momentum = sign * speed_fraction * example.relative_momentum_capacity_nms
        output = wheel_output(example, momentum, (0, 0, 0), sign * 1.0)
        assert output.motor_torque_nm == pytest.approx(sign * 23e-6 * torque_fraction)
        assert output.bus_power_w <= example.max_bus_power_w
        assert output.bus_power_w >= example.idle_power_w
        assert output.dissipated_heat_w >= 0
        assert output.bus_power_w == pytest.approx(
            output.shaft_power_w + output.dissipated_heat_w
        )
    braking = wheel_output(
        example, sign * example.relative_momentum_capacity_nms, (0, 0, 0), -sign
    )
    assert braking.motor_torque_nm == pytest.approx(-sign * 23e-6)
    assert braking.shaft_power_w < 0
    assert braking.bus_power_w > 0
    assert braking.dissipated_heat_w > braking.bus_power_w
    assert braking.bus_power_w == pytest.approx(
        braking.shaft_power_w + braking.dissipated_heat_w
    )


def test_reference_builder_requires_electrical_and_envelope_choices():
    with pytest.raises(TypeError):
        wheel_spec_from_reference(RW1_TYPE_A.profile_id, (1, 0, 0))
    assumed = WheelElectricalAssumptions(0.01, 3, 0.9, 0.2, 0.6)
    result = wheel_spec_from_reference(
        RW1_TYPE_A.profile_id,
        (0, 1, 0),
        operational_speed_rpm=7000,
        constant_torque_until_rpm=2000,
        electrical=assumed,
    )
    assert result.max_speed_rpm == 7000
    assert result.constant_torque_until_rpm == 2000
    assert result.motor_torque_constant_nm_a == 0.01
    assert result.winding_resistance_ohm == 3
    with pytest.raises(ValueError, match="published wheel maximum"):
        wheel_spec_from_reference(
            RW1_TYPE_A.profile_id,
            (1, 0, 0),
            operational_speed_rpm=20000,
            constant_torque_until_rpm=0,
            electrical=assumed,
        )
    with pytest.raises(ValueError, match="efficiency"):
        wheel_spec_from_reference(
            RW1_TYPE_A.profile_id,
            (1, 0, 0),
            operational_speed_rpm=8000,
            constant_torque_until_rpm=0,
            electrical=replace(assumed, non_ohmic_drive_efficiency=1.1),
        )


@pytest.mark.parametrize(
    "changes",
    [
        {"spin_inertia_kg_m2": math.nan},
        {"reference_torque_nm": -1},
        {"nominal_speed_rpm": 20000},
        {"motor_supply_range_v": (6, 5)},
        {"rated_momentum_nms": 1.0},
        {"sources": ()},
    ],
)
def test_reference_validation_rejects_physical_or_evidence_errors(changes):
    with pytest.raises(ValueError):
        replace(RW1_TYPE_A, **changes)


def test_catalogue_is_independent_serializable_and_does_not_modify_standalone():
    first = wheel_profiles()
    assert len(first) == 2
    assert "motor_torque_constant_nm_a" not in first[0]
    json.dumps(first, allow_nan=False)
    json.dumps(wheel_example_metadata(), allow_nan=False)
    first[0]["spin_inertia_kg_m2"] = 1.0
    assert wheel_profiles()[0]["spin_inertia_kg_m2"] == 694.5e-9
    with pytest.raises(ValueError, match="Unknown wheel"):
        wheel_reference("unknown-hardware")
    legacy = default_attitude_study().body.wheels[0]
    assert legacy.spin_inertia_kg_m2 == 5e-7
    assert legacy.max_speed_rpm == 6000
    assert legacy.idle_power_w == 0.01
    assert legacy.max_bus_power_w == 0.05

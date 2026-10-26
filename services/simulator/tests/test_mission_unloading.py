"""Coupled magnetic unloading: authority, compensation and conserved ledgers."""
from dataclasses import replace
import math

from pydantic import ValidationError
import pytest

from cubesat_sim.attitude.actuators import MagnetorquerSpec
from cubesat_sim.attitude.control import allocate_wheel_pd_control, wheel_momentum_body
from cubesat_sim.attitude.dynamics import (
    AttitudeForcing, AttitudeState, RigidBody, derivative, mechanical_invariants,
    state_from_relative_wheel_speeds,
)
from cubesat_sim.attitude.kinematics import conjugate, rotate
from cubesat_sim.attitude.study import default_attitude_study
from cubesat_sim.geometry.vectors import add, dot, norm, scale
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission_models import MissionScenario, MissionWheel


NEW_GNC_FIELDS = {
    "wheel_momentum_body_nms", "wheel_momentum_norm_nms",
    "unloading_requested_torque_body_nm", "unloading_allocated_torque_body_nm",
    "unloading_achieved_torque_body_nm", "unloading_command_time_s", "unloading_status",
}


def mission(duration=60, enabled=True):
    data = default_mission_scenario().model_dump(mode="json")
    data["duration_s"] = duration
    data["magnetic_model"] = None
    data["spacecraft"]["magnetic_unloading_enabled"] = enabled
    data["conops"]["auto_ground_tracking"] = False
    for wheel, rpm in zip(data["spacecraft"]["wheels"], (3000, -2000, 1000)):
        wheel["initial_speed_rpm"] = rpm
    return data


def static_field_mission(monkeypatch, duration=60):
    import cubesat_sim.mission.driver as driver
    monkeypatch.setattr(driver, "magnetic_field_ecef_t", lambda *_: (0, 0, 40e-6))
    monkeypatch.setattr(driver, "ecef_to_inertial", lambda field, *_: field)
    data = mission(duration)
    data["spacecraft"].update(
        initial_q_body_from_inertial_wxyz=(1, 0, 0, 0),
        proportional_nm_per_rad=(0, 0, 0), derivative_nm_s_per_rad=(0, 0, 0),
        magnetic_unloading_time_constant_s=100,
    )
    data["clocks"].update(dynamics_step_s=1, controller_period_s=1,
                           thermal_step_s=1, output_step_s=1)
    return data


def test_unloading_sign_projection_and_actual_magnetic_compensation():
    body = default_attitude_study().body
    state = state_from_relative_wheel_speeds(body, wheel_relative_speed_rad_s=(300, -200, 100))
    field = (0, 0, 40e-6)
    requested = (2e-6, -3e-6, 1e-6)
    allocation = allocate_wheel_pd_control(body, state, requested, field, 100)
    moment = wheel_momentum_body(body, state)
    assert allocation.unloading.torque_body_nm == pytest.approx((-moment[0]/100, -moment[1]/100, 0), abs=1e-20)
    assert dot(moment, allocation.unloading.torque_body_nm) < 0
    assert dot(field, allocation.unloading.torque_body_nm) == 0
    forcing = AttitudeForcing(allocation.wheel_motor_torques_nm,
                              allocation.unloading.dipole_body_am2, field)
    actual = derivative(body, state, forcing)
    rotor_torque = tuple(sum(w.axis_body[i]*h for w, h in zip(body.wheels,
        actual.wheel_absolute_axial_momentum_rate_nm)) for i in range(3))
    assert add(actual.magnetic_torque_body_nm, scale(rotor_torque, -1)) == pytest.approx(requested, abs=1e-20)
    assert actual.wheel_absolute_axial_momentum_rate_nm == pytest.approx(
        tuple(m-r for m, r in zip(allocation.unloading.torque_body_nm, requested)), abs=1e-20)


def test_dipole_saturation_uses_achieved_torque_instead_of_unachievable_request():
    body = default_attitude_study().body
    state = state_from_relative_wheel_speeds(body, wheel_relative_speed_rad_s=(300, 200, 100))
    allocation = allocate_wheel_pd_control(body, state, (0, 0, 0), (0, 0, 40e-6), 1)
    assert allocation.unloading.dipole_saturated
    assert norm(allocation.unloading.dipole_body_am2) == pytest.approx(.2)
    assert norm(allocation.unloading.torque_body_nm) == pytest.approx(8e-6)
    assert allocation.wheel_motor_torques_nm == pytest.approx(allocation.unloading.torque_body_nm, abs=1e-20)
    assert allocation.wheel_motor_torques_nm != pytest.approx(allocation.unloading.requested_torque_body_nm)


def test_absolute_axial_target_and_redundant_nullspace_are_explicit():
    template = default_attitude_study().body.wheels[0]
    body = RigidBody(((.002, 0, 0), (0, .002, 0), (0, 0, .002)),
                     (template, template), MagnetorquerSpec(.2))
    state = state_from_relative_wheel_speeds(body, omega_body_rad_s=(.2, 0, 0),
                                           wheel_relative_speed_rad_s=(300, -300))
    # Relative shaft momenta cancel; stored absolute axial momenta include body rate.
    assert wheel_momentum_body(body, state) == pytest.approx((2*template.spin_inertia_kg_m2*.2, 0, 0))
    at_rest = state_from_relative_wheel_speeds(body, wheel_relative_speed_rad_s=(300, -300))
    allocation = allocate_wheel_pd_control(body, at_rest, (0, 0, 0), (0, 0, 40e-6), 100)
    assert allocation.unloading.torque_body_nm == (0, 0, 0)
    assert at_rest.wheel_absolute_axial_momentum_nms[0] > 0
    assert at_rest.wheel_absolute_axial_momentum_nms[1] < 0


def test_field_aligned_momentum_has_no_instantaneous_unloading_authority(monkeypatch):
    data = static_field_mission(monkeypatch)
    for wheel, rpm in zip(data["spacecraft"]["wheels"], (0, 0, 3000)):
        wheel["initial_speed_rpm"] = rpm
    result = run_mission(MissionScenario.model_validate(data))
    assert all(norm(v) == 0 for v in result["samples"]["gnc"]["unloading_achieved_torque_body_nm"])
    assert result["samples"]["gnc"]["wheel_absolute_axial_momentum_nms"][-1] == result["samples"]["gnc"]["wheel_absolute_axial_momentum_nms"][0]
    assert result["summary"]["energy_j"]["magnetorquer_bus_j"] == 0
    assert all(status == "active" for status in result["samples"]["gnc"]["unloading_status"])


def test_external_angular_momentum_impulse_and_first_law_close(monkeypatch):
    data = static_field_mission(monkeypatch)
    config = MissionScenario.model_validate(data)
    result = run_mission(config)
    samples = result["samples"]
    gnc = samples["gnc"]
    body = config.spacecraft.rigid_body()
    momenta = []
    for time, q, omega, h in zip(samples["time_s"], samples["q_body_from_inertial_wxyz"],
            gnc["omega_body_rad_s"], gnc["wheel_absolute_axial_momentum_nms"]):
        momenta.append(mechanical_invariants(body, AttitudeState(time, q, omega, h)).angular_momentum_inertial_nms)
    # At zero body rate and constant inertial B, held coil and wheel torques
    # cancel exactly on the platform. End-of-interval samples carry that interval's command.
    impulse = (0, 0, 0)
    for q, torque in zip(samples["q_body_from_inertial_wxyz"][1:], gnc["unloading_achieved_torque_body_nm"][1:]):
        impulse = add(impulse, rotate(conjugate(q), torque))
    assert add(momenta[-1], scale(momenta[0], -1)) == pytest.approx(impulse, abs=2e-18)
    assert max(norm(v) for v in gnc["omega_body_rad_s"]) < 1e-16
    assert gnc["wheel_momentum_norm_nms"][-1] < gnc["wheel_momentum_norm_nms"][0]
    energy = result["summary"]["energy_j"]
    assert energy["magnetorquer_bus_j"] > 0
    assert energy["wheel_heat_j"] > energy["wheel_bus_j"]  # Braking energy becomes heat with regeneration disabled.
    assert energy["rotational_storage_delta_j"] < 0
    assert abs(energy["closure_residual_j"]) < 1e-6
    assert abs(energy["mechanical_residual_j"]) < 1e-12
    assert max(gnc["unloading_command_time_s"]) == data["duration_s"]-1


@pytest.mark.parametrize("hardware", ["disabled_mtq", "zero_mtq", "no_mtq", "disabled_wheels"])
def test_missing_or_zero_hardware_preserves_intent_without_unloading_authority(hardware):
    data = mission(30)
    if hardware == "disabled_mtq":
        data["spacecraft"]["magnetorquer"]["enabled"] = False
    elif hardware == "zero_mtq":
        data["spacecraft"]["magnetorquer"]["spec"]["max_dipole_am2"] = 0
    elif hardware == "no_mtq":
        data["spacecraft"]["magnetorquer"] = None
    else:
        for wheel in data["spacecraft"]["wheels"]:
            wheel["enabled"] = False
    result = run_mission(MissionScenario.model_validate(data))
    assert result["manifest"]["scenario"]["spacecraft"]["magnetic_unloading_enabled"]
    assert set(result["samples"]["gnc"]["unloading_status"]) == {"hardware_unavailable"}
    assert all(norm(v) == 0 for v in result["samples"]["gnc"]["unloading_achieved_torque_body_nm"])
    if hardware != "disabled_wheels":
        assert result["summary"]["energy_j"]["magnetorquer_bus_j"] == 0


def test_zero_field_and_inactive_controllers_have_unambiguous_telemetry(monkeypatch):
    import cubesat_sim.mission.driver as driver
    monkeypatch.setattr(driver, "magnetic_field_ecef_t", lambda *_: (0, 0, 0))
    data = mission(30)
    result = run_mission(MissionScenario.model_validate(data))
    assert set(result["samples"]["gnc"]["unloading_status"]) == {"field_unavailable"}
    assert result["summary"]["energy_j"]["magnetorquer_bus_j"] == 0
    data["spacecraft"]["controller"] = "coast"
    result = run_mission(MissionScenario.model_validate(data))
    assert set(result["samples"]["gnc"]["unloading_status"]) == {"controller_inactive"}
    assert all(v is None for v in result["samples"]["gnc"]["unloading_command_time_s"])
    monkeypatch.setattr(driver, "magnetic_field_ecef_t", lambda *_: (0, 0, 40e-6))
    data["conops"]["default_mode"] = "detumble"
    data["spacecraft"]["initial_omega_body_rad_s"] = (.01, .02, -.01)
    result = run_mission(MissionScenario.model_validate(data))
    assert result["summary"]["energy_j"]["magnetorquer_bus_j"] > 0
    assert all(norm(v) == 0 for v in result["samples"]["gnc"]["unloading_achieved_torque_body_nm"])


def test_optional_default_off_and_time_constant_do_not_change_existing_physics():
    data = mission(60, enabled=False)
    a = run_mission(MissionScenario.model_validate(data))
    data["spacecraft"]["magnetic_unloading_time_constant_s"] = 17
    b = run_mission(MissionScenario.model_validate(data))
    assert a["samples"] == b["samples"]
    assert a["summary"] == b["summary"]
    assert a["events"] == b["events"]
    assert set(a["samples"]["gnc"]["unloading_status"]) == {"disabled"}
    assert not default_mission_scenario().spacecraft.magnetic_unloading_enabled


def test_initial_rpm_and_time_constant_validate_before_run():
    data = mission(30)
    wheel = data["spacecraft"]["wheels"][0]
    for speed in (wheel["spec"]["max_speed_rpm"]+1, float("nan"), float("inf")):
        with pytest.raises(ValidationError):
            MissionWheel.model_validate(wheel | dict(initial_speed_rpm=speed))
    for value in (0, -1, float("nan"), float("inf"), 1e8):
        data["spacecraft"]["magnetic_unloading_time_constant_s"] = value
        with pytest.raises(ValidationError):
            MissionScenario.model_validate(data)


def test_compensated_commands_retain_actual_wheel_torque_speed_and_power_limits():
    body = default_attitude_study().body
    state = state_from_relative_wheel_speeds(body,
        wheel_relative_speed_rad_s=tuple(w.max_relative_speed_rad_s for w in body.wheels))
    field = (0, 0, 40e-6)
    requested = (-1e-3, -1e-3, -1e-3)
    allocation = allocate_wheel_pd_control(body, state, requested, field, 1)
    actual = derivative(body, state, AttitudeForcing(allocation.wheel_motor_torques_nm,
        allocation.unloading.dipole_body_am2, field))
    assert norm(actual.magnetic_dipole_body_am2) <= body.magnetorquer.max_dipole_am2*(1+1e-14)
    for wheel, report in zip(body.wheels, actual.wheels):
        assert abs(report.motor_torque_nm) <= wheel.max_motor_torque_nm
        assert report.motor_torque_nm == 0  # Outward drive is inhibited at the speed limit.
        assert report.at_speed_limit and report.torque_saturated
        assert report.bus_power_w <= wheel.max_bus_power_w
    rotor_torque = tuple(sum(w.axis_body[i]*h for w, h in zip(body.wheels,
        actual.wheel_absolute_axial_momentum_rate_nm)) for i in range(3))
    achieved = add(actual.magnetic_torque_body_nm, scale(rotor_torque, -1))
    assert norm(add(requested, scale(achieved, -1))) > 1e-3


def test_initial_rpm_maps_only_enabled_wheels_and_short_time_constant_is_recorded():
    data = mission(30)
    data["spacecraft"]["wheels"][1]["enabled"] = False
    data["spacecraft"]["magnetic_unloading_time_constant_s"] = 1
    result = run_mission(MissionScenario.model_validate(data))
    assert result["samples"]["gnc"]["wheel_relative_speed_rad_s"][0] == pytest.approx(
        tuple(rpm*2*math.pi/60 for rpm in (3000, 1000)))
    assert result["manifest"]["magnetic_unloading"]["ideal_static_field_rest_update_multiplier"] == -1
    assert any("T=Tc/2 has no decay" in warning for warning in result["manifest"]["warnings"])

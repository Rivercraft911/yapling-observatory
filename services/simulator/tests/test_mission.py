"""Coupled state, frame, energy and numerical-boundary regressions."""

from copy import deepcopy
import json
import math
import pytest
from pydantic import ValidationError
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.mission.defaults import default_mission_scenario, orbit_metadata
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission.ephemeris import (
    ecef_to_inertial,
    inertial_to_ecef,
    mean_sun_ra_deg,
    gmst_rad,
    sun_direction_inertial,
)
from cubesat_sim.mission.environment import (
    magnetic_field_ecef_t,
    earth_disk_irradiance,
    sun_visibility,
)
from cubesat_sim.attitude.kinematics import boresight_reference, rotate
from cubesat_sim.attitude.study import default_attitude_study
from cubesat_sim.geometry.vectors import norm


def config(duration=120):
    value = default_mission_scenario().model_dump(mode="json")
    value["duration_s"] = duration
    value["power"]["battery"].pop("electrical", None)
    return value


def validate(value):
    return MissionScenario.model_validate(value)


def test_one_day_default_geometry_reference_and_json_identity():
    c = default_mission_scenario()
    assert c.duration_s == 86400 and c.run_kind == "long_mission"
    assert c.orbit.ltan_hours_at_epoch == pytest.approx(18)
    assert sum(p.active_area_m2 for p in c.power.panels) == pytest.approx(
        0.05431947017597065
    )
    assert c.power.thermal.nodes[0].radiating_area_m2 == pytest.approx(
        0.07846145759020529
    )
    assert validate(json.loads(c.model_dump_json())).identity() == c.identity()
    assert c.power.battery.cells.cell_model == "NCR18650GA"
    assert c.power.battery.electrical is not None
    assert c.power.battery.electrical.initial_soc == 0.5


def test_epoch_frame_roundtrip_and_mean_solar_node():
    epoch = "2026-10-25T12:00:00Z"
    v = (123.0, -456.0, 789.0)
    assert inertial_to_ecef(
        ecef_to_inertial(v, epoch, 137), epoch, 137
    ) == pytest.approx(v, abs=1e-12)
    assert mean_sun_ra_deg(epoch) == pytest.approx(math.degrees(gmst_rad(epoch)))
    c = default_mission_scenario()
    assert orbit_metadata(c.orbit.elements)["ltan_hours"] == pytest.approx(18)
    assert norm(sun_direction_inertial(epoch)) == pytest.approx(1)


def test_spherical_occultation_and_degree_one_field_scaling():
    assert sun_visibility((-7e6, 0, 0), (1, 0, 0), 6371e3) == 0
    assert sun_visibility((7e6, 0, 0), (1, 0, 0), 6371e3) == 1
    assert sun_visibility((-7e6, 7e6, 0), (1, 0, 0), 6371e3) == 1
    first = magnetic_field_ecef_t((0, 0, 7e6), "2025-01-01T00:00:00Z")
    second = magnetic_field_ecef_t((0, 0, 14e6), "2025-01-01T00:00:00Z")
    assert first[2] < 0
    assert second == pytest.approx(tuple(v / 8 for v in first))


def test_earth_ir_nadir_view_factor_independent_closed_form():
    r = 6928137.0
    earth = 6371000.0
    flux = 237.0
    for rings, azimuths in ((4, 12), (8, 24)):
        reflected, ir = earth_disk_irradiance(
            (r, 0, 0), (1, 0, 0), ((-1, 0, 0),), earth, 1361, 0.3, flux, rings, azimuths
        )[0]
        assert ir == pytest.approx(flux * (earth / r) ** 2, rel=1e-12)
        assert reflected > 0


def test_reject_overlapping_pv_nonunit_surfaces_and_stale_ltan():
    c = config()
    invalid = deepcopy(c)
    invalid["power"]["surfaces"][0]["normal_body"] = [0, 0, -2]
    with pytest.raises(ValidationError):
        validate(invalid)
    invalid = deepcopy(c)
    duplicate = deepcopy(invalid["power"]["panels"][0])
    duplicate["panel_id"] = "overlap"
    invalid["power"]["panels"].append(duplicate)
    with pytest.raises(ValidationError):
        validate(invalid)
    invalid = deepcopy(c)
    invalid["orbit"]["elements"]["raan_deg"] += 10
    with pytest.raises(ValidationError, match="LTAN"):
        validate(invalid)


def test_clocks_high_spin_and_unresolved_actuator_power_rejected():
    c = config()
    c["spacecraft"]["initial_omega_body_rad_s"] = [1, 0.5, -0.25]
    with pytest.raises(ValidationError, match="finer"):
        validate(c)
    c = config()
    c["clocks"]["controller_period_s"] = 1.5
    with pytest.raises(ValidationError, match="integer"):
        validate(c)
    c = config()
    c["spacecraft"]["magnetorquer"]["power_model"] = "unresolved"
    c["spacecraft"]["magnetorquer"]["full_axis_power_w"] = None
    with pytest.raises(ValidationError, match="electrical"):
        validate(c)


def test_common_clock_immutable_inputs_and_total_energy_closure():
    data = config(300)
    original = deepcopy(data)
    result = run_mission(validate(data))
    assert data == original
    assert result["samples"]["time_s"] == list(range(0, 301, 30))
    assert len(result["samples"]["q_body_from_inertial_wxyz"]) == 11
    assert len(result["samples"]["thermal"]["node_temperature_k"]["bus"]) == 11
    assert result["summary"]["energy_j"]["closure_residual_j"] == pytest.approx(
        0, abs=1e-6
    )
    assert all(v is None for v in result["samples"]["power"]["battery_voltage_v"])
    assert all(v is None for v in result["samples"]["power"]["battery_current_a"])
    assert result["manifest"]["source_code_hashes"]["cubesat_sim/mission/driver.py"]
    json.dumps(result, allow_nan=False)


def test_output_clock_does_not_change_physics_energy_or_extrema():
    c = config(300)
    first = run_mission(validate(c))
    c["clocks"]["output_step_s"] = 60
    second = run_mission(validate(c))
    assert (
        first["samples"]["q_body_from_inertial_wxyz"][::2]
        == second["samples"]["q_body_from_inertial_wxyz"]
    )
    assert first["summary"]["energy_j"] == second["summary"]["energy_j"]
    assert (
        first["summary"]["max_pointing_error_deg"]
        == second["summary"]["max_pointing_error_deg"]
    )
    assert (
        first["summary"]["max_elevation_deg"] == second["summary"]["max_elevation_deg"]
    )


def test_disabled_actuator_has_no_authority_or_actuator_energy():
    c = config(120)
    c["spacecraft"]["wheels"] = []
    c["spacecraft"]["initial_q_body_from_inertial_wxyz"] = [1, 0, 0, 0]
    enabled = run_mission(validate(c))
    c["spacecraft"]["magnetorquer"]["enabled"] = False
    disabled = run_mission(validate(c))
    assert disabled["summary"]["energy_j"]["magnetorquer_bus_j"] == 0
    assert all(
        q == [1, 0, 0, 0] or q == (1, 0, 0, 0)
        for q in disabled["samples"]["q_body_from_inertial_wxyz"]
    )
    assert (
        enabled["samples"]["q_body_from_inertial_wxyz"][-1]
        != disabled["samples"]["q_body_from_inertial_wxyz"][-1]
    )
    assert enabled["summary"]["energy_j"]["magnetorquer_bus_j"] > 0
    assert disabled["samples"]["gnc"]["controller_status"][0] == "no_actuator_coast"


def test_power_failure_retains_only_last_valid_state_prefix():
    c = config()
    c["power"]["battery"]["initial_energy_fraction"] = 0
    for panel in c["power"]["panels"]:
        panel["enabled"] = False
    result = run_mission(validate(c))
    assert result["summary"]["end_reason"] == "power_unserved"
    assert result["summary"]["computed_duration_s"] == 0
    assert result["samples"]["time_s"] == [0]
    assert result["summary"]["ideal_capacity_bits"] == {"uplink": 0, "downlink": 0}
    assert result["summary"]["energy_j"]["served_load_j"] == 0


def test_physical_wheel_path_and_energy_partition():
    c = config(60)
    c["spacecraft"]["wheels"] = [
        dict(enabled=True, spec=wheel.__dict__)
        for wheel in default_attitude_study().body.wheels
    ]
    c["spacecraft"]["magnetorquer"]["enabled"] = False
    result = run_mission(validate(c))
    assert len(result["samples"]["gnc"]["wheel_speed_utilization"][0]) == 3
    assert result["summary"]["energy_j"]["wheel_bus_j"] > 0
    assert abs(result["summary"]["energy_j"]["closure_residual_j"]) < 1e-6


def test_cancellation_is_headless_and_never_returns_fabricated_result():
    calls = []
    with pytest.raises(InterruptedError):
        run_mission(
            validate(config(300)), cancelled=lambda: True, progress=calls.append
        )
    assert calls == []


def overhead_config(duration=30):
    from cubesat_sim.orbit.elements import elements_to_cartesian
    from cubesat_sim.mission.ephemeris import inertial_to_ecef
    from cubesat_sim.geometry.vectors import scale

    c = config(duration)
    validated = validate(c)
    r = elements_to_cartesian(
        validated.orbit.elements, validated.orbit.mu_m3_s2
    ).position_m
    ecef = inertial_to_ecef(r, validated.epoch_utc)
    c["station"].update(
        latitude_deg=0, longitude_deg=math.degrees(math.atan2(ecef[1], ecef[0]))
    )
    c["spacecraft"].update(
        controller="coast",
        initial_q_body_from_inertial_wxyz=boresight_reference(
            (1, 0, 0, 0), (0, 1, 0), scale(r, -1 / norm(r))
        ),
    )
    c["spacecraft"]["magnetorquer"]["enabled"] = False
    c["schedule"]["first_direction"] = "downlink"
    return c


def test_initial_capacity_pin_and_pa_feed_radiated_power_planes():
    c = overhead_config()
    c["uhf_beacon"] = None
    c["downlink"]["tx_feed_loss_db"] = 10
    c["power"]["transmit_radiation_efficiency"] = 0.5
    result = run_mission(validate(c))
    assert result["samples"]["downlink"]["cumulative_ideal_bits"][0] == 0
    assert result["summary"]["ideal_capacity_bits"]["downlink"] > 0
    expected = c["downlink"]["tx_power_w"] * 0.1 * 0.5
    assert result["summary"]["energy_j"]["escaped_rf_j"] == pytest.approx(expected * 30)
    assert result["samples"]["power"]["component_electrical_w"]["radio"][-1] == 14.0
    assert abs(result["summary"]["energy_j"]["closure_residual_j"]) < 1e-6


def test_offgrid_bdot_uses_actual_elapsed_control_time():
    from cubesat_sim.attitude.actuators import bdot_dipole

    c = config(20)
    c["conops"].update(
        auto_ground_tracking=False,
        windows=[
            dict(window_id="early_detumble", start_s=2, end_s=20, mode="detumble")
        ],
    )
    c["clocks"].update(controller_period_s=10, thermal_step_s=2, output_step_s=2)
    result = run_mission(validate(c))
    fields = result["samples"]["gnc"]["magnetic_field_body_t"]
    difference = tuple((b - a) / 2 for a, b in zip(fields[0], fields[1]))
    expected, _ = bdot_dipole(
        difference,
        c["spacecraft"]["bdot_gain_am2_s_t"],
        validate(c).spacecraft.rigid_body().magnetorquer,
    )
    assert result["samples"]["gnc"]["magnetic_dipole_body_am2"][2] == pytest.approx(
        expected, abs=1e-14
    )


def test_source_revision_change_cannot_publish_a_mixed_run(monkeypatch):
    import cubesat_sim.mission.driver as driver

    calls = []

    def identity():
        calls.append(1)
        return {"revision": "start" if len(calls) == 1 else "changed"}

    monkeypatch.setattr(driver, "_source_hashes", identity)
    with pytest.raises(RuntimeError, match="changed during mission"):
        driver.run_mission(validate(config(30)))


def test_new_mission_default_returns_battery_soc_current_voltage_and_heat():
    data = default_mission_scenario().model_dump(mode="json")
    data["duration_s"] = 60
    result = run_mission(validate(data))
    power = result["samples"]["power"]
    assert result["summary"]["computed_duration_s"] == 60
    assert power["battery_soc"][0] == 0.5
    for key in ("battery_soc", "battery_voltage_v", "battery_current_a", "battery_ohmic_heat_w"):
        assert all(v is not None and math.isfinite(v) for v in power[key])
    assert power["battery_soc"] != power["energy_fraction"]
    assert abs(result["summary"]["energy_j"]["closure_residual_j"]) < 1e-6

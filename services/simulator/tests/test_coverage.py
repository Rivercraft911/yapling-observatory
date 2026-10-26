"""Independent Friis, ellipsoid/ENU and receiver-contract coverage checks."""

import json
import math

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from cubesat_sim.geometry.ellipsoid_shell import StationShell, ecef_geodetic
from cubesat_sim.geometry.frames import WGS84_A_M, WGS84_F, enu_axes, geodetic_ecef
from cubesat_sim.geometry.vectors import cross, dot, norm
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission_coverage import CoverageRequest, coverage, router
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.models import Scenario, Station, default_scenario
from cubesat_sim.rf.antennas import HALF_WAVE_DIRECTIVITY, short_dipole_turnstile
from cubesat_sim.rf.coverage import coverage_contours
from cubesat_sim.rf.spherical_harmonic_models import SphericalHarmonicProfile
from cubesat_sim.rf.spherical_harmonics import reference_profiles


def mode(threshold=1, *, mode_id="test", symbol_rate=1e6):
    return dict(mode_id=mode_id, modulation="QPSK", code_rate="1/2",
                symbol_rate_sps=symbol_rate, frame_size="normal", pilots=True,
                threshold_esn0_db=threshold,
                threshold_status="unresolved" if threshold is None else "illustrative",
                threshold_source="Explicit test threshold", engineering_reserve_db=0)


def compute(scenario=None, *, direction="downlink", modes=None, **changes):
    return coverage_contours(
        scenario or default_scenario(), direction, 550000, modes or [mode()],
        mode_source="configured_receiver", **changes,
    )


def relative_geometry(station, point, altitude):
    origin = geodetic_ecef(station.latitude_deg, station.longitude_deg, station.height_m)
    position = geodetic_ecef(point.get("satellite_latitude_deg", point["latitude_deg"]),
                             point.get("satellite_longitude_deg", point["longitude_deg"]), altitude)
    relative = tuple(p - s for p, s in zip(position, origin))
    distance = norm(relative)
    elevation = math.degrees(math.asin(dot(relative, enu_axes(
        station.latitude_deg, station.longitude_deg
    )[2]) / distance))
    return distance, elevation


@pytest.mark.parametrize("latitude", [-90, -89.99, -60, 0, 37.4, 89.99, 90])
@pytest.mark.parametrize("height", [-500, 0, 550000, 50000000])
def test_geodetic_inverse_closes_forward_equations(latitude, height):
    position = geodetic_ecef(latitude, 179.9, height)
    lat, lon, recovered_height = ecef_geodetic(position)
    reconstructed = geodetic_ecef(lat, lon, recovered_height)
    assert norm(tuple(a - b for a, b in zip(position, reconstructed))) < 3e-8
    assert lat == pytest.approx(latitude, abs=1e-12)
    assert recovered_height == pytest.approx(height, abs=3e-8)


@pytest.mark.parametrize("elevation", [0, 10, 60, 89])
def test_equatorial_east_mask_matches_independent_circle_intersection(elevation):
    station = Station(latitude_deg=0, longitude_deg=0, height_m=30,
                      minimum_elevation_deg=elevation)
    shell = StationShell(station, 550000)
    points, limit = shell.boundary(1e20)
    point = points[36]  # Azimuth90, in the circular equatorial section.
    ground_radius = WGS84_A_M + 30
    satellite_radius = WGS84_A_M + 550000
    angle = math.radians(elevation)
    expected_range = (math.sqrt(satellite_radius**2 - ground_radius**2 * math.cos(angle)**2)
                      - ground_radius * math.sin(angle))
    expected_longitude = math.degrees(math.atan2(
        expected_range * math.cos(angle), ground_radius + expected_range * math.sin(angle)
    ))
    assert point["latitude_deg"] == pytest.approx(0, abs=1e-10)
    assert point["longitude_deg"] == pytest.approx(expected_longitude, abs=3e-10)
    assert shell.mask_ranges[36] == pytest.approx(expected_range, abs=5e-6)
    assert limit == "elevation_mask"
    assert points[0] == points[-1] and len(points) == 145


def test_friis_range_and_every_rf_boundary_point_close_independently():
    scenario = default_scenario()
    link = scenario.downlink
    target_range = 1000000
    # Independent linear Friis and kTRs, evaluated without core decibel helpers.
    received = (link.tx_power_w * 10 ** ((link.ground_peak_gain_dbi + link.spacecraft_peak_gain_dbi
                - link.tx_feed_loss_db - link.extra_path_loss_db) / 10)
                * (299792458 / (4 * math.pi * link.frequency_hz * target_range))**2)
    threshold = 10 * math.log10(received / (1.380649e-23 * link.rx_system_noise_temperature_k * 1e6))
    result = compute(scenario, modes=[mode(threshold)])
    contour = result["contours"][0]
    assert contour["max_slant_range_m"] == pytest.approx(target_range, rel=2e-14)
    assert contour["limit"] == "rf_threshold"
    for point in contour["boundary"]:
        distance, elevation = relative_geometry(scenario.station, point, result["altitude_m"])
        assert distance == pytest.approx(target_range, abs=2e-5)
        assert elevation >= scenario.station.minimum_elevation_deg


def test_low_power_has_no_contour_below_zenith_and_scenario_is_immutable():
    data = default_scenario().model_dump(mode="json")
    data["downlink"]["tx_power_w"] = 1e-9
    scenario = Scenario.model_validate(data)
    before = scenario.model_dump_json()
    contour = compute(scenario)["contours"][0]
    assert contour["status"] == "no_coverage"
    assert contour["limit"] == "below_zenith_threshold"
    assert contour["boundary"] == [] and contour["zenith_margin_db"] < 0
    assert scenario.model_dump_json() == before


def test_range_decreases_monotonically_with_threshold_and_symbol_rate():
    contours = compute(modes=[mode(value, mode_id=str(value)) for value in (0, 3, 6)])["contours"]
    ranges = [entry["max_slant_range_m"] for entry in contours]
    assert ranges[0] > ranges[1] > ranges[2]
    assert ranges[1] / ranges[0] == pytest.approx(10 ** (-3 / 20), rel=2e-14)
    doubled = compute(modes=[mode(0, symbol_rate=2e6)])["contours"][0]
    assert doubled["max_slant_range_m"] / ranges[0] == pytest.approx(1 / math.sqrt(2), rel=2e-14)


def test_carrier_polarization_and_extra_loss_each_change_range_as_expected():
    scenario = default_scenario()
    baseline = compute(scenario)["contours"][0]["max_slant_range_m"]
    double_carrier = scenario.model_copy(update={"downlink": scenario.downlink.model_copy(
        update={"frequency_hz": scenario.downlink.frequency_hz * 2}
    )})
    assert compute(double_carrier)["contours"][0]["max_slant_range_m"] == pytest.approx(baseline / 2)
    assert compute(scenario, polarization_loss_db=6)["contours"][0]["max_slant_range_m"] == pytest.approx(baseline * 10**(-6/20))
    extra_loss = scenario.model_copy(update={"downlink": scenario.downlink.model_copy(
        update={"extra_path_loss_db": scenario.downlink.extra_path_loss_db + 6}
    )})
    assert compute(extra_loss)["contours"][0]["max_slant_range_m"] == pytest.approx(baseline * 10**(-6/20))


def test_mixed_boundary_is_mask_or_rf_limited_in_every_azimuth():
    station = Station(minimum_elevation_deg=0)
    shell = StationShell(station, 550000)
    maximum_range = sum((min(shell.mask_ranges), max(shell.mask_ranges))) / 2
    points, limit = shell.boundary(maximum_range)
    assert limit == "mixed_rf_and_elevation_mask"
    for point in points:
        distance, elevation = relative_geometry(station, point, 550000)
        assert distance <= maximum_range + 2e-5 and elevation >= -2e-9
        assert abs(elevation) < 2e-9 or abs(distance - maximum_range) < 2e-5


def test_turnstile_peak_uses_shared_power_and_matches_pattern():
    base = default_scenario()
    wire = base.downlink.model_copy(update={"spacecraft_antenna": "wire", "spacecraft_peak_gain_dbi": 2})
    scenario = base.model_copy(update={"downlink": wire, "antenna_variant": "turnstile"})
    result = compute(scenario)
    response = short_dipole_turnstile((1,0,0), (0,0,1), (0,1,0), 10**0.2/HALF_WAVE_DIRECTIVITY)
    assert result["rf"]["spacecraft_gain_dbi"] == pytest.approx(10*math.log10(response.gain_linear))
    assert result["rf"]["spacecraft_gain_dbi"] < wire.spacecraft_peak_gain_dbi


def test_mission_additional_efficiency_is_applied_once_and_zero_is_no_coverage():
    base = default_mission_scenario()
    scenario = base.model_copy(update={"power": base.power.model_copy(update={
        "analytical_efficiency_semantics": "pattern_times_additional_v1",
        "transmit_radiation_efficiency": 1,
    })})
    baseline = compute(scenario)["contours"][0]["max_slant_range_m"]
    quarter = scenario.model_copy(update={"power": scenario.power.model_copy(update={
        "transmit_radiation_efficiency": 0.25,
    })})
    assert compute(quarter)["contours"][0]["max_slant_range_m"] == pytest.approx(baseline/2)
    zero = scenario.model_copy(update={"power": scenario.power.model_copy(update={
        "transmit_radiation_efficiency": 0,
    })})
    contour = compute(zero)["contours"][0]
    assert contour["status"] == "no_coverage" and contour["limit"] == "zero_antenna_efficiency"
    unresolved_decoder = compute(zero, modes=[mode(None)])["contours"][0]
    assert unresolved_decoder["status"] == "no_coverage"
    assert unresolved_decoder["limit"] == "zero_antenna_efficiency"


def test_unresolved_fields_and_thresholds_never_borrow_manual_peak():
    base = default_scenario()
    v45 = base.model_copy(update={"antenna_variant": "v45", "downlink": base.downlink.model_copy(
        update={"spacecraft_antenna": "wire", "spacecraft_peak_gain_dbi": 2}
    )})
    harmonic = base.model_copy(update={"downlink": base.downlink.model_copy(update={
        "spacecraft_antenna": "spherical_harmonic", "spherical_harmonic_profile": SphericalHarmonicProfile.model_validate(reference_profiles()[0]["profile"]),
    })})
    for scenario in (v45, harmonic):
        result = compute(scenario)
        assert result["rf"]["spacecraft_gain_dbi"] is None
        assert result["contours"][0]["limit"] == "pattern_unresolved"
        assert result["contours"][0]["status"] == "unresolved"
    assert compute(modes=[mode(None)])["contours"][0]["limit"] == "receiver_threshold_unresolved"


def test_legacy_catalogue_has_all_17_modes_and_applies_explicit_reserve_once():
    base = default_scenario()
    scenario = base.model_copy(update={"downlink": base.downlink.model_copy(update={
        "profile": base.downlink.profile.model_copy(update={"engineering_reserve_db": 3})
    })})
    result = coverage(CoverageRequest(scenario=scenario, direction="downlink"))
    assert result["mode_source"] == "ideal_normal_psk_catalogue" and len(result["contours"]) == 17
    assert result["altitude_m"] == 550000
    qpsk = next(row for row in result["contours"] if row["mode_id"] == "qpsk-1-2")
    assert qpsk["threshold_esn0_db"] == 4 and qpsk["engineering_reserve_db"] == 3
    assert qpsk["max_slant_range_m"] == pytest.approx(compute(modes=[mode(4)])["contours"][0]["max_slant_range_m"])


def test_configured_receiver_subset_and_threshold_are_preserved_without_double_reserve():
    data = default_mission_scenario().model_dump(mode="json")
    data["downlink"]["profile"]["engineering_reserve_db"] = 12
    receiver = data["radio_delivery"]["downlink"]
    selected = receiver["modes"][3]
    selected.update(mode_id="custom-qpsk", decode_threshold_esn0_db=4.25,
                    threshold_status="illustrative", threshold_source="Custom threshold includes 3.25 dB reserve")
    receiver.update(modes=[selected], initial_mode_id="custom-qpsk")
    scenario = MissionScenario.model_validate(data)
    before = scenario.model_dump_json()
    result = coverage(CoverageRequest(scenario=scenario, direction="downlink"))
    assert result["mode_source"] == "configured_receiver" and len(result["contours"]) == 1
    row = result["contours"][0]
    assert row["mode_id"] == "custom-qpsk" and row["threshold_esn0_db"] == 4.25
    assert row["engineering_reserve_db"] is None and row["threshold_includes_reserve"]
    assert row["max_slant_range_m"] == pytest.approx(compute(scenario, modes=[mode(4.25, symbol_rate=selected["symbol_rate_sps"])])["contours"][0]["max_slant_range_m"])
    assert scenario.model_dump_json() == before
    assert result["altitude_source"] == "nominal_orbit_planning_height"


def test_http_route_accepts_archived_full_scenario_and_rejects_invalid_inputs():
    app = FastAPI()
    app.include_router(router)
    body = dict(scenario=default_mission_scenario().model_dump(mode="json"), direction="uplink", altitude_m=None)
    with TestClient(app) as client:
        response = client.post("/api/mission/coverage", json=body)
        assert response.status_code == 200
        result = response.json()
        assert result["altitude_m"] == (body["scenario"]["orbit"]["elements"]["semi_major_axis_m"]
                                         - body["scenario"]["orbit"]["reference_radius_m"])
        assert result["direction"] == "uplink"
        assert len(result["contours"]) == 17
        json.dumps(result, allow_nan=False)
        for patch in (dict(altitude_m=99999), dict(altitude_m=True),
                      dict(polarization_loss_db=-1), dict(polarization_loss_db=True),
                      dict(direction="both"), dict(extra="forbidden")):
            assert client.post("/api/mission/coverage", json=body | patch).status_code == 422


def test_longitude_seam_and_polar_station_produce_finite_closed_geodetic_rings():
    for latitude in (0, 89.9, -89.9):
        shell = StationShell(Station(latitude_deg=latitude, longitude_deg=179.9), 550000)
        points, _ = shell.boundary(1e12)
        assert points[0] == points[-1]
        assert all(-90 <= p["latitude_deg"] <= 90 and -180 <= p["longitude_deg"] < 180 for p in points)


def test_boundary_display_projection_matches_frontend_radial_convention():
    result = compute(modes=[mode(-10)])
    assert result["display_projection"] == "radial_wgs84_surface_geodetic"
    differences = []
    for point in result["contours"][0]["boundary"]:
        satellite = geodetic_ecef(point["satellite_latitude_deg"],
                                  point["satellite_longitude_deg"], result["altitude_m"])
        surface = geodetic_ecef(point["latitude_deg"], point["longitude_deg"], 0)
        # Independent collinearity: earth center, radial surface and satellite.
        assert norm(cross(surface, satellite)) / (norm(surface)*norm(satellite)) < 2e-15
        # Existing display rotates ECEF(x,y,z) to Three(x,z,-y), then uses
        # atan2(Three.y, hypot(Three.x,Three.z)*(b/a)^2).
        display_x, display_y, display_z = satellite[0], satellite[2], -satellite[1]
        frontend_latitude = math.degrees(math.atan2(
            display_y, math.hypot(display_x, display_z)*(1-WGS84_F)**2
        ))
        assert point["latitude_deg"] == pytest.approx(frontend_latitude, abs=1e-12)
        differences.append(abs(point["latitude_deg"] - point["satellite_latitude_deg"]))
    assert max(differences) > 0.001

"""Independent field, power, pole, polarization and shared-link invariants."""
import math
import random

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from cubesat_sim.antenna_models import PatternRequest
from cubesat_sim.api import create_app
from cubesat_sim.geometry.vectors import cross, dot, matvec, norm, scale, transverse, transpose, unit
from cubesat_sim.models import Link, default_scenario
from cubesat_sim.rf.antennas import antenna_orientation_matrix
from cubesat_sim.rf.link_budget import evaluate_link_budget, spacecraft_response
from cubesat_sim.rf.pattern_sampling import pattern_response, sample_pattern
from cubesat_sim.rf.polarization import polarization_coupling
from cubesat_sim.rf.spherical_harmonic_models import SphericalHarmonicProfile
from cubesat_sim.rf.spherical_harmonics import (
    coefficient_power, reference_profiles, spherical_harmonic_response, vector_spherical_harmonic,
)


def profile(index=0, **changes):
    return SphericalHarmonicProfile.model_validate(reference_profiles()[index]["profile"] | changes)


def sphere_quadrature(nz=16, nphi=32):
    # Gauss-Legendre in z and periodic trapezoid in phi. Unlike the evaluator,
    # this uses a Newton root solve; 16x32 integrates every l<=12 power product.
    for i in range(1, nz+1):
        z = math.cos(math.pi*(i-.25)/(nz+.5))
        for _ in range(20):
            previous, current = 1.0, z
            for degree in range(2, nz+1):
                previous, current = current, ((2*degree-1)*z*current-(degree-1)*previous)/degree
            derivative = nz*(z*current-previous)/(z*z-1)
            step = current/derivative
            z -= step
            if abs(step) < 1e-15:
                break
        weight = 2/((1-z*z)*derivative*derivative)
        for j in range(nphi):
            phi = 2*math.pi*j/nphi
            yield (math.sqrt(1-z*z)*math.cos(phi), math.sqrt(1-z*z)*math.sin(phi), z), weight*2*math.pi/nphi


def test_low_order_basis_matches_cartesian_electric_and_magnetic_dipoles():
    for look in ((1, 0, 0), unit((.2, .4, .7)), (0, 0, 1), (0, 0, -1)):
        psi, x = vector_spherical_harmonic(1, 0, look)
        expected = scale(transverse((0, 0, 1), look), math.sqrt(3/(8*math.pi)))
        assert psi == pytest.approx(expected, abs=2e-15)
        assert x == pytest.approx(scale(cross(look, expected), -1j), abs=2e-15)


def test_vector_families_are_jointly_orthonormal_through_degree_cap():
    modes = [(1, -1, 0), (1, 0, 0), (1, 1, 1), (4, -3, 0), (4, -3, 1), (12, -12, 0), (12, 7, 1)]
    integrals = [[0j for _ in modes] for _ in modes]
    for look, weight in sphere_quadrature():
        fields = [vector_spherical_harmonic(l, m, look)[family] for l, m, family in modes]
        for i, a in enumerate(fields):
            for j, b in enumerate(fields):
                integrals[i][j] += weight*sum(v.conjugate()*w for v, w in zip(a, b))
    for i in range(len(modes)):
        for j in range(len(modes)):
            assert integrals[i][j] == pytest.approx(float(i == j), abs=4e-14)


def test_dense_complex_degree_twelve_field_integrates_to_efficiency():
    coefficients = [dict(degree=l, order=m, psi=(math.sin(l+3*m), math.cos(2*l-m)),
                         x=(math.cos(l+m), math.sin(3*l-2*m)))
                    for l in range(1, 13) for m in range(-l, l+1)]
    p = profile(maximum_degree=12, radiation_efficiency=.63, coefficients=coefficients)
    integral = sum(weight*spherical_harmonic_response(p, p.frequency_hz, look).gain_linear
                   for look, weight in sphere_quadrature())
    assert integral/(4*math.pi) == pytest.approx(.63, abs=2e-14)
    scaled = p.model_dump(mode="json")
    for coefficient in scaled["coefficients"]:
        coefficient["psi"] = [7*v for v in coefficient["psi"]]
        coefficient["x"] = [7*v for v in coefficient["x"]]
    scaled = SphericalHarmonicProfile.model_validate(scaled)
    assert coefficient_power(scaled) == pytest.approx(49*coefficient_power(p))
    a = spherical_harmonic_response(p, p.frequency_hz, (.3, -.7, .2))
    b = spherical_harmonic_response(scaled, p.frequency_hz, (.3, -.7, .2))
    assert b.gain_linear == pytest.approx(a.gain_linear, rel=2e-14)
    assert b.polarization == pytest.approx(a.polarization, abs=2e-14)


def test_huygens_reference_matches_independent_cartesian_source_and_null():
    p = profile()
    assert coefficient_power(p) == pytest.approx(16*math.pi/3)
    randomizer = random.Random(619)
    for _ in range(100):
        look = unit(tuple(randomizer.uniform(-1, 1) for _ in range(3)))
        response = spherical_harmonic_response(p, p.frequency_hz, look)
        electric, magnetic = transverse((1, 0, 0), look), cross(look, (0, 0, 1))
        expected = tuple(e+m for e, m in zip(electric, magnetic))
        assert response.gain_linear == pytest.approx(.75*(1+look[1])**2, abs=2e-14)
        assert response.polarization == pytest.approx(unit(expected), abs=2e-13)
        assert abs(dot(look, response.polarization)) < 3e-15
    assert spherical_harmonic_response(p, p.frequency_hz, (0, 1, 0)).gain_linear == pytest.approx(3)
    null = spherical_harmonic_response(p, p.frequency_hz, (0, -1, 0))
    assert null.gain_linear == 0 and null.polarization is None


def test_basis_is_finite_transverse_and_cartesian_continuous_at_poles_and_seam():
    for degree in (1, 3, 12):
        for order in range(-degree, degree+1):
            for pole in (-1, 1):
                exact = vector_spherical_harmonic(degree, order, (0, 0, pole))
                for phi in (0, .7, 2.4, 5.8):
                    look = (1e-9*math.cos(phi), 1e-9*math.sin(phi), pole)
                    near = vector_spherical_harmonic(degree, order, look)
                    for a, b in zip(exact, near):
                        assert b == pytest.approx(a, abs=1e-7)
                        assert abs(dot(unit(look), b)) < 1e-14
                plus = vector_spherical_harmonic(degree, order, unit((1, 1e-12, .4)))
                minus = vector_spherical_harmonic(degree, order, unit((1, -1e-12, .4)))
                for a, b in zip(plus, minus):
                    assert b == pytest.approx(a, abs=5e-11)


def test_complex_coefficients_preserve_circular_polarization_and_phase():
    p = profile(maximum_degree=1, coefficients=[dict(degree=1, order=1, psi=(1, 0))])
    response = spherical_harmonic_response(p, p.frequency_hz, (0, 0, 1))
    assert response.gain_linear > 0
    assert abs(response.polarization[0]) == pytest.approx(2**-.5)
    assert response.polarization[1]/response.polarization[0] == pytest.approx(1j)
    for analyzer in ((1, 0, 0), (0, 1, 0), unit((1, 1, 0))):
        assert polarization_coupling(response.polarization, analyzer) == pytest.approx(.5)
    phase = p.model_dump(mode="json")
    phase["coefficients"][0]["psi"] = [0, 1]
    rotated = spherical_harmonic_response(SphericalHarmonicProfile.model_validate(phase), p.frequency_hz, (0, 0, 1))
    assert rotated.gain_linear == pytest.approx(response.gain_linear)
    assert rotated.polarization == pytest.approx(scale(response.polarization, 1j))


def test_main_link_and_lab_use_same_field_with_native_mount_and_body_pose():
    scenario = default_scenario()
    p = profile(1)
    orientation = (17, -28, 42)
    request = PatternRequest(model="spherical_harmonic", spherical_harmonic_profile=p,
                             frequency_hz=p.frequency_hz, orientation_deg=orientation)
    link = Link.model_validate(scenario.downlink.model_dump() | dict(
        spacecraft_antenna="spherical_harmonic", spherical_harmonic_profile=p,
        antenna_orientation_deg=orientation))
    inertial_from_body = antenna_orientation_matrix((-31, 12, 68))
    look_body = unit((.3, .8, -.4))
    look_inertial = matvec(inertial_from_body, look_body)
    state = dict(zip(("x", "y", "z"), transpose(inertial_from_body))) | dict(
        k=scale(look_inertial, -1), east=(1, 0, 0), north=(0, 1, 0),
        range_m=1e6, range_rate_m_s=0, visible=True)
    main = spacecraft_response(scenario, link, state)
    lab = pattern_response(request, look_body)
    assert main.gain_linear == pytest.approx(lab.gain_linear, rel=2e-14)
    assert main.polarization == pytest.approx(matvec(inertial_from_body, lab.polarization), abs=2e-14)
    scenario = type(scenario).model_validate(scenario.model_dump() | dict(downlink=link))
    budget = evaluate_link_budget(scenario, "downlink", state, True)
    assert budget["valid"]
    assert budget["tx_gain_dbi"] == pytest.approx(10*math.log10(lab.gain_linear))
    changed = Link.model_validate(link.model_dump() | dict(spacecraft_peak_gain_dbi=30))
    assert spacecraft_response(scenario, changed, state) == main  # No independent peak-gain multiplier.
    weaker_profile = SphericalHarmonicProfile.model_validate(p.model_dump() | dict(radiation_efficiency=.425))
    weaker = Link.model_validate(link.model_dump() | dict(spherical_harmonic_profile=weaker_profile))
    weaker_scenario = type(scenario).model_validate(scenario.model_dump() | dict(downlink=weaker))
    weaker_budget = evaluate_link_budget(weaker_scenario, "downlink", state, True)
    assert weaker_budget["received_power_dbw"] == pytest.approx(budget["received_power_dbw"]-10*math.log10(2))


@pytest.mark.parametrize("change", [
    {"maximum_degree": 13}, {"maximum_degree": 0}, {"frequency_hz": 1e6}, {"radiation_efficiency": 1.01},
    {"radiation_efficiency": float("nan")}, {"coefficients": []},
    {"coefficients": [dict(degree=0, order=0, psi=[1, 0])]},
    {"coefficients": [dict(degree=1, order=2, psi=[1, 0])]},
    {"coefficients": [dict(degree=1, order=0, psi=[float("inf"), 0])]},
    {"coefficients": [dict(degree=1, order=0)]},
    {"coefficients": [dict(degree=1, order=0, psi=[1, 0])]*2},
    {"maximum_degree": 1, "coefficients": [dict(degree=2, order=0, psi=[1, 0])]},
    {"unknown": 1},
])
def test_invalid_profile_rejected(change):
    with pytest.raises(ValidationError):
        profile(**change)


def test_input_validation_and_zero_efficiency_have_unambiguous_behavior():
    p = profile()
    for change in ({}, {"frequency_hz": 2.41e9}, {"efficiency": .9}):
        value = dict(model="spherical_harmonic", frequency_hz=2.4e9)
        if change:
            value["spherical_harmonic_profile"] = p
        with pytest.raises(ValidationError):
            PatternRequest.model_validate(value | change)
    with pytest.raises(ValueError):
        spherical_harmonic_response(p, 2.41e9, (0, 1, 0))
    zero = spherical_harmonic_response(profile(radiation_efficiency=0), p.frequency_hz, (0, 1, 0))
    assert zero.gain_linear == 0 and zero.polarization is None
    with pytest.raises(ValidationError):
        Link.model_validate(default_scenario().downlink.model_dump() | dict(spacecraft_antenna="spherical_harmonic"))


def test_catalog_import_and_inspection_are_the_same_strict_typed_path():
    with TestClient(create_app()) as client:
        catalog = client.get("/api/antenna-lab/catalog").json()
        assert "G(θ,φ)" in catalog["models"]["spherical_harmonic"]["formula"]
        for example in catalog["examples"]:
            p = example["profile"]
            payload = dict(model="spherical_harmonic", spherical_harmonic_profile=p,
                           frequency_hz=p["frequency_hz"], polar_steps=12, azimuth_steps=24)
            response = client.post("/api/antenna-lab/pattern", json=payload)
            assert response.status_code == 200
            result = response.json()
            assert result["status"] == p["provenance"]["status"]
            assert result["expected_sphere_mean_gain"] == p["radiation_efficiency"]
            assert "spherical_harmonics.py" in result["source"]["path"]
            payload["frequency_hz"] *= 1.001
            assert client.post("/api/antenna-lab/probe", json=payload).status_code == 422


@pytest.mark.parametrize("antenna,variant,gain", [
    ("patch", "dipole", -10), ("patch", "dipole", 30),
    ("wire", "dipole", -1), ("wire", "turnstile", 1), ("wire", "v45", 0),
    ("spherical_harmonic", "dipole", 6),
])
def test_canonical_link_reference_matches_main_for_every_model(antenna, variant, gain):
    scenario = default_scenario()
    data = scenario.uplink.model_dump() | dict(spacecraft_antenna=antenna,
        spacecraft_peak_gain_dbi=gain, antenna_orientation_deg=(21, -37, 63))
    if antenna == "spherical_harmonic":
        data["spherical_harmonic_profile"] = profile(1)
    link = Link.model_validate(data)
    look = unit((.2, .8, .5))
    state = dict(x=(1, 0, 0), y=(0, 1, 0), z=(0, 0, 1), k=scale(look, -1))
    scenario = type(scenario).model_validate(scenario.model_dump() | dict(antenna_variant=variant))
    with TestClient(create_app()) as client:
        response = client.post("/api/antenna-lab/reference-request", json=dict(
            link=link.model_dump(mode="json"), antenna_variant=variant))
        assert response.status_code == 200
        request = PatternRequest.model_validate(response.json())
    assert request.orientation_deg == link.antenna_orientation_deg
    assert request.frequency_hz == link.frequency_hz
    a, b = spacecraft_response(scenario, link, state), pattern_response(request, look)
    if variant == "v45" and antenna == "wire":
        assert a is None and b is None
    else:
        assert a.gain_linear == pytest.approx(b.gain_linear, abs=2e-13)
        assert a.polarization == pytest.approx(b.polarization, abs=2e-14)


def test_degree_twelve_reported_power_does_not_alias_minimum_display_grid():
    p = profile(maximum_degree=12, radiation_efficiency=.713, coefficients=[
        dict(degree=12, order=-12, psi=(1, .3), x=(.2, -.4)),
        dict(degree=12, order=12, psi=(.4, -.5), x=(-.3, .6)),
        dict(degree=12, order=0, psi=(.2, .3), x=(-.1, .2))])
    result = sample_pattern(PatternRequest(model="spherical_harmonic", spherical_harmonic_profile=p,
        frequency_hz=p.frequency_hz, polar_steps=12, azimuth_steps=24, orientation_deg=(13, 21, -15)))
    assert result["sphere_mean_gain"] == pytest.approx(p.radiation_efficiency, abs=4e-14)
    assert result["integration_rule"] == dict(polar_coordinate="cos(theta)", polar_rule="Gauss-Legendre",
        polar_nodes=13, azimuth_rule="periodic trapezoid", azimuth_nodes=25,
        independent_of_display_resolution=True)

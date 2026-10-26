"""Exact PV field parity against the pre-optimization function, not a new model."""
from dataclasses import asdict
import math
import random

import pytest

from cubesat_sim.power.models import PVPanel, unit_vector
from cubesat_sim.power.solar import PVGeneration, pv_extraction, pv_generation


def original_pv_generation(
    panel, sun_direction_body, irradiance_w_m2=1361, sun_visibility=1,
    extraction_fraction=1, regulator_efficiency=1,
):
    # Copied verbatim arithmetic/validation from the original projection function.
    unit_vector(sun_direction_body)
    if (
        not math.isfinite(irradiance_w_m2)
        or irradiance_w_m2 < 0
        or any(
            not math.isfinite(v) or not 0 <= v <= 1
            for v in (sun_visibility, extraction_fraction, regulator_efficiency)
        )
    ):
        raise ValueError("Finite nonnegative irradiance and fractions within[0,1] required")
    cosine = max(0, sum(a * b for a, b in zip(panel.normal_body, sun_direction_body)))
    if cosine < 1e-14:
        cosine = 0
    incident = (
        irradiance_w_m2 * panel.active_area_m2 * cosine
        * sun_visibility * panel.self_visibility
    )
    absorbed = panel.solar_absorptivity * incident
    available = panel.efficiency * panel.electrical_derate * incident
    terminal = available * extraction_fraction * panel.enabled
    bus = terminal * regulator_efficiency
    heat, regulator = absorbed - terminal, terminal - bus
    return PVGeneration(
        incident, absorbed, available, terminal, bus, heat, regulator,
        available - terminal, absorbed - heat - regulator - bus,
    )


def exact_fields(actual, expected):
    assert {key: float(value).hex() for key, value in asdict(actual).items()} == {
        key: float(value).hex() for key, value in asdict(expected).items()
    }


def panel(**change):
    return PVPanel.model_validate(dict(
        panel_id='test', thermal_node_id='panel', active_area_m2=0.04,
        normal_body=(0, 1, 0), solar_absorptivity=0.9, efficiency=0.29,
    ) | change)


def test_random_pv_projection_and_reextraction_are_bit_exact():
    rng = random.Random(20261025)
    for _ in range(2000):
        def unit():
            values = tuple(rng.uniform(-1, 1) for _ in range(3))
            length = math.hypot(*values)
            return tuple(value / length for value in values)
        absorption = rng.random()
        selected = panel(
            active_area_m2=rng.random() * 2,
            normal_body=unit(), solar_absorptivity=absorption,
            efficiency=rng.random() * absorption,
            electrical_derate=rng.random(), self_visibility=rng.random(),
            enabled=rng.choice((True, False)),
        )
        sun, irradiance, visibility = unit(), rng.random() * 2000, rng.random()
        extraction, regulator = rng.random(), rng.random()
        expected = original_pv_generation(selected, sun, irradiance, visibility, extraction, regulator)
        exact_fields(pv_generation(selected, sun, irradiance, visibility, extraction, regulator), expected)
        potential = pv_generation(selected, sun, irradiance, visibility, regulator_efficiency=regulator)
        exact_fields(pv_extraction(selected, potential, extraction, regulator), expected)


@pytest.mark.parametrize('enabled', [True, False])
@pytest.mark.parametrize('sun,irradiance,visibility', [
    ((0, 1, 0), 1361, 1), ((0, 1, 0), 0, 1),
    ((0, 1, 0), 1361, 0), ((0, -1, 0), 1361, 1),
    ((1, 0, 0), 1361, 1), ((1, 1e-15, 0), 1361, 1),
])
@pytest.mark.parametrize('extraction,regulator', [(0, 0), (0, 1), (1, 0), (1, 1), (0.37, 0.91)])
def test_zero_sun_disabled_curtailment_and_limit_fields_are_exact(enabled, sun, irradiance, visibility, extraction, regulator):
    selected = panel(enabled=enabled)
    potential = pv_generation(selected, sun, irradiance, visibility, regulator_efficiency=regulator)
    expected = original_pv_generation(selected, sun, irradiance, visibility, extraction, regulator)
    exact_fields(pv_extraction(selected, potential, extraction, regulator), expected)
    if not enabled and irradiance and visibility and sun[1] == 1:
        assert potential.available_mpp_w > 0
        assert expected.terminal_w == 0
        assert expected.panel_heat_w == expected.absorbed_solar_w


def test_reextraction_uses_available_power_not_previous_terminal_or_enabled_state():
    selected = panel()
    partial = pv_generation(selected, (0, 1, 0), extraction_fraction=0.2, regulator_efficiency=0.8)
    exact_fields(pv_extraction(selected, partial, 0.6, 0.95),
                 original_pv_generation(selected, (0, 1, 0), extraction_fraction=0.6, regulator_efficiency=0.95))
    disabled = panel(enabled=False)
    exact_fields(pv_extraction(disabled, partial, 1, 0.95),
                 original_pv_generation(disabled, (0, 1, 0), regulator_efficiency=0.95))


@pytest.mark.parametrize('value', [-0.01, 1.01, float('nan'), float('inf')])
def test_public_fraction_validation_remains_checked(value):
    selected = panel()
    potential = pv_generation(selected, (0, 1, 0))
    for keyword in ('extraction_fraction', 'regulator_efficiency'):
        with pytest.raises(ValueError):
            pv_extraction(selected, potential, **{keyword: value})
        with pytest.raises(ValueError):
            pv_generation(selected, (0, 1, 0), **{keyword: value})
    for direction in ((0, 0, 0), (float('nan'), 0, 1), (2, 0, 0)):
        with pytest.raises(ValueError):
            pv_generation(selected, direction)

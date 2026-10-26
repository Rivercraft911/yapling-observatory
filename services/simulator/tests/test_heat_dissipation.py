"""Electrical-export and external-irradiation planes remain separate from heat."""

import pytest

from cubesat_sim.power.heat import total_dissipation_w
from cubesat_sim.power.loads import load_ledger
from cubesat_sim.power.models import ComponentLoad
from cubesat_sim.power.radio import transmit_power


def total(components=(), **kwargs):
    return total_dissipation_w(
        components,
        **(
            dict(
                wheel_heat_w=0,
                magnetorquer_heat_w=0,
                regulator_heat_w=0,
                storage_loss_w=0,
            )
            | kwargs
        ),
    )


def test_whole_spacecraft_draw_and_dissipation_are_distinct_at_radio_planes():
    radio = transmit_power(10, 4, 1, 1)
    ledgers = [
        load_ledger(
            ComponentLoad(
                component_id=name,
                thermal_node_id=name,
                electrical_w=power,
                escaped_rf_w=escaped,
            )
        )
        for name, power, escaped in [
            ("obc", 2, 0),
            ("eps", 0.5, 0),
            ("radio", 10, radio.escaped_rf_w),
        ]
    ]
    heat = total([item.heat_w for item in ledgers], wheel_heat_w=1.2)
    assert 10 + 2 + 0.5 + 1.2 == 13.7
    assert heat == pytest.approx(13.7 - radio.escaped_rf_w)
    assert radio.transmitter_heat_w == 6
    assert radio.total_heat_w == pytest.approx(6.822687061102874)
    assert total(
        [item.heat_w for item in ledgers],
        wheel_heat_w=1.2,
        regulator_heat_w=0.4,
        storage_loss_w=0.02,
        uhf_heat_w=0.3,
    ) == pytest.approx(heat + 0.72)


def test_exported_and_stored_power_are_removed_before_local_dissipation_sum():
    load = load_ledger(
        ComponentLoad(
            component_id="reference",
            thermal_node_id="bus",
            electrical_w=8,
            escaped_rf_w=1,
            other_export_w=2,
            stored_mechanical_w=3,
        )
    )
    assert total(
        [load.heat_w], wheel_heat_w=0.2, magnetorquer_heat_w=0.1
    ) == pytest.approx(2.3)
    assert total() == 0


@pytest.mark.parametrize("value", [-1, float("nan"), float("inf"), True, "1"])
def test_nonphysical_heat_terms_are_rejected(value):
    with pytest.raises(ValueError):
        total([value])
    with pytest.raises(ValueError):
        total([], uhf_heat_w=value)


def test_overflow_is_rejected():
    with pytest.raises(ValueError, match="finite"):
        total([1e308, 1e308])

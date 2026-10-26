"""Direction-time conservation, half-open edges and legacy identity compatibility."""

from types import SimpleNamespace
import math

from pydantic import ValidationError
import pytest

from cubesat_sim.models import Schedule, Scenario, default_scenario
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.operations.capacity import integrate_ideal_capacity
from cubesat_sim.operations.schedule import active_direction, schedule_cuts
from test_mission_rf_efficiency import config as visible_mission


def scenario(schedule):
    return SimpleNamespace(schedule=schedule)


@pytest.mark.parametrize("first", ["uplink", "downlink"])
def test_legacy_equal_slot_shape_identity_and_arithmetic_are_preserved(first):
    legacy = {"slot_duration_s": 30, "first_direction": first}
    absent = Schedule.model_validate(legacy)
    explicit_null = Schedule.model_validate(
        legacy | {"uplink_duration_s": None, "downlink_duration_s": None}
    )
    assert (
        absent.model_dump(mode="json")
        == legacy
        == explicit_null.model_dump(mode="json")
    )
    source = default_scenario().model_dump(mode="json") | {"schedule": legacy}
    a = Scenario.model_validate(source)
    b = Scenario.model_validate(
        source | {"schedule": explicit_null.model_dump(mode="json")}
    )
    assert a.identity() == b.identity()
    other = "downlink" if first == "uplink" else "uplink"
    for i in range(20000):
        t = i * 0.1
        expected = first if math.floor(t / 30 + 1e-12) % 2 == 0 else other
        assert active_direction(scenario(absent), t) == expected
    for start, end in [(0, 120), (0.1, 1), (29.9, 90.1), (30, 60), (2999990, 3000010)]:
        assert schedule_cuts(start, end, absent) == schedule_cuts(start, end, 30)


@pytest.mark.parametrize("first", ["uplink", "downlink"])
def test_unequal_slots_obey_half_open_boundaries_and_repeat(first):
    schedule = Schedule(
        first_direction=first, uplink_duration_s=5, downlink_duration_s=60
    )
    first_duration = 5 if first == "uplink" else 60
    other = "downlink" if first == "uplink" else "uplink"
    for cycle in [0, 1, 100, 39876]:
        start = cycle * 65
        for offset, expected in [
            (0, first),
            (first_duration - 1e-6, first),
            (first_duration, other),
            (65 - 1e-6, other),
            (65, first),
        ]:
            assert active_direction(scenario(schedule), start + offset) == expected
    assert schedule_cuts(0, 130, schedule) == [
        0,
        first_duration,
        65,
        65 + first_duration,
        130,
    ]
    assert schedule_cuts(first_duration, 65, schedule) == [first_duration, 65]
    assert schedule_cuts(0.25, 0.75, schedule) == [0.25, 0.75]


def test_fractional_direction_edges_keep_short_slots_and_exact_cut_endpoints():
    schedule = Schedule(
        first_direction="downlink", uplink_duration_s=1.1, downlink_duration_s=3.3
    )
    for cycle in [0, 1, 100, 500000]:
        edge = cycle * 4.4 + 3.3
        assert active_direction(scenario(schedule), edge - 1e-6) == "downlink"
        assert active_direction(scenario(schedule), edge) == "uplink"
        assert active_direction(scenario(schedule), (cycle + 1) * 4.4) == "downlink"
    cuts = schedule_cuts(2, 9, schedule)
    assert cuts == pytest.approx([2, 3.3, 4.4, 7.7, 8.8, 9], abs=1e-14)
    assert all(a < b for a, b in zip(cuts, cuts[1:]))


@pytest.mark.parametrize(
    "values",
    [
        {"uplink_duration_s": 5},
        {"downlink_duration_s": 60},
        {"uplink_duration_s": 5, "downlink_duration_s": None},
        {"uplink_duration_s": 0, "downlink_duration_s": 60},
        {"uplink_duration_s": 5, "downlink_duration_s": 3601},
        {"uplink_duration_s": float("nan"), "downlink_duration_s": 60},
    ],
)
def test_invalid_or_unpaired_explicit_durations_are_rejected(values):
    with pytest.raises(ValidationError):
        Schedule.model_validate(values)


def test_mission_validates_actual_direction_durations_against_dynamics_clock():
    values = default_mission_scenario().model_dump(mode="json")
    values["clocks"]["dynamics_step_s"] = 2
    with pytest.raises(ValidationError, match="integer dynamics ticks"):
        MissionScenario.model_validate(values)
    values["clocks"]["dynamics_step_s"] = 0.25
    values["schedule"].update(
        slot_duration_s=1.01, uplink_duration_s=1.25, downlink_duration_s=2.5
    )
    MissionScenario.model_validate(values)
    values["schedule"]["uplink_duration_s"] = 1.3
    with pytest.raises(ValidationError, match="integer dynamics ticks"):
        MissionScenario.model_validate(values)


def test_capacity_conserves_direction_time_independent_of_output_grid():
    schedule = Schedule(
        first_direction="downlink", uplink_duration_s=5, downlink_duration_s=60
    )
    link = SimpleNamespace(
        profile=SimpleNamespace(threshold_db=0), spacecraft_antenna="patch"
    )
    c = SimpleNamespace(
        schedule=schedule, antenna_variant="dipole", uplink=link, downlink=link
    )
    state = lambda t: {"time_s": t}
    evaluate = lambda _config, direction, _state: {
        "ideal_rate_bps": 100 if direction == "uplink" else 200
    }
    for times in [[0, 130], [0, 59, 61, 64, 66, 129, 130], list(range(131))]:
        available, bits = integrate_ideal_capacity(c, times, state, evaluate)
        assert all(available.values())
        assert bits["uplink"][-1] == 100 * 10
        assert bits["downlink"][-1] == 200 * 120
    unknown = SimpleNamespace(
        profile=SimpleNamespace(threshold_db=None), spacecraft_antenna="patch"
    )
    c.uplink = unknown
    available, bits = integrate_ideal_capacity(c, [0, 130], state, evaluate)
    assert available["uplink"] is False and bits["uplink"] == [None, None]


def test_new_mission_default_is_user_selected_60_second_tx_5_second_rx_only():
    mission = default_mission_scenario()
    assert mission.schedule.first_direction == "downlink"
    assert mission.schedule.downlink_duration_s == 60
    assert mission.schedule.uplink_duration_s == 5
    assert any("60 s downlink then 5 s uplink" in entry for entry in mission.provenance)
    assert default_scenario().schedule.model_dump(mode="json") == {
        "slot_duration_s": 30,
        "first_direction": "uplink",
    }


def test_coupled_radio_energy_uses_all_60_tx_and_5_rx_seconds_without_output_aliasing():
    values = visible_mission().model_dump(mode="json")
    values["duration_s"] = 65
    values["conops"]["windows"][0]["end_s"] = 65
    values["schedule"].update(
        first_direction="downlink", downlink_duration_s=60, uplink_duration_s=5
    )
    config = MissionScenario.model_validate(values)
    result = run_mission(config)
    samples = result["samples"]
    assert all(samples["radio_active"])
    assert result["summary"]["energy_j"]["requested_load_j"] == pytest.approx(
        60 * 23.5 + 5 * 11
    )
    escaped_per_second = 2.5 * 10 ** (-1 / 10)
    assert result["summary"]["energy_j"]["escaped_rf_j"] == pytest.approx(
        60 * escaped_per_second
    )
    # Power columns retain the preceding accepted interval; direction is the endpoint state.
    assert samples["active_direction"][60] == "uplink"
    assert samples["power"]["component_electrical_w"]["radio"][60] == 14
    assert samples["power"]["component_electrical_w"]["radio"][61] == 1.5
    assert samples["active_direction"][65] == "downlink"
    assert samples["power"]["component_electrical_w"]["radio"][65] == 1.5
    for component, expected in (("obc", 8), ("camera", 1), ("eps", 0.5)):
        assert all(
            value == expected
            for value in samples["power"]["component_electrical_w"][component]
        )
    assert abs(result["summary"]["energy_j"]["closure_residual_j"]) < 1e-6

from copy import deepcopy
import json
import pytest
from cubesat_sim import mission_archive as archive
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.operations.radio_delivery_models import delivery_example
from test_mission import overhead_config

@pytest.fixture(scope="module")
def snapshot():
    data = overhead_config(60)
    data["duration_s"] = 60
    data["radio_delivery"] = delivery_example(default_mission_scenario().uplink, default_mission_scenario().downlink).model_dump(mode="json")
    scenario = MissionScenario.model_validate(data)
    result = run_mission(scenario)
    identity, digest = scenario.identity()
    return json.loads(json.dumps(dict(scenario=scenario.model_dump(mode="json"), run=dict(run_id="report-roundtrip", status="complete", scenario_id=identity, scenario_hash=digest, result=result, error=None))))

def test_daily_receiver_report_roundtrips(snapshot):
    assert snapshot["run"]["result"]["summary"]["radio_delivery"]["downlink"]["delivered_useful_bits"] > 1000000
    encoded = archive.export_archive(snapshot)
    assert archive.import_archive(encoded)["snapshot"] == snapshot

@pytest.mark.parametrize("mutation", [
    lambda r: r["summary"]["reporting"]["days"][0].update(geometric_pass_count=9),
    lambda r: r["summary"]["reporting"]["days"][0].update(partial_day=False),
    lambda r: r["summary"]["reporting"]["days"][0].update(date_utc="2030-01-01"),
    lambda r: r["summary"]["reporting"]["days"][0]["downlink"].update(ideal_capacity_bits=1000),
    lambda r: r["samples"]["radio_delivery"]["downlink"]["mode_index"].__setitem__(0, 99),
    lambda r: r["samples"]["radio_delivery"]["downlink"]["delivered_useful_bits"].__setitem__(0, 1),
    lambda r: r["samples"]["radio_delivery"]["downlink"]["locked"].__setitem__(0, True),
])
def test_inconsistent_report_is_rejected(snapshot, mutation):
    broken = deepcopy(snapshot)
    mutation(broken["run"]["result"])
    with pytest.raises(archive.ArchiveError):
        archive.export_archive(broken)


@pytest.mark.parametrize("period", ["days", "passes"])
@pytest.mark.parametrize("available,payload", [(False, 0), (True, None), (None, 0), (1, 0)])
def test_report_payload_and_availability_must_agree(snapshot, period, available, payload):
    changed = deepcopy(snapshot)
    changed["run"]["result"]["summary"]["reporting"][period][0]["downlink"].update(
        delivery_available=available, delivered_useful_bits=payload)
    with pytest.raises(archive.ArchiveError):
        archive.export_archive(changed)


@pytest.mark.parametrize("period", ["days", "passes"])
def test_known_report_payload_must_match_receiver_total(snapshot, period):
    changed = deepcopy(snapshot)
    changed["run"]["result"]["summary"]["reporting"][period][0]["downlink"]["delivered_useful_bits"] -= 1
    with pytest.raises(archive.ArchiveError, match="frame payload differs"):
        archive.export_archive(changed)


def test_unknown_period_can_precede_known_daily_payload_and_midnight_endpoint_is_preserved():
    from types import SimpleNamespace
    from cubesat_sim.mission.reporting import MissionReporter
    epoch = "2026-10-25T23:59:59Z"
    model = SimpleNamespace(epoch_utc=epoch, radio_delivery=object())
    def increment(bits=0, available=True, boundary=0):
        return dict(delivered_useful_bits=bits, delivery_available=available,
                    receiver_locked_s=0, receiver_ready_s=0,
                    boundary_delivered_useful_bits=boundary,
                    boundary_delivered_frames=int(boundary > 0), boundary_unresolved_frames=0)
    reporter = MissionReporter(epoch, delivery_enabled=True)
    for start, end, available, bits in [(0, 1, False, 0), (1, 2, True, 100)]:
        reporter.advance(start, end, visible=True, elevation_deg=20, radio_active=True,
                         direction="downlink", ideal_rates_bps=dict(uplink=0, downlink=0),
                         delivery_interval=lambda a,b,ok=available,value=bits: dict(
                             uplink=increment(), downlink=increment(value,ok)))
    reporter.finish(True)
    summary = dict(computed_duration_s=2, ideal_capacity_bits=dict(uplink=0, downlink=0),
                   radio_delivery=dict(uplink=dict(delivery_available=True,delivered_useful_bits=0),
                                       downlink=dict(delivery_available=False,delivered_useful_bits=100)))
    archive._validate_reporting(reporter.snapshot(), model, summary)
    assert reporter.snapshot()["days"][0]["downlink"]["delivered_useful_bits"] is None
    assert reporter.snapshot()["days"][1]["downlink"]["delivered_useful_bits"] == 100
    boundary = MissionReporter(epoch, delivery_enabled=True)
    boundary.advance(0,1,visible=True,elevation_deg=20,radio_active=True,direction="downlink",
                     ideal_rates_bps=dict(uplink=0,downlink=0),
                     delivery_interval=lambda *_: dict(uplink=increment(),downlink=increment(100,boundary=100)))
    boundary.finish(True)
    summary.update(computed_duration_s=1)
    summary["radio_delivery"]["downlink"]["delivery_available"] = True
    archive._validate_reporting(boundary.snapshot(),model,summary)
    assert boundary.snapshot()["days"][1]["endpoint_only"]


def test_unmodeled_report_cannot_claim_known_delivery_availability():
    from types import SimpleNamespace
    from cubesat_sim.mission.reporting import MissionReporter
    epoch = "2026-10-25T00:00:00Z"
    reporter = MissionReporter(epoch)
    reporter.advance(0,1,visible=False,elevation_deg=-20,radio_active=False,direction="uplink",
                     ideal_rates_bps=dict(uplink=0,downlink=0))
    report = reporter.snapshot()
    model = SimpleNamespace(epoch_utc=epoch,radio_delivery=None)
    summary = dict(computed_duration_s=1,ideal_capacity_bits=dict(uplink=0,downlink=0))
    archive._validate_reporting(report,model,summary)
    report["days"][0]["uplink"]["delivery_available"] = False
    with pytest.raises(archive.ArchiveError):
        archive._validate_reporting(report,model,summary)


@pytest.mark.parametrize("period", ["days", "passes"])
def test_known_periods_cannot_exceed_known_decoded_count_when_global_delivery_is_unresolved(snapshot, period):
    changed = deepcopy(snapshot)
    result = changed["run"]["result"]
    result["summary"]["radio_delivery"]["downlink"]["delivery_available"] = False
    result["samples"]["radio_delivery"]["downlink"]["delivery_available"] = [False] * len(result["samples"]["time_s"])
    # A false global availability flag retains its integer definite-decoded count.
    archive.export_archive(changed)
    result["summary"]["reporting"][period][0]["downlink"]["delivered_useful_bits"] += 1
    with pytest.raises(archive.ArchiveError, match="known frame payload exceeds"):
        archive.export_archive(changed)

"""Live I/O cannot reset physics, retime commands or mutate immutable replay."""
from copy import deepcopy
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from cubesat_sim import mission_archive as archive
from cubesat_sim.mission import driver
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.geometry import operation_at
from cubesat_sim.mission.runtime import RuntimeDirective
from cubesat_sim.mission_models import MissionScenario, PointingCommand, PointingIntent


def inputs(duration=120):
    value=default_mission_scenario().model_dump(mode="json")
    value["duration_s"]=duration
    value["clocks"]["output_step_s"]=10
    return value


def normalized(value):
    return json.loads(json.dumps(value,allow_nan=False))


def row_at(samples,index):
    return {key:row_at(value,index) if isinstance(value,dict) else value[index]
            for key,value in samples.items()}


class Capture:
    def __init__(self,commands=None,stop=None,mutate_callbacks=False):
        self.commands=commands or {}
        self.stop=stop
        self.mutate_callbacks=mutate_callbacks
        self.calls=[];self.acks=[];self.rows=[]

    def before_step(self,time_s,controller_boundary):
        self.calls.append((time_s,controller_boundary))
        return RuntimeDirective(commands=tuple(self.commands.get(time_s,())),stop=time_s==self.stop)

    def on_command(self,command):
        self.acks.append(deepcopy(command))
        if self.mutate_callbacks: command.update(command_id="mutated outside core",mode="auto")

    def on_sample(self,row):
        self.rows.append(deepcopy(row))
        if self.mutate_callbacks:
            row["gnc"]["requested_torque_body_nm"]=(999,999,999)
            row["power"]["component_electrical_w"].clear()
            row["mode"]="mutated outside core"


def as_snapshot(result):
    scenario=result["manifest"]["scenario"]
    return normalized(dict(scenario=scenario,run=dict(
        run_id="continuous-runtime-test",status="complete",scenario_id=result["manifest"]["scenario_id"],
        scenario_hash=result["manifest"]["scenario_hash"],result=result,error=None,
    )))


def assert_production_replay(result):
    config=MissionScenario.model_validate(result["manifest"]["scenario"])
    replay=driver.run_mission(config)
    for key in ("samples","summary","events"):
        assert normalized(replay[key])==normalized(result[key]),key
    assert replay["manifest"]["scenario_id"]==result["manifest"]["scenario_id"]
    assert replay["manifest"]["scenario_hash"]==result["manifest"]["scenario_hash"]
    snapshot=as_snapshot(result)
    encoded=archive.export_archive(snapshot)
    assert archive.import_archive(encoded)["snapshot"]==snapshot
    return replay


def test_noop_runtime_preserves_every_numerical_value_and_streams_real_copied_rows():
    config=MissionScenario.model_validate(inputs(60));original=config.model_dump(mode="json")
    baseline=driver.run_mission(config);capture=Capture(mutate_callbacks=True)
    live=driver.run_mission(config,runtime=capture)
    for key in ("samples","summary","events"):
        assert normalized(live[key])==normalized(baseline[key])
    assert config.model_dump(mode="json")==original
    assert capture.calls==[(float(i),i%2==0) for i in range(60)]
    assert normalized(capture.rows)==[normalized(row_at(live["samples"],i)) for i in range(7)]
    assert live["manifest"]["scenario"]["pointing_commands"] is None
    assert live["manifest"]["scenario"]["stop_time_s"] is None


def test_commands_keep_one_continuous_integrator_and_replay_exactly_at_output_boundaries(monkeypatch):
    counts={"orbit":0,"body":0}
    original_orbit=driver.elements_to_cartesian
    original_body=driver.state_from_relative_wheel_speeds
    def orbit(*args,**kwargs):
        counts["orbit"]+=1;return original_orbit(*args,**kwargs)
    def body(*args,**kwargs):
        counts["body"]+=1;return original_body(*args,**kwargs)
    monkeypatch.setattr(driver,"elements_to_cartesian",orbit)
    monkeypatch.setattr(driver,"state_from_relative_wheel_speeds",body)
    commands={
        0:[dict(command_id="start",mode="sun_pointing")],
        20:[dict(command_id="station",mode="ground_tracking")],
        40:[dict(command_id="camera",mode="imaging",target_latitude_deg=37.4,target_longitude_deg=-122.1)],
        60:[dict(command_id="automatic",mode="auto")],
        80:[dict(command_id="nadir",mode="imaging")],
        100:[dict(command_id="sun",mode="sun_pointing")],
        # The horizon has no next numerical step, so this is never accepted.
        120:[dict(command_id="too_late",mode="ground_tracking")],
    }
    config=MissionScenario.model_validate(inputs());capture=Capture(commands,mutate_callbacks=True)
    live=driver.run_mission(config,runtime=capture)
    assert counts==dict(orbit=1,body=1)
    assert config.pointing_commands is None
    assert [ack["effective_time_s"] for ack in capture.acks]==[0,20,40,60,80,100]
    assert [ack["command_id"] for ack in capture.acks]==["start","station","camera","automatic","nadir","sun"]
    assert live["manifest"]["scenario"]["pointing_commands"]==capture.acks
    assert capture.rows[0]["stage_id"]=="command_start"
    # A row at20 precedes a command received at20; previously published rows
    # cannot be changed after the fact. The command controls interval20->21.
    samples=live["samples"];at20=samples["time_s"].index(20);at30=samples["time_s"].index(30)
    assert samples["mode"][at20]=="sun_pointing"
    assert samples["mode"][at30]=="ground_tracking"
    assert all(event["command"]["command_id"]!="too_late" for event in live["events"] if event["type"]=="pointing_command")
    assert normalized(capture.rows)==[normalized(row_at(samples,i)) for i in range(13)]
    assert live["summary"]["computed_duration_s"]==120
    assert live["manifest"]["numerical_settings"]["completed_dynamics_ticks"]==120
    assert_production_replay(live)


@pytest.mark.parametrize("stop",[0,1,7,10,19])
def test_stop_flushes_real_prefix_and_replays_exactly_including_archives(stop):
    commands={0:[dict(command_id="first",mode="imaging")], 2:[dict(command_id="second",mode="sun_pointing")]}
    capture=Capture(commands,stop=stop)
    live=driver.run_mission(MissionScenario.model_validate(inputs(60)),runtime=capture)
    assert live["summary"]["end_reason"]=="user_stop"
    assert live["summary"]["computed_duration_s"]==stop
    assert live["manifest"]["scenario"]["stop_time_s"]==stop
    assert live["samples"]["time_s"][-1]==stop
    assert live["manifest"]["numerical_settings"]["completed_dynamics_ticks"]==stop
    assert len(set(live["samples"]["time_s"]))==len(live["samples"]["time_s"])
    assert capture.calls[-1][0]==stop
    assert abs(live["summary"]["energy_j"]["closure_residual_j"])<1e-6
    if stop==0:
        assert capture.acks==[]
        assert live["manifest"]["scenario"]["pointing_commands"] is None
        assert live["summary"]["energy_j"]["served_load_j"]==0
        assert live["samples"]["power"]["requested_load_w"]==[0]
        assert live["samples"]["q_body_from_inertial_wxyz"][0]==pytest.approx(default_mission_scenario().spacecraft.initial_q_body_from_inertial_wxyz)
    assert normalized(capture.rows)==[normalized(row_at(live["samples"],i)) for i in range(len(capture.rows))]
    assert_production_replay(live)


def test_stop_wins_without_accepting_same_directive_commands():
    capture=Capture({4:[dict(command_id="ignored",mode="imaging")]},stop=4)
    result=driver.run_mission(MissionScenario.model_validate(inputs(60)),runtime=capture)
    assert capture.acks==[]
    assert result["manifest"]["scenario"]["pointing_commands"] is None
    assert not any(e["type"]=="pointing_command" for e in result["events"])
    assert_production_replay(result)


def test_same_boundary_commands_are_ordered_and_auto_restores_original_windows():
    value=inputs(60)
    value["conops"]["windows"]=[dict(window_id="original_camera",start_s=0,end_s=60,mode="imaging")]
    value["pointing_commands"]=[dict(command_id="future_sun",effective_time_s=40,mode="sun_pointing")]
    capture=Capture({
        10:[dict(command_id="sun1",mode="sun_pointing"),dict(command_id="ground2",mode="ground_tracking")],
        20:[dict(command_id="restore",mode="auto")],
    })
    result=driver.run_mission(MissionScenario.model_validate(value),runtime=capture)
    recorded=MissionScenario.model_validate(result["manifest"]["scenario"])
    assert [c.command_id for c in recorded.pointing_commands]==["sun1","ground2","restore","future_sun"]
    assert operation_at(recorded,10,False,0)[:2]==("ground_tracking","command_ground2")
    assert operation_at(recorded,20,False,0)[:2]==("imaging","original_camera")
    assert operation_at(recorded,40,False,0)[:2]==("sun_pointing","command_future_sun")
    assert_production_replay(result)


def test_core_rejects_off_boundary_and_duplicate_batches_atomically():
    value=inputs(60);config=MissionScenario.model_validate(value)
    capture=Capture({1:[dict(command_id="off_tick",mode="sun_pointing")]})
    with pytest.raises(ValueError,match="controller boundary"):
        driver.run_mission(config,runtime=capture)
    assert capture.acks==[] and config.pointing_commands is None
    capture=Capture({2:[dict(command_id="duplicate",mode="sun_pointing"),dict(command_id="duplicate",mode="imaging")]})
    with pytest.raises(ValidationError,match="unique"):
        driver.run_mission(config,runtime=capture)
    assert capture.acks==[] and config.pointing_commands is None


@pytest.mark.parametrize("bad",[
    dict(command_id="time-injection",mode="sun_pointing",effective_time_s=0),
    dict(command_id="",mode="auto"),dict(command_id="wrong-mode",mode="detumble"),
    dict(command_id="coordinates",mode="ground_tracking",target_latitude_deg=0,target_longitude_deg=0),
    dict(command_id="half-target",mode="imaging",target_latitude_deg=0),
    dict(command_id="nonfinite",mode="imaging",target_latitude_deg=float('nan'),target_longitude_deg=0),
])
def test_intents_reject_caller_timestamp_and_invalid_targets(bad):
    with pytest.raises(ValidationError):RuntimeDirective(commands=(bad,))


@pytest.mark.parametrize("commands",[
    [dict(command_id="offclock",effective_time_s=1,mode="auto")],
    [dict(command_id="late",effective_time_s=122,mode="auto")],
    [dict(command_id="later",effective_time_s=4,mode="auto"),dict(command_id="earlier",effective_time_s=2,mode="auto")],
    [dict(command_id="same",effective_time_s=0,mode="auto"),dict(command_id="same",effective_time_s=2,mode="auto")],
    [dict(command_id="bool-time",effective_time_s=True,mode="auto")],
])
def test_recorded_commands_obey_clocks_order_ids_and_horizon(commands):
    value=inputs();value["pointing_commands"]=commands
    with pytest.raises(ValidationError):MissionScenario.model_validate(value)


@pytest.mark.parametrize("stop",[-1,.5,120,121,True])
def test_recorded_stop_is_a_strict_numerical_boundary_before_horizon(stop):
    value=inputs();value["stop_time_s"]=stop
    with pytest.raises(ValidationError):MissionScenario.model_validate(value)


def test_command_limit_and_runtime_directive_types():
    value=inputs(300);value["pointing_commands"]=[dict(command_id=str(i),effective_time_s=i*2,mode="auto") for i in range(128)]
    MissionScenario.model_validate(value)
    value["pointing_commands"].append(dict(command_id="extra",effective_time_s=256,mode="auto"))
    with pytest.raises(ValidationError):MissionScenario.model_validate(value)
    with pytest.raises(ValueError):RuntimeDirective(stop=1)
    class Wrong(Capture):
        def before_step(self,*_):return {"commands":[]}
    with pytest.raises(TypeError,match="RuntimeDirective"):
        driver.run_mission(MissionScenario.model_validate(inputs(60)),runtime=Wrong())


def test_new_null_fields_preserve_historical_browser_identity_when_record_available():
    path=Path(__file__).resolve().parents[3]/"private/verification/2026-10-25-power-zoom/browser-day-run.json"
    if not path.exists():pytest.skip("Private frozen browser record unavailable")
    result=json.loads(path.read_text())["result"];raw=result["manifest"]["scenario"]
    config=MissionScenario.model_validate(raw)
    assert config.identity()==(result["manifest"]["scenario_id"],result["manifest"]["scenario_hash"])
    for field in ("pointing_commands","stop_time_s"):raw[field]=None
    assert MissionScenario.model_validate(raw).identity()==config.identity()


def test_archive_rejects_forged_stop_boundary_and_command_event():
    result=driver.run_mission(MissionScenario.model_validate(inputs(60)),runtime=Capture({0:[dict(command_id="real",mode="imaging")]},stop=7))
    snapshot=as_snapshot(result)
    changed=deepcopy(snapshot);changed["run"]["result"]["summary"]["computed_duration_s"]=6
    with pytest.raises(archive.ArchiveError,match="recorded boundary"):
        archive.validate_snapshot(changed)
    changed=deepcopy(snapshot)
    event=next(e for e in changed["run"]["result"]["events"] if e["type"]=="pointing_command")
    event["command"]["command_id"]="not-in-timeline"
    with pytest.raises(archive.ArchiveError,match="absent"):
        archive.validate_snapshot(changed)


def test_fractional_clock_canonicalizes_recorded_times_and_live_command_wins_same_tick():
    value=inputs(1)
    value["clocks"].update(dynamics_step_s=.1,controller_period_s=.3,thermal_step_s=.1,output_step_s=.1)
    value["pointing_commands"]=[dict(command_id="planned",effective_time_s=.3000000001,mode="imaging")]
    config=MissionScenario.model_validate(value)
    assert config.pointing_commands[0].effective_time_s==3*.1
    capture=Capture({3*.1:[dict(command_id="live",mode="sun_pointing")]})
    result=driver.run_mission(config,runtime=capture)
    commands=result["manifest"]["scenario"]["pointing_commands"]
    assert [c["command_id"] for c in commands]==["planned","live"]
    assert commands[0]["effective_time_s"]==commands[1]["effective_time_s"]==3*.1
    assert operation_at(MissionScenario.model_validate(result["manifest"]["scenario"]),3*.1,False,0)[:2]==("sun_pointing","command_live")
    assert_production_replay(result)
    value["pointing_commands"][0]["effective_time_s"]=.3
    assert MissionScenario.model_validate(value).pointing_commands[0].effective_time_s==3*.1


def test_fractional_stop_is_canonical_and_preserves_input_data():
    value=inputs(1);value["clocks"].update(dynamics_step_s=.1,controller_period_s=.3,thermal_step_s=.1,output_step_s=.1)
    value["stop_time_s"]=.3000000001
    original=deepcopy(value);config=MissionScenario.model_validate(value)
    assert value==original
    assert config.stop_time_s==3*.1
    result=driver.run_mission(config)
    assert result["summary"]["computed_duration_s"]==3*.1
    assert_production_replay(result)


class TelemetryCapture(Capture):
    telemetry_period_s=1
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs);self.telemetry=[]
    def on_telemetry(self,row):
        self.telemetry.append(deepcopy(row))
        row["mode"]="external observer mutation"
        row["thermal"]["node_temperature_k"].clear()


@pytest.mark.parametrize("unresolved",[False,True])
@pytest.mark.parametrize("stop",[None,7])
def test_extra_real_telemetry_does_not_change_any_completed_result_or_archive(unresolved,stop):
    value=inputs(60)
    if unresolved:
        value["antenna_variant"]="v45"
        value["uplink"].update(spacecraft_antenna="wire",spacecraft_peak_gain_dbi=2.15)
    config=MissionScenario.model_validate(value)
    commands={0:[dict(command_id="initial",mode="ground_tracking")],2:[dict(command_id="switch",mode="sun_pointing")]}
    baseline_capture=Capture(commands,stop=stop);telemetry_capture=TelemetryCapture(commands,stop=stop)
    baseline=driver.run_mission(config,runtime=baseline_capture)
    telemetry=driver.run_mission(config,runtime=telemetry_capture)
    assert normalized(telemetry)==normalized(baseline)
    assert archive.export_archive(as_snapshot(telemetry))==archive.export_archive(as_snapshot(baseline))
    assert normalized(telemetry_capture.rows)==normalized(baseline_capture.rows)
    assert len(telemetry_capture.telemetry)>len(telemetry_capture.rows)
    times=[row["time_s"] for row in telemetry_capture.telemetry]
    assert times==sorted(times)
    horizon=60 if stop is None else stop
    assert set(times)==set(range(horizon+1))
    assert normalized(telemetry_capture.telemetry[-1])==normalized(telemetry_capture.rows[-1])
    if stop==7:
        # t7 before stop still contains the held thermal state. The final flush
        # updates the actual model state at the same time and replaces latest.
        before_stop=next(row for row in telemetry_capture.telemetry if row["time_s"]==7)
        assert before_stop["thermal"]["node_temperature_k"]==telemetry_capture.telemetry[0]["thermal"]["node_temperature_k"]
        assert telemetry_capture.telemetry[-1]["thermal"]["node_temperature_k"]!=before_stop["thermal"]["node_temperature_k"]
    assert telemetry["manifest"]["numerical_settings"]["output_step_s"]==10
    assert telemetry["manifest"]["numerical_settings"]["thermal_step_s"]==10
    assert_production_replay(telemetry)


def test_no_command_high_rate_telemetry_is_identical_to_plain_production_run():
    config=MissionScenario.model_validate(inputs(60))
    plain=driver.run_mission(config);capture=TelemetryCapture()
    streamed=driver.run_mission(config,runtime=capture)
    assert normalized(streamed)==normalized(plain)
    assert archive.export_archive(as_snapshot(streamed))==archive.export_archive(as_snapshot(plain))
    assert [r["time_s"] for r in capture.telemetry]==list(range(61))
    assert [r["time_s"] for r in capture.rows]==list(range(0,61,10))


@pytest.mark.parametrize("period",[0,-1,.5,float('nan'),float('inf'),True])
def test_extra_telemetry_period_is_an_explicit_valid_numerical_tick_multiple(period):
    capture=TelemetryCapture();capture.telemetry_period_s=period
    with pytest.raises(ValueError,match="telemetry period"):
        driver.run_mission(MissionScenario.model_validate(inputs(60)),runtime=capture)


def test_extra_telemetry_requires_its_separate_callback():
    capture=Capture();capture.telemetry_period_s=1
    with pytest.raises(ValueError,match="on_telemetry callback"):
        driver.run_mission(MissionScenario.model_validate(inputs(60)),runtime=capture)

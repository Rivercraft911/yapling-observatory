"""Independent moving-LOS kinematics, control authority and legacy identity checks."""
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path

import pytest
from pydantic import ValidationError

from cubesat_sim import mission_archive as archive
from cubesat_sim.attitude.control import AttitudeReference, PDConfig, quaternion_pd, minimum_rotation_reference
from cubesat_sim.attitude.dynamics import AttitudeState, RigidBody
from cubesat_sim.attitude.guidance import direction_motion
from cubesat_sim.attitude.kinematics import conjugate, rotate
from cubesat_sim.geometry.vectors import add, cross, dot, norm, scale, unit
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission.ephemeris import EARTH_OMEGA_RAD_S, ecef_to_inertial, sun_direction_inertial, sun_direction_derivatives_inertial
from cubesat_sim.mission.geometry import geometry_at, operation_at, target_direction, target_motion
from cubesat_sim.mission_models import MissionScenario, MissionWindow
from cubesat_sim.orbit.elements import elements_to_cartesian
from cubesat_sim.orbit.two_body import CartesianState, TwoBodyConfig


def short_config(reference="moving_boresight", duration=60):
    value = default_mission_scenario().model_dump(mode="json")
    value["duration_s"] = duration
    value["spacecraft"]["pointing_reference"] = reference
    return value


def derivative(values, step):
    minus, center, plus = values
    return (tuple((p-m)/(2*step) for m,p in zip(minus,plus)),
            tuple((p-2*c+m)/step**2 for m,c,p in zip(minus,center,plus)))


def rotated_z(vector, angle):
    x,y,z = vector
    return (math.cos(angle)*x-math.sin(angle)*y,
            math.sin(angle)*x+math.cos(angle)*y,z)


def orbit_and_geometry():
    config = default_mission_scenario()
    state = elements_to_cartesian(config.orbit.elements, config.orbit.mu_m3_s2)
    orbit = CartesianState(0, state.position_m, state.velocity_m_s)
    geo = geometry_at(config, orbit, AttitudeState(0,(1,0,0,0),(0,0,0)))
    gravity = TwoBodyConfig(config.orbit.mu_m3_s2, 1, force_model=config.orbit.force_model,
                           reference_radius_m=config.orbit.reference_radius_m,j2=config.orbit.j2).gravity
    return config, orbit, geo, gravity.acceleration_m_s2(orbit.position_m)


def test_direction_motion_circular_radial_reversal_and_angular_acceleration():
    radius, rate = 7e6, 0.013
    value = direction_motion((radius,0,0),(0,radius*rate,0),(-radius*rate**2,0,0))
    assert value.direction_inertial == pytest.approx((1,0,0),abs=2e-16)
    assert value.omega_inertial_rad_s == pytest.approx((0,0,rate),abs=1e-18)
    assert value.alpha_inertial_rad_s2 == pytest.approx((0,0,0),abs=1e-18)
    radial = direction_motion((1e6,0,0),(100,0,0),(3,0,0))
    assert radial.omega_inertial_rad_s == radial.alpha_inertial_rad_s2 == (0,0,0)
    p,v,a = (12.,-4.,7.),(-.3,.8,1.2),(.02,.03,-.04)
    result = direction_motion(p,v,a)
    h=.001
    samples=[unit(tuple(x+t*y+.5*t*t*z for x,y,z in zip(p,v,a))) for t in (-h,0,h)]
    udot, uddot = derivative(samples,h)
    assert result.omega_inertial_rad_s == pytest.approx(cross(samples[1],udot),abs=2e-9)
    assert result.alpha_inertial_rad_s2 == pytest.approx(cross(samples[1],uddot),abs=2e-9)
    reversed_los = direction_motion(scale(p,-1),scale(v,-1),scale(a,-1))
    assert reversed_los.direction_inertial == scale(result.direction_inertial,-1)
    assert reversed_los.omega_inertial_rad_s == result.omega_inertial_rad_s
    assert dot(result.direction_inertial,result.omega_inertial_rad_s) == pytest.approx(0,abs=1e-16)
    for invalid in ((0,0,0),(math.nan,0,1)):
        with pytest.raises(ValueError): direction_motion(invalid,v,a)


@pytest.mark.parametrize("mode", ["ground_tracking","imaging_target","imaging_nadir"])
def test_target_motion_against_independently_differenced_rotating_target(mode):
    config, orbit, geo, acceleration = orbit_and_geometry()
    window=None
    if mode=="ground_tracking":
        target=geo["station_position_m"]
        actual_mode=mode
    elif mode=="imaging_target":
        window=MissionWindow(window_id="camera",start_s=0,end_s=60,mode="imaging",target_latitude_deg=34,target_longitude_deg=-120)
        # Independent WGS84 Cartesian target construction.
        lat,lon=map(math.radians,(34,-120));e2=6.6943799901413165e-3
        n=6378137/math.sqrt(1-e2*math.sin(lat)**2)
        target=ecef_to_inertial((n*math.cos(lat)*math.cos(lon),n*math.cos(lat)*math.sin(lon),n*(1-e2)*math.sin(lat)),config.epoch_utc)
        actual_mode="imaging"
    else:
        target=(0,0,0);actual_mode="imaging"
    h=.1
    directions=[]
    for t in (-h,0,h):
        station=rotated_z(target,EARTH_OMEGA_RAD_S*t)
        satellite=tuple(r+t*v+.5*t*t*a for r,v,a in zip(orbit.position_m,orbit.velocity_m_s,acceleration))
        directions.append(unit(tuple(g-s for g,s in zip(station,satellite))))
    udot,uddot=derivative(directions,h)
    result=target_motion(config,geo,actual_mode,window,orbit,acceleration)
    assert result.direction_inertial == pytest.approx(directions[1],abs=2e-15)
    assert result.omega_inertial_rad_s == pytest.approx(cross(directions[1],udot),abs=3e-11)
    assert result.alpha_inertial_rad_s2 == pytest.approx(cross(directions[1],uddot),abs=5e-13)
    if mode=="ground_tracking":
        fixed_station=direction_motion(add(target,scale(orbit.position_m,-1)),scale(orbit.velocity_m_s,-1),scale(acceleration,-1))
        assert norm(add(result.omega_inertial_rad_s,scale(fixed_station.omega_inertial_rad_s,-1))) > 1e-6


def test_sun_derivatives_match_existing_sun_and_centered_differences():
    for epoch,time in (("2026-10-25T20:00:00Z",0),("2028-02-28T23:59:00Z",300),("2029-12-31T00:00:00Z",12345)):
        u,du,ddu=sun_direction_derivatives_inertial(epoch,time)
        assert u == sun_direction_inertial(epoch,time)
        h=100
        fd,sd=derivative([sun_direction_inertial(epoch,time+t) for t in (-h,0,h)],h)
        assert du == pytest.approx(fd,abs=2e-15)
        assert ddu == pytest.approx(sd,abs=3e-17)
        motion=direction_motion(u,du,ddu)
        assert cross(motion.omega_inertial_rad_s,u)==pytest.approx(du,abs=1e-21)


def test_moving_reference_removes_false_damping_of_correct_tracking_rate():
    body=RigidBody(((.002,0,0),(0,.002,0),(0,0,.002)))
    gains=PDConfig((1e-5,)*3,(3e-4,)*3)
    state=AttitudeState(0,(1,0,0,0),(0,0,.01))
    reference=AttitudeReference((1,0,0,0),(0,0,.01))
    command=quaternion_pd(body,state,reference,gains,(0,1,0),damp_free_roll_rate=True)
    legacy=quaternion_pd(body,state,AttitudeReference((1,0,0,0)),gains,(0,1,0),damp_free_roll_rate=True)
    assert command.requested_body_control_torque_nm == pytest.approx((0,0,0),abs=1e-20)
    assert legacy.requested_body_control_torque_nm == pytest.approx((0,0,-3e-6),abs=1e-20)
    # At a misaligned body pose, rate error must be formed in body axes.
    q=(math.cos(.3),math.sin(.3),0,0)
    target=unit((.2,.8,.5))
    omega=cross(target,(0,0,.01))
    state=AttitudeState(0,q,add(rotate(q,omega),(0,.03,0)))
    reference=minimum_rotation_reference(state,(0,1,0),target)
    reference=AttitudeReference(reference.q_reference_from_inertial_wxyz,omega)
    free=quaternion_pd(body,state,reference,gains,(0,1,0),damp_free_roll_rate=False)
    damped=quaternion_pd(body,state,reference,gains,(0,1,0),damp_free_roll_rate=True)
    assert free.rate_error_body_rad_s == pytest.approx((0,0,0),abs=1e-17)
    assert free.requested_body_control_torque_nm[1] == pytest.approx(0,abs=1e-18)
    assert damped.rate_error_body_rad_s == pytest.approx((0,.03,0),abs=1e-17)
    assert damped.requested_body_control_torque_nm[1] < 0


def test_mode_priority_and_ground_direction_are_explicit():
    c=short_config(duration=60)
    c["conops"]["windows"]=[dict(window_id="manual_camera",start_s=10,end_s=20,mode="imaging")]
    config=MissionScenario.model_validate(c)
    assert operation_at(config,9,False)[:2]==("sun_pointing","auto_sun_pointing")
    assert operation_at(config,9,True)[:2]==("ground_tracking","auto_ground_tracking")
    assert operation_at(config,10,True)[:2]==("imaging","manual_camera")
    assert operation_at(config,20,True)[:2]==("ground_tracking","auto_ground_tracking")
    config,orbit,geo,acceleration=orbit_and_geometry()
    motion=target_motion(config,geo,"ground_tracking",None,orbit,acceleration)
    assert motion.direction_inertial == pytest.approx(scale(geo["k"],-1),abs=2e-16)
    q=minimum_rotation_reference(AttitudeState(0,(1,0,0,0),(0,0,0)),(0,1,0),motion.direction_inertial).q_reference_from_inertial_wxyz
    assert rotate(conjugate(q),(0,1,0))==pytest.approx(motion.direction_inertial,abs=1e-15)


@pytest.mark.parametrize("selection", [None,"instantaneous_zero_rate","moving_boresight"])
def test_reference_identity_and_archive_roundtrip(selection):
    data=short_config(selection)
    data.update(radio_delivery=None, uhf_beacon=None)
    config=MissionScenario.model_validate(data)
    result=run_mission(config)
    identity,digest=config.identity()
    run=dict(run_id="moving-reference-roundtrip",status="complete",scenario_id=identity,scenario_hash=digest,result=result,error=None)
    snapshot=json.loads(json.dumps(dict(scenario=config.model_dump(mode="json"),run=run)))
    encoded=archive.export_archive(snapshot)
    assert archive.import_archive(encoded)["snapshot"]==snapshot
    if selection is None:
        omitted=deepcopy(data);omitted["spacecraft"].pop("pointing_reference")
        assert MissionScenario.model_validate(omitted).identity()==config.identity()
        canonical=config.model_dump(mode="json");canonical["spacecraft"].pop("pointing_reference");canonical.pop("radio_delivery",None);canonical.pop("uhf_beacon",None);canonical["conops"].pop("ground_tracking_min_elevation_deg",None);canonical.pop("pointing_commands",None);canonical.pop("stop_time_s",None)
        assert hashlib.sha256(json.dumps(canonical,sort_keys=True,separators=(",",":"),allow_nan=False).encode()).hexdigest()==digest
    else:
        assert result["manifest"]["scenario"]["spacecraft"]["pointing_reference"]==selection
    if selection=="moving_boresight":
        data["spacecraft"]["free_roll"]=False
        with pytest.raises(ValidationError,match="requires free_roll"):
            MissionScenario.model_validate(data)


def test_moving_reference_still_enforces_wheel_torque_and_missing_actuator_limits():
    data=short_config(duration=60)
    data["spacecraft"]["magnetic_unloading_enabled"] = False
    data["spacecraft"]["initial_q_body_from_inertial_wxyz"]=[1,0,0,0]
    for wheel in data["spacecraft"]["wheels"]: wheel["spec"]["max_motor_torque_nm"]=1e-7
    result=run_mission(MissionScenario.model_validate(data));gnc=result["samples"]["gnc"]
    assert any(gnc["wheel_saturated"])
    assert max(abs(t) for row in gnc["actual_torque_body_nm"] for t in row)<=1e-7*(1+1e-12)
    assert max(norm(v) for v in gnc["residual_torque_body_nm"])>1e-6
    data["spacecraft"]["wheels"]=[];data["spacecraft"]["magnetorquer"]["enabled"]=False
    coast=run_mission(MissionScenario.model_validate(data))
    assert set(coast["samples"]["gnc"]["controller_status"])=={"no_actuator_coast"}
    assert all(q==[1,0,0,0] or q==(1,0,0,0) for q in coast["samples"]["q_body_from_inertial_wxyz"])


def aligned_overhead_config(reference, step=1):
    data=short_config(reference,300)
    data["clocks"].update(output_step_s=10,dynamics_step_s=step)
    initial=MissionScenario.model_validate(data)
    state=elements_to_cartesian(initial.orbit.elements,initial.orbit.mu_m3_s2)
    from cubesat_sim.mission.ephemeris import inertial_to_ecef
    ecef=inertial_to_ecef(state.position_m,initial.epoch_utc)
    data["station"].update(latitude_deg=0,longitude_deg=math.degrees(math.atan2(ecef[1],ecef[0])))
    config=MissionScenario.model_validate(data)
    orbit=CartesianState(0,state.position_m,state.velocity_m_s)
    geo=geometry_at(config,orbit,AttitudeState(0,(1,0,0,0),(0,0,0)))
    gravity=TwoBodyConfig(config.orbit.mu_m3_s2,1,force_model=config.orbit.force_model,
                         reference_radius_m=config.orbit.reference_radius_m,j2=config.orbit.j2).gravity
    motion=target_motion(config,geo,"ground_tracking",None,orbit,gravity.acceleration_m_s2(orbit.position_m))
    from cubesat_sim.attitude.kinematics import boresight_reference
    q=boresight_reference((1,0,0,0),(0,1,0),motion.direction_inertial)
    data["spacecraft"].update(initial_q_body_from_inertial_wxyz=q,
                              initial_omega_body_rad_s=rotate(q,motion.omega_inertial_rad_s))
    return MissionScenario.model_validate(data)


def test_already_acquired_overhead_pass_tracks_motion_and_refines_without_gain_changes():
    moving=run_mission(aligned_overhead_config("moving_boresight"))
    stationary=run_mission(aligned_overhead_config("instantaneous_zero_rate"))
    def ground_error(result):
        samples=result["samples"]
        return max(error for error,mode in zip(samples["attitude_angle_deg"],samples["mode"]) if mode=="ground_tracking")
    assert ground_error(moving)<.03
    assert ground_error(stationary)>16
    # Already acquired initial pose/rate isolates tracking from the mode-switch
    # slew. Refinement changes dynamics/orbit, with controller/thermal fixed.
    half=run_mission(aligned_overhead_config("moving_boresight",.5))
    quarter=run_mission(aligned_overhead_config("moving_boresight",.25))
    def differences(first,second):
        values=[]
        for time,qa,qb in zip(first["samples"]["time_s"],first["samples"]["q_body_from_inertial_wxyz"],second["samples"]["q_body_from_inertial_wxyz"]):
            if time<=180:
                sign=1 if dot(qa,qb)>=0 else -1
                values.append(math.degrees(4*math.atan2(norm(tuple(x-sign*y for x,y in zip(qa,qb))),norm(tuple(x+sign*y for x,y in zip(qa,qb))))))
        return max(values)
    coarse_difference=differences(moving,half)
    fine_difference=differences(half,quarter)
    assert fine_difference<coarse_difference
    assert fine_difference<.002
    assert abs(moving["summary"]["energy_j"]["closure_residual_j"])<1e-6


def test_acquisition_elevation_is_optional_auto_only_and_separate_from_rf_visibility():
    data=aligned_overhead_config("moving_boresight").model_dump(mode="json")
    data["duration_s"]=600
    data["orbit"]["elements"]["true_anomaly_deg"]=-15
    data["conops"]["ground_tracking_min_elevation_deg"]=25
    scenario=MissionScenario.model_validate(data)
    assert operation_at(scenario,0,True,24)[0]=="sun_pointing"
    assert operation_at(scenario,0,True,25)[0]=="ground_tracking"
    assert operation_at(scenario,0,False,25)[0]=="sun_pointing"
    with pytest.raises(ValueError,match="requires station geometry"):
        operation_at(scenario,0,True)
    manual=deepcopy(data)
    manual["conops"]["windows"]=[dict(window_id="manual_ground",mode="ground_tracking",start_s=0,end_s=10)]
    assert operation_at(MissionScenario.model_validate(manual),0,False,0)[:2]==("ground_tracking","manual_ground")
    result=run_mission(scenario);samples=result["samples"]
    modes=[event["mode"] for event in result["events"] if event["type"]=="state"]
    assert modes[0]==modes[-1]=="sun_pointing"
    assert "ground_tracking" in modes
    below_acquisition=[i for i,(visible,elevation) in enumerate(zip(samples["visible"],samples["elevation_deg"])) if visible and elevation<25]
    assert below_acquisition
    for i in below_acquisition:
        assert samples["mode"][i]=="sun_pointing"
        assert samples["radio_active"][i] is False
        assert samples["uplink"]["ideal_rate_bps"][i]==samples["downlink"]["ideal_rate_bps"][i]==0
    for selection in (None,25):
        data["conops"]["ground_tracking_min_elevation_deg"]=selection
        config=MissionScenario.model_validate(data)
        explicit=config.identity()
        if selection is None:
            omitted=deepcopy(data);omitted["conops"].pop("ground_tracking_min_elevation_deg")
            assert MissionScenario.model_validate(omitted).identity()==explicit
        # Archive acceptance includes both new explicit values and legacy null.
        short=deepcopy(data);short["duration_s"]=60
        config=MissionScenario.model_validate(short);result=run_mission(config);identity,digest=config.identity()
        snapshot=json.loads(json.dumps(dict(scenario=config.model_dump(mode="json"),run=dict(run_id="acquisition-archive",status="complete",scenario_id=identity,scenario_hash=digest,result=result,error=None))))
        assert archive.import_archive(archive.export_archive(snapshot))["snapshot"]==snapshot

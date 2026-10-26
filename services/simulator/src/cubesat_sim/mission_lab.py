"""Mission HTTP adapter. Numerical state/equations live in named pure domains."""

from dataclasses import asdict, replace
import json
from typing import Literal
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from pydantic import Field
from .mission_models import MissionModel, MissionScenario, MissionOrbit
from .mission.defaults import (
    default_mission_scenario,
    actuator_presets,
    orbit_with_ltan,
    orbit_metadata,
)
from .mission.ephemeris import mean_sun_ra_deg
from .mission_archive import ArchiveError, export_request, import_archive
from .orbit.elements import first_order_sso_inclination_deg
from .orbit.gravity import GravityPotential
from .models import Link
from .power.radio import transmit_power, heat_only_load
from .rf.mission_efficiency import resolve_downlink_efficiency, AnalyticalEfficiencySemantics
from .operations.radio_delivery_models import delivery_example

router = APIRouter(prefix="/api/mission", tags=["mission"])


class MissionRequest(MissionModel):
    scenario: MissionScenario


class RadioPowerRequest(MissionModel):
    tx_electrical_w: float = Field(ge=0, strict=True)
    rx_electrical_w: float = Field(ge=0, strict=True)
    idle_electrical_w: float = Field(ge=0, strict=True)
    downlink: Link
    analytical_radiation_efficiency: float = Field(ge=0, le=1, strict=True)
    analytical_efficiency_semantics: AnalyticalEfficiencySemantics | None = None
    antenna_variant: Literal["dipole", "turnstile", "v45"] = "dipole"


class DeliveryExampleRequest(MissionModel):
    uplink: Link
    downlink: Link


@router.post("/delivery-example")
def receiver_example(request: DeliveryExampleRequest):
    try:
        return delivery_example(request.uplink, request.downlink).model_dump(mode="json")
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


class OrbitRequest(MissionModel):
    orbit: MissionOrbit
    ltan_hours: float | None = Field(default=None, ge=0, lt=24)
    sso: bool = False


@router.get("/default")
def default_config():
    return {"scenario": default_mission_scenario().model_dump(mode="json")}


@router.get("/demo/daytime-pass")
def daytime_demo():
    from .mission.daytime_demo import daytime_overhead_demo
    return {"scenario": daytime_overhead_demo().model_dump(mode="json")}


@router.post("/orbit")
def resolve_orbit(request: OrbitRequest):
    try:
        data = request.orbit.model_dump(mode="json")
        elements = request.orbit.elements
        if request.ltan_hours is not None:
            elements = orbit_with_ltan(elements, request.ltan_hours)
        if request.sso:
            gravity = GravityPotential(
                request.orbit.mu_m3_s2,
                request.orbit.reference_radius_m,
                request.orbit.j2,
            )
            inclination = first_order_sso_inclination_deg(
                elements.semi_major_axis_m,
                elements.eccentricity,
                360 / 365.2422,
                gravity,
            )
            if inclination is None:
                raise ValueError("No first-order SSO inclination for these inputs")
            elements = replace(elements, inclination_deg=inclination)
            data["preset"] = "first_order_mean_J2_terminator_estimate"
        data["elements"] = elements.__dict__
        data["ltan_hours_at_epoch"] = orbit_metadata(elements)["ltan_hours"]
        return {
            "orbit": MissionOrbit.model_validate(data).model_dump(mode="json"),
            "solar_time_convention": "local_mean_solar_time_at_ascending_node",
            "mean_sun_ra_deg": mean_sun_ra_deg(elements.epoch_utc),
        }
    except (ValueError, ArithmeticError) as error:
        raise HTTPException(422, str(error)) from error


@router.post("/runs", status_code=202)
async def create_run(request: MissionRequest, http_request: Request):
    config = request.scenario
    from .mission_models import mission_execution_limits

    limits = mission_execution_limits(config)
    if limits["estimated_work_units"] > limits["maximum_work_units"]:
        raise HTTPException(
            422,
            f"Mission exceeds the {limits['maximum_work_units']} reference work-unit budget; reduce explicit model cost or duration",
        )
    try:
        return http_request.app.state.mission_jobs.create(config).record()
    except ValueError as error:
        raise HTTPException(429, str(error)) from error


@router.get("/runs/{run_id}")
def get_run(run_id: str, request: Request):
    job = request.app.state.mission_jobs.get(run_id)
    if job is None:
        raise HTTPException(404, "Unknown mission run")
    return job.record()


@router.delete("/runs/{run_id}")
async def cancel_run(run_id: str, request: Request):
    job = await request.app.state.mission_jobs.cancel(run_id)
    if job is None:
        raise HTTPException(404, "Unknown mission run")
    return job.record()


@router.get("/actuator-presets")
def presets():
    return actuator_presets()


@router.post("/archive/export")
async def save_archive(request: Request):
    data = await request.body()
    try:
        archive = await run_in_threadpool(export_request, data)
    except ArchiveError as error:
        raise HTTPException(422, str(error)) from error
    return Response(
        archive,
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="ssi-mission.json"'},
    )


@router.post("/archive/import")
async def open_archive(request: Request):
    data = await request.body()
    try:
        result = await run_in_threadpool(import_archive, data)
        # Serialize the complete history in the same bounded background lane.
        response = await run_in_threadpool(
            lambda: json.dumps(result, separators=(",", ":"), allow_nan=False).encode("utf-8")
        )
    except ArchiveError as error:
        raise HTTPException(422, str(error)) from error
    return Response(response, media_type="application/json")


@router.post("/radio-power")
def radio_power(request: RadioPowerRequest):
    try:
        context = resolve_downlink_efficiency(
            request.downlink, request.antenna_variant,
            request.analytical_radiation_efficiency,
            request.analytical_efficiency_semantics,
        )
        efficiency = context.radiation_efficiency
        return dict(
            transmit=asdict(transmit_power(
                request.tx_electrical_w, request.downlink.tx_power_w,
                request.downlink.tx_feed_loss_db, efficiency,
            )),
            receive=heat_only_load(request.rx_electrical_w),
            idle=heat_only_load(request.idle_electrical_w),
        )
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.get("/battery-electrical-default")
def battery_electrical_default():
    from .power.battery_electrical import electrical_defaults, electrical_model_metadata
    return dict(electrical=electrical_defaults(), metadata=electrical_model_metadata())


@router.get("/wheel-reference")
def wheel_reference_example():
    from .attitude.wheel_profiles import wheel_example_metadata, wheel_profiles
    return dict(example=wheel_example_metadata(), references=wheel_profiles())

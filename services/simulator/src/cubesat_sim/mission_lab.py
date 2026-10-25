"""Mission HTTP adapter. Numerical state/equations live in named pure domains."""

from dataclasses import replace
import json
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

router = APIRouter(prefix="/api/mission", tags=["mission"])


class MissionRequest(MissionModel):
    scenario: MissionScenario


class OrbitRequest(MissionModel):
    orbit: MissionOrbit
    ltan_hours: float | None = Field(default=None, ge=0, lt=24)
    sso: bool = False


@router.get("/default")
def default_config():
    return {"scenario": default_mission_scenario().model_dump(mode="json")}


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
    ticks = round(config.duration_s / config.clocks.dynamics_step_s)
    environments = config.duration_s / config.clocks.thermal_step_s
    cost = (
        ticks * (1 + len(config.spacecraft.wheels))
        + environments
        * len(config.power.surfaces)
        * config.power.earth_quadrature_rings
        * config.power.earth_quadrature_azimuths
    )
    if cost > 100_000_000:
        raise HTTPException(
            422,
            "Mission exceeds explicit100M reference work-unit budget; choose shorter duration or a documented coarser/faster fidelity setting",
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

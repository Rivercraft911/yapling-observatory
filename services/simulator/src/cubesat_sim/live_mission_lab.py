"""Validated LIVE transport; physical targets and states are computed in Python."""
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import Field, model_validator

from .geometry.ground_target import ground_target_from_ecef
from .mission_models import MissionModel, MissionScenario, PointingIntent
from .mission.numerics import NumericalStepIntent

router = APIRouter(prefix='/api/live', tags=['live-mission'])


class LiveRequest(MissionModel):
    scenario: MissionScenario
    speed: float = Field(default=1, ge=1, le=1000, strict=True)


class LiveControl(MissionModel):
    speed: float | None = Field(default=None, ge=1, le=1000, strict=True)
    paused: bool | None = Field(default=None, strict=True)
    stop: bool | None = Field(default=None, strict=True)

    @model_validator(mode='after')
    def nonempty(self):
        if self.speed is None and self.paused is None and self.stop is None:
            raise ValueError('Supply a LIVE control')
        return self


class GroundTargetRequest(MissionModel):
    position_ecef_m: tuple[float, float, float]


def session(request, live_id):
    job = request.app.state.live_jobs.get(live_id)
    if job is None:
        raise HTTPException(404, 'LIVE session not found; history is local and session-scoped')
    return job


def response(request, job, after_sequence=0):
    try:
        return {'session': request.app.state.live_jobs.record(job, after_sequence)}
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.post('/ground-target')
def ground_target(body: GroundTargetRequest):
    try:
        return ground_target_from_ecef(body.position_ecef_m)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.post('', status_code=202)
async def create_live(body: LiveRequest, request: Request):
    try:
        job = request.app.state.live_jobs.create(body.scenario, body.speed)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return response(request, job)


@router.get('/{live_id}')
async def get_live(live_id: str, request: Request, after_sequence: int = Query(default=0, ge=0)):
    return response(request, session(request, live_id), after_sequence)


@router.post('/{live_id}/control')
async def control_live(live_id: str, body: LiveControl, request: Request):
    job = session(request, live_id)
    try:
        request.app.state.live_jobs.control(job, **body.model_dump())
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return response(request, job)


@router.post('/{live_id}/commands', status_code=202)
async def command_live(live_id: str, body: PointingIntent, request: Request):
    job = session(request, live_id)
    try:
        request.app.state.live_jobs.command(job, body)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return response(request, job) | {'command_id': body.command_id, 'receipt': 'queued'}


@router.post('/{live_id}/numerics', status_code=202)
async def numerical_live(live_id: str, body: NumericalStepIntent, request: Request):
    job = session(request, live_id)
    try:
        request.app.state.live_jobs.numerical_command(job, body)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return response(request, job) | {'command_id': body.command_id, 'receipt': 'queued'}


@router.delete('/{live_id}')
async def cancel_live(live_id: str, request: Request):
    job = session(request, live_id)
    await request.app.state.live_jobs.cancel(live_id)
    return response(request, job)


@router.get('/{live_id}/archive')
async def live_archive(live_id: str, request: Request):
    job = session(request, live_id)
    if job.status != 'complete' or job.archive is None:
        raise HTTPException(409, 'Only a completed, validated LIVE history can be archived')
    return Response(job.archive, media_type='application/json', headers={
        'Content-Disposition': f'attachment; filename="live-{live_id}.ssi-mission.json"',
    })

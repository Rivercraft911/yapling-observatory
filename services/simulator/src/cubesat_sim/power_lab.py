"""Bounded local power-study adapter. Equations live in power/ and thermal/."""
import math
from fastapi import APIRouter, HTTPException
from .power.models import StudyConfig, BatterySpec
from .power.study import default_study_config, run_study, stage_templates
from .power.battery import capacity_wh

router = APIRouter(prefix="/api/power-lab", tags=["power-lab"])


@router.get("/default")
def default_config():
    return default_study_config().model_dump(mode="json")


@router.get("/stage-templates")
def templates():
    return stage_templates()


@router.post("/capacity")
def capacity(spec: BatterySpec):
    return {"capacity_wh": capacity_wh(spec)}


@router.post("/study")
def study(config: StudyConfig):
    ticks = math.ceil(config.stages[-1].end_s / config.integration_step_s)
    if ticks * len(config.thermal.nodes) > 100000:
        raise HTTPException(422, "Interactive study exceeds 100,000 node steps; increase the integration step or shorten the study.")
    try:
        return run_study(config)
    except (ValueError, ArithmeticError) as exc:
        raise HTTPException(422, str(exc)) from exc

"""Thin HTTP adapter; antenna formulas live in rf/pattern_sampling.py."""
from fastapi import APIRouter
from .antenna_models import PatternRequest, RunProbe
from .rf.pattern_sampling import (
    MODEL_VERSION, IDENTITY, MODELS, orientation_matrix, direction_from_angles,
    pattern_response, field_components, probe_response, sample_pattern,
)

router = APIRouter(prefix="/api/antenna-lab", tags=["antenna-lab"])


@router.get("/catalog")
def catalog():
    return dict(model_version=MODEL_VERSION, models=MODELS, default_request=PatternRequest().model_dump(mode="json"))


@router.post("/pattern")
def pattern(request: PatternRequest):
    return sample_pattern(request)


@router.post("/probe")
def probe(request: PatternRequest):
    """Constant-work probe; playback never rebuilds or resamples the sphere."""
    return probe_response(request)

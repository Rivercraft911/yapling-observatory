"""Thin HTTP adapter; antenna formulas live in rf/pattern_sampling.py."""
from fastapi import APIRouter
from .antenna_models import PatternRequest, RunProbe, LinkPatternReference
from .rf.spherical_harmonics import reference_profiles
from .rf.pattern_sampling import (
    MODEL_VERSION, IDENTITY, MODELS, orientation_matrix, direction_from_angles,
    pattern_response, field_components, probe_response, sample_pattern, pattern_request_for_link,
)

router = APIRouter(prefix="/api/antenna-lab", tags=["antenna-lab"])


@router.get("/catalog")
def catalog():
    return dict(model_version=MODEL_VERSION, models=MODELS, examples=reference_profiles(), default_request=PatternRequest().model_dump(mode="json"))


@router.post("/pattern")
def pattern(request: PatternRequest):
    return sample_pattern(request)


@router.post("/probe")
def probe(request: PatternRequest):
    """Constant-work probe; playback never rebuilds or resamples the sphere."""
    return probe_response(request)


@router.post("/reference-request", response_model=PatternRequest)
def reference_request(request: LinkPatternReference):
    return pattern_request_for_link(request.link, request.antenna_variant)

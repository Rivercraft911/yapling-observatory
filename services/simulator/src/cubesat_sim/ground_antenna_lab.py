"""HTTP adapter for an explicit ground-dish aperture estimate."""

from fastapi import APIRouter, HTTPException
from pydantic import Field

from .models import FrozenModel
from .rf.aperture import circular_aperture_gain

router = APIRouter(prefix="/api/ground-antennas", tags=["ground-antennas"])


class DishGainRequest(FrozenModel):
    diameter_m: float = Field(gt=0, le=100, strict=True)
    frequency_hz: float = Field(gt=1e6, le=40e9, strict=True)
    aperture_efficiency: float = Field(gt=0, le=1, strict=True)


@router.post("/dish-gain")
def dish_gain(request: DishGainRequest):
    try:
        return circular_aperture_gain(
            request.diameter_m, request.frequency_hz, request.aperture_efficiency
        )
    except ValueError as error:
        raise HTTPException(422, str(error)) from error

"""HTTP adapter for a coupled RF-profile and receiver-channel edit."""

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import Field

from .models import FrozenModel, RadioProfile
from .operations.radio_delivery_models import DirectionDelivery
from .mission.radio_channel import resolve_radio_channel

router = APIRouter(prefix="/api/mission", tags=["mission"])


class RadioChannelRequest(FrozenModel):
    profile: RadioProfile
    delivery: DirectionDelivery | None = None
    channel_bandwidth_hz: float = Field(gt=0, le=2e8, strict=True)
    rolloff: Literal[0.2, 0.25, 0.35]


@router.post("/radio-channel")
def radio_channel(request: RadioChannelRequest):
    try:
        return resolve_radio_channel(
            request.profile,
            request.delivery,
            request.channel_bandwidth_hz,
            request.rolloff,
        )
    except ValueError as error:
        raise HTTPException(422, str(error)) from error

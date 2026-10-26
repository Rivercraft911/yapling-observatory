"""HTTP adapter for conditional MODCOD planning footprints."""

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import Field

from .mission_models import MissionScenario
from .models import FrozenModel, Scenario
from .operations.radio_delivery_models import normal_psk_modes
from .rf.coverage import coverage_contours

router = APIRouter(prefix="/api/mission", tags=["mission"])


class CoverageRequest(FrozenModel):
    scenario: MissionScenario | Scenario
    direction: Literal["uplink", "downlink"]
    altitude_m: float | None = Field(default=None, ge=100000, le=50000000, strict=True)
    polarization_loss_db: float = Field(default=0, ge=0, le=100, strict=True)


@router.post("/coverage")
def coverage(request: CoverageRequest):
    scenario = request.scenario
    link = getattr(scenario, request.direction)
    receiver_config = getattr(scenario, "radio_delivery", None)
    receiver = getattr(receiver_config, request.direction) if receiver_config else None
    try:
        if link.profile.waveform != "dvb_s2":
            raise ValueError("MODCOD coverage requires a DVB-S2 link; LoRa remains separate")
        source = "configured_receiver" if receiver else "ideal_normal_psk_catalogue"
        modes = receiver.modes if receiver else normal_psk_modes(
            link.profile.symbol_rate_sps, link.profile.engineering_reserve_db
        )
        records = [dict(
            mode_id=mode.mode_id, modulation=mode.modulation, code_rate=mode.code_rate,
            symbol_rate_sps=mode.symbol_rate_sps, frame_size=mode.frame_size,
            pilots=mode.pilots, threshold_esn0_db=mode.decode_threshold_esn0_db,
            threshold_status=mode.threshold_status, threshold_source=mode.threshold_source,
            engineering_reserve_db=None if receiver else link.profile.engineering_reserve_db,
        ) for mode in modes]
        altitude = request.altitude_m
        altitude_source = "explicit_geodetic_height"
        if altitude is None:
            orbit = scenario.orbit
            altitude = (orbit.elements.semi_major_axis_m - orbit.reference_radius_m
                        if hasattr(orbit, "elements") else orbit.altitude_m)
            altitude_source = "nominal_orbit_planning_height"
        return coverage_contours(
            scenario, request.direction, altitude, records, mode_source=source,
            polarization_loss_db=request.polarization_loss_db, altitude_source=altitude_source,
        )
    except ValueError as error:
        raise HTTPException(422, str(error)) from error

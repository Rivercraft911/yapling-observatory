"""Total onboard dissipation at the existing accepted-interval power clock.

First-law partition: electrical input becomes escaped exports, changes in
stored mechanical energy, or local dissipation. External absorbed irradiation
is a separate thermal input. See NASA SmallSat 2026 Thermal Control, 7.1 Eq. 1:
https://www.nasa.gov/smallsat-institute/sst-soa/thermal-control/
"""

from collections.abc import Sequence
import math


def total_dissipation_w(
    component_heat_w: Sequence[float],
    *,
    wheel_heat_w: float,
    magnetorquer_heat_w: float,
    regulator_heat_w: float,
    storage_loss_w: float,
    uhf_heat_w: float = 0.0,
) -> float:
    """Sum actual modeled heat sources, each supplied exactly once.

    Component heat is the mode-load/S-band ledger after escaped RF, other
    exports and stored mechanical power have been removed. Exclude UHF from
    that sequence when supplying it separately. Battery and regulator heat
    remain separate because their electrical input is not a component load.
    PV extraction is not a heat source, and absorbed sunlight/albedo/Earth IR
    is not part of this internal-dissipation quantity. Inputs must refer to
    the same interval; edge-resolved powers use their time-weighted means.
    """
    terms = (
        *component_heat_w,
        wheel_heat_w,
        magnetorquer_heat_w,
        regulator_heat_w,
        storage_loss_w,
        uhf_heat_w,
    )
    if any(
        type(value) not in (int, float) or not math.isfinite(value) or value < 0
        for value in terms
    ):
        raise ValueError("Dissipation terms must be finite nonnegative watts")
    try:
        result = math.fsum(terms)
    except OverflowError as error:
        raise ValueError("Total dissipation must be finite") from error
    if not math.isfinite(result):
        raise ValueError("Total dissipation must be finite")
    return result

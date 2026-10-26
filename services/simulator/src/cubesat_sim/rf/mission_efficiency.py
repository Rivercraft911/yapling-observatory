"""One explicit mission RF/heat efficiency context, with legacy semantics intact.

Analytical fields already contain their sphere-mean efficiency. New semantics
apply only an additional loss to field gain, while exported RF power uses the
product. Harmonic accepted-power gain already includes its profile efficiency.
"""

from dataclasses import asdict, dataclass
import math
from typing import Literal

from .antennas import HALF_WAVE_DIRECTIVITY

AnalyticalEfficiencySemantics = Literal["pattern_times_additional_v1"]
EFFICIENCY_SEMANTICS = "pattern_times_additional_v1"


@dataclass(frozen=True)
class DownlinkEfficiency:
    semantics: str | None
    pattern_mean_efficiency: float | None
    additional_efficiency: float | None
    gain_multiplier: float
    radiation_efficiency: float
    source: str

    def record(self):
        return asdict(self)


def resolve_downlink_efficiency(
    link,
    antenna_variant,
    analytical_efficiency,
    semantics=None,
) -> DownlinkEfficiency:
    if semantics not in (None, EFFICIENCY_SEMANTICS):
        raise ValueError("Unsupported analytical antenna efficiency semantics")
    if not math.isfinite(analytical_efficiency) or not 0 <= analytical_efficiency <= 1:
        raise ValueError("Analytical antenna efficiency must be finite and in [0, 1]")
    if link.spacecraft_antenna == "spherical_harmonic":
        efficiency = link.spherical_harmonic_profile.radiation_efficiency
        return DownlinkEfficiency(
            semantics, efficiency, None, 1.0, efficiency, "downlink coefficient profile"
        )
    if semantics is None:
        return DownlinkEfficiency(
            None,
            None,
            None,
            1.0,
            analytical_efficiency,
            "legacy independent heat efficiency",
        )
    peak_linear = 10 ** (link.spacecraft_peak_gain_dbi / 10)
    if link.spacecraft_antenna == "patch":
        mean = min(1.0, peak_linear / 2)
    elif link.spacecraft_antenna == "wire" and antenna_variant in (
        "dipole",
        "turnstile",
    ):
        mean = peak_linear / HALF_WAVE_DIRECTIVITY
    else:
        raise ValueError(
            "Coupled antenna efficiency requires a resolved downlink pattern; "
            "the installed V45 wire pattern has no known sphere-mean efficiency"
        )
    return DownlinkEfficiency(
        semantics,
        mean,
        analytical_efficiency,
        analytical_efficiency,
        mean * analytical_efficiency,
        "analytical pattern mean times explicit additional efficiency",
    )


def mission_downlink_efficiency(scenario) -> DownlinkEfficiency:
    return resolve_downlink_efficiency(
        scenario.downlink,
        scenario.antenna_variant,
        scenario.power.transmit_radiation_efficiency,
        scenario.power.analytical_efficiency_semantics,
    )

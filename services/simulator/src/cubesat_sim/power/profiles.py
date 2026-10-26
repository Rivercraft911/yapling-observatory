"""Editable planning inputs confirmed by the user; no flight hardware calibration."""

from dataclasses import asdict, dataclass
from .radio import transmit_power


@dataclass(frozen=True)
class TransmitterPlanningProfile:
    electrical_w: float = 14.0
    pa_output_w: float = 2.5
    feed_loss_db: float = 1.0
    radiation_efficiency: float = 1.0
    profile_id: str = "user-planning-transmitter-14w-2p5w-2026-10-25"
    source_status: str = "user_confirmed_editable_planning_input"
    source: str = (
        "User selected editable S-band defaults of 14 W total transmitter electrical input / "
        "2.5 W conducted PA-port RF on 25 October 2026; 11.5 W transmitter heat is derived. "
        "Existing 1 dB feed loss and unit radiation "
        "efficiency remain provisional assumptions; downstream losses are separate."
    )

    def __post_init__(self):
        transmit_power(
            self.electrical_w,
            self.pa_output_w,
            self.feed_loss_db,
            self.radiation_efficiency,
        )

    def record(self):
        return asdict(self)


PLANNING_TRANSMITTER = TransmitterPlanningProfile()

PLANNING_ACTIVE_OBC_W = 8.0
PLANNING_ACTIVE_CAMERAS_W = 1.0
PLANNING_ACTIVITY_LOAD_SOURCE = (
    "User selected editable imaging and S-band downlink loads of OBC 8 W and cameras "
    "1 W total on 25 October 2026. The existing direction-independent ground_tracking "
    "load profile applies the same OBC/camera loads through uplink/RX slots; separate "
    "RX activity loads are unresolved. Sun-pointing/detumble, EPS and radio standby "
    "allowances remain provisional inputs."
)

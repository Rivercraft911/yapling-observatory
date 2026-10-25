"""Editable planning inputs confirmed by the user; no flight hardware calibration."""

from dataclasses import asdict, dataclass
from .radio import transmit_power


@dataclass(frozen=True)
class TransmitterPlanningProfile:
    electrical_w: float = 10.0
    pa_output_w: float = 4.0
    feed_loss_db: float = 1.0
    radiation_efficiency: float = 1.0
    profile_id: str = "user-planning-transmitter-10w-4w-2026-10-25"
    source_status: str = "user_confirmed_editable_planning_input"
    source: str = (
        "User confirmed the editable 10 W electrical / 4 W PA-port RF example on 25 October 2026; "
        "6 W transmitter heat is derived. Existing 1 dB feed loss and unit radiation "
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

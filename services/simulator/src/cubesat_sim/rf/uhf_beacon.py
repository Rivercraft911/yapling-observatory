"""Independent UHF beacon timing, nominal mode power and vector RF geometry."""

import math
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..geometry.vectors import dot, matvec, transpose, scale
from .lora import LoraModulation, lora_airtime
from .antennas import half_wave_dipole, short_dipole_turnstile
from .pattern_sampling import antenna_orientation_matrix
from .polarization import horizontal_feed, polarization_coupling
from .free_space import fspl_db
from .noise import noise_density_dbw_hz

MINIF27_URL = (
    "https://www.nicerf.com/pdf/minif27-800mw-lora-wireless-transceiver-module-v1.2.pdf"
)
DRIVER_URL = (
    "https://github.com/Lora-net/sx126x_driver/blob/v2.3.2/src/sx126x.c#L1109-L1162"
)


class UhfBeaconConfig(BaseModel):
    model_config = ConfigDict(
        frozen=True, extra="forbid", allow_inf_nan=False, validate_default=True
    )
    frequency_hz: float = Field(default=438e6, ge=150e6, le=960e6)
    tx_power_dbm: float = Field(default=29, ge=0, le=29)
    tx_feed_loss_db: float | None = Field(default=1, ge=0, le=50)
    idle_electrical_w: float = Field(default=0.0198, ge=0, le=100)
    tx_electrical_w: float | None = Field(default=2.5, ge=0, le=100)
    interval_s: float = Field(default=30, ge=1, le=86400)
    phase_s: float = Field(default=0, ge=0)
    modulation: LoraModulation = LoraModulation()
    antenna_variant: str = "dipole"
    antenna_orientation_deg: tuple[float, float, float] = (0, 0, 0)
    radiation_efficiency: float = Field(default=1, ge=0, le=1)
    ground_peak_gain_dbi: float = Field(default=15, ge=-10, le=70)
    ground_feed_roll_deg: float = Field(default=0, ge=-360, le=360)
    rx_system_noise_temperature_k: float | None = Field(default=None, ge=1, le=1e7)
    receiver_threshold_dbm: float | None = Field(default=None, ge=-180, le=10)
    thermal_node_id: str = Field(default="radio", min_length=1, max_length=128)

    @model_validator(mode="after")
    def physical_inputs(self):
        if self.antenna_variant not in ("dipole", "turnstile", "v45"):
            raise ValueError("UHF antenna must be dipole, turnstile or unresolved v45")
        if any(
            not math.isfinite(value) or abs(value) > 360
            for value in self.antenna_orientation_deg
        ):
            raise ValueError("Finite antenna mounting angles within +/-360deg required")
        if self.phase_s >= self.interval_s:
            raise ValueError("Beacon phase must be smaller than its interval")
        if lora_airtime(self.modulation)["packet_airtime_s"] > self.interval_s:
            raise ValueError("Beacon airtime exceeds its repetition interval")
        if self.tx_electrical_w is not None and self.tx_electrical_w < conducted_rf_w(
            self
        ):
            raise ValueError(
                "UHF TX electrical input cannot be less than conducted RF output"
            )
        return self


def default_uhf_beacon():
    return UhfBeaconConfig().model_dump(mode="json")


def conducted_rf_w(config):
    return 10 ** ((config.tx_power_dbm - 30) / 10)


def uhf_beacon_preview(config: UhfBeaconConfig):
    airtime = lora_airtime(config.modulation)
    duty = airtime["packet_airtime_s"] / config.interval_s
    rf = conducted_rf_w(config)
    feed = (
        rf * 10 ** (-config.tx_feed_loss_db / 10)
        if config.tx_feed_loss_db is not None
        else None
    )
    escaped = feed * config.radiation_efficiency if feed is not None else None
    dc = (
        config.idle_electrical_w * (1 - duty) + config.tx_electrical_w * duty
        if config.tx_electrical_w is not None
        else None
    )
    heat = dc - escaped * duty if dc is not None and escaped is not None else None
    missing = []
    if config.tx_electrical_w is None:
        missing.append("tx_electrical_w")
    if config.tx_feed_loss_db is None:
        missing.append("tx_feed_loss_db")
    if config.antenna_variant == "v45":
        missing.append("resolved_antenna_pattern")
    return dict(
        airtime=airtime,
        beacon=dict(
            interval_s=config.interval_s,
            phase_s=config.phase_s,
            duty_fraction=duty,
            payload_bytes=config.modulation.payload_bytes,
            nominal_payload_bits_per_s=8
            * config.modulation.payload_bytes
            / config.interval_s,
        ),
        power=dict(
            conducted_rf_w=rf,
            after_feed_rf_w=feed,
            escaped_rf_w=escaped,
            transmit_electrical_w=config.tx_electrical_w,
            receive_electrical_w=config.idle_electrical_w,
            average_electrical_w=dc,
            average_heat_w=heat,
        ),
        missing_inputs=missing,
        mission_coupling_ready=not missing,
        sources=[
            dict(
                url=MINIF27_URL,
                locator="Printed Rev1.1, pp3-6: module variants, 500mA at5V/29dBm; RX6mA DCDC; separate3.3V logic/PA rails",
            ),
            dict(
                url=DRIVER_URL,
                locator="v2.3.2 airtime numerator; DS.SX1261-2.W.APP rev2.2 section6.1.4",
            ),
        ],
        limits=[
            "Nominal manufacturer-condition mode powers: TX5V*0.5A=2.5W, RX3.3V*0.006A=0.0198W. Board/controller/converter overhead is separate; no sleep state.",
            "438MHz/29dBm and 30s beacon are user inputs. 1dB feed loss is an editable assumption; radiation efficiency1 is a free-space analytical reference. Payload32 bytes is illustrative.",
            "SF11/BW125 baseline comes from the documented SX1262-based1262MiniF27 example; do not apply it to the LLCC68 variant. Purchased chip/variant is not established by the module nickname alone.",
            "Airtime excludes RF ramp/startup, acquisition, retries and application overhead. No decoded packet delivery, FER or Doppler tolerance claim.",
            "Receiver noise and sensitivity remain unresolved by default. The module's -148dBm headline is atSF12/BW10.4kHz and is not this SF11/BW125 receiver threshold.",
            "Feed/antenna/body installation and isolation from S-band require hardware evidence.",
        ],
    )


def beacon_timing(config, time_s):
    duration = lora_airtime(config.modulation)["packet_airtime_s"]
    elapsed = time_s - config.phase_s
    if elapsed < 0:
        return dict(
            transmitting=False,
            cumulative_tx_airtime_s=0.0,
            scheduled_beacons_started=0,
            scheduled_beacons_completed=0,
        )
    cycles = math.floor(elapsed / config.interval_s)
    remainder = elapsed - cycles * config.interval_s
    completed = max(0, math.floor((elapsed - duration) / config.interval_s) + 1)
    return dict(
        transmitting=remainder < duration,
        cumulative_tx_airtime_s=cycles * duration + min(remainder, duration),
        scheduled_beacons_started=cycles + 1,
        scheduled_beacons_completed=completed,
    )


def beacon_tx_airtime(config, start_s, end_s):
    """Aggregate waveform overlap without enumerating a long output window."""
    if not (math.isfinite(start_s) and math.isfinite(end_s) and 0 <= start_s <= end_s):
        raise ValueError("Ordered finite beacon interval required")
    if start_s == end_s or end_s <= config.phase_s:
        return 0.0
    start_s = max(start_s, config.phase_s)
    duration = lora_airtime(config.modulation)["packet_airtime_s"]
    first = math.floor((start_s - config.phase_s) / config.interval_s)
    last = math.floor((end_s - config.phase_s) / config.interval_s)
    if first == last:
        return max(
            0.0,
            min(end_s, config.phase_s + first * config.interval_s + duration) - start_s,
        )
    left = max(0.0, config.phase_s + first * config.interval_s + duration - start_s)
    whole = max(0, last - first - 1) * duration
    right = min(duration, max(0.0, end_s - (config.phase_s + last * config.interval_s)))
    return math.fsum((left, whole, right))


def beacon_segments(config, start_s, end_s):
    """Exact TX/RX edge subdivision; no receiver or mechanics clock is changed."""
    if not (math.isfinite(start_s) and math.isfinite(end_s) and 0 <= start_s < end_s):
        raise ValueError("Positive ordered finite beacon interval required")
    duration = lora_airtime(config.modulation)["packet_airtime_s"]
    first = max(
        0, math.floor((start_s - config.phase_s - duration) / config.interval_s) + 1
    )
    last = math.ceil((end_s - config.phase_s) / config.interval_s) - 1
    if last - first > 10000:
        raise ValueError("Use aggregate airtime for long windows")
    cuts = [start_s, end_s]
    for index in range(first, last + 1):
        beginning = config.phase_s + index * config.interval_s
        for edge in (beginning, beginning + duration):
            if start_s < edge < end_s:
                cuts.append(edge)
    cuts = sorted(set(cuts))
    return tuple(
        (b - a, beacon_timing(config, (a + b) / 2)["transmitting"])
        for a, b in zip(cuts, cuts[1:])
    )


def uhf_link(config, geometry):
    """Vector dipole/turnstile link in the same inertial/body geometry as S-band."""
    if not geometry["visible"]:
        return dict(
            received_power_dbm=None,
            cn0_db_hz=None,
            margin_db=None,
            reason="below_station_mask",
        )
    if config.tx_feed_loss_db is None or config.antenna_variant == "v45":
        return dict(
            received_power_dbm=None,
            cn0_db_hz=None,
            margin_db=None,
            reason="feed_or_pattern_unresolved",
        )
    mount = antenna_orientation_matrix(config.antenna_orientation_deg)
    inertial_from_body = transpose((geometry["x"], geometry["y"], geometry["z"]))
    axes = tuple(matvec(inertial_from_body, axis) for axis in transpose(mount))
    look = scale(geometry["k"], -1)
    response = (
        half_wave_dipole(axes[0], look, config.radiation_efficiency)
        if config.antenna_variant == "dipole"
        else short_dipole_turnstile(axes[0], axes[2], look, config.radiation_efficiency)
    )
    analyzer = horizontal_feed(
        geometry["east"], geometry["north"], geometry["k"], config.ground_feed_roll_deg
    )
    coupling = polarization_coupling(
        response.polarization, tuple(complex(v).conjugate() for v in analyzer)
    )
    if response.gain_linear <= 0 or coupling is None or coupling <= 0:
        return dict(
            received_power_dbm=None,
            cn0_db_hz=None,
            margin_db=None,
            reason="field_or_polarization_null",
        )
    received = (
        config.tx_power_dbm
        - config.tx_feed_loss_db
        + 10 * math.log10(response.gain_linear)
        + config.ground_peak_gain_dbi
        - fspl_db(geometry["range_m"], config.frequency_hz)
        + 10 * math.log10(coupling)
    )
    cn0 = (
        received - 30 - noise_density_dbw_hz(config.rx_system_noise_temperature_k)
        if config.rx_system_noise_temperature_k is not None
        else None
    )
    margin = (
        received - config.receiver_threshold_dbm
        if config.receiver_threshold_dbm is not None
        else None
    )
    return dict(
        received_power_dbm=received,
        cn0_db_hz=cn0,
        margin_db=margin,
        reason=(
            "receiver_threshold_unresolved"
            if margin is None
            else "assumed_receiver_threshold"
        ),
    )

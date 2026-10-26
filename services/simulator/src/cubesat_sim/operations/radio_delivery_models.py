"""Opt-in deterministic DVB frame-accounting assumptions, not a measured receiver.

ETSI EN 302 307-1 V1.4.1: Tables 5a/5b (printed pp.22–23),
5.1.5–5.1.6 (pp.18–19), Figure13/Table11 (p.31), 5.5.3 (p.33).
"""
from fractions import Fraction
import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

ETSI_SOURCE = "https://www.etsi.org/deliver/etsi_en/302300_302399/30230701/01.04.01_60/en_30230701v010401p.pdf"
ESP_REVISION = "f6149796044796f83fe10a27dc381554df21a2d8"
NORMAL_KBCH = {
    "1/4": 16008, "1/3": 21408, "2/5": 25728, "1/2": 32208,
    "3/5": 38688, "2/3": 43040, "3/4": 48408, "4/5": 51648,
    "5/6": 53840, "8/9": 57472, "9/10": 58192,
}
SHORT_KBCH = {
    "1/4": 3072, "1/3": 5232, "2/5": 6312, "1/2": 7032,
    "3/5": 9552, "2/3": 10632, "3/4": 11712, "4/5": 12432,
    "5/6": 13152, "8/9": 14232,
}
PSK8_RATES = {"3/5", "2/3", "3/4", "5/6", "8/9", "9/10"}
CodeRate = Literal["1/4", "1/3", "2/5", "1/2", "3/5", "2/3", "3/4", "4/5", "5/6", "8/9", "9/10"]


class DeliveryModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False, validate_default=True)


class DeliveryMode(DeliveryModel):
    mode_id: str = Field(min_length=1, max_length=80)
    modulation: Literal["QPSK", "8PSK"]
    code_rate: CodeRate
    symbol_rate_sps: float = Field(ge=1, le=1e8)
    frame_size: Literal["normal", "short"] = "normal"
    pilots: bool = True
    decode_threshold_esn0_db: float | None = Field(default=None, ge=-50, le=150)
    threshold_status: Literal["illustrative", "ideal_awgn", "unresolved"] = "unresolved"
    threshold_source: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def supported_frame(self):
        if self.modulation == "8PSK" and self.code_rate not in PSK8_RATES:
            raise ValueError("This code rate has no DVB-S2 8PSK MODCOD")
        if self.frame_size == "short" and self.code_rate not in SHORT_KBCH:
            raise ValueError("Short DVB-S2 FECFRAME has no 9/10 mode")
        if (self.decode_threshold_esn0_db is None) != (self.threshold_status == "unresolved"):
            raise ValueError("A resolved threshold requires explicit evidence status")
        if self.threshold_status == "ideal_awgn" and self.frame_size != "normal":
            raise ValueError("Table13 ideal AWGN references apply to normal FECFRAMEs")
        return self


class DeliveryModeChange(DeliveryModel):
    start_s: float = Field(gt=0, le=31557600)
    mode_id: str = Field(min_length=1, max_length=80)


class DirectionDelivery(DeliveryModel):
    hardware_profile: Literal["generic_dvb_s2_reference", "esp32_s3_short_pair"] = "generic_dvb_s2_reference"
    assumptions: str = Field(min_length=1, max_length=4000)
    modes: tuple[DeliveryMode, ...] = Field(min_length=1, max_length=32)
    initial_mode_id: str = Field(min_length=1, max_length=80)
    policy: Literal["fixed", "scheduled", "adaptive"] = "fixed"
    schedule: tuple[DeliveryModeChange, ...] = Field(default=(), max_length=1000)
    acquisition_s: float = Field(ge=0, le=3600)
    reacquisition_s: float = Field(ge=0, le=3600)
    loss_hold_s: float = Field(ge=0, le=3600)
    minimum_dwell_s: float = Field(ge=0, le=86400)
    mode_change_s: float = Field(ge=0, le=3600)
    acquisition_margin_db: float = Field(default=0, ge=0, le=100)
    hold_margin_db: float = Field(default=0, ge=-100, le=0)
    application_overhead_bits_per_frame: int = Field(default=0, ge=0, strict=True)

    @model_validator(mode="after")
    def valid_policy(self):
        ids = [mode.mode_id for mode in self.modes]
        if len(ids) != len(set(ids)) or self.initial_mode_id not in ids:
            raise ValueError("Unique mode IDs and a defined initial mode are required")
        if any(change.mode_id not in ids for change in self.schedule):
            raise ValueError("Scheduled modes must be defined")
        starts = [change.start_s for change in self.schedule]
        if any(a >= b for a, b in zip(starts, starts[1:])):
            raise ValueError("Scheduled mode times must increase strictly")
        if self.policy != "scheduled" and self.schedule:
            raise ValueError("Only scheduled policy can contain scheduled changes")
        for mode in self.modes:
            kbch = (SHORT_KBCH if mode.frame_size == "short" else NORMAL_KBCH)[mode.code_rate]
            if self.application_overhead_bits_per_frame >= kbch - 80:
                raise ValueError("Application overhead must leave positive DATA FIELD payload")
            if self.hardware_profile == "esp32_s3_short_pair":
                if (mode.frame_size != "short" or not mode.pilots
                    or mode.symbol_rate_sps not in (1e6, 5e6)
                    or mode.code_rate in {"1/4", "1/3", "2/5", "9/10"}
                    or (mode.modulation == "8PSK" and mode.symbol_rate_sps != 5e6)):
                    raise ValueError("ESP32 pair evidence covers supported short frames with pilots at 1/5 Msym/s; 8PSK TX pairing requires 5 Msym/s")
        if self.hardware_profile == "esp32_s3_short_pair" and self.policy != "fixed":
            raise ValueError("ESP32 short-frame receiver evidence does not establish paired per-frame VCM; use a generic explicit study")
        return self


class RadioDeliveryConfig(DeliveryModel):
    schema_version: Literal["0.1.0"] = "0.1.0"
    uplink: DirectionDelivery
    downlink: DirectionDelivery


def delivery_example(uplink, downlink, *, preset="current"):
    """Copy current RF knobs into a separately labelled saturated-GCS assumption."""
    if preset == "adaptive_psk":
        return adaptive_psk_example(uplink, downlink)
    if preset != "current":
        raise ValueError("Unknown frame-accounting preset")
    directions = {}
    for direction, link in (("uplink", uplink), ("downlink", downlink)):
        profile = link.profile
        if profile.waveform != "dvb_s2":
            raise ValueError("Frame accounting currently requires DVB-S2 in both directions; LoRa remains separate")
        rate = str(Fraction(profile.code_rate).limit_denominator(100))
        mode_id = direction + "-current"
        threshold = profile.threshold_db
        if threshold is not None:
            threshold += profile.engineering_reserve_db
        directions[direction] = DirectionDelivery(
            assumptions="Illustrative saturated generic-continuous-stream source; one application unit per DATA FIELD, no retries/queue/TS reassembly/interface bottleneck. Timing inputs are user-editable assumptions, not measured ESP32 behavior.",
            modes=(DeliveryMode(
                mode_id=mode_id, modulation=profile.modulation, code_rate=rate,
                symbol_rate_sps=profile.symbol_rate_sps, frame_size="normal", pilots=True,
                decode_threshold_esn0_db=threshold,
                threshold_status="unresolved" if threshold is None else "illustrative",
                threshold_source=f"Current {direction} RadioProfile threshold ({profile.threshold_status}) plus engineering reserve, used as an assumed whole-frame Es/N0 step. " + ETSI_SOURCE + " Table13 p.36 is a normal-frame ideal AWGN reference, not acquisition or a calibrated receiver curve.",
            ),),
            initial_mode_id=mode_id, acquisition_s=1, reacquisition_s=1,
            loss_hold_s=0.25, minimum_dwell_s=2, mode_change_s=0.1,
        )
    return RadioDeliveryConfig(**directions)


# EN302307-1 V1.4.1 (2014-11), Table13 printed p.36: normal 64800-bit FECFRAME.
NORMAL_PSK_ESN0_DB = (
    ("QPSK", "1/4", -2.35), ("QPSK", "1/3", -1.24),
    ("QPSK", "2/5", -0.30), ("QPSK", "1/2", 1.00),
    ("QPSK", "3/5", 2.23), ("QPSK", "2/3", 3.10),
    ("QPSK", "3/4", 4.03), ("QPSK", "4/5", 4.68),
    ("QPSK", "5/6", 5.18), ("QPSK", "8/9", 6.20),
    ("QPSK", "9/10", 6.42), ("8PSK", "3/5", 5.50),
    ("8PSK", "2/3", 6.62), ("8PSK", "3/4", 7.91),
    ("8PSK", "5/6", 9.35), ("8PSK", "8/9", 10.69),
    ("8PSK", "9/10", 10.98),
)


def normal_psk_modes(symbol_rate_sps, engineering_reserve_db=0, pilots=True):
    """All legal normal-frame QPSK/8PSK combinations, not measured hardware."""
    if (not math.isfinite(engineering_reserve_db)
        or not 0 <= engineering_reserve_db <= 30):
        raise ValueError("Engineering reserve must be finite and within0..30dB")
    source = (
        "ETSI EN302307-1 V1.4.1 (2014-11), Table13 printed p.36; normal64800-bit "
        "FECFRAME QEF PER=1e-7 ideal AWGN simulation, 50 LDPC iterations, perfect "
        "carrier/synchronization recovery, no phase noise. Decoder reference only; "
        f"plus explicit {engineering_reserve_db:g}dB engineering reserve. "
        "Not measured sensitivity, acquisition or a calibrated frame-success curve. " + ETSI_SOURCE
    )
    return tuple(DeliveryMode(
        mode_id=modulation.lower() + "-" + rate.replace("/", "-"),
        modulation=modulation, code_rate=rate, symbol_rate_sps=symbol_rate_sps,
        frame_size="normal", pilots=pilots,
        decode_threshold_esn0_db=threshold + engineering_reserve_db,
        threshold_status="ideal_awgn", threshold_source=source,
    ) for modulation, rate, threshold in NORMAL_PSK_ESN0_DB)


def adaptive_psk_example(uplink, downlink):
    directions = {}
    for direction, link in (("uplink", uplink), ("downlink", downlink)):
        if link.profile.waveform != "dvb_s2":
            raise ValueError("The adaptive PSK example requires DVB-S2; LoRa is separate")
        modes = normal_psk_modes(
            link.profile.symbol_rate_sps, link.profile.engineering_reserve_db,
        )
        directions[direction] = DirectionDelivery(
            policy="adaptive", modes=modes, initial_mode_id=modes[0].mode_id,
            acquisition_s=1, reacquisition_s=1, loss_hold_s=0.25,
            minimum_dwell_s=2, mode_change_s=0.1,
            acquisition_margin_db=0.5, hold_margin_db=-0.5,
            assumptions=(
                "Ideal instantaneous current-channel MODCOD selection over the full user-reported "
                "QPSK/8PSK normal-frame range; generic reference, not ESP32 paired-hardware evidence. "
                "Highest complete-frame useful rate among capture-feasible modes; retain a decoding "
                "current mode within capture hysteresis. Dwell/frame boundaries and reconfiguration/"
                "reacquisition costs apply. Timing and0.5dB capture/hold margins are editable illustrative "
                "assumptions, not calibrated receiver properties. No delayed feedback, command loss, "
                "lookahead, queues/retries or operational ACM claim. Saturated GCS DATA FIELD payload."
            ),
        )
    return RadioDeliveryConfig(**directions)

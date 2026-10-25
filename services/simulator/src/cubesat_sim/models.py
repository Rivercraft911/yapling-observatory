"""Immutable input contracts. Example inputs are not mission requirements."""
from __future__ import annotations

from datetime import datetime
import hashlib
import json
import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .rf.antennas import HALF_WAVE_PEAK_DBI
from .rf.modem import net_rate_bps as profile_net_rate_bps

SCHEMA_VERSION = "0.1.0"
ETSI_URL = "https://www.etsi.org/deliver/etsi_en/302300_302399/30230701/01.04.01_60/en_30230701v010401p.pdf"
ITU_URL = "https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.525-5-202411-I!!PDF-E.pdf"
# EN 302 307-1 V1.4.1, section 6, Table 13, printed p. 36.
# Ideal simulated AWGN, normal 64800-bit FECFRAME, perfect synchronization.
IDEAL_DVB_THRESHOLDS = {
    ("QPSK", 0.25): -2.35, ("QPSK", 1/3): -1.24,
    ("QPSK", 0.4): -0.30, ("QPSK", 0.5): 1.00,
    ("QPSK", 0.6): 2.23, ("QPSK", 2/3): 3.10,
    ("QPSK", 0.75): 4.03, ("QPSK", 0.8): 4.68,
    ("QPSK", 5/6): 5.18, ("QPSK", 8/9): 6.20,
    ("QPSK", 0.9): 6.42, ("8PSK", 0.6): 5.50,
    ("8PSK", 2/3): 6.62, ("8PSK", 0.75): 7.91,
    ("8PSK", 5/6): 9.35, ("8PSK", 8/9): 10.69,
    ("8PSK", 0.9): 10.98,
}


class FrozenModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)


class Evidence(FrozenModel):
    path: str = Field(max_length=160)
    status: Literal["user_report", "illustrative", "primary_reference", "unresolved", "user_input"]
    source: str = Field(max_length=1000)
    conditions: str = Field(default="", max_length=2000)


class Station(FrozenModel):
    latitude_deg: float = Field(default=37.4275, ge=-89.9, le=89.9)
    longitude_deg: float = Field(default=-122.1697, ge=-180, le=180)
    height_m: float = Field(default=30, ge=-500, le=10000)
    minimum_elevation_deg: float = Field(default=10, ge=0, le=89)


class Orbit(FrozenModel):
    altitude_m: float = Field(default=550000, ge=160000, le=2000000)
    ground_track_heading_deg: float = Field(default=0, ge=-360, le=360)


class Attitude(FrozenModel):
    mode: Literal["tracking", "tumble"] = "tracking"
    pointing_error_deg: float = Field(default=0, ge=0, le=90)
    spin_rate_deg_s: float = Field(default=6, ge=0, le=90)
    spin_axis_body: tuple[float, float, float] = (1, 0.4, 0.7)

    @model_validator(mode="after")
    def nonzero_axis(self):
        if not all(math.isfinite(v) and abs(v) <= 1e6 for v in self.spin_axis_body):
            raise ValueError("spin_axis_body must contain bounded finite components")
        if sum(v*v for v in self.spin_axis_body) < 1e-16:
            raise ValueError("spin_axis_body cannot be zero")
        return self


class Schedule(FrozenModel):
    slot_duration_s: float = Field(default=30, ge=1, le=3600)
    first_direction: Literal["uplink", "downlink"] = "uplink"


class RadioProfile(FrozenModel):
    waveform: Literal["lora", "dvb_s2"]
    modulation: Literal["LoRa", "QPSK", "8PSK"]
    symbol_rate_sps: float | None = Field(default=None, ge=1, le=1e8)
    code_rate: float = Field(default=1, gt=0, le=1)
    net_efficiency: float = Field(default=1, gt=0, le=1)
    information_rate_bps: float | None = Field(default=None, gt=0, le=1e8)
    threshold_metric: Literal["cn0", "esn0"]
    threshold_db: float | None = Field(default=None, ge=-50, le=150)
    threshold_status: Literal["illustrative", "ideal_awgn", "unresolved"] = "unresolved"
    engineering_reserve_db: float = Field(default=0, ge=0, le=30)

    @model_validator(mode="after")
    def consistent_profile(self):
        if self.waveform == "lora":
            if self.modulation != "LoRa" or self.threshold_metric != "cn0":
                raise ValueError("LoRa example uses an editable C/N0 threshold; no LoRa symbol/decoder model exists")
            if self.symbol_rate_sps is not None or self.information_rate_bps is None:
                raise ValueError("LoRa requires example information_rate_bps and null symbol_rate_sps")
            if self.threshold_status == "ideal_awgn":
                raise ValueError("No ideal or measured LoRa receiver profile is implemented")
        else:
            if self.modulation not in ("QPSK", "8PSK") or self.threshold_metric != "esn0":
                raise ValueError("DVB-S2 supports QPSK/8PSK Es/N0 studies only")
            if self.symbol_rate_sps is None or self.information_rate_bps is not None:
                raise ValueError("DVB-S2 requires symbol_rate_sps and null information_rate_bps")
            if self.threshold_status == "ideal_awgn":
                expected = next((v for (m, r), v in IDEAL_DVB_THRESHOLDS.items()
                                 if m == self.modulation and abs(r-self.code_rate) < 1e-8), None)
                if expected is None or self.threshold_db is None or abs(expected-self.threshold_db) > 1e-8:
                    raise ValueError("ideal_awgn threshold must match ETSI Table 13 for the selected modulation/code rate; use illustrative for another threshold")
        if (self.threshold_status == "unresolved") != (self.threshold_db is None):
            raise ValueError("unresolved threshold must be null; other statuses require a value")
        return self

    def net_rate_bps(self) -> float:
        return profile_net_rate_bps(self)


class Link(FrozenModel):
    spacecraft_antenna: Literal["patch", "wire"] = "patch"
    frequency_hz: float = Field(gt=1e6, le=40e9)
    tx_power_w: float = Field(ge=1e-9, le=1000)
    tx_feed_loss_db: float = Field(default=1, ge=0, le=50)
    ground_peak_gain_dbi: float = Field(ge=-10, le=70)
    spacecraft_peak_gain_dbi: float = Field(ge=-10, le=30)
    rx_system_noise_temperature_k: float = Field(ge=1, le=1e7)
    extra_path_loss_db: float = Field(default=0, ge=0, le=100)
    ground_feed_roll_deg: float = Field(default=0, ge=-360, le=360)
    profile: RadioProfile

    @model_validator(mode="after")
    def wire_gain_bound(self):
        if self.spacecraft_antenna == "wire" and self.spacecraft_peak_gain_dbi > HALF_WAVE_PEAK_DBI:
            raise ValueError(f"Wire peak gain is a half-wave efficiency reference and must not exceed {HALF_WAVE_PEAK_DBI:.12f} dBi")
        return self


class Scenario(FrozenModel):
    schema_version: Literal["0.1.0"] = SCHEMA_VERSION
    name: str = Field(default="Illustrative Stanford circular pass", min_length=1, max_length=160)
    epoch_utc: str = "2026-10-25T00:00:00Z"
    duration_s: float = Field(default=1200, ge=10, le=3600)
    step_s: float = Field(default=1, ge=0.05, le=30)
    station: Station = Station()
    orbit: Orbit = Orbit()
    attitude: Attitude = Attitude()
    antenna_variant: Literal["dipole", "turnstile", "v45"] = "dipole"
    schedule: Schedule = Schedule()
    uplink: Link
    downlink: Link
    provenance: tuple[Evidence, ...] = Field(default=(), max_length=100)

    @model_validator(mode="after")
    def bounded_grid(self):
        epoch = datetime.fromisoformat(self.epoch_utc.replace("Z", "+00:00"))
        if epoch.utcoffset() is None or epoch.utcoffset().total_seconds() != 0:
            raise ValueError("epoch_utc must include an explicit UTC Z or +00:00 offset")
        if len(self.epoch_utc) > 40:
            raise ValueError("epoch_utc is too long")
        if math.ceil(self.duration_s/self.step_s) + 1 > 7201:
            raise ValueError("At most 7201 requested sample points are permitted")
        return self

    def identity(self) -> tuple[str, str]:
        digest = content_hash(self.model_dump(mode="json"))
        return "scenario_" + digest[:16], digest


def canonical_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def content_hash(value) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def default_scenario() -> Scenario:
    return Scenario(
        uplink=Link(frequency_hz=2.4e9, tx_power_w=5, ground_peak_gain_dbi=31,
                    spacecraft_peak_gain_dbi=6, rx_system_noise_temperature_k=800,
                    profile=RadioProfile(waveform="dvb_s2", modulation="QPSK", symbol_rate_sps=1e6,
                                         code_rate=.5, net_efficiency=.9, threshold_metric="esn0",
                                         threshold_db=1, threshold_status="ideal_awgn")),
        downlink=Link(frequency_hz=2.4e9, tx_power_w=2, ground_peak_gain_dbi=31,
                      spacecraft_peak_gain_dbi=6, rx_system_noise_temperature_k=150,
                      profile=RadioProfile(waveform="dvb_s2", modulation="QPSK", symbol_rate_sps=1e6,
                                           code_rate=.5, net_efficiency=.9, threshold_metric="esn0",
                                           threshold_db=1, threshold_status="ideal_awgn")),
        provenance=(
            Evidence(path="station", status="illustrative", source="Approximate Stanford campus location, not a surveyed antenna reference point",
                     conditions="User reports Durand roof; these approximate campus coordinates and 30 m ellipsoidal height are demonstration assumptions, not Durand measurements."),
            Evidence(path="orbit", status="illustrative", source="User's 550 km circular planning case; an overhead-like plane is constructed for demonstration",
                     conditions="No launch orbit, TLE, inclination, RAAN or flight ephemeris has been supplied."),
            Evidence(path="uplink.ground_peak_gain_dbi", status="illustrative", source="Editable 31 dBi example for the user-reported 1.9 m S-band dish", conditions="Pattern, feed efficiency, antenna reference point and measurements unresolved."),
            Evidence(path="uplink.profile.threshold_db", status="primary_reference", source=ETSI_URL,
                     conditions="EN 302 307-1 V1.4.1 section 6, Table 13, p. 36: ideal simulated QPSK 1/2, 1 dB Es/N0. Not a receiver acquisition or measured decoder curve."),
            Evidence(path="downlink.profile.threshold_db", status="primary_reference", source=ETSI_URL,
                     conditions="EN 302 307-1 V1.4.1 section 6, Table 13, p. 36: ideal simulated QPSK 1/2 threshold 1 dB, AWGN, normal FECFRAME, perfect synchronization. No hardware/acquisition claim."),
            Evidence(path="downlink.ground_peak_gain_dbi", status="illustrative", source="Editable 31 dBi example near aperture estimate for reported 1.9 m dish",
                     conditions="User reports dish diameter; efficiency/feed/pattern/receiver measurements unavailable. This gain is independently editable and does not update with frequency."),
            Evidence(path="", status="illustrative", source="Bundled analytical example, version 0.1.0",
                     conditions="All remaining inputs, including power, noise, feed loss, net efficiency, schedules and kinematic attitude, are editable demonstration assumptions. No mission hardware is selected."),
        ),
    )

"""Periodic UHF beacon bookkeeping, independent of S-band direction slots."""

from dataclasses import dataclass
import math

from ..rf.uhf_beacon import (
    beacon_segments,
    beacon_timing,
    beacon_tx_airtime,
    uhf_beacon_preview,
    uhf_link,
)


@dataclass(frozen=True)
class UhfInterval:
    duration_s: float
    segments: tuple[tuple[float, bool], ...]
    tx_airtime_s: float
    electrical_w: float
    heat_w: float
    escaped_rf_w: float


class UhfBeaconAccumulator:
    def __init__(self, config):
        self.config = config
        self.preview = uhf_beacon_preview(config)
        if not self.preview["mission_coupling_ready"]:
            raise ValueError(
                "UHF coupling requires explicit power/feed and resolved antenna model"
            )
        self.tx_airtime = self.contact_airtime = 0.0
        self.electrical_j = self.heat_j = self.escaped_j = 0.0

    def interval(self, start_s, end_s):
        segments = beacon_segments(self.config, start_s, end_s)
        duration = end_s - start_s
        on_air = math.fsum(span for span, active in segments if active)
        electrical = (
            math.fsum(
                span
                * (
                    self.config.tx_electrical_w
                    if active
                    else self.config.idle_electrical_w
                )
                for span, active in segments
            )
            / duration
        )
        escaped = self.preview["power"]["escaped_rf_w"] * on_air / duration
        return UhfInterval(
            duration, segments, on_air, electrical, electrical - escaped, escaped
        )

    def commit(self, interval, visible):
        self.tx_airtime += interval.tx_airtime_s
        if visible:
            self.contact_airtime += interval.tx_airtime_s
        self.electrical_j += interval.electrical_w * interval.duration_s
        self.heat_j += interval.heat_w * interval.duration_s
        self.escaped_j += interval.escaped_rf_w * interval.duration_s

    def sample(self, time_s, geometry, previous_output_s, last_interval):
        timing = beacon_timing(self.config, time_s)
        budget = uhf_link(self.config, geometry)
        active = timing["transmitting"] and geometry["visible"]
        span = time_s - previous_output_s
        duty = (
            beacon_tx_airtime(self.config, previous_output_s, time_s) / span
            if span > 0
            else 0.0
        )
        duty = max(0.0, min(1.0, duty))
        output_dc = (
            (
                self.config.idle_electrical_w * (1 - duty)
                + self.config.tx_electrical_w * duty
            )
            if span > 0
            else 0.0
        )
        output_rf = self.preview["power"]["escaped_rf_w"] * duty
        return dict(
            transmitting=timing["transmitting"],
            visible=geometry["visible"],
            received_power_dbm=budget["received_power_dbm"] if active else None,
            available_received_power_dbm=budget["received_power_dbm"],
            cn0_db_hz=budget["cn0_db_hz"] if active else None,
            margin_db=budget["margin_db"] if active else None,
            reason=budget["reason"],
            tx_airtime_s=self.preview["airtime"]["packet_airtime_s"],
            output_interval_tx_fraction=duty,
            cumulative_tx_airtime_s=self.tx_airtime,
            output_interval_electrical_w=output_dc,
            output_interval_heat_w=output_dc - output_rf,
            output_interval_escaped_rf_w=output_rf,
            scheduled_beacons_started=timing["scheduled_beacons_started"],
            scheduled_beacons_completed=timing["scheduled_beacons_completed"],
            contact_tx_airtime_s=self.contact_airtime,
            electrical_w=last_interval.electrical_w if last_interval else 0.0,
            heat_w=last_interval.heat_w if last_interval else 0.0,
            escaped_rf_w=last_interval.escaped_rf_w if last_interval else 0.0,
        )

    def summary(self, time_s):
        timing = beacon_timing(self.config, time_s)
        return dict(
            tx_airtime_s=self.tx_airtime,
            contact_tx_airtime_s=self.contact_airtime,
            electrical_j=self.electrical_j,
            heat_j=self.heat_j,
            escaped_rf_j=self.escaped_j,
            scheduled_beacons_started=timing["scheduled_beacons_started"],
            scheduled_beacons_completed=timing["scheduled_beacons_completed"],
            decoded_beacons=None,
            delivered_bits=None,
            semantics="Scheduled waveform airtime and geometric station exposure; no receiver/acquisition/FER or packet delivery model",
        )

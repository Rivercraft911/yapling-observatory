"""Electrical, RF and heat at explicit transmitter, feed and antenna planes."""

from dataclasses import dataclass
import math


@dataclass(frozen=True)
class TransmitPower:
    electrical_w: float
    rf_output_w: float
    transmitter_heat_w: float
    feed_heat_w: float
    antenna_heat_w: float
    escaped_rf_w: float
    total_heat_w: float
    radiation_efficiency: float


def transmit_power(electrical_w, rf_output_w, feed_loss_db, radiation_efficiency):
    values = (electrical_w, rf_output_w, feed_loss_db, radiation_efficiency)
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in values):
        raise ValueError("Radio powers, loss and efficiency must be finite numbers")
    if min(electrical_w, rf_output_w, feed_loss_db) < 0 or not 0 <= radiation_efficiency <= 1:
        raise ValueError("Nonnegative powers/loss and radiation efficiency in [0,1] required")
    if rf_output_w > electrical_w + 1e-12:
        raise ValueError("Transmitter electrical input must cover its RF port output")
    antenna_input = rf_output_w * 10 ** (-feed_loss_db / 10)
    escaped = antenna_input * radiation_efficiency
    return TransmitPower(
        electrical_w=electrical_w,
        rf_output_w=rf_output_w,
        transmitter_heat_w=electrical_w - rf_output_w,
        feed_heat_w=rf_output_w - antenna_input,
        antenna_heat_w=antenna_input - escaped,
        escaped_rf_w=escaped,
        total_heat_w=electrical_w - escaped,
        radiation_efficiency=radiation_efficiency,
    )


def heat_only_load(electrical_w):
    if type(electrical_w) not in (int, float) or not math.isfinite(electrical_w) or electrical_w < 0:
        raise ValueError("Radio electrical input must be finite and nonnegative")
    return dict(electrical_w=electrical_w, heat_w=electrical_w)

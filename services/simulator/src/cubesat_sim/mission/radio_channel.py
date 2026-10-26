"""Apply an explicit planning channel without replacing receiver assumptions."""

from ..models import RadioProfile
from ..operations.radio_delivery_models import DirectionDelivery
from ..rf.bandwidth import CHANNEL_ASSUMPTIONS, symbol_rate_for_bandwidth


def resolve_radio_channel(profile, delivery, channel_bandwidth_hz, rolloff):
    if profile.waveform != "dvb_s2":
        raise ValueError("Allocated channel bandwidth currently applies to DVB-S2 only")
    symbol_rate = symbol_rate_for_bandwidth(channel_bandwidth_hz, rolloff)
    updated_profile = RadioProfile.model_validate(
        profile.model_dump(mode="json")
        | dict(
            symbol_rate_sps=symbol_rate,
            channel_bandwidth_hz=channel_bandwidth_hz,
            rolloff=rolloff,
        )
    )
    updated_delivery = None
    if delivery is not None:
        if delivery.hardware_profile == "esp32_s3_short_pair" and rolloff != 0.35:
            raise ValueError("ESP32 short-pair evidence uses rolloff 0.35")
        values = delivery.model_dump(mode="json")
        for mode in values["modes"]:
            mode["symbol_rate_sps"] = symbol_rate
        updated_delivery = DirectionDelivery.model_validate(values)
    return dict(
        profile=updated_profile.model_dump(mode="json"),
        delivery=updated_delivery.model_dump(mode="json") if updated_delivery else None,
        symbol_rate_sps=symbol_rate,
        channel_bandwidth_hz=channel_bandwidth_hz,
        rolloff=rolloff,
        assumptions=CHANNEL_ASSUMPTIONS,
    )

"""Generic nominal rate estimate, not exact DVB framing or LoRa airtime."""


def net_rate_bps(profile) -> float:
    if profile.waveform == "lora":
        return float(profile.information_rate_bps) * profile.net_efficiency
    return float(profile.symbol_rate_sps) * (2 if profile.modulation == "QPSK" else 3) * profile.code_rate * profile.net_efficiency

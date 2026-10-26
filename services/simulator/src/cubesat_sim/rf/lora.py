"""SX126x legacy LoRa coding airtime; no acquisition, FER or goodput claim.

Semtech DS.SX1261-2.W.APP rev2.2 (Dec2024), section6.1.4, points to the
sx126x driver. Arithmetic follows its v2.3.2 airtime numerator, including SF5/6.
"""

from pydantic import BaseModel, ConfigDict, Field, model_validator


class LoraModulation(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)
    spreading_factor: int = Field(default=11, ge=5, le=12, strict=True)
    bandwidth_hz: int = Field(default=125000, strict=True)
    coding_rate_denominator: int = Field(default=5, ge=5, le=8, strict=True)
    payload_bytes: int = Field(default=32, ge=0, le=255, strict=True)
    preamble_symbols: int = Field(default=8, ge=1, le=65535, strict=True)
    explicit_header: bool = Field(default=True, strict=True)
    payload_crc: bool = Field(default=True, strict=True)
    low_data_rate_optimization: bool | None = Field(default=None, strict=True)

    @model_validator(mode="after")
    def supported_bandwidth(self):
        if self.bandwidth_hz not in (
            7812,
            10417,
            15625,
            20833,
            31250,
            41667,
            62500,
            125000,
            250000,
            500000,
        ):
            raise ValueError("Bandwidth must be an SX126x driver bandwidth in Hz")
        return self


def lora_airtime(config: LoraModulation):
    sf = config.spreading_factor
    symbol_s = 2**sf / config.bandwidth_hz
    ldro = (
        symbol_s >= 0.01638
        if config.low_data_rate_optimization is None
        else config.low_data_rate_optimization
    )
    numerator = 8 * config.payload_bytes + (16 if config.payload_crc else 0) - 4 * sf
    numerator += 20 if config.explicit_header else 0
    if sf <= 6:
        denominator = 4 * sf
    else:
        numerator += 8
        denominator = 4 * (sf - (2 if ldro else 0))
    blocks = (max(0, numerator) + denominator - 1) // denominator
    whole_symbols = (
        config.preamble_symbols
        + 12
        + blocks * config.coding_rate_denominator
        + (2 if sf <= 6 else 0)
    )
    quarter_symbols = 4 * whole_symbols + 1
    clock_numerator = quarter_symbols * 2 ** (sf - 2)
    warnings = []
    if sf <= 6 and config.preamble_symbols < 12:
        warnings.append(
            "SF5/6 use the SX126x short-SF airtime rule; short-preamble acquisition needs hardware verification."
        )
    if symbol_s >= 0.01638 and not ldro:
        warnings.append(
            "Long symbol time with LDRO disabled; clock-drift tolerance needs verification."
        )
    return dict(
        packet_airtime_s=clock_numerator / config.bandwidth_hz,
        symbol_duration_s=symbol_s,
        packet_symbols=quarter_symbols / 4,
        quarter_symbols=quarter_symbols,
        airtime_numerator=clock_numerator,
        airtime_denominator_hz=config.bandwidth_hz,
        low_data_rate_optimization=ldro,
        warnings=warnings,
    )

"""Free-space attenuation and linear-power to decibel conversion, all SI."""
import math
C_M_S = 299792458.0  # Exact SI definition.


def fspl_db(distance_m, frequency_hz):
    if distance_m <= 0 or frequency_hz <= 0:
        raise ValueError("Positive SI range and frequency required")
    return 20*math.log10(4*math.pi*distance_m*frequency_hz/C_M_S)


def power_db(value):
    return 10*math.log10(value) if value > 1e-24 else None

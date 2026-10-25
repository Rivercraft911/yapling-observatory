"""Antenna-port thermal noise density from the supplied system temperature."""
import math
K_B_J_K = 1.380649e-23  # Exact SI definition.


def noise_density_dbw_hz(temperature_k):
    if temperature_k <= 0:
        raise ValueError("Positive antenna-referred system noise temperature required")
    return 10*math.log10(K_B_J_K*temperature_k)

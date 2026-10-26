"""Far-field boresight gain of a circular reflector, with declared efficiency.

NASA-TM-84953 (January 1983), "Antenna Size and Gain Consideration",
printed p. 8 (PDF p. 17), gives G = 10 log10[eta (pi D / lambda)^2].
This scalar estimate supplies neither an off-axis pattern nor tracking losses.
"""

import math

from .free_space import C_M_S

APERTURE_SOURCE = {
    "url": "https://ntrs.nasa.gov/api/citations/19830016274/downloads/19830016274.pdf",
    "locator": "NASA-TM-84953 (January 1983), Antenna Size and Gain Consideration, printed p. 8 (PDF p. 17)",
}
APERTURE_ASSUMPTIONS = (
    "Far-field boresight estimate for an electrically large circular reflector. Aperture efficiency is an "
    "explicit assumed effective-to-physical aperture ratio, including the antenna "
    "losses assigned to that ratio. No separate feeder, pointing or polarization "
    "loss is included. This is not a measured gain or off-axis antenna pattern."
)


def _positive(value, name):
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive finite number")
    return float(value)


def circular_aperture_gain(diameter_m, frequency_hz, aperture_efficiency):
    """Return SI inputs and analytical gain referenced to an isotropic radiator."""
    diameter = _positive(diameter_m, "Diameter")
    frequency = _positive(frequency_hz, "Frequency")
    efficiency = _positive(aperture_efficiency, "Aperture efficiency")
    if efficiency > 1:
        raise ValueError("Aperture efficiency must not exceed 1")
    wavelength = C_M_S / frequency
    gain_dbi = 10 * math.log10(efficiency) + 20 * (
        math.log10(math.pi) + math.log10(diameter) - math.log10(wavelength)
    )
    if not math.isfinite(gain_dbi) or not math.isfinite(wavelength):
        raise ValueError("Aperture estimate must be finite")
    return dict(
        diameter_m=diameter,
        frequency_hz=frequency,
        aperture_efficiency=efficiency,
        wavelength_m=wavelength,
        peak_gain_dbi=gain_dbi,
        evidence_status="analytical_estimate",
        assumptions=APERTURE_ASSUMPTIONS,
        source=APERTURE_SOURCE.copy(),
    )

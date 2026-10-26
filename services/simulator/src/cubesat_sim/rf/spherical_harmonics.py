"""Complex transverse vector spherical harmonics with analytic power balance.

Y_lm uses the orthonormal Condon-Shortley convention (DLMF 14.30.1).
Psi = grad_S(Y)/sqrt(l(l+1)); X = -i rhat cross Psi. Each family has unit
sphere norm and the families are mutually orthogonal in the sphere integral.
Coefficients describe dimensionless angular fields, never fields in V/m.
"""
from __future__ import annotations

from functools import lru_cache
import math

from ..geometry.vectors import matvec, norm, transpose, unit
from .antennas import AntennaResponse, normalized_response
from .spherical_harmonic_models import MAXIMUM_DEGREE, SphericalHarmonicProfile

MODEL_VERSION = "transverse-vector-spherical-harmonics-1.0.0"
FORMULA = (
    "Y_lm = sqrt((2l+1)/(4π) · (l−m)!/(l+m)!) P_l^m(cos θ) exp(i m φ); "
    "Ψ_lm = ∇S Y_lm / sqrt(l(l+1)); X_lm = −i r̂ × Ψ_lm; "
    "F0 = Σ(a_lm Ψ_lm + b_lm X_lm); "
    "PΣ = Σ(|a_lm|² + |b_lm|²) = ∫|F0|² dΩ; "
    "F = sqrt(4π ηrad/PΣ) F0; G(θ,φ) = |F|²; (1/4π) ∫G dΩ = ηrad."
)
CONVENTIONS = (
    "Orthonormal complex Condon–Shortley Y_lm; l≥1; negative m: "
    "Y_l,−m=(−1)^m conjugate(Y_lm). θ from native +Z; φ from +X toward +Y. "
    "exp(+jωt); Cartesian complex transverse field. Coefficient arrays are [real, imaginary]. "
    "Accepted-power gain includes profile radiation efficiency once, excludes mismatch/feed loss. "
    "One exact profile frequency, no interpolation/extrapolation. Native-to-body mount: Rz(yaw) Ry(pitch) Rx(roll)."
)


@lru_cache(maxsize=16)
def _normalizations(maximum_degree):
    return {(l, m): math.sqrt((2*l+1)/(4*math.pi)*math.factorial(l-m)/math.factorial(l+m))
            for l in range(1, maximum_degree+1) for m in range(l+1)}


@lru_cache(maxsize=256)
def _angular_basis(maximum_degree, look):
    """Return Ψ theta/phi components; X follows by a transverse quarter turn.

    Differentiate the Legendre recurrence directly to avoid cancellation at
    the poles. P_l^m/sin(theta) has an analytic pole limit only for |m|=1.
    """
    x, y, z = look
    sine = math.hypot(x, y)
    phi = math.atan2(y, x) if sine else 0.0
    cosine_phi, sine_phi = math.cos(phi), math.sin(phi)
    theta_axis = (z*cosine_phi, z*sine_phi, -sine)
    phi_axis = (-sine_phi, cosine_phi, 0.0)
    legendre, derivative = {(0, 0): 1.0}, {(0, 0): 0.0}
    for m in range(maximum_degree+1):
        if m:
            factor = -(2*m-1)
            legendre[m, m] = factor*sine*legendre[m-1, m-1]
            derivative[m, m] = factor*(z*legendre[m-1, m-1] + sine*derivative[m-1, m-1])
        if m < maximum_degree:
            legendre[m+1, m] = (2*m+1)*z*legendre[m, m]
            derivative[m+1, m] = (2*m+1)*(-sine*legendre[m, m] + z*derivative[m, m])
        for l in range(m+2, maximum_degree+1):
            legendre[l, m] = ((2*l-1)*z*legendre[l-1, m] - (l+m-1)*legendre[l-2, m])/(l-m)
            derivative[l, m] = ((2*l-1)*(-sine*legendre[l-1, m] + z*derivative[l-1, m])
                                      - (l+m-1)*derivative[l-2, m])/(l-m)
    basis = {}
    for (l, m), normalization in _normalizations(maximum_degree).items():
        phase = complex(math.cos(m*phi), math.sin(m*phi))
        divisor = math.sqrt(l*(l+1))
        theta = normalization*derivative[l, m]*phase/divisor
        if sine:
            azimuthal = 1j*m*normalization*(legendre[l, m]/sine)*phase/divisor
        elif m == 1:
            pole_ratio = -l*(l+1)/2 if z > 0 else (-1)**l*l*(l+1)/2
            azimuthal = 1j*normalization*pole_ratio/divisor
        else:
            azimuthal = 0j
        basis[l, m] = (theta, azimuthal)
        if m:
            parity = (-1)**m
            basis[l, -m] = (parity*theta.conjugate(), parity*azimuthal.conjugate())
    return theta_axis, phi_axis, basis


def vector_spherical_harmonic(degree, order, look):
    """Inspect one orthonormal (Ψ_lm, X_lm) pair in Cartesian coordinates."""
    if not 1 <= degree <= MAXIMUM_DEGREE or abs(order) > degree:
        raise ValueError("Require 1 <= degree <= 12 and |order| <= degree")
    theta_axis, phi_axis, basis = _angular_basis(degree, unit(look))
    theta, phi = basis[degree, order]
    psi = tuple(theta*t + phi*p for t, p in zip(theta_axis, phi_axis))
    x = tuple(1j*phi*t - 1j*theta*p for t, p in zip(theta_axis, phi_axis))
    return psi, x


@lru_cache(maxsize=128)
def _compiled(profile):
    power = sum(v*v for item in profile.coefficients for v in (*item.psi, *item.x))
    normalization = math.sqrt(4*math.pi*profile.radiation_efficiency/power)
    modes = tuple((item.degree, item.order, complex(*item.psi)*normalization,
                   complex(*item.x)*normalization) for item in profile.coefficients)
    return modes, power


@lru_cache(maxsize=16384)
def _nominal_response(profile, look):
    modes, _ = _compiled(profile)
    theta_axis, phi_axis, basis = _angular_basis(profile.maximum_degree, look)
    field_theta, field_phi = 0j, 0j
    for l, m, a, b in modes:
        psi_theta, psi_phi = basis[l, m]
        field_theta += a*psi_theta + b*1j*psi_phi
        field_phi += a*psi_phi - b*1j*psi_theta
    field = tuple(field_theta*t + field_phi*p for t, p in zip(theta_axis, phi_axis))
    return normalized_response(field, norm(field)**2)


def spherical_harmonic_response(profile: SphericalHarmonicProfile, frequency_hz, look_body, matrix=None):
    """Shared mission/lab evaluator; matrix maps native antenna axes to body."""
    profile.check_frequency(frequency_hz)
    if matrix is None:
        return _nominal_response(profile, unit(look_body))
    response = _nominal_response(profile, unit(matvec(transpose(matrix), unit(look_body))))
    return AntennaResponse(response.gain_linear,
                           matvec(matrix, response.polarization) if response.polarization is not None else None)


def coefficient_power(profile):
    """Exact sphere integral of the unnormalized coefficient field."""
    return _compiled(profile)[1]



@lru_cache(maxsize=12)
def _gauss_legendre_nodes(count):
    nodes = []
    for index in range(1, count+1):
        z = math.cos(math.pi*(index-.25)/(count+.5))
        for _ in range(20):
            previous, current = 1.0, z
            for degree in range(2, count+1):
                previous, current = current, ((2*degree-1)*z*current-(degree-1)*previous)/degree
            derivative = count*(z*current-previous)/(z*z-1)
            step = current/derivative
            z -= step
            if abs(step) < 1e-15:
                break
        previous, current = 1.0, z
        for degree in range(2, count+1):
            previous, current = current, ((2*degree-1)*z*current-(degree-1)*previous)/degree
        derivative = count*(z*current-previous)/(z*z-1)
        nodes.append((z, 2/((1-z*z)*derivative*derivative)))
    return tuple(nodes)


@lru_cache(maxsize=128)
def sphere_mean_gain(profile):
    """Independent power quadrature, unaffected by mesh/cut display resolution.

    The phi rule removes every nonzero Fourier order through 2L; the remaining
    z polynomial has degree <=2L, integrated by L+1 Gauss-Legendre nodes.
    """
    count_phi = 2*profile.maximum_degree+1
    samples = []
    for z, weight in _gauss_legendre_nodes(profile.maximum_degree+1):
        radius = math.sqrt(1-z*z)
        for index in range(count_phi):
            phi = 2*math.pi*index/count_phi
            look = (radius*math.cos(phi), radius*math.sin(phi), z)
            gain = spherical_harmonic_response(profile, profile.frequency_hz, look).gain_linear
            samples.append(weight*gain/(2*count_phi))
    return math.fsum(samples)


def reference_profiles():
    """An ideal source plus declared synthetic sensitivity, not patch data."""
    coefficient = math.sqrt(4*math.pi/3)
    huygens = SphericalHarmonicProfile(
        name="Ideal Huygens source · electric + magnetic dipoles", revision="analytical-1",
        provenance=dict(status="analytical", source="NBS Technical Note 1072 (1984), §5.2 pp.26–27 and Appendix D pp.63–64; ideal collocated orthogonal electric/magnetic dipoles. https://nvlpubs.nist.gov/nistpubs/Legacy/TN/nbstechnicalnote1072.pdf",
                        conditions="Ideal free-space reference at one assigned 2.4 GHz frequency, beam +Y. F = (I−nnᵀ) x̂ + n×ẑ; D = 3(1+n_y)²/4. Equal electric/magnetic far fields in phase. No spacecraft, finite patch, matching or bandwidth model."),
        frequency_hz=2.4e9, maximum_degree=1, radiation_efficiency=1,
        coefficients=(dict(degree=1, order=-1, psi=(coefficient, 0)),
                      dict(degree=1, order=1, psi=(-coefficient, 0)),
                      dict(degree=1, order=0, x=(0, coefficient*math.sqrt(2)))))
    synthetic = SphericalHarmonicProfile(
        name="Synthetic multipole sensitivity · no hardware prediction", revision="illustrative-1",
        provenance=dict(status="illustrative", source="Deterministic user-editable vector spherical-harmonic coefficients. Ideal Huygens source with deliberately added l=2…8 transverse modes; no fit to EM or measured data.",
                        conditions="Illustrative amplitude/phase and polarization sensitivity at assigned 2.4 GHz; assumed efficiency 0.85. Mode weights and efficiency are synthetic. No patch, installed-spacecraft, flight-fit or resonance claim."),
        frequency_hz=2.4e9, maximum_degree=8, radiation_efficiency=.85,
        coefficients=(*huygens.coefficients,
                      dict(degree=2, order=-2, psi=(.7, .3), x=(.1, -.4)),
                      dict(degree=2, order=1, psi=(.35, -.25), x=(-.3, .15)),
                      dict(degree=3, order=0, psi=(.2, .45), x=(.25, -.1)),
                      dict(degree=3, order=2, psi=(-.45, .15), x=(.1, .25)),
                      dict(degree=4, order=-1, psi=(.35, -.2), x=(-.25, .2)),
                      dict(degree=5, order=3, psi=(-.2, .2), x=(.3, -.15)),
                      dict(degree=6, order=-4, psi=(.2, .1), x=(-.1, .2)),
                      dict(degree=8, order=2, psi=(.2, -.1), x=(.1, .15))))
    return [dict(id="ideal-huygens", label="Huygens reference", profile=huygens.model_dump(mode="json")),
            dict(id="synthetic-multipole-sensitivity", label="Multipole example", profile=synthetic.model_dump(mode="json"))]

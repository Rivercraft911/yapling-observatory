"""Sample free-space vector patterns in body axes; no mesh-derived RF.

Dimensionless field F has |F|² = gain, not electric-field units V/m.
"""
from __future__ import annotations
import math
from ..antenna_models import PatternRequest
from ..models import content_hash
from ..geometry.frames import rotation
from ..geometry.vectors import add, scale, norm, unit, matvec, matmul, transpose
from .antennas import AntennaResponse, half_wave_dipole, short_dipole_turnstile, cosine_patch
from .polarization import polarization_coupling
from .free_space import power_db
MODEL_VERSION = "antenna-lab-core-patterns-0.1.0"
IDENTITY = ((1, 0, 0), (0, 1, 0), (0, 0, 1))
MODELS = {
    "dipole": dict(label="Half-wave dipole", axes="Dipole axis +X", function="half_wave_dipole",
                   limits="Thin, sinusoidal-current half-wave dipole in free space. No feed, wire diameter, bandwidth, matching or installed metal."),
    "turnstile": dict(label="Quadrature turnstile", axes="Orthogonal short dipoles +X and +Z; +90° phase", function="short_dipole_turnstile",
                      limits="Two ideal short dipoles share one total power budget equally. No mutual coupling, feed error or installed metal. This is not a half-wave four-arm EM solution."),
    "patch": dict(label="Cosine patch surrogate", axes="Boresight +Y; linear feed +X", function="cosine_patch",
                  limits="One-sided cosine-power lobe with projected linear polarization. No patch dimensions, resonance, substrate, matching or installed-field prediction."),
    "v45": dict(label="45° V / tape", axes="Installed pattern unresolved", function=None,
                limits="The rendered tape shape supplies no current, feed or installed vector pattern. An EM solution or measurement is required."),
}


def orientation_matrix(angles):
    """R_body_from_nominal = Rz(yaw) Ry(pitch) Rx(roll), right-hand active."""
    roll, pitch, yaw = map(math.radians, angles)
    return matmul(rotation((0, 0, 1), yaw), matmul(rotation((0, 1, 0), pitch), rotation((1, 0, 0), roll)))


def direction_from_angles(azimuth_deg, elevation_deg):
    az, el = map(math.radians, (azimuth_deg, elevation_deg))
    return (math.cos(el)*math.cos(az), math.cos(el)*math.sin(az), math.sin(el))


def pattern_response(request: PatternRequest, look_body, matrix=None):
    """Rotate the same scalar/vector response used by the pass core into body axes."""
    if request.model == "v45":
        return None
    matrix = matrix or orientation_matrix(request.orientation_deg)
    look_nominal = matvec(transpose(matrix), unit(look_body))
    if request.model == "dipole":
        response = half_wave_dipole((1, 0, 0), look_nominal, request.efficiency)
    elif request.model == "turnstile":
        response = short_dipole_turnstile((1, 0, 0), (0, 0, 1), look_nominal, request.efficiency)
    else:
        original = cosine_patch((0, 1, 0), (1, 0, 0), look_nominal, request.patch_peak_gain_dbi)
        response = AntennaResponse(original.gain_linear*request.efficiency, original.polarization if request.efficiency > 0 else None)
    return AntennaResponse(response.gain_linear,
                           matvec(matrix, response.polarization) if response.polarization is not None else None)


def field_components(response):
    if response.polarization is None:
        return None, None
    field = scale(response.polarization, math.sqrt(response.gain_linear))
    return [v.real for v in field], [v.imag for v in field]


def probe_response(request: PatternRequest, matrix=None):
    if request.run_probe:
        run = request.run_probe
        q = unit(run.q_body_from_inertial_wxyz)
        vector_norm = norm(q[1:])
        body_from_inertial = rotation(q[1:], 2*math.atan2(vector_norm, q[0])) if vector_norm > 1e-14 else IDENTITY
        direction = matvec(body_from_inertial, unit(add(run.station_position_m, scale(run.spacecraft_position_m, -1))))
        az = math.atan2(direction[1], direction[0])
        el = math.asin(max(-1, min(1, direction[2])))
    else:
        az, el = map(math.radians, (request.probe_azimuth_deg, request.probe_elevation_deg))
        direction = direction_from_angles(request.probe_azimuth_deg, request.probe_elevation_deg)
    # Analyzer reference is increasing elevation. Roll +90° points along
    # increasing azimuth; at a pole the reported azimuth fixes a declared basis.
    elevation_axis = (-math.sin(el)*math.cos(az), -math.sin(el)*math.sin(az), math.cos(el))
    azimuth_axis = (-math.sin(az), math.cos(az), 0)
    roll = math.radians(request.linear_feed_roll_deg)
    analyzer = add(scale(elevation_axis, math.cos(roll)), scale(azimuth_axis, math.sin(roll)))
    response = pattern_response(request, direction, matrix)
    real, imaginary = field_components(response) if response else (None, None)
    return dict(direction_body=direction, azimuth_deg=math.degrees(az), elevation_deg=math.degrees(el),
                gain_linear=response.gain_linear if response else None,
                gain_dbi=power_db(response.gain_linear) if response else None,
                field_real=real, field_imag=imaginary, linear_analyzer_body=analyzer,
                linear_coupling=polarization_coupling(response.polarization, analyzer) if response else None,
                source="run_line_of_sight" if request.run_probe else "manual_direction",
                polarization_status="defined" if response and response.polarization is not None else "undefined_at_null_or_unresolved")


def sample_pattern(request: PatternRequest):
    matrix = orientation_matrix(request.orientation_deg)
    base = dict(model=request.model, model_version=MODEL_VERSION, request=request.model_dump(mode="json"),
                identity=content_hash(request.model_dump(mode="json") | {"model_version": MODEL_VERSION}),
                definition=MODELS[request.model], frame="Body +X,+Y,+Z; azimuth +X toward +Y; elevation above XY",
                orientation="R_body_from_nominal = Rz(yaw) Ry(pitch) Rx(roll), right-hand degrees",
                field_convention="exp(+jωt); dimensionless gain-normalized F, |F|² = gain; not V/m",
                source=dict(path="services/simulator/src/cubesat_sim/rf/antennas.py", function=MODELS[request.model]["function"],
                            evidence="analytical implementation; not EM, installed or measured"),
                probe=probe_response(request, matrix))
    if request.model == "v45":
        return base | dict(status="unresolved", grid=None, cuts=None, peak_gain_linear=None,
                           peak_gain_dbi=None, sphere_mean_gain=None)
    directions, gains, real, imaginary = [], [], [], []
    for i in range(request.polar_steps+1):
        theta = math.pi*i/request.polar_steps
        for j in range(request.azimuth_steps+1):
            phi = 2*math.pi*j/request.azimuth_steps
            direction = (math.sin(theta)*math.cos(phi), math.sin(theta)*math.sin(phi), math.cos(theta))
            response = pattern_response(request, direction, matrix)
            a, b = field_components(response)
            directions.append(direction); gains.append(response.gain_linear); real.append(a); imaginary.append(b)
    # Independent equal-solid-angle midpoint quadrature, including no pole samples.
    total = 0.0
    for i in range(request.polar_steps):
        z = -1+(i+.5)*2/request.polar_steps
        for j in range(request.azimuth_steps):
            phi = 2*math.pi*(j+.5)/request.azimuth_steps
            direction = (math.sqrt(1-z*z)*math.cos(phi), math.sqrt(1-z*z)*math.sin(phi), z)
            total += pattern_response(request, direction, matrix).gain_linear
    cuts = {}
    for name, angles in (("azimuth", list(range(-180, 181, 2))), ("elevation", list(range(-90, 91, 2)))):
        cut_gains = [pattern_response(request, direction_from_angles(a, request.cut_elevation_deg) if name == "azimuth"
                                      else direction_from_angles(request.cut_azimuth_deg, a), matrix).gain_linear for a in angles]
        cuts[name] = dict(angle_deg=angles, gain_linear=cut_gains, gain_dbi=[power_db(g) for g in cut_gains],
                          fixed_angle_deg=request.cut_elevation_deg if name == "azimuth" else request.cut_azimuth_deg)
    peak = max(gains)
    return base | dict(status="analytical", grid=dict(polar_steps=request.polar_steps, azimuth_steps=request.azimuth_steps,
                        directions_body=directions, gain_linear=gains, gain_dbi=[power_db(g) for g in gains],
                        field_real=real, field_imag=imaginary), cuts=cuts,
                       peak_gain_linear=peak, peak_gain_dbi=power_db(peak),
                       sphere_mean_gain=total/(request.polar_steps*request.azimuth_steps),
                       expected_sphere_mean_gain=request.efficiency*(min(1, 10**(request.patch_peak_gain_dbi/10)/2) if request.model == "patch" else 1),
                       integration="Equal-solid-angle midpoint quadrature; finite angular resolution limits the integral, especially for narrow lobes.")

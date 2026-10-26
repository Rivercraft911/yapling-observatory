"""Compatibility imports. Formulas are defined once in the named domain modules."""
import math
from dataclasses import dataclass
from .geometry.vectors import dot, add, scale, cross, norm, unit, matvec, transpose, matmul, transverse
from .geometry.frames import WGS84_A_M, WGS84_F, rz, rotation, quaternion_from_matrix, geodetic_ecef, enu_axes
from .attitude.prescribed import tracking_matrix
from .orbit.circular_pass import EARTH_MU_M3_S2, EARTH_OMEGA_RAD_S
from .rf.antennas import (HALF_WAVE_DIRECTIVITY, HALF_WAVE_PEAK_DBI, AntennaResponse,
                          normalized_response, half_wave_dipole, short_dipole_turnstile, cosine_patch)
from .rf.polarization import horizontal_feed, polarization_coupling
from .rf.free_space import C_M_S, fspl_db, power_db
from .rf.noise import K_B_J_K, noise_density_dbw_hz
from .operations.capacity import integrate_piecewise

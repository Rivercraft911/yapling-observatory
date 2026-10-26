"""WGS84 geodetic/ENU transforms and right-hand rotation matrices."""
import math
from .vectors import unit, scale
WGS84_A_M = 6378137.0
WGS84_F = 1 / 298.257223563


def rz(angle):
    c, s = math.cos(angle), math.sin(angle)
    return ((c, -s, 0), (s, c, 0), (0, 0, 1))


def rotation(axis, angle):
    x, y, z = unit(axis)
    c, s, v = math.cos(angle), math.sin(angle), 1-math.cos(angle)
    return ((c+x*x*v, x*y*v-z*s, x*z*v+y*s),
            (y*x*v+z*s, c+y*y*v, y*z*v-x*s),
            (z*x*v-y*s, z*y*v+x*s, c+z*z*v))


def quaternion_from_matrix(m):
    """Scalar-first Hamilton quaternion, q [0,v_I] q* = [0,v_B]."""
    trace = sum(m[i][i] for i in range(3))
    if trace > 0:
        s = math.sqrt(trace+1)*2
        q = (s/4, (m[2][1]-m[1][2])/s, (m[0][2]-m[2][0])/s, (m[1][0]-m[0][1])/s)
    else:
        i = max(range(3), key=lambda k: m[k][k])
        j, k = (i+1)%3, (i+2)%3
        s = math.sqrt(1+m[i][i]-m[j][j]-m[k][k])*2
        a = [0.0]*4
        a[0] = (m[k][j]-m[j][k])/s
        a[i+1] = s/4
        a[j+1] = (m[j][i]+m[i][j])/s
        a[k+1] = (m[k][i]+m[i][k])/s
        q = tuple(a)
    q = unit(q)
    return scale(q, -1) if q[0] < 0 else q


def geodetic_ecef(latitude_deg, longitude_deg, height_m):
    lat, lon = math.radians(latitude_deg), math.radians(longitude_deg)
    e2 = WGS84_F*(2-WGS84_F)
    n = WGS84_A_M / math.sqrt(1-e2*math.sin(lat)**2)
    return ((n+height_m)*math.cos(lat)*math.cos(lon),
            (n+height_m)*math.cos(lat)*math.sin(lon),
            (n*(1-e2)+height_m)*math.sin(lat))


def enu_axes(latitude_deg, longitude_deg):
    lat, lon = math.radians(latitude_deg), math.radians(longitude_deg)
    return ((-math.sin(lon), math.cos(lon), 0),
            (-math.sin(lat)*math.cos(lon), -math.sin(lat)*math.sin(lon), math.cos(lat)),
            (math.cos(lat)*math.cos(lon), math.cos(lat)*math.sin(lon), math.sin(lat)))
